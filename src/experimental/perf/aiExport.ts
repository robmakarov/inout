/**
 * EXPERIMENTAL — AI1 evidence: the export for AI, measured (task AI1).
 *
 * The unit tests prove the selection rules on synthetic luma grids. This proves
 * them on REAL takes: canvases recorded through MediaRecorder exactly as a
 * screen channel is captured, decoded by the production reader, composed by the
 * production layout, and run through the production builder — so codec noise,
 * frame timing and the composite geometry are all in the loop.
 *
 * It answers the gates in the order they were written:
 *   economy      a mostly-static minute costs ≤8 pages, an idle span costs 0,
 *                a motion burst concentrates its pages inside itself
 *   cursor       PO's hard case: a cursor wandering a still screen is ≤1 page
 *                after the first, a caret is 0, a tooltip is exactly 1 + crop
 *   trail        precision of the pointer detector against the path the rig
 *                actually drew — the number that decides whether it ships
 *   clock        the picture on page N IS the frame its caption claims, read
 *                back out of the PDF by decoding the rig's own fiducial strip
 *   edit         a cut take: no page from the cut span, times remapped
 *   cost         build wall clock against the same take's full render
 *
 * The clock and edit gates read the file BACK — JPEGs scanned out of the PDF
 * bytes, decoded, and the timecode read off the picture — because the only
 * claim worth gating is what a reader will find in the file, not what the
 * builder believed while writing it.
 */
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'
import {
  exportForAi,
  getLastAiExportStats,
  setAiWorkerEnabled,
  POINTER_TRAIL_ENABLED,
  SAMPLE_FPS,
} from '@core/ai'
import { exportRecording } from '@core/compose'
import { newId } from '@core/id'
import { blobStore } from '@core/store'
import { openVideoChannel } from '@core/compose/video'
import { channelSourceTimeAt, clampEditState, defaultEditState } from '@core/timeline'
import type { ChannelRecording, EditState, Recording } from '@core/types'
import { LongTaskWatch, SchedulingDelayWatch } from './mainThreadWatch'
import { decodeBits, FID_BLOCK, FID_BLOCK_COUNT, FID_MARGIN } from '../oracle/fiducial'
import { recordFiducialSession, RIG_HEIGHT, RIG_WIDTH } from '../oracle/rig'

const RAW_MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
const W = 1280
const H = 720
/** Cursor drawn at the size a real one occupies on a 720p frame. */
const CURSOR_PX = 16
const TOOLTIP_W = 200
const TOOLTIP_H = 54

interface Painter {
  (g: CanvasRenderingContext2D, tMs: number): void
}

/** The still page everything is painted over — a plausible screen, not noise. */
function paintPage(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#0d1117'
  g.fillRect(0, 0, W, H)
  g.fillStyle = '#161b22'
  g.fillRect(0, 0, W, 48)
  g.font = '16px monospace'
  g.textBaseline = 'top'
  for (let row = 0; row < 24; row++) {
    g.fillStyle = row % 5 === 0 ? '#7ee787' : row % 3 === 0 ? '#79c0ff' : '#c9d1d9'
    g.fillText(`  const sample${row} = compute(${row}, 'channel-${row % 7}')`, 40, 70 + row * 26)
  }
}

function paintCursor(g: CanvasRenderingContext2D, xFrac: number, yFrac: number): void {
  g.fillStyle = '#ffffff'
  g.beginPath()
  const x = xFrac * W
  const y = yFrac * H
  g.moveTo(x, y)
  g.lineTo(x, y + CURSOR_PX)
  g.lineTo(x + CURSOR_PX * 0.45, y + CURSOR_PX * 0.72)
  g.lineTo(x + CURSOR_PX * 0.72, y + CURSOR_PX * 0.72)
  g.closePath()
  g.fill()
}

/** Where the rig's cursor is at a given instant — the truth the trail is scored against. */
export function cursorPathAt(tMs: number): { xFrac: number; yFrac: number } {
  const t = tMs / 1000
  return {
    xFrac: 0.5 + 0.33 * Math.sin(t * 0.9),
    yFrac: 0.5 + 0.3 * Math.sin(t * 0.55 + 1),
  }
}

const PAINTERS: Record<string, Painter> = {
  // A cursor, and nothing else, over a page that never changes.
  cursor: (g, tMs) => {
    paintPage(g)
    const p = cursorPathAt(tMs)
    paintCursor(g, p.xFrac, p.yFrac)
  },
  // A text caret blinking in one place at 1.5 Hz.
  caret: (g, tMs) => {
    paintPage(g)
    if (Math.floor(tMs / 350) % 2 === 0) {
      g.fillStyle = '#e6edf3'
      g.fillRect(W * 0.42, H * 0.5, 3, 22)
    }
  },
  // The cursor arrives, stops, and a tooltip appears under it at 4 s and stays.
  tooltip: (g, tMs) => {
    paintPage(g)
    const settleMs = 3000
    const p = cursorPathAt(Math.min(tMs, settleMs))
    paintCursor(g, p.xFrac, p.yFrac)
    if (tMs >= 4000) {
      const x = p.xFrac * W + 12
      const y = p.yFrac * H + 14
      g.fillStyle = '#f0f6fc'
      g.fillRect(x, y, TOOLTIP_W, TOOLTIP_H)
      g.fillStyle = '#0d1117'
      g.font = '14px system-ui'
      g.fillText('Commit and push to origin', x + 10, y + 12)
      g.fillText('Shortcut: cmd+enter', x + 10, y + 32)
    }
  },
  // Still, then a burst of full-frame motion, then still again.
  burst: (g, tMs) => {
    paintPage(g)
    if (tMs < 20_000 || tMs >= 25_000) return
    const phase = (tMs - 20_000) / 5000
    const grad = g.createLinearGradient(0, 0, W, H)
    grad.addColorStop(0, `hsl(${Math.round(phase * 720) % 360} 80% 45%)`)
    grad.addColorStop(1, `hsl(${(Math.round(phase * 720) + 120) % 360} 80% 25%)`)
    g.fillStyle = grad
    g.fillRect(0, 0, W, H)
    g.fillStyle = '#ffffff'
    g.fillRect((phase * W * 3) % W, H * 0.4, 220, 140)
  },
}

