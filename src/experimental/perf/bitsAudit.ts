/**
 * EXPERIMENTAL — O11 evidence: where the bits actually go, and what each lever
 * is worth in bytes.
 *
 * Two things make this run rather than reason:
 *
 * 1. CONTENT DECIDES EVERYTHING. A screen recording is mostly still pixels with
 *    sharp glyph edges; the existing synthetic rig paints a full-frame gradient
 *    that changes everywhere every frame. Those two contents price the GOP
 *    lever in opposite directions, so both are measured and both are reported —
 *    the honest answer is the pair, not an average.
 * 2. THE FILE IS THE WITNESS. Every number below is demuxed back out of the
 *    exported file (packet types and byte lengths), not self-reported by the
 *    encoder we are auditing.
 *
 * Ladders measured:
 *   (a) keyframe cadence 1 / 2 / 3 / 5 / 8 s at the default 1080p — task O11b.
 *       Reported with a PSNR against the 2 s baseline, because a GOP change
 *       must not be a quality change.
 *   (b) candidate quality STEPS (resolution × bitrate) — task F7b, whose step
 *       rule is that adjacent steps must differ by more than the estimator's
 *       ±20 % error band.
 */

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink } from 'mediabunny'
import { newId } from '@core/id'
import { blobStore } from '@core/store'
import { exportRecording } from '@core/compose'
import { startLiveComposite } from '@core/capture/liveComposite'
import { readCertification } from '@core/compose/certify'
import { defaultEditState } from '@core/timeline'
import { defaultCameraPose, poseToRect } from '@core/timeline/cameraTrack'
import type { ChannelRecording, Recording } from '@core/types'

/** The shipped raw-camera bitrate, and the O11c candidate. */
const CAMERA_BITRATES = [4_000_000, 2_500_000]

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

interface Source {
  canvas: HTMLCanvasElement
  stop: () => void
}

/**
 * What a screen recording actually looks like: a dark editor page of coloured
 * text that holds perfectly still, scrolls one line every 2.5 s, and blinks a
 * caret. Sharp glyph edges, tiny inter-frame change — the content the whole
 * bits audit exists to price.
 */
function screenLikeSource(width: number, height: number): Source {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')!
  const lines: { text: string; color: string }[] = []
  const words = ['const', 'function', 'return', 'await', 'export', 'if', 'for', 'type']
  for (let i = 0; i < 60; i++) {
    const indent = '  '.repeat(i % 4)
    lines.push({
      text: `${indent}${words[i % words.length]} sample${i} = compute(${i}, 'channel-${i % 7}')`,
      color: i % 5 === 0 ? '#7ee787' : i % 3 === 0 ? '#79c0ff' : '#c9d1d9',
    })
  }
  const t0 = performance.now()
  let raf = 0
  const draw = (): void => {
    const t = (performance.now() - t0) / 1000
    const scroll = Math.floor(t / 2.5)
    g.fillStyle = '#0d1117'
    g.fillRect(0, 0, width, height)
    g.font = `${Math.round(height / 38)}px monospace`
    g.textBaseline = 'top'
    for (let row = 0; row < 34; row++) {
      const line = lines[(row + scroll) % lines.length]!
      g.fillStyle = '#484f58'
      g.fillText(String(row + scroll + 1).padStart(3, ' '), width * 0.01, row * (height / 36) + 8)
      g.fillStyle = line.color
      g.fillText(line.text, width * 0.05, row * (height / 36) + 8)
    }
    // A caret is the only thing moving between scrolls — same as a real editor.
    if (Math.floor(t * 2) % 2 === 0) {
      g.fillStyle = '#c9d1d9'
      g.fillRect(width * 0.05 + 320, 12 * (height / 36) + 8, 3, height / 40)
    }
    raf = requestAnimationFrame(draw)
  }
  draw()
  return { canvas, stop: () => cancelAnimationFrame(raf) }
}

