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
 *   4. ONE window, a WHOLE GOP long (150 frames), because the "factor of three"
 *      turned out not to be a factor at all.        −6.7 to −15.4 / −30.5 to −39.9 %
 *      `npm run exp -- f7c` measured delta cost against DISTANCE FROM THE
 *      KEYFRAME, 180 frames behind one key, warm-up discarded:
 *              1-14    15-29    30-59   60-119  120-179   GOP mean   ratio
 *        screen 6386     2087     1127     2239     1715       2039   0.32
 *        motion 4775     4373     6043    10348    16356       9486   1.99
 *      A short window is not a cheap sample of a GOP, it is a different
 *      quantity — three times too EXPENSIVE on screen and twice too CHEAP on
 *      motion. The error flips sign with content, which is attempt 1's tell
 *      again, and no single correction can fix a sign flip. So the window
 *      became the GOP, and that HALVED the error and put SCREEN content inside
 *      the ±20 % gate for the first time (−6.7 / −7.3 / −12.9 / −15.4 %).
 *
 * STILL NOT SHIPPED, and the gate says every step on BOTH rigs. Motion content
 * stays 30-40 % low, and suspiciously UNIFORMLY so: predicted ÷ actual is
 * ~1.44 at every step, including 1080p, where the probe draws the composed
 * frame 1:1 and cannot be blamed on rescaling. The probe now costs 5.6-6.0 s
 * (attempt 3 cost 1.7-2.5 s), which the panel can absorb — it opens instantly
 * and the number lands late — but not for an answer that is still wrong on one
 * content type.
 *
 * WHAT THE FIFTH ATTEMPT MUST HANDLE: why a probe that encodes EXACTLY the GOP
 * the render encodes, from the same pixels, at the same bitrate, comes out a
 * uniform 1.44× under on motion content. It is one number, not a curve, which
 * is a strong hint that something countable is missing — a keyframe the render
 * emits and the model does not, the first GOP of a file costing more than a
 * middle one, or the audio term. Count them before modelling anything.
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
import { AUDIO_BITRATE, KEYFRAME_INTERVAL_SEC, RENDER_ENCODER_OPTIONS } from '@core/compose/codecs'
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
  /**
   * THE SAME WINDOW, ENCODED TWICE, REPORTED SEPARATELY (attempt 5).
   *
   * A file's FIRST GOP is not a typical one and the difference is large and
   * content-dependent — measured over four consecutive GOPs
   * (`npm run exp -- f7c`): a later GOP costs 1.81x the first on motion content
   * and 0.88x on screen. So neither pass alone can price a file: a 6 s take is
   * essentially ONE first GOP, a 5 minute take is one first GOP and 59 later
   * ones. Both are measured in one encode — the second pass opens on a forced
   * keyframe and carries five seconds of this content in the rate controller,
   * which is exactly the history a middle GOP has — and the estimate blends
   * them by the take's own length.
   */
  firstKeyframeBytes: number
  firstDeltaBytes: number
  laterKeyframeBytes: number
  laterDeltaBytes: number
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
/**
 * One window, a WHOLE GOP long, encoded TWICE.
 *
 * 150 frames is exactly what the shipped 5 s cadence produces at 30 fps
 * (O11b). Both passes are measured and reported separately: a file is one FIRST
 * GOP followed by later ones, and the two cost differently enough that neither
 * alone can price a take of unknown length.
 */
const WINDOW_FRAMES = 150

/** One step's encoder, fed frames as they are composed. */
interface TierLane {
  tier: QualityTier
  canvas: OffscreenCanvas
  ctx: OffscreenCanvasRenderingContext2D
  output: Output
  source: CanvasSource
  firstKey: number[]
  firstDelta: number[]
  laterKey: number[]
  laterDelta: number[]
  nextFirstIsKey: boolean
  nextLaterIsKey: boolean
  seq: number
  failed: boolean
}

/**
 * MEMORY IS FLAT ON PURPOSE. The spike held all 150 composed frames as
 * ImageBitmaps so it could replay them per step — 1920x1080x4 x 150 is about
 * 1.2 GB of texture, which is fine in a rig and not fine on a user's machine
 * while a take is open. Every step's encoder is opened up front instead and
 * each composed frame is handed to all of them before it is released, so the
 * probe holds ONE frame at a time. The cost is composing the window twice
 * (decode is the floor — note 13) rather than once.
 */