/** Record a painted canvas the way production records a raw screen channel. */
async function recordPainted(
  painter: Painter,
  takeMs: number,
): Promise<{ channel: ChannelRecording; blobKey: string }> {
  const mime = RAW_MIMES.find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) throw new Error('no supported raw recorder mime')
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext('2d')!
  const stream = canvas.captureStream(30)
  const blobKey = `exp-ai-${newId('src')}.webm`
  const writer = (await blobStore.createWriteStream(blobKey)).getWriter()
  let chain = Promise.resolve()
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return
    chain = chain.then(() => writer.write(e.data).catch(() => undefined))
  }
  const t0 = performance.now()
  let raf = 0
  const loop = (): void => {
    painter(g, performance.now() - t0)
    raf = requestAnimationFrame(loop)
  }
  painter(g, 0)
  recorder.start(1000)
  loop()
  await new Promise((r) => setTimeout(r, takeMs))
  cancelAnimationFrame(raf)
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    recorder.requestData()
    recorder.stop()
  })
  await chain
  await writer.close().catch(() => undefined)
  for (const t of stream.getTracks()) t.stop()
  return {
    blobKey,
    channel: {
      id: newId('ch'),
      kind: 'screen',
      media: 'video',
      mimeType: mime,
      blobKey,
      startOffsetMs: 0,
      durationMs: takeMs,
      width: W,
      height: H,
    },
  }
}

function recordingOf(channel: ChannelRecording, takeMs: number): Recording {
  return { id: newId('rec'), createdAt: Date.now(), durationMs: takeMs, channels: [channel] }
}

export interface ScenarioResult {
  scenario: string
  takeMs: number
  samples: number
  keyframes: number
  pages: number
  bytes: number
  approxTokens: number
  perPageTokens: number[]
  keyframeAtMs: number[]
  cropped: number
  classes: Record<string, number>
  /** Pages that are frames of something moving — what "recreate the animation" needs. */
  burstPages: number
  budget: number
  finalPaceMs: number
  buildMs: number
  /** Longest stretch of the take with no page at all — the idle claim. */
  longestGapMs: number
}

async function runScenario(scenario: string, takeMs: number): Promise<ScenarioResult> {
  const painter = PAINTERS[scenario]
  if (!painter) throw new Error(`unknown scenario ${scenario}`)
  const { channel, blobKey } = await recordPainted(painter, takeMs)
  const recording = recordingOf(channel, takeMs)
  const edit = clampEditState(recording, defaultEditState(recording))
  try {
    const t0 = performance.now()
    const result = await exportForAi({ recording, edit })
    const buildMs = performance.now() - t0
    const stats = getLastAiExportStats()!
    const times = stats.keyframeAtOutMs
    let longestGap = times.length ? takeMs - times[times.length - 1]! : takeMs
    for (let i = 1; i < times.length; i++) {
      longestGap = Math.max(longestGap, times[i]! - times[i - 1]!)
    }
    return {
      scenario,
      takeMs,
      samples: stats.samples,
      keyframes: stats.keyframes,
      pages: stats.pages,
      bytes: result.blob.size,
      approxTokens: stats.approxTokens,
      perPageTokens: stats.perPageTokens,
      keyframeAtMs: times.map((t) => Math.round(t)),
      cropped: stats.keyframeHasCrop.filter(Boolean).length,
      classes: stats.classes,
      burstPages: stats.burstPages,
      budget: stats.budget,
      finalPaceMs: stats.finalPaceMs,
      buildMs: Math.round(buildMs),
      longestGapMs: Math.round(longestGap),
    }
  } finally {
    await blobStore.remove(blobKey).catch(() => undefined)
  }
}

/** Pointer readings against the path the rig actually drew. */
async function measureTrail(takeMs: number): Promise<{
  readings: number
  confident: number
  withinFrame5Pct: number
  precisionPct: number
  medianErrorFrac: number
  shipped: boolean
}> {
  const { channel, blobKey } = await recordPainted(PAINTERS.cursor!, takeMs)
  const recording = recordingOf(channel, takeMs)
  const edit = clampEditState(recording, defaultEditState(recording))
  try {
    await exportForAi({ recording, edit })
    const stats = getLastAiExportStats()!
    const confident = stats.pointerReadings.filter((p) => p.confident)
    const errors = confident.map((p) => {
      const truth = cursorPathAt(p.atOutMs)
      // The cursor is drawn from its tip; the diff sees its whole body.
      return Math.hypot(p.xFrac - truth.xFrac, p.yFrac - truth.yFrac)
    })
    const within = errors.filter((e) => e <= 0.05).length
    const sorted = [...errors].sort((a, b) => a - b)
    return {
      readings: stats.pointerReadings.length,
      confident: confident.length,
      withinFrame5Pct: within,
      precisionPct: errors.length ? Math.round((1000 * within) / errors.length) / 10 : 0,
      medianErrorFrac: sorted.length ? Math.round(sorted[sorted.length >> 1]! * 1000) / 1000 : 0,
      shipped: POINTER_TRAIL_ENABLED,
    }
  } finally {
    await blobStore.remove(blobKey).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Reading the file back: JPEGs out of the PDF, timecode off the picture.
// ---------------------------------------------------------------------------

/** Every JPEG stream in the file, in page order. FF D8 … FF D9 is unambiguous. */
export function extractJpegs(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xd8 || bytes[i + 2] !== 0xff) continue
    for (let j = i + 2; j + 1 < bytes.length; j++) {
      if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
        out.push(bytes.subarray(i, j + 2))
        i = j + 1
        break
      }
    }
  }
  return out
}

