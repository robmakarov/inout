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
 *
 * AND THEN THE LANE GREW THE PART THAT MATTERED MOST: WHERE THE COLOUR GOES.
 * The pair rows above compare files with EACH OTHER, so a loss every path
 * shares — which is exactly what 4:2:0 chroma subsampling is — cancels to zero.
 * Robert saw it by eye in the crops and was right. The chroma stages measure every
 * artifact against the CANVAS THE SYNTHETIC SCREEN PAINTED instead, masked by
 * the source's own palette, so the loss lands on a stage: one generation at the
 * raw channel, a second at the composite, nothing at all at the export.
 *
 * R1 (2026-08-29) HARDENED THAT INSTRUMENT, because it is now the evidence for
 * O3b and for the 4:4:4 decision and it could report wrong without saying so.
 * Everything it could have done silently is named at its fix site; the two
 * things a reader needs up front are:
 *   · A MEASUREMENT THAT DID NOT HAPPEN IS NOT A SCORE. Missing stages read
 *     MISSING, empty masks read MASK EMPTY, and both FAIL every chroma gate.
 *     `{"drill":"dead-composite-blob"|"dead-instant-export"|"palette-drift"}`
 *     points the rig at its own blind spots, one command each.
 *   · THE C1/C2 CONTROL PAIR IS WHAT MAKES THE ATTRIBUTION A CLAIM. 4:2:0 and a
 *     YUV matrix/range drift leave the same fingerprint here — saturated glyphs
 *     fade, grey holds — so the same palette goes through the same encoder as
 *     flat slabs AND as thin glyphs. Slabs keep 99-101 %, glyphs 80-82 %: it is
 *     subsampling on thin glyphs, and 4:4:4 will deliver.
 */
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'
import { blobStore } from '@core/store'
import { createCaptureSession } from '@core/capture/session'
import {
  setSyntheticScreenContent,
  setSyntheticScreenSize,
  textScreenReference,
  TEXT_SCREEN_PALETTE,
  type GlyphColourKey,
} from '@core/capture/synthetic'
import { exportByBestPath } from '@core/compose'
import { setSmartCutEnabled, smartCutEnabled } from '@core/compose/smartCutFlag'
import { clampEditState, defaultEditState } from '@core/timeline'
import type { EditState, Recording } from '@core/types'
import { warmRigEncoder } from '../rigWarm'
import { textEdgeMetric, type TextEdgeMetric } from '../oracle/textEdge'
import {
  comparePatch,
  crop,
  chromaMask,
  chromaRows,
  decodeByOrdinal,
  encodeDeterministic,
  findOffsetSec,
  GLYPH_CROP,
  magnify,
  mean,
  openNative,
  PAGE_COLOURS,
  stillSource,
  type ChromaMask,
  type ChromaRow,
  type Crop,
  type NativeReader,
  type Rect,
} from './textSource'

const W = 1920
const H = 1080
const FPS = 30
/**
 * How far below a pair's BEST sampled instant a winning match may score and
 * still count as a localisation (task B8). Measured spread of a real
 * localisation across five takes: 41.3-43.1 dB, i.e. under 2 dB. The two
 * instants that were not localisations scored 8.5 and 10.7 dB below their own
 * pair's best.
 */
const LOCALISE_DB = 6

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

/**
 * WHERE ONE PAIR'S SECOND FILE PLACES THE PICTURE, AT EVERY SAMPLED INSTANT
 * (task B8).
 *
 * `frames` is the whole measurement and the other three fields only summarise
 * it, because the SHAPE of the list is what names the cause:
 *   0 / -1 / 0 / -1   grid quantisation — the composite is frame-driven and the
 *                     render is on a fixed grid, so a read at t can land one
 *                     output frame apart. Not a defect; it is what comparing
 *                     two different clocks costs.
 *   -9 / -9 / -9 /-9  a CONSTANT placement error: the two paths disagree about
 *                     when the take began (a declared startOffsetMs).
 *   -6 /-14/-24/-33   a DRIFT: the two paths disagree about how fast it runs.
 *                     Frames the live composite never encoded is one way in.
 */
export interface AlignCensus {
  pair: string
  atSec: number[]
  frames: number[]
  /** Match quality at each winning offset, dB. A uniformly poor best match is
   *  itself evidence: no single offset explains the two files. */
  db: number[]
  /**
   * Instants whose winning match scored so far below this pair's best that it
   * is not a localisation at all. They are REPORTED and excluded from the
   * summary, never silently averaged in — the number this task was filed on
   * came from one of them. More than one of these is a failed measurement.
   */
  unlocalisedAtSec: number[]
  /** Over the localised instants only. */
  meanFrames: number | null
  spreadFrames: number | null
}

/** One artifact in the chain, measured against the SOURCE rather than a sibling. */
export interface ChromaStage {
  stage: string
  what: string
  width: number
  height: number
  /**
   * 'SKIPPED' means NOTHING WAS MEASURED HERE, and it exists because the old
   * loop expressed that with `continue` (R1 fixes 1 and 5). A stage that
   * silently vanishes is indistinguishable from a stage that was never asked
   * for, and the gates read the absence as `null` and passed.
   */
  status: 'ok' | 'SKIPPED'
  /** Why, in words, when status is SKIPPED. */
  skipped: string | null
  rows: ChromaRow[]
}

/**
 * THE DRILLS R1 IS GATED ON, and they are options rather than a test file
 * because what they prove is that the RIG reports its own blindness — which
 * only means anything when the whole rig runs.
 *
 *   dead-composite-blob   one stage points at a blobKey that does not exist.
 *                         That stage must read MISSING and the report must
 *                         still be produced (the old code threw the entire
 *                         report away on it — fix 5).
 *   dead-instant-export   the instant lane's file is replaced with nonsense,
 *                         so the stage BOTH chroma gates read cannot be
 *                         measured. Both must say NOT MEASURED and FAIL; the
 *                         old pair passed on it and was born red on it,
 *                         respectively (fixes 1 and 4).
 *   palette-drift         one palette entry is moved by +8 before the mask is
 *                         built. Every row must read MASK EMPTY. The old rig
 *                         reported "0 % kept" — a fabricated total colour loss
 *                         that would have read as a P1 (fix 10).
 */
export type X15Drill = 'dead-composite-blob' | 'dead-instant-export' | 'palette-drift'

