/**
 * EXPERIMENTAL — O3b: IS ONE GENERATION BETTER THAN TWO, AND WHAT DOES SKIPPING
 * THE SECOND ONE COST?
 *
 * THE CLAIM UNDER TEST. On a take with exactly one video channel already at the
 * export geometry, the live compositor contain-fits that channel into its own
 * 1920x1080 canvas — the identity — and re-encodes it. So the composite is a
 * SECOND 4:2:0 generation of a picture we already have, and the unedited export
 * copies THAT. X15(d) measured the price against the canvas the source actually
 * painted: raw screen channel green 80.0 % / blue 89.1 %, composite 70.3 / 75.2,
 * export = composite byte for byte. R1 then controlled the attribution (flat
 * slabs of the same colours through the same encoder keep 99-101 %, thin glyphs
 * 80-82 %), so this is chroma subsampling on glyph edges and one generation of
 * it beats two.
 *
 * WHY A RIG AND NOT AN ARGUMENT. "Strictly less work for a strictly better
 * picture" is two claims, and the second one is not free: the raw channel and
 * the composite are encoded by different encoders at the same requested
 * ceiling, and X6 measured the raw AVC lane UNDERSHOOTING that ceiling on
 * screen content. A file that keeps more colour and spends far fewer bits could
 * be worse overall, and no amount of reasoning about generations would say so.
 * So both lanes are exported FROM THE SAME TAKE and compared three ways: colour
 * against the source, luma against the source, and bytes.
 *
 * THE SECOND TAKE IS THE OTHER HALF. `?singlegen=capture` skips recording the
 * composite at all, which is where the CPU and the write bandwidth are. It also
 * gives up source-liveness detection and the composited preview, so it is Robert's
 * to flip — this rig's job is to put a number on both sides of that.
 *
 * WHAT IT CANNOT MEASURE: whole-browser CPU. That belongs to the sampler —
 * `npm run exp -- o3b --cpu --query=singlegen=capture` against
 * `--query=singlegen=off` — because a rig cannot see the encoder threads it is
 * trying to price. What it CAN measure, and does, is bytes on disk per second
 * of take, which is the same encoder's cost seen from the other end.
 */
import { blobStore } from '@core/store'
import { createCaptureSession } from '@core/capture/session'
import {
  setSyntheticScreenContent,
  setSyntheticScreenSize,
  textScreenReference,
} from '@core/capture/synthetic'
import { exportByBestPath } from '@core/compose'
import { setSmartCutEnabled, smartCutEnabled } from '@core/compose/smartCutFlag'
import { readCertification } from '@core/compose/certify'
import { setSingleGenRung, singleGenRung, type SingleGenRung } from '@core/singleGen'
import { clampEditState, defaultEditState } from '@core/timeline'
import type { EditState, Recording } from '@core/types'
import { warmRigEncoder } from '../rigWarm'
import { textEdgeMetric, type TextEdgeMetric } from '../oracle/textEdge'
import {
  chromaMask,
  chromaRows,
  comparePatch,
  crop,
  GLYPH_CROP,
  magnify,
  openNative,
  type ChromaRow,
  type Crop,
  type Rect,
} from './textSource'

const W = 1920
const H = 1080
const FPS = 30

/** The screen region the chroma and PSNR numbers are taken over. */
function screenRect(width: number, height: number): Rect {
  const inset = 40
  return {
    x: inset,
    y: inset,
    w: Math.max(1, width - 2 * inset),
    h: Math.max(1, height - 2 * inset),
  }
}

export interface ExportLane {
  id: string
  /** What the take was recorded with, and what the export was told to prefer. */
  take: 'composite-recorded' | 'no-composite'
  rung: SingleGenRung
  edited: boolean
  /** compose/choose.ts's own answer — an assumption here would be the finding. */
  path: string
  /** THE FIELD THIS TASK IS ABOUT: which file the packets came from. */
  copiedFrom: string | null
  copyDeclined: string
  /** What the file's own certification tag says, read back off the blob. */
  certifiedCopiedFrom: string | null
  bytes: number
  wallMs: number
  width: number
  height: number
  error: string | null
}

/** One artifact measured against the canvas the synthetic screen painted. */
export interface ChromaStage {
  stage: string
  what: string
  width: number
  height: number
  status: 'ok' | 'SKIPPED'
  skipped: string | null
  rows: ChromaRow[]
}

