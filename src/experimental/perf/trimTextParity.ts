/**
 * EXPERIMENTAL — X15 lane (c): DOES ADDING ONE TRIM CHANGE HOW A TAKE'S TEXT
 * LOOKS? BACKLOG P1, moved out of the lab and into the product.
 *
 * WHAT X5 FOUND AND COULD NOT CLOSE. Fed the same software-decoded frame and
 * the same default composition, the two composite painters — compose/layout.ts
 * (2D, the render) and capture/compositorGL.ts (GL, the live composite) — agree
 * to only 37.3 dB on screen TEXT: max 156 of 255, 3.8 % of pixels off by more
 * than 8, with a mean signed delta of ≈0 and a clean camera region, i.e.
 * sharp-edge 4:2:0 chroma handling and not colour or geometry. That matters
 * beyond X5 because conflict rule 8 REQUIRES the two to agree: an unedited take
 * packet-copies the GL composite, and the same take with an edit is re-rendered
 * through the 2D painter. If the divergence survives in production, adding a
 * trim changes the look of the text.
 * X5 named the gap in its own finding: it fed both painters a SOFTWARE-DECODED
 * frame, while the live GL composite consumes a GPU-resident capture frame, and
 * the two conversions may not differ the same way. Only a real take can say.
 *
 * WHAT THE BACKLOG ENTRY GOT WRONG, AND THIS LANE FIXES: it says "export it
 * unedited (instant path) and with a one-frame trim (render path)". A trim-only
 * edit does not take the render path — SMART CUT has been the default since
 * 2026-08-25, and it COPIES the composite's packets inside every kept span and
 * re-encodes only the cut boundaries. So the file a user actually gets for a
 * trimmed take is mostly the same packets as the unedited one, and the question
 * "does a trim change how text looks" has a different answer for the path the
 * product picks than for the path the backlog assumed. Both are measured here:
 *
 *   instant    unedited          → packet copy of the GL composite
 *   smartcut   trailing trim     → the product's own ladder, default flags
 *   render     the SAME trim     → smart cut switched off, so the 2D painter runs
 *
 * THE TRIM IS AT THE TAIL ON PURPOSE. A leading trim slides every later frame,
 * and then a PSNR between two files is a measurement of placement. Trimming the
 * end leaves t=0 shared by all three.
 *
 * AND THE SCREEN FIXTURE HOLDS STILL, which this rig learned by getting it
 * wrong. On the scrolling code page it read instant vs render at 13.1 dB with
 * exactly O9's misaligned fingerprint (fringe 22.4 · smear 67.6 · contrast
 * 0.49), and no offset search fixed it — because the two paths do not start at
 * the same instant, and a page that changes in STEPS turns any residual offset
 * into a different page at some samples and not others. The dumped frames
 * (`{"thumbs":true}`) showed the same page one line apart, which is what
 * settled it. A still page cannot express that confound, so the screen row is
 * pixels and only pixels. The camera PiP still moves, and its alignment IS the
 * placement measurement — reported, not absorbed.
 */
import { blobStore } from '@core/store'
import { createCaptureSession } from '@core/capture/session'
import { setSyntheticScreenContent, setSyntheticScreenSize } from '@core/capture/synthetic'
import { exportByBestPath } from '@core/compose'
import { setSmartCutEnabled, smartCutEnabled } from '@core/compose/smartCutFlag'
import { clampEditState, defaultEditState } from '@core/timeline'
import type { EditState, Recording } from '@core/types'
import { textEdgeMetric, type TextEdgeMetric } from '../oracle/textEdge'
import {
  comparePatch,
  crop,
  decodeByOrdinal,
  encodeDeterministic,
  findOffsetSec,
  GLYPH_CROP,
  magnify,
  mean,
  openNative,
  stillSource,
  type Crop,
  type NativeReader,
  type Rect,
} from './textSource'

const W = 1920
const H = 1080
const FPS = 30

export interface ExportLane {
  id: 'instant' | 'smartcut' | 'render'
  /** What compose/choose.ts ACTUALLY picked — an assumption here would be the bug. */
  path: string
  declined: { path: string; reason: string }[]
  bytes: number
  wallMs: number
  width: number
  height: number
}