export interface X15TrimReport {
  /** Which self-check this run is, if any — null for a real measurement. */
  drill: X15Drill | null
  notes: string[]
  takeMs: number
  engine: string
  compositeBytes: number
  sampledAtSec: number[]
  lanes: ExportLane[]
  rows: PairRow[]
  /** B8: where each pair's second file places the picture, at EVERY sampled
   *  instant. The alignment gate reads this, not one sample. */
  alignment: AlignCensus[]
  /** B8: the take's own clocks, and what the stop path's clamp discarded. */
  clocks: TakeClocks
  /**
   * What ONE re-encode of the instant lane's own frame costs it, over the same
   * screen rect. The floor instant↔render must beat to be about painters.
   */
  encodeFloor: { psnrDb: number; max: number; over8Pct: number; edge: TextEdgeMetric } | null
  /**
   * WHERE THE COLOUR GOES, measured against the canvas the synthetic screen
   * actually painted — the composite and the raw channel included, so the loss
   * is attributed to a stage instead of to "the export".
   */
  chroma: ChromaStage[]
  /** Downscaled PNGs, one per lane, only with {"thumbs":true}. */
  thumbs: { lane: string; atSec: number; png: string }[]
  /** Robert-visible artifacts, magnified glyph crops. Only with {"crops":true}. */
  crops: Crop[]
  gates: Record<string, { pass: boolean; detail: string }>
  verdict: string
  captureLog: string[]
}

/** X5's parity bar: ≤1 LSB or ≥60 dB. Below it, two painters disagree. */
const PARITY_DB = 60
/** The band this codebase calls "visually the same" (O11, x6's quality gate). */
const SAME_PICTURE_DB = 35

/**
 * THE COMMITTED CHROMA BASELINE — what this rig measured on 2026-08-26, and
 * what TASKS, BACKLOG and CONTEXT all quote (R1 fix 4).
 *
 * The chroma gate is a REGRESSION gate against these, not an absolute bar. The
 * absolute bar it used to carry (>= 90 % kept) was unreachable by construction:
 * the shipped chain measures 70.3 %, and O3b — the best outcome anyone has
 * proposed — is 80 %. Move these numbers when a change legitimately improves
 * the chain, in the same commit as the doc tables that quote them.
 */
const CHROMA_BASELINE: Record<'green' | 'blue', number> = { green: 70.3, blue: 75.2 }
/** The run-to-run variance this rig states for itself, in saturation points. */
const CHROMA_EPS = 2
/**
 * How much colour a FLAT slab has to keep before "the mechanism is subsampling
 * on thin glyphs" is a claim rather than an assumption (R1 fix 8). A flat area
 * gives 4:2:0 nothing to average across, so anything short of ~full retention
 * there is a different fault — a matrix or range round-trip — wearing the same
 * fingerprint.
 */
const FLAT_CONTROL_KEPT = 95

/**
 * The standalone encode both controls run through — the export's own shape
 * (AVC High 4:2:0, 8 Mbps, 1080p30), so "what one encode costs" is measured
 * with one encoder and not with two different ones.
 */
const CONTROL_ENCODE = {
  codec: 'avc1.640028',
  bitrate: 8_000_000,
  framerate: FPS,
  latencyMode: 'quality',
} as const satisfies Omit<VideoEncoderConfig, 'width' | 'height'>
const CONTROL_FRAMES = 60
/** Well past the opening keyframe, so the sample is a steady-state picture. */
const CONTROL_ORDINAL = 45

/** Stable artifact numbering — the old expression labelled two lanes `c-02`. */
const CROP_ORDER: Record<ExportLane['id'], number> = { instant: 1, smartcut: 2, render: 4 }

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/**
 * THE FLAT-PATCH CONTROL PICTURE (R1 fix 8): the same three glyph colours on
 * the same background, in slabs big enough that chroma subsampling has nothing
 * to average across.
 *
 * Painted through the wire's own context for the same reason the reference is
 * (fix 3) — a control rasterized differently from the thing it controls is not
 * a control. The slabs sit inside `rect` so the mask, the metric and the region
 * are the ones every other stage uses.
 */
function drawFlatPatches(width: number, height: number, rect: Rect): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')
  if (!g) throw new Error('2d canvas context unavailable')
  g.fillStyle = TEXT_SCREEN_PALETTE.background
  g.fillRect(0, 0, width, height)
  const bandH = Math.floor(rect.h / (TEXT_SCREEN_PALETTE.glyph.length * 2))
  TEXT_SCREEN_PALETTE.glyph.forEach((c, i) => {
    g.fillStyle = c.hex
    // Every other band, so each slab is surrounded by background — a slab that
    // filled the rect edge to edge would have no boundary to be wrong at.
    g.fillRect(rect.x, rect.y + i * 2 * bandH, rect.w, bandH)
  })
  return g.getImageData(0, 0, width, height)
}

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

/**
 * THE TAKE'S OWN CLOCKS, AND WHAT THE STOP PATH DID TO THEM (task B8).
 *
 * A placement number says the two files disagree; it cannot say why. This does,
 * from the take's own arithmetic, and it is why B8's answer is neither of the
 * two candidates that task named.
 *
 * Every channel and the composite are placed on the recording timeline by
 * `startOffsetMs`, and session.ts rebases them at stop so the earliest media is
 * t=0. The composite's rebase is CLAMPED AT ZERO, on the stated reasoning that
 * a composite reading earlier than the earliest channel is "measurement noise
 * between two first-arrival stamps". It is not noise. The composite's origin is
 * the first thing that reached the compositor worker — usually the mic's first
 * audio batch — while a raw video channel's origin is its own first FRAME,
 * which waits for a VideoEncoder to configure. Measured here: 190.7 ms apart on
 * one 10 s take. Everything the clamp discards is a displacement of the copied
 * picture against the audio the same export mixes from the raw channels.
 *
 * Read out of `[capture] composite v2 clock starts +Nms` and the B7 anchors
 * line, both of which the session already prints and this rig already taps. A
 * line that does not parse reads null and FAILS its gate — an unparsed log is
 * not a take that was fine.
 */
export interface TakeClocks {
  /** Pre-rebase, ms from the session epoch. */
  compositeOriginMs: number | null
  /** What the rebase subtracted: the earliest channel's own pre-rebase stamp. */
  minChannelAnchorMs: number | null
  /** What the composite's offset SHOULD be after the rebase. Negative = the
   *  composite's clock began before any channel delivered. */
  trueCompositeOffsetMs: number | null
  /** What the take actually carries — Math.max(0, true). */
  declaredCompositeOffsetMs: number | null
  /** true − declared. Non-zero = the clamp fired and this much was discarded. */
  clampedAwayMs: number | null
  /** The displacement that discard puts on the copied picture, in frames. */
  predictedAlignFrames: number | null
  channels: { kind: string; startOffsetMs: number; rawAnchorMs: number | null }[]
  /**
   * READ OUT OF THE COMPOSITE FILE ITSELF, so the finding does not rest on a
   * parsed log line. The worker's timeline begins at whatever reached it first
   * — the mix, in every take measured here — and its VIDEO cannot begin until a
   * source frame arrives, so this gap IS the lead the clamp discards. Both in
   * the file's own ms.
   */
  compositeAudioStartsMs: number | null
  compositeVideoStartsMs: number | null
}

