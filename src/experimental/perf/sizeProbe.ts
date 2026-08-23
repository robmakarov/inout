/**
 * EXPERIMENTAL — F7c SPIKE: can the per-step size be MEASURED instead of
 * modelled? Three designs, all measured, none good enough to ship. Kept here
 * with its numbers so the next attempt starts from the fourth idea, not the
 * first.
 *
 * F7b shipped a finer export ladder and reported its own gate unmet: the
 * per-step size was predicted from the composite, and the composite's encoder
 * is not the export's encoder. On still text-heavy screen content MediaRecorder
 * spends 0.97 Mbps where the export spends 1.84 Mbps for the same pixels, so
 * the prediction landed 47 % low at 1440p; on full-motion content the two agree
 * within 7 %. No exponent fixes both, because the missing quantity is what the
 * EXPORT encoder charges for THIS content — and nothing short of encoding it
 * can know that.
 *
 * So encode it: a two-frame MINIATURE OF THE RENDER at every step. Sample a few
 * instants of the take, compose each through the very same drawVideoFrame the
 * exporter uses (so the camera pose and the background frame are in the
 * picture), and encode a KEYFRAME plus the DELTA that follows it at that step's
 * resolution and bitrate. A file is made of exactly those two things:
 *
 *     bytes/s = keyframes/s · meanKeyframeBytes + (fps − keyframes/s) · meanDeltaBytes
 *
 * IT READS THE RAW CHANNELS, NOT THE COMPOSITE, and that is the whole point. A
 * first version sampled the composite and was wrong in OPPOSITE DIRECTIONS by
 * content — +136 % on screen, −68 % on motion — because a composite frame is
 * not the frame the render encodes: on text it carries MediaRecorder's ringing,
 * which costs bits to re-encode, and on motion it has already been smoothed,
 * which does not. The render decodes the raw channels; so does this.
 *
 * WHAT WAS TRIED, and what each attempt measured against real rendered sizes
 * (12 s takes, screen-like content and full-motion content, the shipped ladder):
 *
 *   1. key+delta pair sampled from the COMPOSITE.   +136 / −68 %
 *      Wrong pixels: a composite frame carries MediaRecorder's ringing on text
 *      (expensive to re-encode) and is already smoothed on motion (cheap).
 *   2. key+delta pair composed from the RAW CHANNELS through the production
 *      drawVideoFrame — the right pixels.           +128 / −64 %
 *      Wrong shape: one delta measured against a fresh keyframe is not what a
 *      file is made of. In a real file a delta references another delta, and
 *      the rate controller has settled by then.
 *   3. two 15-frame WINDOWS of consecutive composed frames, one keyframe each,
 *      mean delta from the run.                     −7 to −43 % / −59 to −69 %
 *      Better on screen content, still far out on motion — the measured delta
 *      (4.8 KB at 1080p) is a third of what the same content actually costs the
 *      render (14-19 KB/frame). Something about a 30-frame encode still does
 *      not reach the steady state a 360-frame encode does.
 *
 * SO IT IS NOT SHIPPED. The panel keeps F7's estimate, whose error is smaller
 * and — this is the point — already known and written down. A probe that is
 * 60 % out on one content type is not an improvement on a model that is 20-45 %
 * out on the other.
 *
 * WHAT THE FOURTH ATTEMPT MUST HANDLE: measure a long enough stretch that rate
 * control settles (the gap between a 30-frame and a 360-frame encode is the
 * unexplained factor of three), and prove it on BOTH content types before it
 * touches the panel. `npm run exp -- o11` already scores any candidate against
 * real rendered sizes on both — use it.
 *
 * Everything is in memory (BufferTarget), so a probe leaves nothing on disk.
 */
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, type VideoSample } from 'mediabunny'
import { blobStore } from '@core/store'
import {
  cameraPoseAt,
  cameraTrackIsActive,
  channelSourceTimeAt,
  outputDurationMs as outputDurationOf,
  outputToRecordingMs,
} from '@core/timeline'
import type { EditState, Recording } from '@core/types'
import { AUDIO_BITRATE, KEYFRAME_INTERVAL_SEC } from '@core/compose/codecs'
import { drawVideoFrame, type FrameCanvas } from '@core/compose/layout'
import { isDefaultTier, type QualityTier, type SizeEstimate } from '@core/compose/quality'
import { openVideoChannel, type VideoChannelReader } from '@core/compose/video'

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
  /** Instants of the OUTPUT that were sampled, seconds. */
  sampledAtSec: number[]
  /** What the probe cost, ms — this is a budget, and budgets get measured. */
  wallMs: number
}

/**
 * Two WINDOWS of consecutive output frames, not two isolated pairs.
 *
 * A single delta measured right after a fresh keyframe is not what a file is
 * made of, and the first version of this probe proved it: +128 % on screen
 * content and −64 % on motion, from the same code. A delta in a real file
 * references a frame that is itself a delta, and the rate controller has
 * settled by then. So each window encodes one keyframe and a run of deltas, and
 * the mean delta comes from the run.
 */
/**
 * ATTEMPT 4: one window, a WHOLE GOP long.
 *
 * MEASURED 2026-08-23 (`npm run exp -- f7c`), 180 frames behind one keyframe,
 * mean delta bytes by distance from it:
 *              1-14    15-29    30-59   60-119  120-179   GOP mean   ratio
 *   screen     6386     2087     1127     2239     1715       2039   0.32
 *   motion     4775     4373     6043    10348    16356       9486   1.99
 * A 15-frame window is not a cheap approximation of a GOP, it is a different
 * quantity — three times too EXPENSIVE on screen content and twice too CHEAP on
 * motion. The error flips sign with content, which is the same tell attempt 1
 * had, and no single correction factor can fix a sign flip. So the window stops
 * being a sample of the GOP and becomes the GOP.
 */