export interface PairRow {
  pair: string
  region: string
  /** The WORST of the sampled instants, at the pair's measured alignment. */
  psnrDb: number
  meanPsnrDb: number | null
  max: number
  over8Pct: number
  meanSigned: [number, number, number]
  /**
   * Where the second file's matching picture sits, in frames. Non-zero is a
   * PLACEMENT difference between two export paths, which is its own finding.
   */
  alignFrames: number
  /** The glyph metric, at the winning alignment. */
  edge: TextEdgeMetric | null
}

export interface X15TrimReport {
  notes: string[]
  takeMs: number
  engine: string
  compositeBytes: number
  sampledAtSec: number[]
  lanes: ExportLane[]
  rows: PairRow[]
  /**
   * What ONE re-encode of the instant lane's own frame costs it, over the same
   * screen rect. The floor instant↔render must beat to be about painters.
   */
  encodeFloor: { psnrDb: number; max: number; over8Pct: number; edge: TextEdgeMetric } | null
  /** Downscaled PNGs, one per lane, only with {"thumbs":true}. */
  thumbs: { lane: string; atSec: number; png: string }[]
  /** PO-visible artifacts, magnified glyph crops. Only with {"crops":true}. */
  crops: Crop[]
  gates: Record<string, { pass: boolean; detail: string }>
  verdict: string
  captureLog: string[]
}

/** X5's parity bar: ≤1 LSB or ≥60 dB. Below it, two painters disagree. */
const PARITY_DB = 60
/** The band this codebase calls "visually the same" (O11, x6's quality gate). */
const SAME_PICTURE_DB = 35

function tapConsole(sink: string[]): () => void {
  const realInfo = console.info
  const realWarn = console.warn
  const tap =
    (real: typeof console.info) =>
    (...a: unknown[]): void => {
      if (typeof a[0] === 'string' && a[0].startsWith('[capture')) sink.push(a[0])
      real.apply(console, a as [])
    }
  console.info = tap(realInfo)
  console.warn = tap(realWarn)
  return () => {
    console.info = realInfo
    console.warn = realWarn
  }
}

/** The screen region of the composite, kept clear of the camera PiP. */
function screenTextRect(width: number, height: number): Rect {
  // timeline/cameraTrack's default pose, the same arithmetic glComposite uses.
  const pw = 0.24 * width
  const margin = 24 * (width / 1920)
  const pipLeft = width - pw - margin
  const inset = 40
  return {
    x: inset,
    y: inset,
    w: Math.max(1, Math.floor(pipLeft - 2 * inset)),
    h: Math.max(1, height - 2 * inset),
  }
}

/**
 * A downscaled PNG of a frame, as a data URL.
 *
 * A number can say two files differ; only a picture says HOW. This rig's first
 * two runs read 13 dB with the fingerprint of a misaligned reference, and no
 * amount of re-reasoning about offsets settled whether that was placement or
 * content — looking at the frames did, in one step. `{"thumbs":true}`.
 */
async function thumb(img: ImageData): Promise<string> {
  const src = new OffscreenCanvas(img.width, img.height)
  src.getContext('2d', { alpha: false })!.putImageData(img, 0, 0)
  const dst = new OffscreenCanvas(640, Math.round((640 * img.height) / img.width))
  dst.getContext('2d', { alpha: false })!.drawImage(src, 0, 0, dst.width, dst.height)
  const blob = await dst.convertToBlob({ type: 'image/png' })
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]!)
  return `data:image/png;base64,${btoa(s)}`
}