async function compositeTrackStarts(
  blob: Blob | null,
): Promise<{ audioMs: number | null; videoMs: number | null }> {
  if (!blob) return { audioMs: null, videoMs: null }
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const v = await input.getPrimaryVideoTrack()
    const a = await input.getPrimaryAudioTrack()
    const videoMs = v ? Math.round((await v.getFirstTimestamp()) * 1000 * 10) / 10 : null
    const audioMs = a ? Math.round((await a.getFirstTimestamp()) * 1000 * 10) / 10 : null
    return { audioMs, videoMs }
  } catch {
    return { audioMs: null, videoMs: null }
  } finally {
    input.dispose()
  }
}

function readClocks(
  recording: Recording,
  log: string[],
  tracks: { audioMs: number | null; videoMs: number | null },
): TakeClocks {
  const originLine = log.find((l) => l.includes('composite v2 clock starts'))
  const compositeOriginMs = originLine
    ? (Number(/clock starts \+?(-?[\d.]+)ms/.exec(originLine)?.[1]) ?? NaN)
    : NaN
  const anchorLine = log.find((l) => l.includes('B7 anchors'))
  const raw = new Map<string, number>()
  if (anchorLine) {
    for (const m of anchorLine.matchAll(/(\w+) off=(-?[\d.]+)ms raw=(-?[\d.]+)ms/g)) {
      raw.set(m[1]!, Number(m[3]))
    }
  }
  const channels = recording.channels.map((c) => ({
    kind: c.kind,
    startOffsetMs: c.startOffsetMs,
    rawAnchorMs: raw.get(c.kind) ?? null,
  }))
  // The rebase subtracted one number from every channel, so ANY channel with a
  // pre-rebase stamp recovers it: min = raw − offset. Video only — the mic's
  // stamp is input-latency-adjusted after the raw one is printed, so it would
  // recover a value ~10 ms off and quietly bias the whole finding.
  const fromVideo = channels.filter(
    (c) => (c.kind === 'screen' || c.kind === 'camera') && c.rawAnchorMs !== null,
  )
  const minChannelAnchorMs = fromVideo.length
    ? Math.min(...fromVideo.map((c) => c.rawAnchorMs! - c.startOffsetMs))
    : NaN
  const declared = recording.composite?.startOffsetMs
  const trueOffset = compositeOriginMs - minChannelAnchorMs
  const ok = Number.isFinite(compositeOriginMs) && Number.isFinite(minChannelAnchorMs)
  return {
    compositeOriginMs: Number.isFinite(compositeOriginMs) ? compositeOriginMs : null,
    minChannelAnchorMs: Number.isFinite(minChannelAnchorMs)
      ? Math.round(minChannelAnchorMs * 10) / 10
      : null,
    trueCompositeOffsetMs: ok ? Math.round(trueOffset * 10) / 10 : null,
    declaredCompositeOffsetMs: typeof declared === 'number' ? declared : null,
    clampedAwayMs: ok && typeof declared === 'number' ? Math.round((declared - trueOffset) * 10) / 10 : null,
    predictedAlignFrames: ok ? Math.round(Math.min(0, trueOffset) * (FPS / 1000)) : null,
    channels,
    compositeAudioStartsMs: tracks.audioMs,
    compositeVideoStartsMs: tracks.videoMs,
  }
}