export async function calibrateSteps(
  recording: Recording,
  edit: EditState,
  tiers: QualityTier[],
  opts: {
    signal?: AbortSignal
    /**
     * false = read ONE GOP instead of two, so every step is priced as a first
     * GOP — which is what attempt 4 did. Kept as a parameter so both models can
     * be scored against the SAME take in one run: this content is re-recorded
     * every run and a few points of spread between runs would otherwise read as
     * a difference between models.
     */
    warmPass?: boolean
  } = {},
): Promise<Calibration | null> {
  const warmPass = opts.warmPass !== false
  const t0 = performance.now()
  const aborted = (): boolean => !!opts.signal?.aborted
  const readers: VideoChannelReader[] = []
  const lanes: TierLane[] = []
  const sampledAtSec: number[] = []
  /** Set between the passes; every packet before it belongs to the first GOP. */
  let boundarySec = Number.POSITIVE_INFINITY
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

    /**
     * THE WINDOW HAS TO FIT IN THE TAKE, and in the spike it did not: it started
     * halfway through and ran 5 s, so on a 6 s take the last 60 of its 150
     * frames were `Math.min(durationSec - 0.01, ...)` — the SAME frozen instant,
     * sixty times, each encoding to almost nothing. Forty per cent of every
     * delta mean the probe ever reported was a duplicate of one still picture.
     * (Note 10: the rig is wrong before the product is.)
     */
    /**
     * TWO CONSECUTIVE GOPS, READ FORWARD ONCE.
     *
     * The first version of this encoded ONE window twice, and that was wrong
     * for a reason worth writing down: a channel reader walks its decoder
     * forward, so replaying the same seconds means seeking backwards, and what
     * came back the second time was the same frame over and over. The measured
     * "later GOP" was 150 duplicates — the probe read 84 % under and looked
     * like a modelling failure. It was a rewind.
     *
     * So the window is 300 consecutive frames with a forced keyframe at 0 and
     * at 150. That is not a simulation of a file's first two GOPs, it IS one,
     * and it costs a single forward pass over ten seconds of the take.
     */
    const totalFrames = warmPass ? 2 * WINDOW_FRAMES : WINDOW_FRAMES
    const windowSec = totalFrames / 30
    // Away from both ends where it can be: the first frames of a capture are
    // often a blank surface and the last are the stop itself.
    const atSec = Math.max(0, Math.min(Math.max(0, durationSec / 2 - windowSec / 2), durationSec - windowSec))
    sampledAtSec.push(Math.round(atSec * 100) / 100)

    for (const tier of tiers) {
      const lane = openLane(tier, () => boundarySec)
      if (lane) lanes.push(lane)
    }
    if (lanes.length === 0) return null
    for (const lane of lanes) await lane.output.start()

    let composed = 0
    for (let f = 0; f < totalFrames; f++) {
      if (aborted()) return null
      const t = atSec + f / 30
      // Past the end of the take there is nothing to measure. Stopping short is
      // honest; repeating the last frame is not — every mean below would then be
      // diluted by however much of the window fell off the end, which is exactly
      // the defect the spike shipped with.
      if (t > durationSec - 0.01) break
      const bitmap = await composeAt(frame, readers, recording, edit, t, cameraFull, cameraMoves)
      if (!bitmap) break
      try {
        for (const lane of lanes) await addFrame(lane, bitmap, f % WINDOW_FRAMES === 0)
      } finally {
        bitmap.close()
      }
      composed = f + 1
      // Set before the second GOP's first frame is added, so a packet that
      // lands late still lands on the right side of the boundary.
      if (composed === WINDOW_FRAMES) boundarySec = WINDOW_FRAMES / 30 - 1e-6
    }
    if (composed < 2) return null

    const steps: Record<string, StepMeasurement> = {}
    for (const lane of lanes) {
      const measured = await closeLane(lane)
      if (measured) steps[lane.tier.id] = measured
    }
    if (Object.keys(steps).length === 0) return null
    return { steps, sampledAtSec, wallMs: Math.round(performance.now() - t0) }
  } catch (err) {
    console.warn('[quality] size calibration failed, falling back to the estimate', err)
    return null
  } finally {
    for (const lane of lanes) {
      if (lane.output.state !== 'finalized' && lane.output.state !== 'canceled') {
        await lane.output.cancel().catch(() => undefined)
      }
    }
    for (const r of readers) r.dispose()
  }
}