/**
 * Read the oracle rig's timecode strip off a keyframe image.
 *
 * The strip is painted into every rig frame at a known place in RIG pixels; the
 * export composed it into a 1920×1080 frame and then scaled the page image
 * down, so the block grid is scaled by (imageWidth / RIG_WIDTH) — the rig is
 * 16:9 like the output, so there is no letterbox to correct for.
 */
function readStrip(g: CanvasRenderingContext2D, imageWidth: number): number | null {
  const scale = imageWidth / RIG_WIDTH
  const block = FID_BLOCK * scale
  const margin = FID_MARGIN * scale
  const read = (i: number): number => {
    const x = Math.round(margin + i * block + block * 0.3)
    const y = Math.round(margin + block * 0.3)
    const w = Math.max(1, Math.round(block * 0.4))
    const d = g.getImageData(x, y, w, w).data
    let sum = 0
    for (let p = 0; p < d.length; p += 4) sum += (d[p]! + d[p + 1]! + d[p + 2]!) / 3
    return sum / (d.length / 4)
  }
  const levels: number[] = []
  for (let i = 0; i < FID_BLOCK_COUNT; i++) levels.push(read(i))
  return decodeBits({ luma: (i: number) => levels[i]! })
}

async function readFiducial(jpeg: Uint8Array): Promise<number | null> {
  const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }))
  // Read the size BEFORE closing: a closed ImageBitmap reports 0×0, which
  // silently scales every block coordinate to the same pixel (note 10 — the
  // instrument was wrong before the product was, again).
  const imageWidth = bitmap.width
  const canvas = document.createElement('canvas')
  canvas.width = imageWidth
  canvas.height = bitmap.height
  const g = canvas.getContext('2d', { willReadFrequently: true })!
  g.drawImage(bitmap, 0, 0)
  bitmap.close()
  return readStrip(g, imageWidth)
}

/**
 * The same timecode, read straight off the CHANNEL at the same instants.
 *
 * This is the control for the clock gate. "The caption is 755 ms away from the
 * picture" could be the export mis-stating time OR the recording's own epoch
 * mapping; only decoding the source at the same output instants tells them
 * apart. It also catches the take's FIRST frame, which on a canvas capture
 * holds whatever was painted before the recorder started — an artifact every
 * export path inherits, and one worth naming rather than averaging away.
 */
async function probeChannelFiducials(
  recording: Recording,
  edit: EditState,
  atOutMs: number[],
): Promise<(number | null)[]> {
  const channel = recording.channels.find((c) => c.media === 'video')
  if (!channel) return atOutMs.map(() => null)
  const blob = await blobStore.read(channel.blobKey)
  const reader = await openVideoChannel(blob, channel.id, channel.kind, channel.durationMs / 1000)
  if (!reader) return atOutMs.map(() => null)
  const canvas = document.createElement('canvas')
  canvas.width = channel.width ?? RIG_WIDTH
  canvas.height = channel.height ?? RIG_HEIGHT
  const g = canvas.getContext('2d', { willReadFrequently: true })!
  const out: (number | null)[] = []
  try {
    for (const outMs of atOutMs) {
      const localMs = channelSourceTimeAt(recording, edit, channel.id, outMs)
      if (localMs === null) {
        out.push(null)
        continue
      }
      const sample = await reader.sampleAt(localMs / 1000)
      if (!sample) {
        out.push(null)
        continue
      }
      sample.draw(g, 0, 0, canvas.width, canvas.height)
      out.push(readStrip(g, canvas.width))
    }
  } finally {
    reader.dispose()
  }
  return out
}

/**
 * Run a REAL FILE through the builder — the PO's own take, dropped into
 * public/ and fetched over the dev server.
 *
 * The synthetic scenarios prove the rules; they cannot prove the CALIBRATION,
 * and the calibration is what PO's first real export got wrong ("it loses way
 * too much frames"). A real 97 s UI walkthrough answers what no painted canvas
 * can: how many pages a genuine session earns, where they land, and whether the
 * moments that matter — a field being typed into, a button turning active, a
 * tab switching — survive.
 *
 * The file is never committed (.gitignore: public/__*) and nothing here writes
 * it anywhere but OPFS, which the throwaway profile discards.
 */
export interface RealFileResult {
  url: string
  durationMs: number
  width: number
  height: number
  samples: number
  keyframes: number
  pages: number
  burstPages: number
  budget: number
  finalPaceMs: number
  approxTokens: number
  bytes: number
  buildMs: number
  keyframeAtMs: number[]
  /** Spacing between consecutive pages, ms — the "does it lose things" number. */
  gapsMs: { max: number; median: number; over3s: number }
  cropped: number
  classes: Record<string, number>
  /** The built file, when asked for — this is what PO uploads to an AI. */
  pdfBase64?: string
}