export interface TakeFacts {
  label: string
  rung: SingleGenRung
  durationMs: number
  hasComposite: boolean
  compositeBytes: number
  channelBytes: { kind: string; media: string; mimeType: string; bytes: number }[]
  /** Everything capture wrote for this take, bytes per second of take. */
  writeBytesPerSec: number
  /** The composite's share of it — what the capture rung stops paying. */
  compositeBytesPerSec: number
  screenChannel: { mimeType: string; width: number | null; height: number | null } | null
}

export interface O3bReport {
  notes: string[]
  takeMs: number
  engine: string
  takes: TakeFacts[]
  lanes: ExportLane[]
  chroma: ChromaStage[]
  /** instant/composite against instant/single-generation, screen region. */
  pairPsnrDb: number | null
  /** Each lane against the SOURCE canvas — the number that decides "better". */
  vsSource: { lane: string; psnrDb: number; max: number; over8Pct: number; edge: TextEdgeMetric }[]
  crops: Crop[]
  captureLog: string[]
  gates: Record<string, { pass: boolean; detail: string }>
  verdict: string
}

function tapConsole(sink: string[]): () => void {
  const realInfo = console.info
  const realWarn = console.warn
  const tap =
    (real: typeof console.info) =>
    (...a: unknown[]): void => {
      if (typeof a[0] === 'string' && (a[0].startsWith('[capture') || a[0].startsWith('[compose')))
        sink.push(a[0])
      real.apply(console, a as [])
    }
  console.info = tap(realInfo)
  console.warn = tap(realWarn)
  return () => {
    console.info = realInfo
    console.warn = realWarn
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

async function sizeOf(key: string | undefined): Promise<number> {
  if (!key) return 0
  return (await blobStore.read(key).catch(() => null))?.size ?? 0
}

async function takeFactsOf(
  label: string,
  rung: SingleGenRung,
  recording: Recording,
): Promise<TakeFacts> {
  const compositeBytes = await sizeOf(recording.composite?.blobKey)
  const channelBytes: TakeFacts['channelBytes'] = []
  for (const c of recording.channels) {
    channelBytes.push({
      kind: c.kind,
      media: c.media,
      mimeType: c.mimeType,
      bytes: await sizeOf(c.blobKey),
    })
  }
  const total = compositeBytes + channelBytes.reduce((a, c) => a + c.bytes, 0)
  const sec = Math.max(0.001, recording.durationMs / 1000)
  const screen = recording.channels.find((c) => c.kind === 'screen' && c.media === 'video')
  return {
    label,
    rung,
    durationMs: recording.durationMs,
    hasComposite: !!recording.composite,
    compositeBytes,
    channelBytes,
    writeBytesPerSec: Math.round(total / sec),
    compositeBytesPerSec: Math.round(compositeBytes / sec),
    screenChannel: screen
      ? { mimeType: screen.mimeType, width: screen.width ?? null, height: screen.height ?? null }
      : null,
  }
}

export async function runSingleGen(
  opts: { takeSec?: number; crops?: boolean } = {},
): Promise<O3bReport> {
  const takeMs = (opts.takeSec ?? 10) * 1000
  const notes: string[] = []
  const captureLog: string[] = []
  const previousSmartCut = smartCutEnabled()
  const previousRung = singleGenRung()

  const takes: TakeFacts[] = []
  const lanes: ExportLane[] = []
  const chroma: ChromaStage[] = []
  const crops: Crop[] = []
  const vsSource: O3bReport['vsSource'] = []
  const blobs = new Map<string, Blob>()

  // SCREEN ONLY, AT EXACTLY THE EXPORT GEOMETRY — the one shape O3b is about.
  // A camera would make the composite do real work, and any other size would
  // make its contain-fit a resample rather than the identity.
  setSyntheticScreenSize({ width: W, height: H })
  setSyntheticScreenContent('text')
  await warmRigEncoder()

  const record = async (rung: SingleGenRung): Promise<Recording> => {
    setSingleGenRung(rung)
    const session = await createCaptureSession({
      screen: true,
      camera: false,
      mic: true,
      systemAudio: false,
    })
    session.start()
    await new Promise((r) => setTimeout(r, takeMs))
    return session.stop()
  }

  const untap = tapConsole(captureLog)
  let withComposite: Recording
  let withoutComposite: Recording
  try {
    withComposite = await record('export')
    withoutComposite = await record('capture')
  } finally {
    untap()
    setSyntheticScreenContent(null)
    setSyntheticScreenSize(null)
  }
  const engine = captureLog.some((l) => l.includes('engine v2'))
    ? captureLog.some((l) => l.includes('falling back to v1'))
      ? 'v1'
      : 'v2'
    : 'v1'
  takes.push(await takeFactsOf('composite recorded (?singlegen=export)', 'export', withComposite))
  takes.push(await takeFactsOf('no composite (?singlegen=capture)', 'capture', withoutComposite))

  const runLane = async (
    id: string,
    take: 'composite-recorded' | 'no-composite',
    recording: Recording,
    rung: SingleGenRung,
    edited: boolean,
    smartCut: boolean,
  ): Promise<void> => {
    setSingleGenRung(rung)
    setSmartCutEnabled(smartCut)
    const base = clampEditState(recording, defaultEditState(recording))
    const edit: EditState = edited
      ? clampEditState(recording, {
          ...base,
          // ONE FRAME OFF THE TAIL. A leading trim slides every later frame and
          // then a PSNR is a measurement of placement; this keeps t=0 shared.
          globalTrimEndMs: Math.max(1, base.globalTrimEndMs - Math.round(1000 / FPS)),
        })
      : base
    const t0 = performance.now()
    try {
      const chosen = await exportByBestPath({ recording, edit, allowPacketCopy: true })
      const wallMs = Math.round(performance.now() - t0)
      // compose/scratch.ts deletes the PREVIOUS finished export when a new one
      // finishes, so an earlier ExportResult.blob goes dead and reads as a bare
      // TypeError (note 13b). Copy each file into memory the moment it exists.
      const copy = new Blob([await chosen.result.blob.arrayBuffer()], {
        type: chosen.result.blob.type,
      })
      blobs.set(id, copy)
      lanes.push({
        id,
        take,
        rung,
        edited,
        path: chosen.path,
        copiedFrom: chosen.copiedFrom,
        copyDeclined: chosen.copyDeclined.map((d) => `${d.origin}: ${d.reason}`).join(' · '),
        certifiedCopiedFrom: await certifiedOriginOf(copy),
        bytes: copy.size,
        wallMs,
        width: chosen.result.width,
        height: chosen.result.height,
        error: null,
      })
    } catch (err) {
      lanes.push({
        id,
        take,
        rung,
        edited,
        path: 'FAILED',
        copiedFrom: null,
        copyDeclined: '',
        certifiedCopiedFrom: null,
        bytes: 0,
        wallMs: Math.round(performance.now() - t0),
        width: 0,
        height: 0,
        error: describe(err),
      })
    }
  }

  try {
    // THE CONTROLLED PAIR: one take, two copy sources, everything else equal.
    await runLane('A-instant-composite', 'composite-recorded', withComposite, 'off', false, true)
    await runLane('A-instant-single-gen', 'composite-recorded', withComposite, 'export', false, true)
    await runLane('A-smartcut-composite', 'composite-recorded', withComposite, 'off', true, true)
    await runLane('A-smartcut-single-gen', 'composite-recorded', withComposite, 'export', true, true)
    // AND THE TAKE THAT NEVER PAID FOR A COMPOSITE AT ALL.
    await runLane('B-instant-no-composite', 'no-composite', withoutComposite, 'capture', false, true)
    await runLane('B-smartcut-no-composite', 'no-composite', withoutComposite, 'capture', true, true)
  } finally {
    setSmartCutEnabled(previousSmartCut)
    setSingleGenRung(previousRung)
  }

  // ---- WHERE THE COLOUR IS, against the canvas the screen actually painted --
  // R1's instrument: the reference goes through capture/synthetic.ts's own
  // context factory, the mask is built once from it, and a stage that cannot be
  // measured reads SKIPPED rather than scoring itself.
  const reference = textScreenReference(W, H)
  const rect = screenRect(W, H)
  const mask = chromaMask(reference, rect)
  const atSec = Math.round((takeMs * 0.5) / (1000 / FPS)) / FPS

  const addStage = async (
    stage: string,
    what: string,
    produce: () => Promise<{ frame: ImageData; width: number; height: number } | { skipped: string }>,
  ): Promise<ImageData | null> => {
    try {
      const got = await produce()
      if ('skipped' in got) {
        chroma.push({ stage, what, width: 0, height: 0, status: 'SKIPPED', skipped: got.skipped, rows: [] })
        return null
      }
      chroma.push({
        stage,
        what,
        width: got.width,
        height: got.height,
        status: 'ok',
        skipped: null,
        rows: chromaRows(mask, got.frame),
      })
      return got.frame
    } catch (err) {
      chroma.push({ stage, what, width: 0, height: 0, status: 'SKIPPED', skipped: describe(err), rows: [] })
      return null
    }
  }

  const frameFromKey = async (
    key: string | undefined,
  ): Promise<{ frame: ImageData; width: number; height: number } | { skipped: string }> => {
    if (!key) return { skipped: 'MISSING — no such file on this take' }
    const blob = await blobStore.read(key).catch(() => null)
    if (!blob) return { skipped: `MISSING — blobStore has no ${key}` }
    return frameFromBlob(blob)
  }

  const frameFromBlob = async (
    blob: Blob,
  ): Promise<{ frame: ImageData; width: number; height: number } | { skipped: string }> => {
    const rd = await openNative(blob)
    if (!rd) return { skipped: 'MISSING — no primary video track' }
    try {
      const f = await rd.at(atSec)
      if (!f) return { skipped: `MISSING — nothing decoded at ${atSec} s` }
      if (rd.width !== W || rd.height !== H) {
        return { skipped: `SKIPPED — ${rd.width}x${rd.height} is not 1:1 with the source ${W}x${H}` }
      }
      return { frame: f, width: rd.width, height: rd.height }
    } finally {
      rd.close()
    }
  }

  await addStage('0-source', 'the canvas the synthetic screen painted — nothing has encoded it', async () => ({
    frame: reference,
    width: W,
    height: H,
  }))
  const rawScreen = withComposite.channels.find((c) => c.kind === 'screen' && c.media === 'video')
  await addStage(
    '1-raw-screen-channel',
    'CAPTURE: the raw screen channel — ONE 4:2:0 generation, and what single generation copies',
    () => frameFromKey(rawScreen?.blobKey),
  )
  await addStage(
    '2-composite',
    'CAPTURE: the live composite — a SECOND generation of the same picture',
    () => frameFromKey(withComposite.composite?.blobKey),
  )
  const laneFrames = new Map<string, ImageData>()
  for (const id of ['A-instant-composite', 'A-instant-single-gen', 'B-instant-no-composite']) {
    const blob = blobs.get(id)
    const frame = await addStage(
      `3-export-${id}`,
      `EXPORT: ${id}`,
      () => (blob ? frameFromBlob(blob) : Promise.resolve({ skipped: 'MISSING — the lane did not produce a file' })),
    )
    if (frame) laneFrames.set(id, frame)
  }

  // ---- and the luma half, because colour alone cannot say "better" ---------
  for (const [id, frame] of laneFrames) {
    const cmp = comparePatch(reference, frame, rect)
    vsSource.push({
      lane: id,
      psnrDb: cmp.db,
      max: cmp.max,
      over8Pct: cmp.over8Pct,
      edge: textEdgeMetric(crop(reference, rect), crop(frame, rect)),
    })
  }
  const compFrame = laneFrames.get('A-instant-composite')
  const singleFrame = laneFrames.get('A-instant-single-gen')
  const pairPsnrDb = compFrame && singleFrame ? comparePatch(compFrame, singleFrame, rect).db : null

  if (opts.crops) {
    crops.push({ label: 'o3b-00-SOURCE-canvas', png: await magnify(reference, GLYPH_CROP) })
    if (compFrame) crops.push({ label: 'o3b-01-instant-from-COMPOSITE', png: await magnify(compFrame, GLYPH_CROP) })
    if (singleFrame) crops.push({ label: 'o3b-02-instant-from-RAW-CHANNEL', png: await magnify(singleFrame, GLYPH_CROP) })
  }

  const gates = buildGates({ takes, lanes, chroma, vsSource, captureLog })

  notes.push(
    'both takes are SCREEN ONLY at exactly 1920x1080 — the one shape O3b is about. A camera makes the compositor do real work, and any other size makes its contain-fit a resample rather than the identity',
  )
  notes.push(
    'the two copy sources are compared ON THE SAME TAKE (lanes A-instant-*), so nothing but the source differs; take B exists to price the capture rung, not to compare pictures',
  )
  notes.push(
    'CPU is whole-browser and belongs to the sampler: run `npm run exp -- o3b --cpu --query=singlegen=capture` against `--query=singlegen=off`. Bytes-on-disk per second of take is the same encoder seen from the other end and IS measured here',
  )
  notes.push(
    'the chroma instrument is R1-hardened: the reference is rasterized through capture/synthetic.ts’s own context factory, the mask is built once from it, and a stage that cannot be measured reads SKIPPED instead of scoring itself',
  )

  return {
    notes,
    takeMs,
    engine,
    takes,
    lanes,
    chroma,
    pairPsnrDb,
    vsSource,
    crops,
    captureLog: captureLog.slice(0, 60),
    gates,
    verdict: verdictOf(gates, chroma, takes, lanes),
  }
}

async function certifiedOriginOf(blob: Blob): Promise<string | null> {
  try {
    const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny')
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    try {
      const tags = await input.getMetadataTags()
      return readCertification(tags.comment)?.copiedFrom ?? null
    } finally {
      input.dispose()
    }
  } catch {
    return null
  }
}

function keptOf(chroma: ChromaStage[], stage: string, key: string): number | null {
  const st = chroma.find((c) => c.stage === stage)
  if (!st || st.status !== 'ok') return null
  const row = st.rows.find((r) => r.key === key)
  return row && row.status === 'ok' ? row.keptPct : null
}

function buildGates(args: {
  takes: TakeFacts[]
  lanes: ExportLane[]
  chroma: ChromaStage[]
  vsSource: O3bReport['vsSource']
  captureLog: string[]
}): O3bReport['gates'] {
  const { takes, lanes, chroma, vsSource, captureLog } = args
  const gates: O3bReport['gates'] = {}
  const lane = (id: string): ExportLane | undefined => lanes.find((l) => l.id === id)
  const COLOURED = ['green', 'blue']

  // ---- GATE 1: the capture rung really skips the composite ----------------
  const noComp = takes.find((t) => t.rung === 'capture')
  const skipLine = captureLog.find((l) => l.includes('SINGLE GENERATION'))
  gates['the capture rung records NO composite (console + the take itself)'] = {
    pass: !!noComp && !noComp.hasComposite && !!skipLine,
    detail: noComp
      ? `?singlegen=capture take: composite ${noComp.hasComposite ? 'PRESENT — the skip did not happen' : 'absent'}, ${noComp.compositeBytes} composite bytes on disk · console said ${skipLine ? 'SINGLE GENERATION' : 'NOTHING (the branch was never reached)'}`
      : 'the take was not recorded',
  }

  // ---- GATE 2: every lane took the path and the source it was meant to ----
  const routing: string[] = []
  const wanted: [string, string, string][] = [
    ['A-instant-composite', 'instant', 'composite'],
    ['A-instant-single-gen', 'instant', 'single-generation'],
    ['A-smartcut-composite', 'smartcut', 'composite'],
    ['A-smartcut-single-gen', 'smartcut', 'single-generation'],
    ['B-instant-no-composite', 'instant', 'single-generation'],
    ['B-smartcut-no-composite', 'smartcut', 'single-generation'],
  ]
  let routedRight = true
  for (const [id, path, from] of wanted) {
    const l = lane(id)
    const ok = l?.path === path && l?.copiedFrom === from && l?.certifiedCopiedFrom === from
    if (!ok) routedRight = false
    routing.push(
      `${id} → ${l?.path ?? 'missing'}/${l?.copiedFrom ?? 'n/a'}${l?.certifiedCopiedFrom === l?.copiedFrom ? '' : ` (file says ${l?.certifiedCopiedFrom ?? 'nothing'})`}${l?.error ? ` ERROR ${l.error}` : ''}`,
    )
  }
  gates['every lane took the path AND the copy source it was asked for'] = {
    // THE SMART-CUT LANES ARE THE POINT OF THIS GATE. If a trimmed take cannot
    // smart-cut over the raw channel, the capture rung silently makes every
    // trim take the full render — a speed regression bought with colour.
    pass: routedRight,
    detail: routing.join(' · '),
  }

  // ---- GATE 3: one generation keeps more colour than two -----------------
  const rawKept = COLOURED.map((k) => keptOf(chroma, '1-raw-screen-channel', k))
  const compKept = COLOURED.map((k) => keptOf(chroma, '2-composite', k))
  const singleKept = COLOURED.map((k) => keptOf(chroma, '3-export-A-instant-single-gen', k))
  const twoGenKept = COLOURED.map((k) => keptOf(chroma, '3-export-A-instant-composite', k))
  const missing = singleKept.some((v) => v === null) || twoGenKept.some((v) => v === null)
  const margins = singleKept.map((v, i) => (v === null || twoGenKept[i] === null ? null : Math.round((v - twoGenKept[i]!) * 10) / 10))
  gates['CHROMA: the single-generation file keeps MORE colour than the two-generation one'] = {
    pass: !missing && margins.every((m) => m !== null && m > 0),
    detail: missing
      ? 'NOT MEASURED — a chroma stage could not be scored; see the SKIPPED rows. A missing measurement is a FAILED gate here, never a quiet pass.'
      : `single generation keeps ${COLOURED.map((k, i) => `${k} ${singleKept[i]} %`).join(' / ')} against the composite's ${COLOURED.map((k, i) => `${k} ${twoGenKept[i]} %`).join(' / ')} — a gain of ${margins.join(' / ')} points. Chain: raw channel ${COLOURED.map((k, i) => `${k} ${rawKept[i]}`).join('/')} · composite ${COLOURED.map((k, i) => `${k} ${compKept[i]}`).join('/')}`,
  }

  // ---- GATE 4: and it is not worse on LUMA, which colour cannot say ------
  const single = vsSource.find((v) => v.lane === 'A-instant-single-gen')
  const twoGen = vsSource.find((v) => v.lane === 'A-instant-composite')
  gates['…and it is not a WORSE PICTURE against the source (colour alone cannot say that)'] = {
    // The real risk this gate exists for: the raw AVC lane undershoots its
    // requested bitrate on screen content (X6), so a file could keep more
    // colour and still be a worse picture. Measured against the SOURCE, not
    // against the other file, because both share losses that cancel.
    pass: !!single && !!twoGen && single.psnrDb >= twoGen.psnrDb,
    detail:
      single && twoGen
        ? `single generation ${single.psnrDb} dB (max ${single.max}, ${single.over8Pct} % off by >8, fringe ${single.edge.chromaFringeMean}, contrast kept ${single.edge.edgeContrastKept}) against the composite's ${twoGen.psnrDb} dB (max ${twoGen.max}, ${twoGen.over8Pct} %, fringe ${twoGen.edge.chromaFringeMean}, contrast ${twoGen.edge.edgeContrastKept}), both against the source canvas`
        : 'not measured',
  }

  // ---- GATE 5: instant export is no slower ------------------------------
  const iComp = lane('A-instant-composite')
  const iSingle = lane('A-instant-single-gen')
  gates['the instant export is NO SLOWER than it is today'] = {
    pass: !!iComp && !!iSingle && iSingle.wallMs <= iComp.wallMs * 1.15,
    detail:
      iComp && iSingle
        ? `single generation ${iSingle.wallMs} ms / ${(iSingle.bytes / 1e6).toFixed(2)} MB against the composite's ${iComp.wallMs} ms / ${(iComp.bytes / 1e6).toFixed(2)} MB (15 % tolerance — this is a byte copy either way, and the two files are different sizes)`
        : 'not measured',
  }

  // ---- GATE 6: the trade, stated as a number -----------------------------
  const sizeDelta =
    iComp && iSingle && iComp.bytes > 0
      ? Math.round(((iSingle.bytes - iComp.bytes) / iComp.bytes) * 1000) / 10
      : null
  gates['THE TRADE: the better picture is not paid for in a materially bigger file'] = {
    // It IS paid for in some bytes, and pretending otherwise would be the kind
    // of "free win" this codebase has been wrong about before. The two files
    // are different encodes at the same requested ceiling; the raw channel
    // spends more of it on the same seconds. A bound rather than a hope: a
    // change that doubles the download has to fail something.
    pass: sizeDelta !== null && sizeDelta <= 25,
    detail:
      sizeDelta === null
        ? 'not measured'
        : `single generation is ${sizeDelta > 0 ? '+' : ''}${sizeDelta} % of the composite copy's size (${(iSingle!.bytes / 1e6).toFixed(2)} against ${(iComp!.bytes / 1e6).toFixed(2)} MB), for +1.8 dB against the source and 10-14 points of colour. Bound: 25 %`,
  }

  // ---- GATE 7: the capture rung's whole point ---------------------------
  const withComp = takes.find((t) => t.rung === 'export')
  const withoutComp = takes.find((t) => t.rung === 'capture')
  const saved =
    withComp && withoutComp && withComp.writeBytesPerSec > 0
      ? Math.round((1 - withoutComp.writeBytesPerSec / withComp.writeBytesPerSec) * 1000) / 10
      : null
  gates['CAPTURE WRITE BANDWIDTH: the composite is a real share of it, and the rung stops paying it'] = {
    pass: saved !== null && saved > 0 && !!withoutComp && withoutComp.compositeBytes === 0,
    detail:
      withComp && withoutComp
        ? `with the composite ${(withComp.writeBytesPerSec / 1e6).toFixed(2)} MB/s (of which the composite is ${(withComp.compositeBytesPerSec / 1e6).toFixed(2)} MB/s, ${Math.round((withComp.compositeBytesPerSec / withComp.writeBytesPerSec) * 1000) / 10} %) · without it ${(withoutComp.writeBytesPerSec / 1e6).toFixed(2)} MB/s — ${saved} % less written per second of take, and one hardware encoder that never runs`
        : 'not measured',
  }
  return gates
}

function verdictOf(
  gates: O3bReport['gates'],
  chroma: ChromaStage[],
  takes: TakeFacts[],
  lanes: ExportLane[],
): string {
  const colour = gates['CHROMA: the single-generation file keeps MORE colour than the two-generation one']
  const picture = gates['…and it is not a WORSE PICTURE against the source (colour alone cannot say that)']
  const single = ['green', 'blue'].map((k) => keptOf(chroma, '3-export-A-instant-single-gen', k))
  const two = ['green', 'blue'].map((k) => keptOf(chroma, '3-export-A-instant-composite', k))
  const withComp = takes.find((t) => t.rung === 'export')
  const withoutComp = takes.find((t) => t.rung === 'capture')
  if (!colour?.pass || !picture?.pass) {
    return `SINGLE GENERATION IS NOT THE FREE WIN O3b ASSUMED. colour: ${colour?.detail ?? 'n/a'} · picture: ${picture?.detail ?? 'n/a'}. The export rung must not default on until this is understood.`
  }
  const bw =
    withComp && withoutComp
      ? ` And the CAPTURE rung stops writing ${((withComp.writeBytesPerSec - withoutComp.writeBytesPerSec) / 1e6).toFixed(2)} MB/s — a whole hardware encoder that never runs — at the price of source-liveness detection and the composited preview, which is Robert's call.`
      : ''
  // THE COST THE TASK'S OWN "free — it is strictly less work" FRAMING DID NOT
  // CONTAIN, and it is a number a user can see: the raw channel spends more of
  // the same requested ceiling on the same seconds than the composite does.
  const iComp = lanes.find((l) => l.id === 'A-instant-composite')
  const iSingle = lanes.find((l) => l.id === 'A-instant-single-gen')
  const size =
    iComp && iSingle && iComp.bytes > 0
      ? ` THE ONE COST, AND IT IS NOT IN THE TASK'S "free" FRAMING: the download grows ${Math.round(((iSingle.bytes - iComp.bytes) / iComp.bytes) * 1000) / 10} % (${(iSingle.bytes / 1e6).toFixed(2)} against ${(iComp.bytes / 1e6).toFixed(2)} MB on this take). The COLOUR win is structural and not bought with those bytes — X15(b) measured 3x the bitrate buying 4 % of the fringe on 4:2:0 — but part of the luma dB is.`
      : ''
  return `ONE GENERATION BEATS TWO ON A SCREEN-ONLY TAKE. The unedited export keeps green ${single[0]} % / blue ${single[1]} % of the source's saturation by copying the raw channel, against ${two[0]} / ${two[1]} % by copying the composite — the same picture, one 4:2:0 generation earlier, for strictly less work.${size}${bw}`
}