/** The opposite extreme: every pixel changes every frame (a game tab). */
function motionSource(width: number, height: number): Source {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')!
  const t0 = performance.now()
  let raf = 0
  const draw = (): void => {
    const t = (performance.now() - t0) / 1000
    const hue = (t * 40) % 360
    const grad = g.createLinearGradient(0, 0, width, height)
    grad.addColorStop(0, `hsl(${hue}, 55%, 18%)`)
    grad.addColorStop(1, `hsl(${(hue + 90) % 360}, 55%, 32%)`)
    g.fillStyle = grad
    g.fillRect(0, 0, width, height)
    g.fillStyle = '#ffffff'
    const bar = width / 8
    g.fillRect(((t * width) / 2) % (width + bar) - bar, 0, bar, height)
    raf = requestAnimationFrame(draw)
  }
  draw()
  return { canvas, stop: () => cancelAnimationFrame(raf) }
}

/** A webcam: a head-and-shoulders blob that drifts, on a flat backdrop. */
function cameraSource(): Source {
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  const g = canvas.getContext('2d')!
  const t0 = performance.now()
  let raf = 0
  const draw = (): void => {
    const t = (performance.now() - t0) / 1000
    g.fillStyle = '#20242b'
    g.fillRect(0, 0, 1280, 720)
    const cx = 640 + Math.sin(t * 0.9) * 60
    const cy = 420 + Math.cos(t * 0.7) * 30
    g.fillStyle = '#c78e6a'
    g.beginPath()
    g.ellipse(cx, cy - 120, 130, 165, 0, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = '#2f6f4f'
    g.beginPath()
    g.ellipse(cx, cy + 220, 290, 200, 0, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = '#12151a'
    g.beginPath()
    g.ellipse(cx - 45, cy - 150, 14, 9 + 5 * Math.abs(Math.sin(t * 2.3)), 0, 0, Math.PI * 2)
    g.ellipse(cx + 45, cy - 150, 14, 9 + 5 * Math.abs(Math.sin(t * 2.3)), 0, 0, Math.PI * 2)
    g.fill()
    raf = requestAnimationFrame(draw)
  }
  draw()
  return { canvas, stop: () => cancelAnimationFrame(raf) }
}

const RAW_MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

/**
 * Record a canvas the way production records a RAW channel (MediaRecorder →
 * durable blob), then describe it as a ChannelRecording so the production
 * exporter can render it with no special casing at all.
 *
 * Several bitrates at once, off ONE stream: an A/B of encoder settings must not
 * also be an A/B of what happened to be on screen at the time.
 */
async function recordChannels(
  source: Source,
  kind: 'screen' | 'camera',
  takeMs: number,
  bitrates: number[],
): Promise<ChannelRecording[]> {
  const mime = RAW_MIMES.find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) throw new Error('no supported raw recorder mime')
  const stream = source.canvas.captureStream(30)
  const lanes = await Promise.all(
    bitrates.map(async (videoBitsPerSecond) => {
      const blobKey = `exp-o11-${newId('src')}.webm`
      const writer = (await blobStore.createWriteStream(blobKey)).getWriter()
      let chain = Promise.resolve()
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond })
      recorder.ondataavailable = (e) => {
        if (!e.data.size) return
        chain = chain.then(() => writer.write(e.data).catch(() => undefined))
      }
      return { blobKey, writer, recorder, videoBitsPerSecond, chain: () => chain }
    }),
  )
  for (const lane of lanes) lane.recorder.start(1000)
  await new Promise((r) => setTimeout(r, takeMs))
  await Promise.all(
    lanes.map(
      (lane) =>
        new Promise<void>((resolve) => {
          lane.recorder.onstop = () => resolve()
          lane.recorder.requestData()
          lane.recorder.stop()
        }),
    ),
  )
  const out: ChannelRecording[] = []
  for (const lane of lanes) {
    await lane.chain()
    await lane.writer.close().catch(() => undefined)
    out.push({
      id: newId('ch'),
      kind,
      media: 'video',
      mimeType: mime,
      blobKey: lane.blobKey,
      startOffsetMs: 0,
      durationMs: takeMs,
      width: source.canvas.width,
      height: source.canvas.height,
    })
  }
  for (const t of stream.getTracks()) t.stop()
  return out
}

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