export async function runTrimTextParity(
  opts: {
    takeSec?: number
    thumbs?: boolean
    searchSec?: number
    crops?: boolean
    drill?: X15Drill
  } = {},
): Promise<X15TrimReport> {
  const drill = opts.drill ?? null
  const takeMs = (opts.takeSec ?? 10) * 1000
  const notes: string[] = []
  const captureLog: string[] = []
  const previousSmartCut = smartCutEnabled()

  setSyntheticScreenSize({ width: W, height: H })
  setSyntheticScreenContent('text')
  // NOTE 6. Production warms at MOUNT (prearm.ts, and since X6 it warms when a
  // raw channel will use WebCodecs too); a rig that calls createCaptureSession
  // directly does not, and a fresh process's first VideoEncoder init is
  // multi-second — long enough to eat most of a 10 s take. Without this the
  // raw channels reported 200 of 283 frames DROPPED ("encoder behind"), which
  // reads exactly like a throughput defect on the newly-default WebCodecs raw
  // path and is not one. The warm is SHARED now (R1 fix 11 →
  // experimental/rigWarm.ts): eleven other rigs were still cold.
  await warmRigEncoder()
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

  const clocks = readClocks(
    recording,
    captureLog,
    await compositeTrackStarts(
      recording.composite ? await blobStore.read(recording.composite.blobKey).catch(() => null) : null,
    ),
  )

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
  const readerFailures = new Map<ExportLane['id'], string>()
  for (const lane of lanes) {
    try {
      const file =
        drill === 'dead-instant-export' && lane.id === 'instant'
          ? new Blob([new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])], { type: 'video/mp4' })
          : blobs.get(lane.id)!
      const r = await openNative(file)
      if (!r) {
        readerFailures.set(lane.id, 'the file has no primary video track')
        continue
      }
      readers.set(lane.id, r)
      lane.width = r.width
      lane.height = r.height
    } catch (err) {
      readerFailures.set(lane.id, describe(err))
    }
  }

  const rows: PairRow[] = []
  const alignment: AlignCensus[] = []
  const pairFailures: string[] = []
  let encodeFloor: X15TrimReport['encodeFloor'] = null
  const chroma: ChromaStage[] = []
  const crops: Crop[] = []
  const thumbs: { lane: string; atSec: number; png: string }[] = []
  try {
    const ref = readers.get('instant')
    const width = ref?.width || W
    const height = ref?.height || H
    // THE PAIR ROWS' RECT — derived from the files being compared, which is
    // correct FOR THEM and wrong for the chroma stages (see chromaRect below).
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

    // ONE DECODE OF THE SHARED INSTANT, PER READER (R1 fix 13).
    // sampledAtSec[0] was being decoded up to three times per file — once for
    // the chroma row, once for the crop, once for the thumb — and `at()`
    // re-seeks from the keyframe every call. It also means the crop Robert looks
    // at and the number printed beside it are the SAME frame by construction
    // rather than by coincidence.
    const firstFrame = new Map<ExportLane['id'], ImageData | null>()
    for (const [id, r] of readers) {
      try {
        firstFrame.set(id, await r.at(sampledAtSec[0]!))
      } catch (err) {
        firstFrame.set(id, null)
        readerFailures.set(id, describe(err))
      }
    }

    const pairs: [ExportLane['id'], ExportLane['id']][] = [
      ['instant', 'smartcut'],
      ['instant', 'render'],
      ['smartcut', 'render'],
    ]
    for (const [a, b] of pairs) {
      // PER-PAIR CATCH (R1 fix 5). One rejected `at()` on one corrupt tail used
      // to escape the whole measurement block — which has a `finally` and no
      // `catch` — and throw away every row in the report, chroma stages
      // included, none of which had touched the bad file.
      try {
        const A = readers.get(a)
        const B = readers.get(b)
        if (!A || !B) {
          pairFailures.push(`${a} ↔ ${b}: SKIPPED — ${!A ? a : b} could not be opened`)
          continue
        }
        if (A.width !== B.width || A.height !== B.height) {
          pairFailures.push(
            `${a} ↔ ${b}: SKIPPED — ${A.width}x${A.height} against ${B.width}x${B.height}, not comparable`,
          )
          continue
        }

        // THE TWO REGIONS ARE MEASURED DIFFERENTLY, AND THAT IS THE DESIGN.
        // The screen is STILL, so its comparison needs no alignment and is given
        // none: a search there could only pick whichever neighbouring frame
        // flattered the pair. The camera PiP MOVES, so it is the one region that
        // can localise a file in time — its winning offset IS the placement
        // measurement, and it is reported rather than absorbed.
        //
        // B8: THE PLACEMENT IS LOCALISED AT EVERY SAMPLED INSTANT, NOT ONE.
        // One sample cannot tell a CONSTANT placement error (the two files
        // disagree about when the take started) from a DRIFTING one (they
        // disagree about how fast it runs), and those have different causes and
        // different fixes — the first is an offset, the second is dropped or
        // re-paced frames. It also cannot tell either from grid quantisation,
        // which is ±1 frame of jitter around zero and is not a defect at all.
        // The single sample is what made this gate flip run to run on the same
        // build (R1's finding (b), 2026-08-29): its bar was |align| ≤ 1 and the
        // jitter sits at 0…−2. A census answers all three questions and does
        // not flip, which is the same move G1/LC1 made on the sync gate — band
        // location and dispersion, never one extreme sample against a constant.
        const census: { atSec: number; frames: number; db: number }[] = []
        for (const t of sampledAtSec) {
          const anchor = t === sampledAtSec[0] ? (firstFrame.get(a) ?? null) : await A.at(t)
          if (!anchor) continue
          const hit = await findOffsetSec(anchor, B, t, pipRect, {
            spanSec: opts.searchSec ?? 1.5,
          })
          if (hit) census.push({ atSec: t, frames: Math.round(hit.offsetSec * FPS), db: hit.db })
        }
        // A SEARCH THAT FOUND NO MATCH DID NOT MEASURE A PLACEMENT, and that
        // distinction is this whole task. B8 was filed as "-15 frames (-0.5 s)"
        // and the August build re-measured today reads -38 — both from ONE
        // instant whose winning offset scored 23.6 / 30.9 dB while the same
        // pair's other instants scored 41.5 and sat at -1 / -1 / 0. On a take
        // whose live composite is dropping a third of its frames the PiP is
        // momentarily frozen, nothing in the search window matches, and the
        // winner is wherever the noise happened to be lowest. Scoring that as a
        // placement is the error R1 spent a whole session removing from the
        // chroma stages: a measurement that did not happen must not read as a
        // number. The bar is RELATIVE to the pair's own best instant, because
        // the absolute level belongs to the encode and not to the alignment.
        const best = census.length ? Math.max(...census.map((c) => c.db)) : 0
        const localised = census.filter((c) => c.db >= best - LOCALISE_DB)
        alignment.push({
          pair: `${a} ↔ ${b}`,
          atSec: census.map((c) => c.atSec),
          frames: census.map((c) => c.frames),
          db: census.map((c) => Math.round(c.db * 10) / 10),
          unlocalisedAtSec: census.filter((c) => c.db < best - LOCALISE_DB).map((c) => c.atSec),
          // The systematic component: where the second file PLACES the picture.
          meanFrames: mean(localised.map((c) => c.frames)),
          // The scatter around it. Quantisation is small and bounded; a drift is
          // large and monotonic, which the frames list shows by eye.
          spreadFrames: localised.length
            ? Math.max(...localised.map((c) => c.frames)) - Math.min(...localised.map((c) => c.frames))
            : null,
        })
        // The row's own psnr keeps the FIRST instant's offset, unchanged, so
        // every number this rig has ever committed stays comparable.
        const camOffsetSec = (census.find((c) => c.atSec === sampledAtSec[0])?.frames ?? 0) / FPS

        for (const [regionName, region, offsetSec] of [
          ['screen TEXT', rect, 0],
          ['camera PiP', pipRect, camOffsetSec],
        ] as [string, Rect, number][]) {
          const scored: { cmp: ReturnType<typeof comparePatch>; edge: TextEdgeMetric }[] = []
          let missed = 0
          for (const t of sampledAtSec) {
            const left = t === sampledAtSec[0] ? (firstFrame.get(a) ?? null) : await A.at(t)
            const right = await B.at(t + offsetSec)
            if (!left || !right) {
              missed++
              continue
            }
            scored.push({
              cmp: comparePatch(left, right, region),
              edge: textEdgeMetric(crop(left, region), crop(right, region)),
            })
          }
          if (!scored.length) {
            pairFailures.push(
              `${a} ↔ ${b} / ${regionName}: SKIPPED — none of the ${sampledAtSec.length} sampled instants decoded`,
            )
            continue
          }
          if (missed) {
            pairFailures.push(
              `${a} ↔ ${b} / ${regionName}: ${missed} of ${sampledAtSec.length} instants did not decode`,
            )
          }
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
      } catch (err) {
        pairFailures.push(`${a} ↔ ${b}: SKIPPED — ${describe(err)}`)
      }
    }
    // THE CONTROL THE QUESTION NEEDS. instant↔render is a painter difference
    // AND a re-encode, and this repo's own note puts the re-encode alone at
    // ~37.5 dB. So the same instant frame goes back through an encoder of the
    // export's shape, and what THAT costs is the floor the pair row has to beat
    // before "the painters differ" is a claim about painters.
    const still = ref ? (firstFrame.get('instant') ?? null) : null
    if (still) {
      try {
        const enc = await encodeDeterministic({
          config: { ...CONTROL_ENCODE, width: still.width, height: still.height },
          frames: CONTROL_FRAMES,
          source: stillSource(still),
          paced: false,
        })
        if (enc.blob) {
          const back = await decodeByOrdinal(enc.blob, [CONTROL_ORDINAL], still.width, still.height)
          const got = back.frames[0]
          if (got) {
            if (opts.crops)
              crops.push({
                label: 'c-03-instant-frame-RE-ENCODED-control',
                png: await magnify(got, GLYPH_CROP),
              })
            const cmp = comparePatch(still, got, rect)
            encodeFloor = {
              psnrDb: cmp.db,
              max: cmp.max,
              over8Pct: cmp.over8Pct,
              edge: textEdgeMetric(crop(still, rect), crop(got, rect)),
            }
          }
        }
      } catch {
        /* the floor is optional; its gate says "not measured" (fix 5) */
      }
    }

    // ---- WHERE THE COLOUR GOES ------------------------------------------
    // Against the SOURCE, not against a sibling file. The chain is measured
    // stage by stage so the loss lands on a stage: the RAW screen channel and
    // the COMPOSITE are what capture produced, and instant is a packet copy of
    // the composite while render re-composites from the raw channels. If the
    // composite is worse than the raw channel, the fast path a user gets by
    // default is the worst-coloured file the product makes — which is Robert's
    // observation, and it is free to act on if true.
    //
    // THE REFERENCE COMES THROUGH THE WIRE'S OWN CONTEXT (R1 fix 3). It used
    // to be rasterized on an `{alpha:false}` canvas while syntheticScreen()
    // paints on get2d()'s default (alpha:true), and an opaque canvas is
    // eligible for different text antialiasing — a reference that disagrees
    // with the wire about every glyph edge before anything has encoded it. The
    // dead second getContext() call went with it (R1 fix 14: repeat-call
    // attributes are ignored per spec, so `{willReadFrequently:true}` there was
    // never applied).
    const reference = textScreenReference(W, H)
    // AND THE RECT COMES FROM THE REFERENCE (R1 fix 2). It used to be derived
    // from the INSTANT READER's dimensions: with a reader of another size the
    // rect ran off the end of the source, where `data[i]` is undefined, every
    // tolerance test is false, and out-of-bounds pixels counted as mask HITS.
    // Only artifacts that are 1:1 with the source reach chromaRows at all, so
    // this is the one rect that is always inside both.
    const chromaRect = screenTextRect(W, H)
    const maskPalette =
      drill === 'palette-drift'
        ? PAGE_COLOURS.map((c, i) =>
            i === 1 ? { ...c, rgb: c.rgb.map((v) => Math.min(255, v + 8)) as [number, number, number] } : c,
          )
        : PAGE_COLOURS
    const mask = chromaMask(reference, chromaRect, 6, maskPalette)

    const addStage = async (
      stage: string,
      what: string,
      produce: () => Promise<
        | { frame: ImageData; width: number; height: number }
        | { skipped: string; width?: number; height?: number }
      >,
      /** The control stages paint a different reference, so they mask by it. */
      against: ChromaMask = mask,
    ): Promise<void> => {
      // PER-STAGE CATCH (R1 fix 5): a blob read, an openNative or an at() that
      // rejects becomes a SKIPPED ROW, not a lost report.
      try {
        const got = await produce()
        if ('skipped' in got) {
          chroma.push({
            stage,
            what,
            width: got.width ?? 0,
            height: got.height ?? 0,
            status: 'SKIPPED',
            skipped: got.skipped,
            rows: [],
          })
          return
        }
        chroma.push({
          stage,
          what,
          width: got.width,
          height: got.height,
          status: 'ok',
          skipped: null,
          rows: chromaRows(against, got.frame),
        })
      } catch (err) {
        chroma.push({
          stage,
          what,
          width: 0,
          height: 0,
          status: 'SKIPPED',
          skipped: describe(err),
          rows: [],
        })
      }
    }

    await addStage(
      '0-source',
      'the canvas the synthetic screen painted — nothing has encoded it',
      async () => ({ frame: reference, width: W, height: H }),
    )

    // THE SCREEN TRACK'S OWN SIZE, which is what the composite guard needs
    // (R1 fix 7). The compositor contain-fits whatever it is given into a
    // HARDCODED 1920x1080 canvas, so `composite.width === W` only ever says
    // that the container is 1920x1080 — it is true of every take this product
    // makes and can never fail. What has to be 1:1 with the source is the
    // screen CONTENT inside it, and that is the screen track's size.
    const rawScreen = recording.channels.find((c) => c.kind === 'screen' && c.media === 'video')
    let screenTrack: { width: number; height: number } | null =
      rawScreen?.width && rawScreen?.height
        ? { width: rawScreen.width, height: rawScreen.height }
        : null

    await addStage(
      '1-raw-screen-channel',
      'CAPTURE: the raw screen channel (what the render composites from)',
      async () => {
        if (!rawScreen?.blobKey) return { skipped: 'MISSING — the take has no raw screen channel' }
        const blob = await blobStore.read(rawScreen.blobKey).catch(() => null)
        if (!blob) return { skipped: `MISSING — blobStore has no ${rawScreen.blobKey}` }
        const rd = await openNative(blob)
        if (!rd) return { skipped: 'MISSING — the raw screen channel has no video track' }
        try {
          // The channel is the screen track, one encode later: its decoded size
          // is the most direct statement of what the screen actually was.
          screenTrack ??= { width: rd.width, height: rd.height }
          const f = await rd.at(sampledAtSec[0]!)
          if (!f) return { skipped: 'MISSING — nothing decoded at the sampled instant', width: rd.width, height: rd.height }
          if (rd.width !== W || rd.height !== H) {
            return {
              skipped: `SKIPPED — ${rd.width}x${rd.height} is not 1:1 with the source ${W}x${H}; a scaled artifact measures the resampler`,
              width: rd.width,
              height: rd.height,
            }
          }
          return { frame: f, width: rd.width, height: rd.height }
        } finally {
          rd.close()
        }
      },
    )

    await addStage(
      '2-composite',
      'CAPTURE: the live composite (what instant packet-copies)',
      async () => {
        const key =
          drill === 'dead-composite-blob'
            ? `${recording.composite?.blobKey ?? 'none'}-R1-DRILL-DEAD`
            : recording.composite?.blobKey
        if (!key) return { skipped: 'MISSING — the take has no composite' }
        const blob = await blobStore.read(key).catch(() => null)
        if (!blob) return { skipped: `MISSING — blobStore has no ${key}` }
        const rd = await openNative(blob)
        if (!rd) return { skipped: 'MISSING — the composite has no video track' }
        try {
          const f = await rd.at(sampledAtSec[0]!)
          if (!f) return { skipped: 'MISSING — nothing decoded at the sampled instant', width: rd.width, height: rd.height }
          if (rd.width !== W || rd.height !== H) {
            return {
              skipped: `SKIPPED — ${rd.width}x${rd.height} is not 1:1 with the source ${W}x${H}`,
              width: rd.width,
              height: rd.height,
            }
          }
          // R1 fix 7: the composite letterboxes the screen into its own fixed
          // canvas, so the CONTAINER matching the source proves nothing. Unless
          // the screen track is itself W x H the contain-fit is a resample and
          // this stage would be measuring the scaler, not the chroma.
          if (!screenTrack) {
            return {
              skipped: 'SKIPPED — the screen track size is unknown, so the contain-fit cannot be shown to be 1:1',
              width: rd.width,
              height: rd.height,
            }
          }
          if (screenTrack.width !== W || screenTrack.height !== H) {
            return {
              skipped: `SKIPPED — the screen TRACK is ${screenTrack.width}x${screenTrack.height}, contain-fitted into a ${rd.width}x${rd.height} composite; the content is resampled and not 1:1 with the source`,
              width: rd.width,
              height: rd.height,
            }
          }
          return { frame: f, width: rd.width, height: rd.height }
        } finally {
          rd.close()
        }
      },
    )

    for (const lane of lanes) {
      const id = lane.id
      await addStage(`3-export-${id}`, `EXPORT: ${id}`, async () => {
        const r = readers.get(id)
        if (!r)
          return { skipped: `MISSING — ${readerFailures.get(id) ?? 'the export was never opened'}` }
        const f = firstFrame.get(id) ?? null
        if (!f)
          return {
            skipped: `MISSING — nothing decoded at ${sampledAtSec[0]} s${readerFailures.has(id) ? ` (${readerFailures.get(id)})` : ''}`,
            width: r.width,
            height: r.height,
          }
        if (r.width !== W || r.height !== H) {
          return {
            skipped: `SKIPPED — ${r.width}x${r.height} is not 1:1 with the source ${W}x${H}`,
            width: r.width,
            height: r.height,
          }
        }
        return { frame: f, width: r.width, height: r.height }
      })
    }

    // ---- THE FLAT-PATCH CONTROL (R1 fix 8) -------------------------------
    // 4:2:0 subsampling and a YUV matrix/range round-trip drift leave the SAME
    // fingerprint on this page: saturated glyphs fade, grey holds. Everything
    // above therefore reads the same whichever one is happening, and the whole
    // 4:4:4 case rests on it being the first — because a flat area has no
    // chroma detail for subsampling to throw away, while a matrix error hits
    // every pixel of the same colour equally.
    // So: the identical palette, in slabs, through the identical encoder, and
    // the identical text page beside it as the matched half of the pair. If
    // the SLABS lose colour too, the attribution is wrong and 4:4:4 will
    // under-deliver against what BACKLOG P1 promises.
    const flatRef = drawFlatPatches(W, H, chromaRect)
    const flatMask = chromaMask(flatRef, chromaRect, 6, maskPalette)
    const throughEncoder = async (img: ImageData): Promise<ImageData | null> => {
      const enc = await encodeDeterministic({
        config: { ...CONTROL_ENCODE, width: img.width, height: img.height },
        frames: CONTROL_FRAMES,
        source: stillSource(img),
        paced: false,
      })
      if (!enc.blob) return null
      const back = await decodeByOrdinal(enc.blob, [CONTROL_ORDINAL], img.width, img.height)
      return back.frames[0] ?? null
    }
    await addStage(
      'C1-control-FLAT-PATCHES',
      'CONTROL: the same three colours as flat slabs, through one AVC 4:2:0 encode — nothing here for subsampling to damage',
      async () => {
        const got = await throughEncoder(flatRef)
        if (!got) return { skipped: 'MISSING — the control encode produced nothing', width: W, height: H }
        return { frame: got, width: W, height: H }
      },
      flatMask,
    )
    await addStage(
      'C2-control-TEXT-PAGE',
      'CONTROL: the SAME source page through the SAME encoder — the matched half of the pair, thin glyphs instead of slabs',
      async () => {
        const got = await throughEncoder(reference)
        if (!got) return { skipped: 'MISSING — the control encode produced nothing', width: W, height: H }
        return { frame: got, width: W, height: H }
      },
    )

    if (opts.crops) {
      crops.push({ label: 'c-00-SOURCE-canvas', png: await magnify(reference, GLYPH_CROP) })
      for (const lane of lanes) {
        const f = firstFrame.get(lane.id)
        if (f) crops.push({ label: `c-0${CROP_ORDER[lane.id]}-${lane.id}`, png: await magnify(f, GLYPH_CROP) })
      }
    }

    if (opts.thumbs) {
      for (const [id, f] of firstFrame) {
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

  gates['every pair row that was asked for was actually measured'] = {
    // R1 fix 5's other half: pairs used to disappear on `continue` and on a
    // thrown `at()`, and every gate below reads a missing row as "not measured"
    // — which is a comment, not a failure. This is the failure.
    pass: pairFailures.length === 0 && rows.length === 6,
    detail: pairFailures.length
      ? pairFailures.join(' · ')
      : `${rows.length} of 6 rows (3 pairs x 2 regions)${readerFailures.size ? ` · reader trouble: ${[...readerFailures].map(([k, v]) => `${k}: ${v}`).join('; ')}` : ''}`,
  }
  // B8 — WHAT THIS GATE IS ALLOWED TO FORGIVE, AND WHY IT IS TWO NUMBERS.
  //
  // The instant lane's file is the LIVE COMPOSITE: its frames are stamped when
  // a source frame arrived, so they sit on irregular instants. The render's are
  // on an exact 1/fps grid. Reading both at the same t therefore lands on
  // pictures up to one output frame apart, and the composite's own picture may
  // itself hold a camera frame that arrived up to one camera interval earlier.
  // That is arithmetic, not a defect, and it is BOUNDED — it cannot accumulate,
  // and it is not signed one way.
  //
  // So the two things worth banding are the two things quantisation cannot do:
  // a SYSTEMATIC displacement (the mean, i.e. the two paths disagree about when
  // the take began) and a WIDE SCATTER (the spread, i.e. they disagree about
  // how fast it runs). The old bar — one sample against |align| ≤ 1 — could see
  // neither, and flipped on the jitter it was accidentally measuring instead.
  //
  // THE BANDS ARE THE MEASURED FLOOR, NOT A ROUND NUMBER. Five 10 s takes on one
  // machine, 2026-09-01, instant ↔ render, over the LOCALISED instants: the two
  // takes whose composite offset was NOT clamped read mean -1.00 and -1.25
  // frames at spread 0 and 1; the three that were read -3, -6 and -6. The floor
  // is one frame and it is SIGNED, because both of its terms lag — the copied
  // file's frames sit on arrival instants and the render's on a 1/fps grid, and
  // the composite paints the latest camera frame it holds, which can be one
  // camera interval old. 2 frames is that floor with a frame of headroom, and
  // 3 frames of spread is the same headroom on a scatter measured at 0-2. A
  // DRIFT does not fit under either: it arrives in tens.
  //
  // IT IS DELIBERATELY THE LOOSER OF THE TWO GATES. The tight one is the CAUSE
  // gate below: a placement error this cannot separate from quantisation is
  // still named exactly, in ms, by the take's own clock arithmetic.
  const PLACEMENT_FRAMES = 2
  const SPREAD_FRAMES = 3
  const censusComplete =
    alignment.length === 3 &&
    alignment.every(
      (a) => a.frames.length === sampledAtSec.length && a.unlocalisedAtSec.length <= 1,
    )
  gates['the export paths PLACE the picture in the same spot (alignment, not quality)'] = {
    pass:
      censusComplete &&
      alignment.every(
        (a) =>
          Math.abs(a.meanFrames ?? Infinity) <= PLACEMENT_FRAMES &&
          (a.spreadFrames ?? Infinity) <= SPREAD_FRAMES,
      ),
    detail: alignment.length
      ? `${alignment
          .map(
            (a) =>
              `${a.pair}: mean ${a.meanFrames} frames, spread ${a.spreadFrames} [${a.frames.join(', ')}] at ${a.atSec.join('/')}s (${a.db.join('/')} dB)${a.unlocalisedAtSec.length ? ` — NOT LOCALISED at ${a.unlocalisedAtSec.join('/')}s, excluded` : ''}`,
          )
          .join(' · ')}${censusComplete ? '' : ` — CENSUS INCOMPLETE: ${alignment.length} of 3 pairs, and a pair the search could not localise is not a pair that agreed`}`
      : 'NOT MEASURED — no pair could be localised at any instant',
  }
  // B8 — THE CAUSE, GATED SEPARATELY FROM THE SYMPTOM. The gate above says the
  // two files disagree; this one says whether the take's own arithmetic already
  // predicted it, and a placement finding that this gate does NOT explain is a
  // different defect wearing the same number.
  gates['the composite is placed where its clock actually starts (nothing clamped away)'] = {
    pass:
      clocks.clampedAwayMs !== null &&
      Math.abs(clocks.clampedAwayMs) <= 1 &&
      clocks.predictedAlignFrames !== null,
    detail:
      clocks.trueCompositeOffsetMs === null
        ? 'NOT MEASURED — the capture log did not carry the composite origin or the B7 anchors, so nothing here was checked'
        : `composite clock starts +${clocks.compositeOriginMs} ms · earliest channel +${clocks.minChannelAnchorMs} ms → true offset ${clocks.trueCompositeOffsetMs} ms, take carries ${clocks.declaredCompositeOffsetMs} ms (${clocks.clampedAwayMs} ms discarded by the Math.max(0, …) clamp in session.ts) → predicts ${clocks.predictedAlignFrames} frames; measured ${alignment.find((a) => a.pair === 'instant ↔ render')?.meanFrames ?? 'n/a'}. THE FILE ITSELF, independent of the log: composite audio starts ${clocks.compositeAudioStartsMs} ms, video ${clocks.compositeVideoStartsMs} ms — a lead of ${clocks.compositeAudioStartsMs !== null && clocks.compositeVideoStartsMs !== null ? Math.round((clocks.compositeVideoStartsMs - clocks.compositeAudioStartsMs) * 10) / 10 : 'n/a'} ms with no picture in it`,
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

  // ---- the chroma gates ------------------------------------------------
  // ONE DEFINITION OF MISSING, SHARED BY BOTH (R1 fixes 1 and 4). They used to
  // disagree: one read `null` as a total colour loss and was born red, the
  // other read `null` as "fine" and passed on it. A stage that was skipped, a
  // frame that never decoded and a mask with no pixels in it are all the same
  // thing — NOTHING WAS MEASURED — and none of them is a score.
  const stageOf = (stage: string): ChromaStage | undefined => chroma.find((c) => c.stage === stage)
  const rowOf = (stage: string, key: GlyphColourKey): ChromaRow | null => {
    const st = stageOf(stage)
    if (!st || st.status !== 'ok') return null
    // BY KEY, NEVER BY LABEL (R1 fix 1). The old lookup was
    // `rows.find(r => r.colour.startsWith('green'))` against a display string
    // that carries padding and a hex code — rename the label and every chroma
    // gate silently starts reading `null`, i.e. passes or fails for free.
    return st.rows.find((r) => r.key === key) ?? null
  }
  const kept = (stage: string, key: GlyphColourKey): number | null => {
    const r = rowOf(stage, key)
    return r && r.status === 'ok' ? r.keptPct : null
  }
  const deltaPts = (stage: string, key: GlyphColourKey): number | null => {
    const r = rowOf(stage, key)
    return r && r.status === 'ok' ? r.saturationDeltaPts : null
  }
  /** Why a stage cannot be scored, in words — '' when it can. */
  const missingOf = (stage: string): string => {
    const st = stageOf(stage)
    if (!st) return `${stage}: MISSING — the stage never ran`
    if (st.status !== 'ok') return `${stage}: ${st.skipped ?? 'MISSING'}`
    const empty = st.rows.filter((r) => r.status === 'MASK EMPTY').map((r) => r.key)
    if (empty.length === st.rows.length) {
      return `${stage}: MASK EMPTY — the source mask matched no pixels at all, so nothing was measured (a palette drift does this)`
    }
    if (empty.length) return `${stage}: MASK EMPTY on ${empty.join('/')}`
    return ''
  }
  const missing = (...stages: string[]): string =>
    stages.map(missingOf).filter(Boolean).join(' · ')

  /** The rows the chroma question is actually about; grey is the control. */
  const COLOURED = ['green', 'blue'] as const satisfies readonly GlyphColourKey[]
  const table = chroma
    .map((c) =>
      c.status !== 'ok'
        ? `${c.stage} ${c.skipped ?? 'SKIPPED'}`
        : `${c.stage} ${c.rows
            .map((r) =>
              r.status === 'ok'
                ? `${r.key} ${r.keptPct}% (${r.saturationDeltaPts! >= 0 ? '+' : ''}${r.saturationDeltaPts} pts)`
                : `${r.key} MASK EMPTY`,
            )
            .join(' / ')}`,
    )
    .join(' · ')

  const instMissing = missing('3-export-instant')
  gates['CHROMA: the shipped chain keeps as much colour as the committed baseline'] = {
    // R1 fix 4. THIS GATE WAS BORN RED: it asked for >= 90 % against a chain
    // that measures 70.3 %, so it could only ever fail — including after O3b,
    // whose whole prize is 80 %. A gate that cannot pass is not a gate, it is a
    // permanent alarm, and this codebase has already paid for one of those.
    // The 30 % loss is the STANDING FINDING (BACKLOG P1), not a regression; it
    // is stated in the detail and it is Robert's to spend CPU on. What a gate can
    // usefully do is notice the day it gets WORSE — so the bar is the committed
    // baseline minus the rig's own stated run-to-run variance, and it moves up
    // the day O3b lands.
    pass:
      !instMissing &&
      COLOURED.every((k) => (kept('3-export-instant', k) ?? -1) >= CHROMA_BASELINE[k] - CHROMA_EPS),
    detail: instMissing
      ? `NOT MEASURED — ${instMissing}. A missing measurement is a FAILED gate here, never a quiet pass.`
      : `instant keeps green ${kept('3-export-instant', 'green')} % / blue ${kept('3-export-instant', 'blue')} % of the source's saturation, against the committed baseline green ${CHROMA_BASELINE.green} / blue ${CHROMA_BASELINE.blue} (±${CHROMA_EPS} pts run variance).` +
        ` THE ~30 % LOSS ITSELF IS THE FINDING, not a regression — BACKLOG P1, and O3b is the free third of it. Full chain: ${table}`,
  }

  const fastMissing = missing('3-export-instant', '3-export-render')
  const margins = COLOURED.map((k) => {
    const i = kept('3-export-instant', k)
    const r = kept('3-export-render', k)
    return i === null || r === null ? null : Math.round((i - r) * 10) / 10
  })
  const worstMargin = margins.some((m) => m === null)
    ? null
    : Math.min(...(margins as number[]))
  gates['CHROMA: the UNEDITED fast path is not the worst-coloured file we make'] = {
    // R1 fixes 1 and 6. It used to pass whenever EITHER side was null — the
    // exact case where nobody knows — and to compare green alone at a 1 pt
    // margin, which is tighter than the ~2 pt run variance the rig itself
    // states. Green alone also flatters the answer: the render wins blue and
    // loses green, so a single-colour test reads whichever colour it picked.
    pass: !fastMissing && worstMargin !== null && worstMargin >= -CHROMA_EPS,
    detail: fastMissing
      ? `NOT MEASURED — ${fastMissing}. A missing measurement is a FAILED gate here, never a quiet pass.`
      : `worst of the coloured rows: instant − render = ${worstMargin} pts (${COLOURED.map((k, i) => `${k} ${margins[i]}`).join(', ')}), tolerance ${CHROMA_EPS} pts.` +
        ` Kept: source 100 % · raw screen ${kept('1-raw-screen-channel', 'green') ?? 'n/a'} % · composite ${kept('2-composite', 'green') ?? 'n/a'} % · instant ${kept('3-export-instant', 'green') ?? 'n/a'} % · render ${kept('3-export-render', 'green') ?? 'n/a'} % (green).` +
        (worstMargin !== null && worstMargin < -CHROMA_EPS
          ? ' THE FAST PATH IS WORSE ON AT LEAST ONE COLOUR, and it is the default for every untouched take.' +
            ' THIS IS THE STANDING X15(d) FINDING, NOT A NEW REGRESSION: the render wins blue and loses green, so it is a' +
            ' wash and there is no free colour in choosing the slower path. The gate reads the worst colour rather than' +
            ' the flattering one, and it goes green when O3b lands — a single-screen take that packet-copies the raw' +
            ' channel beats the render on every row.'
          : ''),
  }

  const ctrlMissing = missing('C1-control-FLAT-PATCHES', 'C2-control-TEXT-PAGE')
  const flatWorst = COLOURED.map((k) => kept('C1-control-FLAT-PATCHES', k))
  const textWorst = COLOURED.map((k) => kept('C2-control-TEXT-PAGE', k))
  gates['CHROMA CONTROL: the loss is 4:2:0 on thin glyphs, not a matrix/range drift'] = {
    // R1 fix 8. Chroma subsampling and a YUV matrix or range round-trip error
    // leave the SAME fingerprint on this fixture — saturated glyphs fade, grey
    // holds — so every stage above is consistent with either, and the case for
    // 4:4:4 rests entirely on it being the first. Flat slabs of the identical
    // colours through the identical encoder separate them: subsampling has no
    // detail to average away there, a matrix error does not care.
    pass:
      !ctrlMissing &&
      flatWorst.every((v) => v !== null && v >= FLAT_CONTROL_KEPT) &&
      textWorst.every((v) => v !== null && v < FLAT_CONTROL_KEPT),
    detail: ctrlMissing
      ? `NOT MEASURED — ${ctrlMissing}.`
      : `flat slabs keep ${COLOURED.map((k, i) => `${k} ${flatWorst[i]} %`).join(' / ')} (bar ${FLAT_CONTROL_KEPT} %) while the SAME page's thin glyphs through the SAME encoder keep ${COLOURED.map((k, i) => `${k} ${textWorst[i]} %`).join(' / ')}.` +
        (flatWorst.some((v) => v !== null && v < FLAT_CONTROL_KEPT)
          ? ' THE SLABS LOSE COLOUR TOO — the loss is not (only) subsampling, and 4:4:4 will under-deliver against what BACKLOG P1 promises.'
          : ' Subsampling on thin glyphs is the mechanism, as claimed.'),
  }

  const greyMissing = missing('3-export-instant')
  const greyDelta = deltaPts('3-export-instant', 'grey')
  const colouredDeltas = COLOURED.map((k) => deltaPts('3-export-instant', k))
  gates['CHROMA: grey barely moves — the “not brightness or gamma” argument, unamplified'] = {
    // R1 fix 9. That argument used to be made with grey's keptPct, which
    // divides by a SOURCE SATURATION OF 7.4 % — so ±1 LSB of decode noise
    // arrives as ±6 points and the headline number is mostly amplifier. In
    // absolute saturation points the claim is the same and the noise is not:
    // grey moves a couple of points, the coloured rows move an order more.
    pass:
      !greyMissing &&
      greyDelta !== null &&
      colouredDeltas.every((d) => d !== null) &&
      Math.abs(greyDelta) < 0.5 * Math.min(...colouredDeltas.map((d) => Math.abs(d!))),
    detail: greyMissing
      ? `NOT MEASURED — ${greyMissing}.`
      : `grey moves ${greyDelta} saturation points (from a source saturation of ${rowOf('3-export-instant', 'grey')?.sourceSaturationPct} %) against ${COLOURED.map((k, i) => `${k} ${colouredDeltas[i]}`).join(' / ')} points. As a RATIO grey reads ${kept('3-export-instant', 'grey')} % kept, which is the 7.4 % denominator talking, not the picture.`,
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
  notes.push(
    'the chroma reference is rasterized through capture/synthetic.ts\'s OWN context factory (R1 fix 3): it used to be built on an {alpha:false} canvas while the wire paints on the alpha:true default, and an opaque canvas is eligible for different text antialiasing — a reference that could disagree with the wire about every glyph edge before anything encoded it',
  )
  notes.push(
    'grey is reported as an ABSOLUTE saturation delta as well as a ratio (R1 fix 9): its source saturation is 7.4 %, so the ratio multiplies +-1 LSB of decode noise into +-6 points',
  )
  notes.push(
    'C1/C2 are the matched control pair (R1 fix 8): the same palette as flat slabs and as thin glyphs, through ONE standalone AVC 4:2:0 encode. Subsampling can only damage the second; a YUV matrix or range drift would damage both, and until this ran the two were indistinguishable on this fixture',
  )
  notes.push(
    'the rig can be pointed at its own blind spots: {"drill":"dead-composite-blob"} | "dead-instant-export" | "palette-drift" — a missing stage must read MISSING and a drifted palette must read MASK EMPTY, never a score',
  )
  if (drill) {
    notes.push(
      `THIS RUN IS A DRILL (${drill}) AND ITS NUMBERS ARE DELIBERATELY WRONG. It is checking that the instrument says so out loud; do not quote anything from it.`,
    )
  }

  return {
    drill,
    notes,
    takeMs,
    engine,
    compositeBytes,
    sampledAtSec,
    lanes,
    rows,
    alignment,
    clocks,
    encodeFloor,
    chroma,
    thumbs,
    crops,
    gates,
    verdict: drill
      ? `DRILL RUN (${drill}) — this is the rig testing itself, not a measurement. Read the gates: they must name what is missing rather than score it.`
      : verdictOf(instRender, instSmart, rows),
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