async function runRealFile(url: string, includePdf = false): Promise<RealFileResult> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`real file ${url}: HTTP ${res.status}`)
  const blob = await res.blob()
  const blobKey = `exp-ai-real-${newId('src')}.mp4`
  const writer = (await blobStore.createWriteStream(blobKey)).getWriter()
  await writer.write(blob)
  await writer.close()
  try {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    let durationMs = 0
    let width = 0
    let height = 0
    try {
      durationMs = Math.round((await input.computeDuration()) * 1000)
      const track = await input.getPrimaryVideoTrack()
      width = track?.displayWidth ?? 0
      height = track?.displayHeight ?? 0
    } finally {
      input.dispose()
    }
    const channel: ChannelRecording = {
      id: newId('ch'),
      kind: 'screen',
      media: 'video',
      mimeType: blob.type || 'video/mp4',
      blobKey,
      startOffsetMs: 0,
      durationMs,
      width,
      height,
    }
    const recording = recordingOf(channel, durationMs)
    const edit = clampEditState(recording, defaultEditState(recording))
    const t0 = performance.now()
    const result = await exportForAi({ recording, edit })
    const buildMs = performance.now() - t0
    const stats = getLastAiExportStats()!
    const times = stats.keyframeAtOutMs
    const gaps: number[] = []
    for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!)
    const sorted = [...gaps].sort((a, b) => a - b)
    return {
      url,
      durationMs,
      width,
      height,
      samples: stats.samples,
      keyframes: stats.keyframes,
      pages: stats.pages,
      burstPages: stats.burstPages,
      budget: stats.budget,
      finalPaceMs: stats.finalPaceMs,
      approxTokens: stats.approxTokens,
      bytes: result.blob.size,
      buildMs: Math.round(buildMs),
      keyframeAtMs: times.map((t) => Math.round(t)),
      gapsMs: {
        max: Math.round(Math.max(0, ...gaps)),
        median: sorted.length ? Math.round(sorted[sorted.length >> 1]!) : 0,
        over3s: gaps.filter((g) => g > 3000).length,
      },
      cropped: stats.keyframeHasCrop.filter(Boolean).length,
      classes: stats.classes,
      ...(includePdf ? { pdfBase64: base64(new Uint8Array(await result.blob.arrayBuffer())) } : {}),
    }
  } finally {
    await blobStore.remove(blobKey).catch(() => undefined)
  }
}

export interface AiExportReport {
  notes: string[]
  scenarios: ScenarioResult[]
  /** Present when a real recording was run through the builder. */
  real?: RealFileResult
  trail: Awaited<ReturnType<typeof measureTrail>>
  clock: {
    keyframes: number
    decodedFiducials: number
    /** Caption time minus picture time, per keyframe (ms). */
    offsetsMs: number[]
    medianOffsetMs: number | null
    /**
     * Spread around the median — the only part of the offset AI1 owns. The
     * constant itself is the recording's own epoch mapping, and the control
     * below proves it belongs to the channel and not to this export.
     */
    maxDeviationMs: number | null
    /** The same instants decoded straight off the channel — the control. */
    channelOffsetsMs: (number | null)[]
    /** Pages whose picture is NOT the frame the channel holds at that instant. */
    pagesDisagreeingWithChannel: number
    /** Pages excluded from the spread, with why. */
    excluded: string[]
  }
  edit: {
    cutSpanMs: [number, number]
    keyframeRecMs: number[]
    /** Pages whose PICTURE was taken from inside the cut span. */
    fromCutSpan: number
    /** Output length before and after the cut. */
    beforeMs: number
    afterMs: number
  }
  cost: {
    takeMs: number
    aiBuildMs: number
    renderMs: number
    ratio: number
    aiBytes: number
    renderBytes: number
    aiTokens: number
    /** What the same take would cost an agent as frames of video, for scale. */
    videoFrameTokens: number
  }
  /** X9: the same take built in the worker and in-thread, both orders. */
  threads: ThreadLane[]
  gates: Record<string, { pass: boolean; detail: string }>
  pdfBase64?: string
}

/**
 * X9 — the same take built on BOTH threads.
 *
 * Two questions, and the second is the whole point of the task: is the file the
 * same (a worker must not be a second implementation), and does the UI thread
 * keep working while it is built.
 *
 * THE FIRST INSTRUMENT FOR THE SECOND QUESTION WAS WRONG, and it read GREEN —
 * note 10's shape exactly. It counted `longtask` PerformanceObserver entries,
 * on the reasoning that a long task IS "the main thread was busy ≥50 ms". It
 * read ZERO on both threads, which would have said the in-thread build never
 * janked at all. It does: the build awaits a decode every sample (8/s), so its
 * work arrives as hundreds of 5-15 ms tasks that never trip the 50 ms rule
 * while still occupying the thread end to end. A user does not experience "one
 * task over 50 ms", they experience a UI callback that does not get to run.
 *
 * So the instrument is SCHEDULING LATENESS — a 16 ms ticker on the main thread
 * and how much of its time it does not get. The O5 rig had already learned this
 * and written it down; X9 reached for the long-task counter anyway, which is
 * why the instrument is now a shared file (perf/mainThreadWatch.ts) instead of
 * a lesson living inside one rig. The long-task count is still reported next to
 * it, unGATED, because it is free and because it is the number that lied.
 */