function openLane(tier: QualityTier, boundary: () => number): TierLane | null {
  const canvas = new OffscreenCanvas(tier.width, tier.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return null
  const lane: TierLane = {
    tier,
    canvas,
    ctx,
    output: null as unknown as Output,
    source: null as unknown as CanvasSource,
    firstKey: [],
    firstDelta: [],
    laterKey: [],
    laterDelta: [],
    nextFirstIsKey: true,
    nextLaterIsKey: true,
    seq: 0,
    failed: false,
  }
  lane.output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  lane.source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: tier.videoBitrate,
    // THE PROBE'S ENCODER MUST BE THE EXPORT'S ENCODER, and a hand-rolled
    // config is not: the render passes RENDER_ENCODER_OPTIONS. Pricing the same
    // pixels with a different encoder is the exact mistake F7b made with the
    // composite, one level down.
    ...RENDER_ENCODER_OPTIONS,
    // Never let the encoder insert a keyframe of its own: this measurement
    // depends on knowing exactly which packet is which. A finite number, not
    // Infinity — mediabunny validates the field and throws on non-finite, which
    // is how the first version of this probe returned null every time.
    keyFrameInterval: 1e6,
    onEncodedPacket: (p) => {
      if (p.timestamp < boundary()) {
        if (p.type === 'key' || lane.nextFirstIsKey) lane.firstKey.push(p.byteLength)
        else lane.firstDelta.push(p.byteLength)
        lane.nextFirstIsKey = false
        return
      }
      if (p.type === 'key' || lane.nextLaterIsKey) lane.laterKey.push(p.byteLength)
      else lane.laterDelta.push(p.byteLength)
      lane.nextLaterIsKey = false
    },
  })
  lane.output.addVideoTrack(lane.source, { frameRate: tier.fps })
  return lane
}

async function addFrame(lane: TierLane, bitmap: ImageBitmap, keyFrame: boolean): Promise<void> {
  if (lane.failed) return
  try {
    lane.ctx.drawImage(bitmap, 0, 0, lane.tier.width, lane.tier.height)
    await lane.source.add(lane.seq / lane.tier.fps, 1 / lane.tier.fps, { keyFrame })
    lane.seq++
  } catch (err) {
    // One step failing must not cost the others their measurement.
    console.warn(`[quality] calibration encode failed for ${lane.tier.id}`, err)
    lane.failed = true
  }
}

async function closeLane(lane: TierLane): Promise<StepMeasurement | null> {
  if (lane.failed) return null
  try {
    lane.source.close()
    await lane.output.finalize()
  } catch (err) {
    console.warn(`[quality] calibration finalize failed for ${lane.tier.id}`, err)
    await lane.output.cancel().catch(() => undefined)
    return null
  }
  const mean = (xs: number[]): number =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0
  const hasLater = lane.laterDelta.length > 0
  const firstKey = mean(lane.firstKey)
  const firstDelta = mean(lane.firstDelta)
  if (!firstKey || !firstDelta) return null
  return {
    tierId: lane.tier.id,
    // The headline pair stays the LATER GOP where there is one — that is what
    // most of a real take is made of.
    meanKeyframeBytes: hasLater ? mean(lane.laterKey) : firstKey,
    meanDeltaBytes: hasLater ? mean(lane.laterDelta) : firstDelta,
    samples: Math.min(lane.laterKey.length + lane.firstKey.length, lane.laterDelta.length + lane.firstDelta.length),
    firstKeyframeBytes: firstKey,
    firstDeltaBytes: firstDelta,
    laterKeyframeBytes: hasLater ? mean(lane.laterKey) : firstKey,
    laterDeltaBytes: hasLater ? mean(lane.laterDelta) : firstDelta,
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

/**
 * The predicted file as the encoder actually builds it: one FIRST GOP, then as
 * many later GOPs as the take has room for, each priced by its own measured
 * keyframe and delta.
 *
 * Counting the GOPs rather than dividing by the cadence matters at both ends: a
 * 6 s take at a 5 s cadence holds TWO keyframes, not 1.2, and on screen content
 * a keyframe is ~200 KB against a ~5 KB delta, so the difference is a third of
 * the file. And a take shorter than one GOP is entirely first-GOP.
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
  const gopSec = KEYFRAME_INTERVAL_SEC
  const firstSec = Math.min(seconds, gopSec)
  const laterSec = Math.max(0, seconds - gopSec)
  const perGop = (keyBytes: number, deltaBytes: number, spanSec: number): number => {
    if (spanSec <= 0) return 0
    const frames = spanSec * tier.fps
    const keys = Math.max(1, Math.ceil(spanSec / gopSec))
    return keys * keyBytes + Math.max(0, frames - keys) * deltaBytes
  }
  const videoBytes =
    perGop(step.firstKeyframeBytes, step.firstDeltaBytes, firstSec) +
    perGop(step.laterKeyframeBytes, step.laterDeltaBytes, laterSec)
  const ceiling = tier.videoBitrate / 8
  return {
    bytes: Math.round(Math.min(ceiling * seconds, videoBytes) + audioBytes),
    fromSource: true,
    // The default step is still the composite itself, copied — that number was
    // never a prediction and this does not change it.
    exact: isDefaultTier(tier),
  }
}