export async function runTrimTextParity(
  opts: { takeSec?: number; thumbs?: boolean; searchSec?: number; crops?: boolean } = {},
): Promise<X15TrimReport> {
  const takeMs = (opts.takeSec ?? 10) * 1000
  const notes: string[] = []
  const captureLog: string[] = []
  const previousSmartCut = smartCutEnabled()

  setSyntheticScreenSize({ width: W, height: H })
  setSyntheticScreenContent('text')
  const untap = tapConsole(captureLog)
  let recording: Recording
  try {
    const session = await createCaptureSession({
      screen: true,
      camera: true,
      mic: true,
      systemAudio: false,
    })
    session.start()
    await new Promise((r) => setTimeout(r, takeMs))
    recording = await session.stop()
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
  const compositeBytes = recording.composite
    ? ((await blobStore.read(recording.composite.blobKey).catch(() => null))?.size ?? 0)
    : 0

  const base = clampEditState(recording, defaultEditState(recording))
  // ONE FRAME off the tail. Leading trims move every later frame; this one does
  // not, so all three files share t=0 and a PSNR is about pixels.
  const trimmed: EditState = clampEditState(recording, {
    ...base,
    globalTrimEndMs: Math.max(1, base.globalTrimEndMs - Math.round(1000 / FPS)),
  })

  const lanes: ExportLane[] = []
  const blobs = new Map<ExportLane['id'], Blob>()

  const runLane = async (id: ExportLane['id'], edit: EditState, smartCut: boolean): Promise<void> => {
    setSmartCutEnabled(smartCut)
    const t0 = performance.now()
    const chosen = await exportByBestPath({ recording, edit, allowPacketCopy: true })
    const wallMs = Math.round(performance.now() - t0)
    // compose/scratch.ts deletes the PREVIOUS finished export when a new one
    // finishes, so an earlier ExportResult.blob goes dead and reads as a bare
    // TypeError (note 13b). Copy each file into memory the moment it exists.
    const copy = new Blob([await chosen.result.blob.arrayBuffer()], { type: chosen.result.blob.type })
    blobs.set(id, copy)
    lanes.push({
      id,
      path: chosen.path,
      declined: chosen.declined,
      bytes: copy.size,
      wallMs,
      width: 0,
      height: 0,
    })
  }

  try {
    await runLane('instant', base, previousSmartCut)
    await runLane('smartcut', trimmed, true)
    await runLane('render', trimmed, false)
  } finally {
    setSmartCutEnabled(previousSmartCut)
  }

  // Instants inside the take, away from both ends. The alignment search below
  // is what makes them safe: the screen source scrolls a line every 2.5 s and
  // its phase in OUTPUT time depends on how long arming took, so no fixed
  // instant can be guaranteed to sit clear of a page change.
  const sampledAtSec = [takeMs * 0.3, takeMs * 0.5, takeMs * 0.7, takeMs * 0.85].map(
    (ms) => Math.round(ms / (1000 / FPS)) / FPS,
  )

  const readers = new Map<ExportLane['id'], NativeReader>()
  for (const lane of lanes) {
    const r = await openNative(blobs.get(lane.id)!)
    if (!r) continue
    readers.set(lane.id, r)
    lane.width = r.width
    lane.height = r.height
  }

  const rows: PairRow[] = []
  let encodeFloor: X15TrimReport['encodeFloor'] = null
  const crops: Crop[] = []
  const thumbs: { lane: string; atSec: number; png: string }[] = []
  try {
    const ref = readers.get('instant')
    const width = ref?.width || W
    const height = ref?.height || H
    const rect = screenTextRect(width, height)
    const pipRect: Rect = (() => {
      const pw = 0.24 * width
      const ph = pw / (640 / 480)
      const margin = 24 * (width / 1920)
      const inset = 30
      return {
        x: Math.round(width - pw - margin) + inset,
        y: Math.round(height - ph - margin) + inset,
        w: Math.max(1, Math.round(pw) - 2 * inset),
        h: Math.max(1, Math.round(ph) - 2 * inset),
      }
    })()

    const pairs: [ExportLane['id'], ExportLane['id']][] = [
      ['instant', 'smartcut'],
      ['instant', 'render'],
      ['smartcut', 'render'],
    ]
    for (const [a, b] of pairs) {
      const A = readers.get(a)
      const B = readers.get(b)
      if (!A || !B || A.width !== B.width || A.height !== B.height) continue

      // THE TWO REGIONS ARE MEASURED DIFFERENTLY, AND THAT IS THE DESIGN.
      // The screen is STILL, so its comparison needs no alignment and is given
      // none: a search there could only pick whichever neighbouring frame
      // flattered the pair. The camera PiP MOVES, so it is the one region that
      // can localise a file in time — its winning offset IS the placement
      // measurement, and it is reported rather than absorbed.
      const camAnchor = await A.at(sampledAtSec[0]!)
      const found = camAnchor
        ? await findOffsetSec(camAnchor, B, sampledAtSec[0]!, pipRect, {
            spanSec: opts.searchSec ?? 1.5,
          })
        : null
      const camOffsetSec = found?.offsetSec ?? 0

      for (const [regionName, region, offsetSec] of [
        ['screen TEXT', rect, 0],
        ['camera PiP', pipRect, camOffsetSec],
      ] as [string, Rect, number][]) {
        const scored: { cmp: ReturnType<typeof comparePatch>; edge: TextEdgeMetric }[] = []
        for (const t of sampledAtSec) {
          const left = await A.at(t)
          const right = await B.at(t + offsetSec)
          if (!left || !right) continue
          scored.push({
            cmp: comparePatch(left, right, region),
            edge: textEdgeMetric(crop(left, region), crop(right, region)),
          })
        }
        if (!scored.length) continue
        const worst = scored.reduce((lo, r) => (r.cmp.db < lo.cmp.db ? r : lo))
        rows.push({
          pair: `${a} ↔ ${b}`,
          region: regionName,
          psnrDb: worst.cmp.db,
          meanPsnrDb: mean(scored.map((s) => s.cmp.db)),
          max: worst.cmp.max,
          over8Pct: worst.cmp.over8Pct,
          meanSigned: worst.cmp.meanSigned,
          alignFrames: Math.round(camOffsetSec * FPS),
          edge: worst.edge,
        })
      }
    }
    // THE CONTROL THE QUESTION NEEDS. instant↔render is a painter difference
    // AND a re-encode, and this repo's own note puts the re-encode alone at
    // ~37.5 dB. So the same instant frame goes back through an encoder of the
    // export's shape, and what THAT costs is the floor the pair row has to beat
    // before "the painters differ" is a claim about painters.
    const still = ref ? await ref.at(sampledAtSec[0]!) : null
    if (still) {
      const enc = await encodeDeterministic({
        config: {
          codec: 'avc1.640028',
          width: still.width,
          height: still.height,
          bitrate: 8_000_000,
          framerate: FPS,
          latencyMode: 'quality',
        },
        frames: 60,
        source: stillSource(still),
        paced: false,
      })
      if (enc.blob) {
        const back = await decodeByOrdinal(enc.blob, [45], still.width, still.height)
        const got = back.frames[0]
        if (got) {
          if (opts.crops) crops.push({ label: 'c-03-instant-frame-RE-ENCODED-control', png: await magnify(got, GLYPH_CROP) })
          const cmp = comparePatch(still, got, rect)
          encodeFloor = {
            psnrDb: cmp.db,
            max: cmp.max,
            over8Pct: cmp.over8Pct,
            edge: textEdgeMetric(crop(still, rect), crop(got, rect)),
          }
        }
      }
    }

    if (opts.crops) {
      for (const [id, r] of readers) {
        const f = await r.at(sampledAtSec[0]!)
        if (f) crops.push({ label: `c-0${id === 'instant' ? 1 : 2}-${id}`, png: await magnify(f, GLYPH_CROP) })
      }
    }

    if (opts.thumbs) {
      for (const [id, r] of readers) {
        const f = await r.at(sampledAtSec[0]!)
        if (f) thumbs.push({ lane: id, atSec: sampledAtSec[0]!, png: await thumb(f) })
      }
    }
  } finally {
    for (const r of readers.values()) r.close()
  }
  const gates: X15TrimReport['gates'] = {}
  const pathOf = (id: ExportLane['id']): string => lanes.find((l) => l.id === id)?.path ?? 'none'
  gates['the three lanes really took the three paths (an assumption here would be the finding)'] = {
    pass: pathOf('instant') === 'instant' && pathOf('smartcut') === 'smartcut' && pathOf('render') === 'render',
    detail: lanes
      .map((l) => `${l.id} → ${l.path}${l.declined.length ? ` (declined: ${l.declined.map((d) => `${d.path}: ${d.reason}`).join('; ')})` : ''}`)
      .join(' · '),
  }
  const textRow = (pair: string): PairRow | undefined =>
    rows.find((r) => r.pair === pair && r.region === 'screen TEXT')
  const instRender = textRow('instant ↔ render')
  const instSmart = textRow('instant ↔ smartcut')

  gates['the export paths PLACE the picture in the same spot (alignment, not quality)'] = {
    pass: rows.every((r) => Math.abs(r.alignFrames) <= 1),
    detail: rows
      .filter((r) => r.region === 'screen TEXT')
      .map((r) => `${r.pair}: ${r.alignFrames} frames`)
      .join(' · '),
  }
  gates['BACKLOG P1: instant and render draw the SAME text (X5’s parity bar, ≥60 dB)'] = {
    pass: (instRender?.psnrDb ?? 0) >= PARITY_DB,
    detail: instRender
      ? `worst ${instRender.psnrDb} dB (mean ${instRender.meanPsnrDb}) · max ${instRender.max} · ${instRender.over8Pct} % of pixels off by >8 · align ${instRender.alignFrames} frames · mean signed ${instRender.meanSigned.join('/')}`
      : 'not measured',
  }
  gates['…and if they do not, is it at least the same PICTURE (≥35 dB)?'] = {
    pass: (instRender?.psnrDb ?? 0) >= SAME_PICTURE_DB,
    detail: instRender ? `${instRender.psnrDb} dB on screen text` : 'not measured',
  }
  gates['THE CONTROL: is instant↔render worse than ONE re-encode of the same frame?'] = {
    pass: !!encodeFloor && !!instRender && instRender.psnrDb < encodeFloor.psnrDb - 1,
    detail: encodeFloor
      ? `re-encoding the instant frame alone costs ${encodeFloor.psnrDb} dB (max ${encodeFloor.max}, ${encodeFloor.over8Pct} % off by >8, fringe ${encodeFloor.edge.chromaFringeMean}); instant↔render reads ${instRender?.psnrDb ?? 'n/a'} dB. A pair row AT this floor cannot tell a painter difference from the encode`
      : 'not measured',
  }
  gates['THE PATH A USER GETS: a trimmed take (smart cut) matches the untrimmed one'] = {
    pass: (instSmart?.psnrDb ?? 0) >= PARITY_DB,
    detail: instSmart
      ? `${instSmart.psnrDb} dB · max ${instSmart.max} · ${instSmart.over8Pct} % off by >8 · align ${instSmart.alignFrames}`
      : 'not measured',
  }

  notes.push(
    'the screen source is the code-editor page (setSyntheticScreenContent(\'text\')) — the default synthetic screen is a gradient with two huge glyphs, which is the wrong fixture for a chroma-upsampling question',
  )
  notes.push(
    'the screen row is measured at offset 0 because the screen HOLDS STILL; the camera PiP row carries the alignment search, and its winner (alignFrames) is the measured placement difference between the two paths. The earlier scrolling fixture could not separate the two and read 13.1 dB on a one-line page shift',
  )
  notes.push(
    'the camera PiP row is the control: X5 measured it clean (max 5-8) while screen text diverged, so a divergence on BOTH would be something else entirely',
  )
  notes.push(
    'every export blob is copied into memory as it is produced — compose/scratch.ts deletes the previous finished export when the next one finishes (note 13b)',
  )

  return {
    notes,
    takeMs,
    engine,
    compositeBytes,
    sampledAtSec,
    lanes,
    rows,
    encodeFloor,
    thumbs,
    crops,
    gates,
    verdict: verdictOf(instRender, instSmart, rows),
    captureLog: captureLog.slice(0, 40),
  }
}

function verdictOf(
  instRender: PairRow | undefined,
  instSmart: PairRow | undefined,
  rows: PairRow[],
): string {
  if (!instRender) return 'not measured'
  const cam = rows.find((r) => r.pair === 'instant ↔ render' && r.region === 'camera PiP')
  const head =
    instRender.psnrDb >= PARITY_DB
      ? `THE PAINTERS AGREE IN PRODUCTION: instant and render read ${instRender.psnrDb} dB on screen text (max ${instRender.max}), clearing X5's ≥60 dB parity bar. X5's lab divergence does NOT survive the real capture path — its own named gap (a software-decoded frame standing in for a GPU-resident capture frame) is the explanation, and BACKLOG P1 resolves.`
      : `THE PAINTERS DIVERGE IN PRODUCTION TOO: instant and render read ${instRender.psnrDb} dB on screen text — max ${instRender.max} of 255, ${instRender.over8Pct} % of pixels off by more than 8, mean signed ${instRender.meanSigned.join('/')} — against X5's ≥60 dB bar. BACKLOG P1 is CONFIRMED LIVE on the default export.`
  const camPart = cam ? ` The camera PiP control reads ${cam.psnrDb} dB (max ${cam.max}).` : ''
  const smartPart = instSmart
    ? ` AND THE PATH A USER ACTUALLY GETS: a trimmed take exports through SMART CUT, not the render — it reads ${instSmart.psnrDb} dB against the untrimmed file (max ${instSmart.max}), because it copies the same composite packets. The render's number is what a user sees only when smart cut declines.`
    : ''
  return head + camPart + smartPart
}