const WINDOW_COUNT = 1
const WINDOW_FRAMES = 150

interface Window {
  /** Consecutive composed OUTPUT frames, 1/30 s apart, at 1920×1080. */
  frames: ImageBitmap[]
}

export async function calibrateSteps(
  recording: Recording,
  edit: EditState,
  tiers: QualityTier[],
  opts: { signal?: AbortSignal } = {},
): Promise<Calibration | null> {
  const t0 = performance.now()
  const aborted = (): boolean => !!opts.signal?.aborted
  const readers: VideoChannelReader[] = []
  const windows: Window[] = []
  const sampledAtSec: number[] = []
  try {
    for (const channel of recording.channels) {
      if (channel.media !== 'video') continue
      if (aborted()) return null
      const blob = await blobStore.read(channel.blobKey)
      const reader = await openVideoChannel(blob, channel.id, channel.kind, channel.durationMs / 1000)
      if (reader) readers.push(reader)
    }
    if (readers.length === 0) return null

    // Compose at the take's own geometry; every step is a scale of this.
    const canvas = new OffscreenCanvas(1920, 1080)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return null
    const frame: FrameCanvas = { ctx, width: 1920, height: 1080, scale: 1 }
    const cameraFull = !readers.some((r) => r.kind === 'screen')
    const cameraMoves = !cameraFull && cameraTrackIsActive(edit.camera)
    const durationSec = Math.max(0.2, outputDurationOf(edit) / 1000)

    for (let i = 0; i < WINDOW_COUNT; i++) {
      if (aborted()) return null
      // Spread across the take, avoiding both ends: the first frames of a
      // capture are often a blank surface and the last are the stop itself.
      const atSec = durationSec * ((i + 1) / (WINDOW_COUNT + 1))
      const frames: ImageBitmap[] = []
      for (let f = 0; f < WINDOW_FRAMES; f++) {
        const t = Math.min(durationSec - 0.01, atSec + f / 30)
        const bitmap = await composeAt(frame, readers, recording, edit, t, cameraFull, cameraMoves)
        if (!bitmap) break
        frames.push(bitmap)
      }
      if (frames.length < 2) {
        for (const b of frames) b.close()
        continue
      }
      sampledAtSec.push(Math.round(atSec * 100) / 100)
      windows.push({ frames })
    }
    if (windows.length === 0) return null

    const steps: Record<string, StepMeasurement> = {}
    for (const tier of tiers) {
      if (aborted()) return null
      const measured = await measureTier(tier, windows)
      if (measured) steps[tier.id] = measured
    }
    if (Object.keys(steps).length === 0) return null
    return { steps, sampledAtSec, wallMs: Math.round(performance.now() - t0) }
  } catch (err) {
    console.warn('[quality] size calibration failed, falling back to the estimate', err)
    return null
  } finally {
    for (const w of windows) for (const b of w.frames) b.close()
    for (const r of readers) r.dispose()
  }
}

/** One output frame, composed exactly as pipeline.renderFrame composes it. */
async function composeAt(
  frame: FrameCanvas,
  readers: VideoChannelReader[],
  recording: Recording,
  edit: EditState,
  atSec: number,
  cameraFull: boolean,
  cameraMoves: boolean,
): Promise<ImageBitmap | null> {
  let screen: VideoSample | null = null
  let camera: VideoSample | null = null
  for (const reader of readers) {
    const localMs = channelSourceTimeAt(recording, edit, reader.channelId, atSec * 1000)
    if (localMs === null) continue
    const sample = await reader.sampleAt(localMs / 1000)
    if (!sample) continue
    if (reader.kind === 'screen') screen = sample
    else camera = sample
  }
  if (!screen && !camera) return null
  let pose
  if (cameraMoves && camera && camera.displayWidth > 0 && camera.displayHeight > 0) {
    const recMs = outputToRecordingMs(edit, atSec * 1000)
    if (recMs !== null) {
      pose = cameraPoseAt(edit.camera, recMs, {
        frameAspect: frame.width / frame.height,
        cameraAspect: camera.displayWidth / camera.displayHeight,
      })
    }
  }
  drawVideoFrame(frame, screen, camera, cameraFull, pose, edit.background)
  // A bitmap, because the readers are about to be asked for the next instant
  // and their samples do not outlive that.
  return createImageBitmap(frame.ctx.canvas)
}

async function measureTier(tier: QualityTier, windows: Window[]): Promise<StepMeasurement | null> {
  const canvas = new OffscreenCanvas(tier.width, tier.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return null
  const keyBytes: number[] = []
  const deltaBytes: number[] = []
  let nextIsKey = true
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: tier.videoBitrate,
    // Never let the encoder insert a keyframe of its own: this measurement
    // depends on knowing exactly which packet is which. A finite number, not
    // Infinity — mediabunny validates the field and throws on non-finite, which
    // is how the first version of this probe returned null every time.
    keyFrameInterval: 1e6,
    onEncodedPacket: (p) => {
      // Packets come back in encode order, and the first of every window is the
      // only forced keyframe in it.
      if (p.type === 'key' || nextIsKey) keyBytes.push(p.byteLength)
      else deltaBytes.push(p.byteLength)
      nextIsKey = false
    },
  })
  output.addVideoTrack(source, { frameRate: tier.fps })
  try {
    await output.start()
    let seq = 0
    for (const window of windows) {
      for (let i = 0; i < window.frames.length; i++) {
        ctx.drawImage(window.frames[i]!, 0, 0, tier.width, tier.height)
        await source.add(seq++ / tier.fps, 1 / tier.fps, { keyFrame: i === 0 })
      }
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