export interface ThreadLane {
  where: 'worker' | 'in-thread'
  order: number
  wallMs: number
  bytes: number
  sha256: string
  /** Main-thread tasks ≥50 ms observed while this build ran (diagnostic). */
  longTasks: number
  longTaskMs: number
  /** Heartbeat ticks the UI thread got, and how much wall clock it lost. */
  ticks: number
  blockedMs: number
  worstGapMs: number
  /** Share of the build's wall clock in which the UI thread was unavailable. */
  blockedPct: number
  pages: number
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function buildOnThread(
  where: 'worker' | 'in-thread',
  order: number,
  recording: Recording,
  edit: EditState,
): Promise<ThreadLane> {
  const longWatch = new LongTaskWatch()
  const delayWatch = new SchedulingDelayWatch()
  setAiWorkerEnabled(where === 'worker')
  // A settle tick first, so a stall from the PREVIOUS lane cannot be
  // attributed to this one — note 10, the rig is wrong before the product is.
  await new Promise((r) => setTimeout(r, 250))
  longWatch.start()
  delayWatch.start()
  try {
    const t0 = performance.now()
    const result = await exportForAi({ recording, edit })
    const wallMs = performance.now() - t0
    const pulse = delayWatch.stop()
    const tasks = longWatch.stop()
    const stats = getLastAiExportStats()
    return {
      where,
      order,
      wallMs: Math.round(wallMs),
      bytes: result.blob.size,
      sha256: await sha256(result.blob),
      longTasks: tasks.count,
      longTaskMs: tasks.totalMs,
      ticks: pulse.ticks,
      blockedMs: pulse.totalLateMs,
      worstGapMs: pulse.maxLateMs,
      blockedPct: Math.round((pulse.totalLateMs / Math.max(1, wallMs)) * 1000) / 10,
      pages: stats?.pages ?? 0,
    }
  } finally {
    delayWatch.stop()
    longWatch.stop()
    setAiWorkerEnabled(true)
  }
}

/** Both threads, in BOTH orders — note 10(a): the first lane pays the cold start. */
async function measureThreads(recording: Recording, edit: EditState): Promise<ThreadLane[]> {
  const lanes: ThreadLane[] = []
  lanes.push(await buildOnThread('worker', 1, recording, edit))
  lanes.push(await buildOnThread('in-thread', 2, recording, edit))
  lanes.push(await buildOnThread('in-thread', 3, recording, edit))
  lanes.push(await buildOnThread('worker', 4, recording, edit))
  return lanes
}

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export async function runAiExport(
  opts: {
    economySec?: number
    shortSec?: number
    fiducialSec?: number
    includePdf?: boolean
    /** A real recording served from public/ — the calibration case. */
    realFile?: string
    /** Skip the synthetic scenarios and only run the real file. */
    realOnly?: boolean
  } = {},
): Promise<AiExportReport> {
  if (opts.realOnly) {
    const real = await runRealFile(opts.realFile ?? '/__po-take.mp4', opts.includePdf)
    return {
      notes: [
        `real file only: ${real.url}`,
        `${real.keyframes} frames over ${(real.durationMs / 1000).toFixed(1)}s — median gap ${real.gapsMs.median}ms, worst ${real.gapsMs.max}ms, ${real.gapsMs.over3s} gaps over 3s`,
        `${real.burstPages} pages are frames of motion; ~${real.approxTokens} tokens, ${(real.bytes / 1024 / 1024).toFixed(1)} MB, built in ${real.buildMs}ms`,
      ],
      scenarios: [],
      real,
      trail: {
        readings: 0,
        confident: 0,
        withinFrame5Pct: 0,
        precisionPct: 0,
        medianErrorFrac: 0,
        shipped: POINTER_TRAIL_ENABLED,
      },
      clock: {
        keyframes: 0,
        decodedFiducials: 0,
        offsetsMs: [],
        medianOffsetMs: null,
        maxDeviationMs: null,
        channelOffsetsMs: [],
        pagesDisagreeingWithChannel: 0,
        excluded: [],
      },
      edit: { cutSpanMs: [0, 0], keyframeRecMs: [], fromCutSpan: 0, beforeMs: 0, afterMs: 0 },
      cost: {
        takeMs: real.durationMs,
        aiBuildMs: real.buildMs,
        renderMs: 0,
        ratio: 0,
        aiBytes: real.bytes,
        renderBytes: 0,
        aiTokens: real.approxTokens,
        videoFrameTokens: Math.round(((real.durationMs / 1000) * 30 * (1024 * 576)) / 750),
      },
      threads: [],
      gates: {},
    }
  }
  const economyMs = (opts.economySec ?? 60) * 1000
  const shortMs = (opts.shortSec ?? 12) * 1000
  const fiducialMs = (opts.fiducialSec ?? 12) * 1000
  const notes: string[] = []
  const scenarios: ScenarioResult[] = []

  notes.push(
    `analysis samples at ${SAMPLE_FPS}/s; every take here is a real MediaRecorder vp9 capture, decoded and composed by production code`,
  )

  // A real recording, when one was dropped in: the synthetic scenarios prove
  // the rules, this proves the calibration on the thing PO actually records.
  const real = opts.realFile ? await runRealFile(opts.realFile) : undefined
  scenarios.push(await runScenario('burst', economyMs))
  scenarios.push(await runScenario('cursor', shortMs))
  scenarios.push(await runScenario('caret', shortMs))
  scenarios.push(await runScenario('tooltip', shortMs))
  const trail = await measureTrail(shortMs)

  // --- the fiducial take: clock, edit fidelity, cost ------------------------
  const rig = await recordFiducialSession(fiducialMs, { flashClick: true })
  const base = clampEditState(rig.recording, defaultEditState(rig.recording))
  const cutStart = Math.round(fiducialMs * 0.35)
  const cutEnd = Math.round(fiducialMs * 0.55)
  const cutEdit: EditState = clampEditState(rig.recording, {
    ...base,
    segments: [
      { startMs: base.globalTrimStartMs, endMs: cutStart },
      { startMs: cutEnd, endMs: base.globalTrimEndMs },
    ],
  })

  let clock: AiExportReport['clock'] = {
    keyframes: 0,
    decodedFiducials: 0,
    offsetsMs: [],
    medianOffsetMs: null,
    maxDeviationMs: null,
    channelOffsetsMs: [],
    pagesDisagreeingWithChannel: 0,
    excluded: [],
  }
  let edit: AiExportReport['edit'] = {
    cutSpanMs: [cutStart, cutEnd],
    keyframeRecMs: [],
    fromCutSpan: 0,
    beforeMs: 0,
    afterMs: 0,
  }
  let cost: AiExportReport['cost'] = {
    takeMs: fiducialMs,
    aiBuildMs: 0,
    renderMs: 0,
    ratio: 0,
    aiBytes: 0,
    renderBytes: 0,
    aiTokens: 0,
    videoFrameTokens: 0,
  }
  let pdfBase64: string | undefined
  let threads: ThreadLane[] = []

  try {
    // Warm the decoder before timing anything: note 10, the first lane of any
    // matrix pays the cold start and reads as a difference between engines.
    await exportForAi({ recording: rig.recording, edit: base })

    const tAi = performance.now()
    const aiResult = await exportForAi({ recording: rig.recording, edit: cutEdit })
    const aiMs = performance.now() - tAi
    const aiStats = getLastAiExportStats()!
    const bytes = new Uint8Array(await aiResult.blob.arrayBuffer())
    if (opts.includePdf) pdfBase64 = base64(bytes)

    // Every page's own picture, read back out of the file.
    const jpegs = extractJpegs(bytes)
    const viewIndices: number[] = []
    let at = 0
    for (const hasCrop of aiStats.keyframeHasCrop) {
      viewIndices.push(at)
      at += hasCrop ? 2 : 1
    }
    const pictureMs: (number | null)[] = []
    for (let i = 0; i < viewIndices.length; i++) {
      const jpeg = jpegs[viewIndices[i]!]
      pictureMs.push(jpeg ? await readFiducial(jpeg) : null)
    }
    // The control: the same instants, read straight off the channel.
    const channelPictureMs = await probeChannelFiducials(
      rig.recording,
      cutEdit,
      aiStats.keyframeAtOutMs,
    )
    const disagreeing = pictureMs.filter((p, i) => {
      const c = channelPictureMs[i]
      return p !== null && c !== null && Math.abs(p - c) > 34
    }).length

    const offsets: { i: number; value: number }[] = []
    for (let i = 0; i < pictureMs.length; i++) {
      const p = pictureMs[i]
      if (p !== null) offsets.push({ i, value: aiStats.keyframeAtRecMs[i]! - p })
    }
    // THE TAKE'S FIRST FRAME IS NOT A CLOCK ERROR AND IT IS NOT OURS. A canvas
    // captureStream's first encoded frame holds whatever was painted before
    // the recorder existed, so its PICTURE is older than its timestamp — the
    // control above reads exactly the same thing off the channel, and every
    // export path (this one, the render, the packet copy) inherits it. It is
    // named here and left out of the spread, never quietly averaged in.
    const excluded: string[] = []
    const scored = offsets.filter((o) => {
      const isFirst = o.i === 0 && aiStats.keyframeAtOutMs[0] === 0
      if (!isFirst) return true
      const agrees =
        pictureMs[0] !== null &&
        channelPictureMs[0] !== null &&
        Math.abs(pictureMs[0] - channelPictureMs[0]!) <= 34
      excluded.push(
        `page 1 (take’s first frame): picture ${pictureMs[0]} ms vs caption ${Math.round(aiStats.keyframeAtRecMs[0]!)} ms — capture pre-roll, ${agrees ? 'confirmed identical on the channel itself' : 'NOT reproduced on the channel'}`,
      )
      return false
    })
    const values = scored.map((o) => o.value).sort((a, b) => a - b)
    const median = values.length ? values[values.length >> 1]! : null
    clock = {
      keyframes: aiStats.keyframes,
      decodedFiducials: offsets.length,
      offsetsMs: offsets.map((o) => Math.round(o.value)),
      medianOffsetMs: median === null ? null : Math.round(median),
      maxDeviationMs:
        median === null ? null : Math.round(Math.max(...values.map((v) => Math.abs(v - median)))),
      channelOffsetsMs: channelPictureMs.map((p, i) =>
        p === null ? null : Math.round(aiStats.keyframeAtRecMs[i]! - p),
      ),
      pagesDisagreeingWithChannel: disagreeing,
      excluded,
    }
    const mean = median
    edit = {
      cutSpanMs: [cutStart, cutEnd],
      keyframeRecMs: aiStats.keyframeAtRecMs.map((t) => Math.round(t)),
      // The rig's fiducial clock and the recording epoch differ by a constant
      // (the channel's own start offset), so the cut span is tested on the
      // PICTURE times corrected by that same constant.
      fromCutSpan: pictureMs.filter((p) => {
        if (p === null || mean === null) return false
        const recMs = p + mean
        return recMs > cutStart + 150 && recMs < cutEnd - 150
      }).length,
      beforeMs: cutStart,
      afterMs: base.globalTrimEndMs - cutEnd,
    }

    const tRender = performance.now()
    const rendered = await exportRecording({ recording: rig.recording, edit: cutEdit })
    const renderMs = performance.now() - tRender
    cost = {
      takeMs: fiducialMs,
      aiBuildMs: Math.round(aiMs),
      renderMs: Math.round(renderMs),
      ratio: Math.round((aiMs / renderMs) * 100) / 100,
      aiBytes: aiResult.blob.size,
      renderBytes: rendered.blob.size,
      aiTokens: aiStats.approxTokens,
      // The thing this file exists not to be: every frame of the same take at
      // 1024×576, which is what "give the agent the video" would cost.
      videoFrameTokens: Math.round(((fiducialMs / 1000) * 30 * (1024 * 576)) / 750),
    }

    // X9: where the build runs. Last, so it cannot perturb the clock and edit
    // lanes above, and after four builds of this take have already warmed the
    // decoder.
    threads = await measureThreads(rig.recording, cutEdit)
  } finally {
    await rig.cleanup().catch(() => undefined)
  }

  const byName = (name: string): ScenarioResult => scenarios.find((s) => s.scenario === name)!
  const cursor = byName('cursor')
  const caret = byName('caret')
  const tooltip = byName('tooltip')
  const burst = byName('burst')
  const burstInside = burst.keyframeAtMs.filter((t) => t >= 19_000 && t <= 26_000).length

  const gates: AiExportReport['gates'] = {
    // WAS "≤8 pages", and that gate encoded the design PO rejected: it passed
    // by summarizing a motion burst into one page. The economy claim that
    // survives is about WHERE the pages go, not how few there are — bounded by
    // what the readers actually accept, checked 2026-08-24: Claude 32 MB /
    // 600 pages on 1M-context models, Gemini 50 MB / 1000 pages.
    'economy: the file fits what the readers accept (≤600 pages, ≤30 MB)': {
      pass:
        [burst, tooltip, cursor, caret].every((s) => s.pages <= 600 && s.bytes <= 30 * 1024 * 1024) &&
        (!real || (real.pages <= 600 && real.bytes <= 30 * 1024 * 1024)),
      detail:
        `60 s take: ${burst.pages} pages, ~${burst.approxTokens} tokens` +
        (real ? ` · real 97 s take: ${real.pages} pages, ${(real.bytes / 1048576).toFixed(1)} MB` : ''),
    },
    'economy: an idle span emits nothing after its first': {
      pass: burst.keyframeAtMs.filter((t) => t < 19_000).length <= 1,
      detail: `${burst.keyframeAtMs.filter((t) => t < 19_000).length} in the first 19 s (the still part); longest gap ${burst.longestGapMs} ms`,
    },
    'economy: the pages go where the motion is, and are DENSE there': {
      // PO's use is an agent recreating a UI and its animations: five seconds
      // of motion has to come back as a sequence, not as one summary page.
      pass: burstInside >= burst.keyframes - 1 && burstInside >= 12,
      detail: `${burstInside} of ${burst.keyframes} inside 20-25 s; times ${burst.keyframeAtMs.join(',')}`,
    },
    'cursor immunity: a wandering cursor is ≤1 page after the first': {
      pass: cursor.keyframes <= 2,
      detail: `${cursor.keyframes} keyframes over ${cursor.samples} samples; classes ${JSON.stringify(cursor.classes)}`,
    },
    'cursor immunity: a blinking caret is 0 after the first': {
      pass: caret.keyframes <= 1,
      detail: `${caret.keyframes} keyframes; classes ${JSON.stringify(caret.classes)}`,
    },
    'cursor immunity: a tooltip is exactly 1 page, cropped': {
      pass: tooltip.keyframes === 2 && tooltip.cropped >= 1,
      detail: `${tooltip.keyframes} keyframes (first + tooltip), ${tooltip.cropped} cropped, at ${tooltip.keyframeAtMs.join(',')} ms`,
    },
    'clock: the picture on a page is the frame its caption claims': {
      pass: clock.maxDeviationMs !== null && clock.maxDeviationMs <= 150,
      detail:
        clock.maxDeviationMs === null
          ? 'no fiducial could be decoded from the file'
          : `${clock.decodedFiducials}/${clock.keyframes} pages read back; caption−picture median ${clock.medianOffsetMs} ms (the recording’s own epoch mapping), max deviation ${clock.maxDeviationMs} ms${clock.excluded.length ? ` · excluded: ${clock.excluded.join('; ')}` : ''}`,
    },
    'clock: every page shows the frame the CHANNEL holds at that instant': {
      pass: clock.pagesDisagreeingWithChannel === 0 && clock.decodedFiducials > 0,
      detail: `${clock.pagesDisagreeingWithChannel} of ${clock.decodedFiducials} pages differ from the channel decoded independently at the same output times`,
    },
    'edit fidelity: no page comes from the cut span': {
      pass: edit.fromCutSpan === 0,
      detail: `${edit.fromCutSpan} of ${clock.decodedFiducials} decoded pages inside ${cutStart}-${cutEnd} ms`,
    },
    'token price is reported per page and in total': {
      pass: tooltip.perPageTokens.length === tooltip.keyframes && cost.aiTokens > 0,
      detail: `e.g. the tooltip take: pages ${tooltip.perPageTokens.join(' + ')} = ~${tooltip.approxTokens} tokens; the fiducial take ~${cost.aiTokens}`,
    },
    ...(real
      ? {
          'a REAL recording is covered end to end, densely enough to follow': {
            // The three numbers PO's complaint was about: nothing skipped for
            // long, the whole take covered, and the file still uploadable.
            pass:
              real.gapsMs.median <= 1500 &&
              real.gapsMs.max <= 5000 &&
              real.pages <= 600 &&
              real.keyframeAtMs[real.keyframeAtMs.length - 1]! >= real.durationMs * 0.9,
            detail:
              `${real.keyframes} frames over ${(real.durationMs / 1000).toFixed(1)}s: median gap ` +
              `${real.gapsMs.median}ms, worst ${real.gapsMs.max}ms, ${real.gapsMs.over3s} over 3s, ` +
              `last frame at ${(real.keyframeAtMs[real.keyframeAtMs.length - 1]! / 1000).toFixed(1)}s, ` +
              `${real.pages} pages, ~${real.approxTokens} tokens, ${(real.bytes / 1048576).toFixed(1)} MB`,
          },
        }
      : {}),
    'cost: the build is ≤1.5× the same take’s full render': {
      pass: cost.ratio <= 1.5,
      detail: `${cost.aiBuildMs} ms vs ${cost.renderMs} ms = ${cost.ratio}×`,
    },
    'X9: the worker builds the SAME file the main thread does (byte-identical)': {
      pass: threads.length > 0 && new Set(threads.map((t) => t.sha256)).size === 1,
      detail: threads.length
        ? threads
            .map((t) => `${t.order} ${t.where} ${t.bytes} B sha ${t.sha256.slice(0, 12)}`)
            .join(' · ')
        : 'not measured',
    },
    'X9: the For-AI build leaves the UI thread running': {
      // The claim is a RATIO against the same build in-thread, not an absolute:
      // this rig's own scaffolding runs on the main thread too, so an absolute
      // floor would gate the rig rather than the build.
      //
      // THE VACUITY GUARD IS RELATIVE FOR THE SAME REASON. The first version
      // demanded the in-thread lane lose >100 ms of wall clock before the gate
      // would count, and read FAIL on a run where the effect was clean and
      // fivefold (78 ms lost in-thread vs 15 in the worker) purely because this
      // fixture's build is one second long. The quantity that does not depend on
      // the fixture is the SHARE of the build's own wall clock the UI did not
      // have: ≥3 % in-thread means the lane is a real load to compare against,
      // and the worker must cost at most a quarter of it.
      pass: (() => {
        const w = threads.filter((t) => t.where === 'worker')
        const m = threads.filter((t) => t.where === 'in-thread')
        if (!w.length || !m.length) return false
        const wMs = w.reduce((a, t) => a + t.blockedMs, 0) / w.length
        const mMs = m.reduce((a, t) => a + t.blockedMs, 0) / m.length
        const mPct = m.reduce((a, t) => a + t.blockedPct, 0) / m.length
        return mPct >= 3 && wMs <= mMs * 0.25
      })(),
      detail: threads
        .map(
          (t) =>
            `${t.order} ${t.where}: UI lost ${t.blockedMs} ms of ${t.wallMs} (${t.blockedPct}%), ` +
            `${t.ticks} ticks, worst gap ${t.worstGapMs} ms, ${t.longTasks} long tasks`,
        )
        .join(' · '),
    },
  }

  notes.push(
    `token price: this file ~${cost.aiTokens} tokens against ~${cost.videoFrameTokens} for the same take as video frames (${Math.round(cost.videoFrameTokens / Math.max(1, cost.aiTokens))}× cheaper)`,
  )
  notes.push(
    `pointer trail: ${trail.precisionPct}% of confident readings land within 5% of the frame of the path the rig drew (median error ${trail.medianErrorFrac}); shipped=${trail.shipped}`,
  )
  notes.push(`rig fiducial take is ${RIG_WIDTH}x${RIG_HEIGHT}, composed to 1920x1080 by production layout`)

  if (threads.length) {
    const w = threads.filter((t) => t.where === 'worker')
    const m = threads.filter((t) => t.where === 'in-thread')
    const mean = (xs: ThreadLane[], f: (t: ThreadLane) => number): number =>
      Math.round(xs.reduce((a, t) => a + f(t), 0) / xs.length)
    notes.push(
      `X9 where the build runs: the UI thread lost ${mean(m, (t) => t.blockedMs)} ms in-thread vs ` +
        `${mean(w, (t) => t.blockedMs)} ms in the worker (worst single gap ${Math.max(...m.map((t) => t.worstGapMs))} vs ` +
        `${Math.max(...w.map((t) => t.worstGapMs))} ms); wall ${mean(m, (t) => t.wallMs)} vs ${mean(w, (t) => t.wallMs)} ms — ` +
        `the worker is not FASTER, it is elsewhere`,
    )
    notes.push(
      `X9 the long-task counter read ${m.reduce((a, t) => a + t.longTasks, 0)} in-thread and ` +
        `${w.reduce((a, t) => a + t.longTasks, 0)} in the worker: the build awaits a decode every sample, so its ` +
        `work never forms a single ≥50 ms task even while it occupies the thread end to end. Kept as a diagnostic, not a gate`,
    )
  }

  return { notes, scenarios, real, trail, clock, edit, cost, threads, gates, pdfBase64 }
}
