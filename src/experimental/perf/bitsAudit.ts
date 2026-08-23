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
import { readCertification } from '@core/compose/certify'
import { defaultEditState } from '@core/timeline'
import type { ChannelRecording, Recording } from '@core/types'

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

const RAW_MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

/**
 * Record a canvas the way production records a RAW screen channel (MediaRecorder
 * → durable blob), then describe it as a ChannelRecording so the production
 * exporter can render it with no special casing at all.
 */
async function recordChannel(source: Source, takeMs: number): Promise<ChannelRecording> {
  const mime = RAW_MIMES.find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) throw new Error('no supported raw recorder mime')
  const blobKey = `exp-o11-${newId('src')}.webm`
  const writable = await blobStore.createWriteStream(blobKey)
  const writer = writable.getWriter()
  let chain = Promise.resolve()
  const stream = source.canvas.captureStream(30)
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return
    chain = chain.then(() => writer.write(e.data).catch(() => undefined))
  }
  recorder.start(1000)
  await new Promise((r) => setTimeout(r, takeMs))
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    recorder.requestData()
    recorder.stop()
  })
  await chain
  await writer.close().catch(() => undefined)
  for (const t of stream.getTracks()) t.stop()
  return {
    id: newId('ch'),
    kind: 'screen',
    media: 'video',
    mimeType: mime,
    blobKey,
    startOffsetMs: 0,
    durationMs: takeMs,
    width: source.canvas.width,
    height: source.canvas.height,
  }
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
  width: number
  height: number
  videoBitrate: number
  bytes: number
  achievedMbps: number
  /** Size against the previous (smaller) step. F7b wants ≥25 %. */
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
}

export interface O11Report {
  takeMs: number
  contents: ContentReport[]
  steps: StepRung[]
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
  let codecTag: FileBits['codecTag'] = null

  for (const kind of ['screen', 'motion'] as const) {
    const source = kind === 'screen' ? screenLikeSource(1920, 1080) : motionSource(1920, 1080)
    let channel: ChannelRecording | null = null
    try {
      channel = await recordChannel(source, takeMs)
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
      contents.push({
        content: kind,
        sourceChannelBytes: sourceBlob.size,
        gopLadder: rungs,
        bestGopSec: best.gopSec,
        savingAtBestPct: best.deltaVsDefaultPct,
        minPsnrDb: psnrs.length ? Math.min(...psnrs) : null,
      })

      // (b) candidate quality steps — only on the screen-like content, which is
      // what the slider will be used on.
      if (kind === 'screen') {
        const candidates = [
          { label: '720p lean', width: 1280, height: 720, videoBitrate: 2_000_000 },
          { label: '720p', width: 1280, height: 720, videoBitrate: 4_000_000 },
          { label: '1080p lean', width: 1920, height: 1080, videoBitrate: 4_500_000 },
          { label: '1080p', width: 1920, height: 1080, videoBitrate: 8_000_000 },
          { label: '1440p', width: 2560, height: 1440, videoBitrate: 14_000_000 },
        ]
        for (const c of candidates) {
          const { blob, wallMs } = await renderAt(recording, { ...c, fps: 30 })
          const bits = await auditFile(blob)
          const prev = steps[steps.length - 1]
          steps.push({
            ...c,
            bytes: bits.bytes,
            achievedMbps: bits.achievedMbps,
            deltaVsPrevPct:
              prev && prev.bytes > 0
                ? Math.round(((bits.bytes - prev.bytes) / prev.bytes) * 1000) / 10
                : null,
            wallMs,
          })
        }
      }
    } finally {
      source.stop()
      if (channel) await blobStore.remove(channel.blobKey).catch(() => undefined)
    }
  }

  return {
    takeMs,
    contents,
    steps,
    codecTag,
    notes: [
      'every byte count is demuxed back out of the exported file, not reported by the encoder under test',
      'screen content = a still editor page that scrolls one line every 2.5 s; motion content = a full-frame gradient that changes everywhere every frame. Real takes sit between them and much closer to the first',
      'PSNR is measured against the 2 s-GOP render at three instants, downscaled to 960x540; above ~45 dB the two files are visually the same picture',
      'outputDurationMs of these takes is short, so a single keyframe is a big share of a small file — read the SHARE and the mean sizes, not the absolute bytes',
    ],
  }
}
