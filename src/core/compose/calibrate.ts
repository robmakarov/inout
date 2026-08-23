/**
 * THE SIZE NUMBER, MEASURED INSTEAD OF MODELLED (task F7c).
 *
 * F7b shipped a finer export ladder and reported its own gate unmet: the
 * per-step size is predicted from the composite, and the composite's encoder is
 * not the export's encoder. On still text-heavy screen content MediaRecorder's
 * AVC spends 0.97 Mbps where the export's AVC spends 1.84 Mbps for the same
 * pixels, so the prediction landed 47 % low at 1440p; on full-motion content
 * the two agree within 7 %. No exponent fixes both, because the missing
 * quantity is what the EXPORT encoder charges for THIS content — and nothing
 * short of encoding it can know that.
 *
 * So encode it. Take a few instants of the take, and at every step encode a
 * KEYFRAME and the DELTA that follows it, through the same mediabunny encoder
 * the export uses, at that step's resolution and bitrate. That gives the two
 * numbers a file is made of, measured rather than scaled:
 *
 *     bytes/s = keyframes/s · meanKeyframeBytes + (fps − keyframes/s) · meanDeltaBytes
 *
 * Sanity check on the numbers F7b already had: the 1080p screen render measured
 * 2.73 MB over 12 s with a 235 KB keyframe and 5.7 KB deltas, and this formula
 * predicts 2.60 MB — 4.6 % out, against the 47 % the scaling model managed.
 *
 * Everything here is in memory (BufferTarget), so a probe leaves nothing on
 * disk, and every failure path returns null so the caller falls back to F7's
 * estimate rather than showing nothing.
 */
import { ALL_FORMATS, BlobSource, BufferTarget, CanvasSource, Input, Mp4OutputFormat, Output, VideoSampleSink } from 'mediabunny'
import { blobStore } from '@core/store'
import type { Recording } from '@core/types'
import { AUDIO_BITRATE, KEYFRAME_INTERVAL_SEC } from './codecs'
import { isDefaultTier, type QualityTier, type SizeEstimate } from './quality'

export interface StepMeasurement {
  tierId: string
  /** Mean encoded size of a keyframe at this step, bytes. */
  meanKeyframeBytes: number
  /** Mean encoded size of the frame that follows it, bytes. */
  meanDeltaBytes: number
  samples: number
}

export interface Calibration {
  /** Keyed by tier id. */
  steps: Record<string, StepMeasurement>
  /** Instants of the take that were sampled, seconds. */
  sampledAtSec: number[]
  /** What the probe cost, ms — this is a budget, and budgets get measured. */
  wallMs: number
}

/** Instants to sample. Three is enough to notice that a take has a busy half. */
const SAMPLE_COUNT = 3

/**
 * Decode a pair of adjacent frames at each sampled instant, and encode both at
 * every step. The pair matters: a delta frame is only meaningful against the
 * keyframe it refers to, so each pair is encoded key-then-delta in order.
 */
export async function calibrateSteps(
  recording: Recording,
  tiers: QualityTier[],
  opts: { signal?: AbortSignal } = {},
): Promise<Calibration | null> {
  const composite = recording.composite
  if (!composite || !composite.width || !composite.height) return null
  const t0 = performance.now()
  const aborted = (): boolean => !!opts.signal?.aborted

  let input: Input | null = null
  const pairs: { key: VideoFrameLike; delta: VideoFrameLike }[] = []
  const sampledAtSec: number[] = []
  try {
    const blob = await blobStore.read(composite.blobKey)
    if (blob.size === 0) return null
    input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) return null
    const durationSec = Math.max(0.2, composite.durationMs / 1000)
    const sink = new VideoSampleSink(track)
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      if (aborted()) return null
      // Spread across the take, avoiding both ends: the first frames of a
      // capture are often a blank surface and the last are the stop itself.
      const at = durationSec * ((i + 1) / (SAMPLE_COUNT + 1))
      const key = await sink.getSample(at)
      const delta = await sink.getSample(Math.min(durationSec - 0.01, at + 1 / 30))
      if (!key || !delta) {
        key?.close()
        delta?.close()
        continue
      }
      sampledAtSec.push(Math.round(at * 100) / 100)
      pairs.push({ key, delta })
    }
    if (pairs.length === 0) return null

    const steps: Record<string, StepMeasurement> = {}
    for (const tier of tiers) {
      if (aborted()) return null
      const measured = await measureTier(tier, pairs)
      if (measured) steps[tier.id] = measured
    }
    if (Object.keys(steps).length === 0) return null
    return { steps, sampledAtSec, wallMs: Math.round(performance.now() - t0) }
  } catch (err) {
    console.warn('[quality] size calibration failed, falling back to the estimate', err)
    return null
  } finally {
    for (const p of pairs) {
      p.key.close()
      p.delta.close()
    }
    input?.dispose()
  }
}