export interface FileBits {
  bytes: number
  videoBytes: number
  videoPackets: number
  keyframeCount: number
  keyframeBytes: number
  keyframeSharePct: number
  meanKeyframeBytes: number
  meanDeltaBytes: number
  achievedMbps: number
  durationSec: number
  codecTag: { container: string; video: string; audio?: string; gopSec?: number } | null
}

/** Every number here comes out of the FILE — packets, types, byte lengths. */
async function auditFile(blob: Blob): Promise<FileBits> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    const duration = await input.computeDuration()
    let videoBytes = 0
    let videoPackets = 0
    let keyframeCount = 0
    let keyframeBytes = 0
    if (track) {
      const sink = new EncodedPacketSink(track)
      for await (const p of sink.packets()) {
        videoBytes += p.byteLength
        videoPackets++
        if (p.type === 'key') {
          keyframeCount++
          keyframeBytes += p.byteLength
        }
      }
    }
    const tags = await input.getMetadataTags()
    const cert = readCertification(tags.comment)
    const deltas = videoPackets - keyframeCount
    return {
      bytes: blob.size,
      videoBytes,
      videoPackets,
      keyframeCount,
      keyframeBytes,
      keyframeSharePct:
        videoBytes > 0 ? Math.round((keyframeBytes / videoBytes) * 1000) / 10 : 0,
      meanKeyframeBytes: keyframeCount > 0 ? Math.round(keyframeBytes / keyframeCount) : 0,
      meanDeltaBytes: deltas > 0 ? Math.round((videoBytes - keyframeBytes) / deltas) : 0,
      achievedMbps: duration > 0 ? Math.round(((videoBytes * 8) / duration / 1e6) * 1000) / 1000 : 0,
      durationSec: Math.round(duration * 1000) / 1000,
      codecTag: cert?.codec ?? null,
    }
  } finally {
    input.dispose()
  }
}

const PSNR_W = 960
const PSNR_H = 540

async function framesAt(blob: Blob, times: number[]): Promise<(ImageData | null)[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const canvas = new OffscreenCanvas(PSNR_W, PSNR_H)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return times.map(() => null)
    const sink = new VideoSampleSink(track)
    const out: (ImageData | null)[] = []
    for (const t of times) {
      const s = await sink.getSample(t)
      if (!s) {
        out.push(null)
        continue
      }
      ctx.clearRect(0, 0, PSNR_W, PSNR_H)
      s.draw(ctx, 0, 0, PSNR_W, PSNR_H)
      s.close()
      out.push(ctx.getImageData(0, 0, PSNR_W, PSNR_H))
    }
    return out
  } finally {
    input.dispose()
  }
}

/**
 * Frames decoded at full output size, cropped to a rect given in FRACTIONS of
 * the frame. The camera lever only touches the PiP, and a PSNR over the whole
 * frame would be dominated by the ~92 % of pixels the lever cannot reach.
 */
async function cropFramesAt(
  blob: Blob,
  times: number[],
  rect: { leftFrac: number; topFrac: number; widthFrac: number; heightFrac: number },
): Promise<(ImageData | null)[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const canvas = new OffscreenCanvas(1920, 1080)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const x = Math.round(rect.leftFrac * 1920)
  const y = Math.round(rect.topFrac * 1080)
  const w = Math.max(1, Math.round(rect.widthFrac * 1920))
  const h = Math.max(1, Math.round(rect.heightFrac * 1080))
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return times.map(() => null)
    const sink = new VideoSampleSink(track)
    const out: (ImageData | null)[] = []
    for (const t of times) {
      const s = await sink.getSample(t)
      if (!s) {
        out.push(null)
        continue
      }
      ctx.clearRect(0, 0, 1920, 1080)
      s.draw(ctx, 0, 0, 1920, 1080)
      s.close()
      out.push(ctx.getImageData(x, y, w, h))
    }
    return out
  } finally {
    input.dispose()
  }
}

/** dB against the baseline render, sampled at the same instants. ∞ = identical. */
function psnr(a: ImageData, b: ImageData): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c]! - b.data[i + c]!
      sum += d * d
      n++
    }
  }
  const mse = sum / Math.max(1, n)
  if (mse === 0) return Infinity
  return Math.round(10 * Math.log10((255 * 255) / mse) * 10) / 10
}

/** Control-flow marker: this content has no camera half to run. */
class SkipCamera extends Error {}

/**
 * Record a LIVE COMPOSITE over the same source and describe its shape. This is
 * the input the shipped size estimator actually gets, so a claim about the
 * estimator has to be made against a real composite, not against a raw channel.
 * The packet walk is metadata-only — byte lengths and types, no sample data.
 */
async function captureCompositeShape(source: Source, takeMs: number): Promise<CompositeShape | null> {
  const stream = source.canvas.captureStream(30)
  const key = `exp-o11-comp-${newId('c')}.mp4`
  try {
    const handle = await startLiveComposite({ screen: stream, audio: [] }, key)
    await new Promise((r) => setTimeout(r, takeMs))
    const composite = await handle.stop()
    if (!composite) return null
    const blob = await blobStore.read(key)
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    try {
      const track = await input.getPrimaryVideoTrack()
      if (!track) return null
      const duration = await input.computeDuration()
      let keyframeBytes = 0
      let deltaBytes = 0
      const sink = new EncodedPacketSink(track)
      for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
        if (p.type === 'key') keyframeBytes += p.byteLength
        else deltaBytes += p.byteLength
      }
      const total = keyframeBytes + deltaBytes
      return {
        bytes: blob.size,
        keyframeBytes,
        deltaBytes,
        keyframeSharePct: total > 0 ? Math.round((keyframeBytes / total) * 1000) / 10 : 0,
        durationSec: Math.round(duration * 1000) / 1000,
        width: composite.width,
        height: composite.height,
      }
    } finally {
      input.dispose()
    }
  } catch {
    return null
  } finally {
    for (const t of stream.getTracks()) t.stop()
    await blobStore.remove(key).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

export interface GopRung {
  gopSec: number
  bytes: number
  keyframeCount: number
  keyframeSharePct: number
  meanKeyframeBytes: number
  meanDeltaBytes: number
  achievedMbps: number
  /** Size against the 2 s default, negative = smaller. */
  deltaVsDefaultPct: number
  /** Mean PSNR vs the 2 s render at three sampled instants (dB). */
  psnrDb: number | null
  wallMs: number
}

export interface StepRung {
  label: string
  /** 'ladder' rungs are the candidate steps; 'probe' rungs test one lever. */
  role: 'ladder' | 'probe'
  width: number
  height: number
  videoBitrate: number
  bytes: number
  achievedMbps: number
  /** Size against the previous LADDER step. F7b wants ≥25 %. */
  deltaVsPrevPct: number | null
  wallMs: number
}

export interface ContentReport {
  content: 'screen' | 'motion'
  sourceChannelBytes: number
  gopLadder: GopRung[]
  bestGopSec: number
  savingAtBestPct: number
  minPsnrDb: number | null
  /** The live composite of this content, and what each estimator model makes of it. */
  composite: CompositeShape | null
  estimates: EstimateRow[]
  worstErrorPct: { sqrt: number; piecewise: number } | null
}

/**
 * The take's own composite, described the way a size estimator can use it:
 * how many bytes per second it cost, and how those bytes split between
 * keyframes (spatial detail — scales with pixels) and deltas (change over
 * time — barely scales with pixels). F7b lives or dies on that split.
 */
export interface CompositeShape {
  bytes: number
  keyframeBytes: number
  deltaBytes: number
  keyframeSharePct: number
  durationSec: number
  width: number
  height: number
}

/** Predicted vs actual for one candidate step, under each candidate model. */
export interface EstimateRow {
  label: string
  pixelRatio: number
  actualBytes: number
  /** √(pixel ratio) — what F7 ships today. */
  sqrtPredicted: number
  sqrtErrorPct: number
  /** Linear below the source resolution, √ above it. */
  piecewisePredicted: number
  piecewiseErrorPct: number
  /** ln(actual/source) / ln(pixelRatio): the exponent this content actually
   *  obeys. 1 = size follows pixels, 0.5 = the shipped √ model, 0 = flat. */
  impliedExponent: number | null
}

export interface CameraRung {
  requestedMbps: number
  /** What the RAW camera channel cost on disk — the only thing this lever saves. */
  channelBytes: number
  channelSavingPct: number | null
  /** Size of the export that used this channel (the PiP is ~8 % of the frame). */
  exportBytes: number
  /** PSNR inside the PiP rect against the 4 Mbps channel's export. */
  pipPsnrDb: number | null
}

export interface O11Report {
  takeMs: number
  contents: ContentReport[]
  steps: StepRung[]
  camera: CameraRung[]
  codecTag: FileBits['codecTag']
  notes: string[]
}

async function renderAt(
  recording: Recording,
  settings: { width: number; height: number; fps: number; videoBitrate: number; keyFrameIntervalSec?: number },
): Promise<{ blob: Blob; wallMs: number }> {
  const edit = defaultEditState(recording)
  const t0 = performance.now()
  const result = await exportRecording({ recording, edit, settings })
  return { blob: result.blob, wallMs: Math.round(performance.now() - t0) }
}

export async function runBitsAudit(
  opts: { takeMs?: number; gops?: number[] } = {},
): Promise<O11Report> {
  const takeMs = opts.takeMs ?? 6000
  const gops = opts.gops ?? [1, 2, 3, 5, 8]
  const contents: ContentReport[] = []
  const steps: StepRung[] = []
  const camera: CameraRung[] = []
  let codecTag: FileBits['codecTag'] = null

  for (const kind of ['screen', 'motion'] as const) {
    const source = kind === 'screen' ? screenLikeSource(1920, 1080) : motionSource(1920, 1080)
    let channel: ChannelRecording | null = null
    try {
      channel = (await recordChannels(source, 'screen', takeMs, [8_000_000]))[0]!
      const recording: Recording = {
        id: newId('rec'),
        createdAt: Date.now(),
        durationMs: takeMs,
        channels: [channel],
      }
      const sourceBlob = await blobStore.read(channel.blobKey)

      // (a) keyframe cadence ladder.
      const rungs: GopRung[] = []
      const framesByGop = new Map<number, (ImageData | null)[]>()
      const sampleTimes = [0.5, takeMs / 2000, Math.max(0.5, takeMs / 1000 - 0.5)]
      for (const gopSec of gops) {
        const { blob, wallMs } = await renderAt(recording, {
          width: 1920,
          height: 1080,
          fps: 30,
          videoBitrate: 8_000_000,
          keyFrameIntervalSec: gopSec,
        })
        const bits = await auditFile(blob)
        codecTag = bits.codecTag ?? codecTag
        framesByGop.set(gopSec, await framesAt(blob, sampleTimes))
        rungs.push({
          gopSec,
          bytes: bits.bytes,
          keyframeCount: bits.keyframeCount,
          keyframeSharePct: bits.keyframeSharePct,
          meanKeyframeBytes: bits.meanKeyframeBytes,
          meanDeltaBytes: bits.meanDeltaBytes,
          achievedMbps: bits.achievedMbps,
          deltaVsDefaultPct: 0,
          psnrDb: null,
          wallMs,
        })
      }
      const baselineBytes = rungs.find((r) => r.gopSec === 2)?.bytes ?? 0
      const baselineFrames = framesByGop.get(2) ?? []
      for (const rung of rungs) {
        rung.deltaVsDefaultPct =
          baselineBytes > 0
            ? Math.round(((rung.bytes - baselineBytes) / baselineBytes) * 1000) / 10
            : 0
        if (rung.gopSec === 2) continue
        const own = framesByGop.get(rung.gopSec)
        if (!own || !baselineFrames.length) continue
        const vals: number[] = []
        for (let i = 0; i < own.length; i++) {
          const a = own[i]
          const b = baselineFrames[i]
          // Infinity (bit-identical frames) would poison a mean — count it as
          // the top of the scale instead of dropping the sample.
          if (a && b) vals.push(Math.min(99, psnr(a, b)))
        }
        rung.psnrDb = vals.length
          ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10
          : null
      }
      const best = rungs.reduce((a, b) => (b.bytes < a.bytes ? b : a), rungs[0]!)
      const psnrs = rungs.map((r) => r.psnrDb).filter((v): v is number => v !== null)
      const ladderRows: StepRung[] = []

      // (b) candidate quality steps. Run on BOTH contents: the step sizes
      // themselves are a screen-content question, but whether a size ESTIMATOR
      // can be honest is exactly a question about content differences.
      {
        // Bitrate ceilings scale with pixel count, as QUALITY_TIERS already
        // does. The two PROBE rungs answer the question that decides the shape
        // of the ladder: is bitrate a step at all, or only resolution?
        const candidates: (Omit<StepRung, 'bytes' | 'achievedMbps' | 'deltaVsPrevPct' | 'wallMs'>)[] = [
          { label: '540p', role: 'ladder', width: 960, height: 540, videoBitrate: 2_000_000 },
          { label: '720p', role: 'ladder', width: 1280, height: 720, videoBitrate: 4_000_000 },
          { label: '900p', role: 'ladder', width: 1600, height: 900, videoBitrate: 6_000_000 },
          { label: '1080p', role: 'ladder', width: 1920, height: 1080, videoBitrate: 8_000_000 },
          { label: '1440p', role: 'ladder', width: 2560, height: 1440, videoBitrate: 14_000_000 },
          { label: '1080p @3Mbps', role: 'probe', width: 1920, height: 1080, videoBitrate: 3_000_000 },
          { label: '1080p @1.5Mbps', role: 'probe', width: 1920, height: 1080, videoBitrate: 1_500_000 },
        ]
        let prevLadder: StepRung | null = null
        for (const c of candidates) {
          const { blob, wallMs } = await renderAt(recording, {
            width: c.width,
            height: c.height,
            fps: 30,
            videoBitrate: c.videoBitrate,
          })
          const bits = await auditFile(blob)
          const rung: StepRung = {
            ...c,
            bytes: bits.bytes,
            achievedMbps: bits.achievedMbps,
            deltaVsPrevPct:
              c.role === 'ladder' && prevLadder && prevLadder.bytes > 0
                ? Math.round(((bits.bytes - prevLadder.bytes) / prevLadder.bytes) * 1000) / 10
                : null,
            wallMs,
          }
          if (c.role === 'ladder') prevLadder = rung
          ladderRows.push(rung)
          if (kind === 'screen') steps.push(rung)
        }

        // (c) camera-when-PiP: the raw camera channel is recorded at 4 Mbps and
        // then drawn at ~24 % of the frame width. Record the SAME camera at two
        // bitrates off one stream, export each as a PiP over this screen
        // channel, and compare inside the PiP rect — where the lever lives.
        const cam = kind === 'screen' ? cameraSource() : null
        const camChannels: ChannelRecording[] = []
        try {
          if (!cam) throw new SkipCamera()
          camChannels.push(...(await recordChannels(cam!, 'camera', takeMs, CAMERA_BITRATES)))
          const geometry = { frameAspect: 16 / 9, cameraAspect: 1280 / 720 }
          const pipRect = poseToRect(defaultCameraPose(geometry), geometry)
          let baseFrames: (ImageData | null)[] = []
          let baseChannelBytes = 0
          for (const camChannel of camChannels) {
            const rec: Recording = {
              id: newId('rec'),
              createdAt: Date.now(),
              durationMs: takeMs,
              channels: [channel, camChannel],
            }
            const { blob } = await renderAt(rec, {
              width: 1920,
              height: 1080,
              fps: 30,
              videoBitrate: 8_000_000,
            })
            const channelBytes = (await blobStore.read(camChannel.blobKey)).size
            const frames = await cropFramesAt(blob, sampleTimes, pipRect)
            const isBase = camera.length === 0
            if (isBase) {
              baseFrames = frames
              baseChannelBytes = channelBytes
            }
            const vals: number[] = []
            if (!isBase) {
              for (let i = 0; i < frames.length; i++) {
                const a = frames[i]
                const b = baseFrames[i]
                if (a && b) vals.push(Math.min(99, psnr(a, b)))
              }
            }
            camera.push({
              requestedMbps: CAMERA_BITRATES[camera.length]! / 1e6,
              channelBytes,
              channelSavingPct: isBase
                ? null
                : Math.round(((channelBytes - baseChannelBytes) / baseChannelBytes) * 1000) / 10,
              exportBytes: blob.size,
              pipPsnrDb: vals.length
                ? Math.round((vals.reduce((x, v) => x + v, 0) / vals.length) * 10) / 10
                : null,
            })
          }
        } catch (err) {
          if (!(err instanceof SkipCamera)) throw err
        } finally {
          cam?.stop()
          for (const c of camChannels) await blobStore.remove(c.blobKey).catch(() => undefined)
        }
      }
      // (d) the size ESTIMATOR, which is what F7b actually promises the user.
      // It reads the take's own live composite, so the composite has to exist:
      // record one over the same source and then price every step against it.
      const shape = await captureCompositeShape(source, takeMs)
      const estimates: EstimateRow[] = []
      if (shape && shape.durationSec > 0) {
        const srcPixels = shape.width * shape.height
        const srcRate = shape.bytes / shape.durationSec
        const seconds = takeMs / 1000
        for (const rung of ladderRows) {
          if (rung.role !== 'ladder') continue
          const r = (rung.width * rung.height) / srcPixels
          const ceiling = (rung.videoBitrate / 8) * seconds
          const sqrtPredicted = Math.round(Math.min(ceiling, srcRate * Math.sqrt(r) * seconds))
          const piecewisePredicted = Math.round(
            Math.min(ceiling, srcRate * (r <= 1 ? r : Math.sqrt(r)) * seconds),
          )
          const ratio = rung.bytes / (srcRate * seconds)
          estimates.push({
            label: rung.label,
            pixelRatio: Math.round(r * 1000) / 1000,
            actualBytes: rung.bytes,
            sqrtPredicted,
            sqrtErrorPct: Math.round(((sqrtPredicted - rung.bytes) / rung.bytes) * 1000) / 10,
            piecewisePredicted,
            piecewiseErrorPct:
              Math.round(((piecewisePredicted - rung.bytes) / rung.bytes) * 1000) / 10,
            impliedExponent:
              r > 0 && r !== 1 && ratio > 0
                ? Math.round((Math.log(ratio) / Math.log(r)) * 100) / 100
                : null,
          })
        }
      }
      contents.push({
        content: kind,
        sourceChannelBytes: sourceBlob.size,
        gopLadder: rungs,
        bestGopSec: best.gopSec,
        savingAtBestPct: best.deltaVsDefaultPct,
        minPsnrDb: psnrs.length ? Math.min(...psnrs) : null,
        composite: shape,
        estimates,
        worstErrorPct: estimates.length
          ? {
              sqrt: Math.max(...estimates.map((e) => Math.abs(e.sqrtErrorPct))),
              piecewise: Math.max(...estimates.map((e) => Math.abs(e.piecewiseErrorPct))),
            }
          : null,
      })
    } finally {
      source.stop()
      if (channel) await blobStore.remove(channel.blobKey).catch(() => undefined)
    }
  }

  return {
    takeMs,
    contents,
    steps,
    camera,
    codecTag,
    notes: [
      'every byte count is demuxed back out of the exported file, not reported by the encoder under test',
      'screen content = a still editor page that scrolls one line every 2.5 s; motion content = a full-frame gradient that changes everywhere every frame. Real takes sit between them and much closer to the first',
      'PSNR is measured against the 2 s-GOP render at three instants, downscaled to 960x540; above ~45 dB the two files are visually the same picture',
      'the camera rungs record ONE camera stream into two files at once, so an A/B of the encoder setting is not also an A/B of what the camera happened to be doing',
      'outputDurationMs of these takes is short, so a single keyframe is a big share of a small file — read the SHARE and the mean sizes, not the absolute bytes',
    ],
  }
}