/** Only what this module needs from a decoded sample. */
interface VideoFrameLike {
  displayWidth: number
  displayHeight: number
  draw(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dx: number,
    dy: number,
    dw?: number,
    dh?: number,
  ): void
  close(): void
}

async function measureTier(
  tier: QualityTier,
  pairs: { key: VideoFrameLike; delta: VideoFrameLike }[],
): Promise<StepMeasurement | null> {
  const canvas = new OffscreenCanvas(tier.width, tier.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return null
  const keyBytes: number[] = []
  const deltaBytes: number[] = []
  let expectKey = true
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: tier.videoBitrate,
    // Never let the encoder insert a keyframe of its own: this measurement
    // depends on knowing exactly which packet is which.
    keyFrameInterval: Number.POSITIVE_INFINITY,
    onEncodedPacket: (p) => {
      if (expectKey) keyBytes.push(p.byteLength)
      else deltaBytes.push(p.byteLength)
      expectKey = !expectKey
    },
  })
  output.addVideoTrack(source, { frameRate: tier.fps })
  try {
    await output.start()
    let seq = 0
    for (const pair of pairs) {
      drawFit(ctx, pair.key, tier.width, tier.height)
      await source.add(seq++ / tier.fps, 1 / tier.fps, { keyFrame: true })
      drawFit(ctx, pair.delta, tier.width, tier.height)
      await source.add(seq++ / tier.fps, 1 / tier.fps, { keyFrame: false })
    }
    source.close()
    await output.finalize()
  } catch (err) {
    console.warn(`[quality] calibration encode failed for ${tier.id}`, err)
    await output.cancel().catch(() => undefined)
    return null
  }
  if (keyBytes.length === 0 || deltaBytes.length === 0) return null
  const mean = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)
  return {
    tierId: tier.id,
    meanKeyframeBytes: mean(keyBytes),
    meanDeltaBytes: mean(deltaBytes),
    samples: Math.min(keyBytes.length, deltaBytes.length),
  }
}

/** Contain-fit, the same way the export's layout draws a screen surface. */
function drawFit(
  ctx: OffscreenCanvasRenderingContext2D,
  frame: VideoFrameLike,
  width: number,
  height: number,
): void {
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, width, height)
  const sw = frame.displayWidth || width
  const sh = frame.displayHeight || height
  const s = Math.min(width / sw, height / sh)
  const dw = sw * s
  const dh = sh * s
  frame.draw(ctx, (width - dw) / 2, (height - dh) / 2, dw, dh)
}

/**
 * The predicted file, from measured parts. Returns null when this step was not
 * calibrated, so the caller can fall back rather than invent a number.
 */
export function estimateFromCalibration(
  recording: Recording,
  tier: QualityTier,
  outputDurationMs: number,
  calibration: Calibration | null,
): SizeEstimate | null {
  const step = calibration?.steps[tier.id]
  if (!step) return null
  const seconds = Math.max(0, outputDurationMs / 1000)
  const hasAudio = recording.channels.some((c) => c.media === 'audio')
  const audioBytes = hasAudio ? (AUDIO_BITRATE / 8) * seconds : 0
  const keyframesPerSec = 1 / KEYFRAME_INTERVAL_SEC
  const deltasPerSec = Math.max(0, tier.fps - keyframesPerSec)
  const videoBytesPerSec =
    keyframesPerSec * step.meanKeyframeBytes + deltasPerSec * step.meanDeltaBytes
  const ceiling = tier.videoBitrate / 8
  return {
    bytes: Math.round(Math.min(ceiling, videoBytesPerSec) * seconds + audioBytes),
    fromSource: true,
    // The default step is still the composite itself, copied — that number was
    // never a prediction and this does not change it.
    exact: isDefaultTier(tier),
  }
}
