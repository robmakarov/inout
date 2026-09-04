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
 *   6. THE PROBE WAS NOT ENCODING THE WAY THE EXPORT ENCODES, and had not been
 *      since constant quality shipped (B1b, 2026-09-01). Two of its three
 *      encoder inputs were wrong:
 *        · BITRATE. It passed `tier.videoBitrate`, the DECLARED ceiling, while
 *          every real export is configured through `settingsForTier`, which
 *          bounds it by what this take needed (`cappedTierBitrate`). On the
 *          fixture below those were 14.00 and 3.50 Mbps.
 *        · RATE CONTROL. render.ts drops the bitrate target and drives the QP
 *          (CQ_DEFAULT 20) through a CUSTOM encoder that mediabunny only uses
 *          once `registerConstantQualityEncoder()` has been called. This file
 *          never called it, so the probe priced a rate control the product
 *          stopped using — a bitrate target SPENDS its budget where a
 *          quantizer spends what the picture needs.
 *      MEASURED against the file the export actually produced, at 1440p:
 *                                   produced   probe before   probe after
 *        still text, 159.6 s        21.52 MB      64.92 (3.02x)   32.32 (1.50x)
 *        motion, 77.4 s              4.28 MB       4.24 (0.99x)    4.28 (1.00x)
 *      The keyframe term went from 1.58x the render's own mean to 1.04x, the
 *      probe got FASTER (6.6 s → 3.8 s on the text fixture), and the calibrated
 *      ladder came out monotonic in pixel count with no flooring. Motion
 *      content is unchanged, because there the two rate controls cost the same.
 *      WHAT IS LEFT, and it is now the whole error: the delta term on still
 *      content, 4,540 B against the render's own 2,357 B. Not a GOP-position
 *      effect — with constant quality the first and later windows agree (4,429
 *      vs 4,540) — so attempt 5's blend has nothing left to explain it. The
 *      next attempt is about the 300 frames the probe encodes against the 4,789
 *      the file has, or about the pixels those frames carry.
 *      FOR SCALE, the model on the same two fixtures: 19.92 MB (0.93x) and
 *      0.54 MB (7.96x). Neither instrument dominates; the probe's worst case is
 *      now 1.5x where the model's is 8x.
 *
 *   7. THE 1.50x WAS NEVER IN THE ENCODE — IT WAS THE TEN SECONDS IT PICKED
 *      (B1b, 2026-09-04, `npm run exp -- b1b`). Every earlier comparison scored
 *      the probe's WINDOW against the whole FILE's mean, which cannot tell a
 *      wrong encode from an unrepresentative sample. Measuring the file's own
 *      mean delta INSIDE the probe's window separates them, and it is not the
 *      encode: on the gate's own fixture (160 s, the code-editor page +
 *      camera, 1440p) the probe charges 0.98-1.10x what the render charges for
 *      the very same seconds. (One chosen-window run read 0.68x there, and it
 *      is the comparison that bends, not the probe: that window sat at 10 s,
 *      where the FILE is still paying for its own first GOPs while the probe
 *      opens a fresh encoder on them. `firstStart` keeps the choice off the
 *      take's opening for the same reason "take the middle" used to.) What
 *      varies is the seconds — the RENDERED file's
 *      mean delta ran 824-1,770 B by ten-second bucket, a factor of two inside
 *      one take of one content, and the middle ten seconds are not the take.
 *      SO THE WINDOW IS CHOSEN, NOT TAKEN: `chooseWindow` bins the raw
 *      channels' own packet sizes per output second (`metadataOnly` — the
 *      container index, no decode, no payload, 91-366 ms, and budgeted) and
 *      takes the stretch whose mean is nearest the take's. Measured at the
 *      fixture's own length, probe ÷ produced, every run listed:
 *                              window CHOSEN      window taken from the MIDDLE
 *        text + camera         0.96 / 0.91        0.97 / 0.98 / 1.03
 *        motion + camera       1.03 / 0.94        0.98 / 1.00 / 1.06
 *        bimodal               0.54 / 0.43        6.00 / 5.68
 *      The ladder is monotonic in pixel count on all three with no flooring.
 *      Run-to-run spread is ±6 points on the same fixture and the same machine,
 *      so read the band, not a single number.
 *      THE BIMODAL FIXTURE IS DELIBERATE and it is what is left: still text
 *      with a band of motion straddling the middle, i.e. a take that is quiet
 *      while someone reads and busy while they scroll. One window cannot price
 *      two contents, so the probe now under-promises there instead of promising
 *      six times the file — the safe direction (B1's whole point is never to
 *      show a size the export will not deliver), and not yet the right answer.
 *      TWO CHEAPER FIXES WERE BUILT, MEASURED AND REFUSED, so nobody re-walks
 *      them: (a) SCALING the measured delta by the source's activity ratio —
 *      the source is encoded at a bitrate TARGET, which spends its budget
 *      evenly and compresses the dynamic range, so it called the busy window
 *      0.448x the take's average where the exported file called it 0.132x, 3.4x
 *      apart; it only ever gets a third of the way. Only the ORDERING of the
 *      source's bytes survives that compression, which is exactly what
 *      choosing a window needs and scaling one does not. (b) FEEDING THE LANES
 *      SIDE BY SIDE (`Promise.all` instead of one at a time) — three runs each:
 *      12,986 / 11,139 / 11,098 ms in turn against 14,118 / 16,999 / 15,607 ms
 *      in parallel, 40 % SLOWER, four hardware encoder sessions contending on
 *      an 8 GB machine.
 *      THE WALL, and it is the one gate this task did not meet. Split by
 *      `wallMs`/`composeMs`/`encodeMs`: the encode is 70-80 % of it, and it is
 *      the hardware encoder, not scheduling. A probe encodes a whole GOP at
 *      every step: 300 frames x (0.52 + 0.92 + 2.07 + 3.69 Mpx) = 2.16 Gpx,
 *      against the ~385 Mpx/s this machine measures for its own AVC encoder at
 *      mount (B14) — a 5.6 s floor, 4.1 s in the product's usual three-lane
 *      shape where the 1080p step packet-copies. The <2 s budget is therefore
 *      not reachable while the probe encodes a GOP per step, and the measured
 *      lever is ONE GOP instead of two (`warmPass: false`): wall 13.5 -> 3.4 s,
 *      residual text 0.96 -> 0.91x, motion 1.03 -> 1.00x, bimodal 0.54 -> 0.50x.
 *      It is not taken here because it spends the accuracy this whole task was
 *      about on a budget nothing in the product derives — the panel opens
 *      instantly and the number lands late — but it is one flag away if the
 *      budget ever earns itself.
 *
 * Everything is in memory (BufferTarget), so a probe leaves nothing on disk.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  type VideoSample,
} from 'mediabunny'
import { frameAspectFor, frameForAspect, frameScale } from '@core/frame'
import { takeRate } from '@core/rate'
import { blobStore } from '@core/store'
import {
  cameraPoseAt,
  cameraTrackIsActive,
  channelSourceTimeAt,
  outputDurationMs as outputDurationOf,
  outputToRecordingMs,
} from '@core/timeline'
import type { EditState, Recording } from '@core/types'
import { copySourceForTier } from './quality'
import { AUDIO_BITRATE, RENDER_ENCODER_OPTIONS } from '@core/compose/codecs'
import { keyframeIntervalSec } from '@core/compose/keyframeInterval'
import {
  constantQualityCodec,
  constantQualityQp,
  markConstantQuality,
  registerConstantQualityEncoder,
} from '@core/compose/constantQuality'
import { drawVideoFrame, type FrameCanvas } from '@core/compose/layout'
import {
  cappedTierBitrate,
  isDefaultTier,
  type QualityTier,
  type SizeEstimate,
} from '@core/compose/quality'
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
  /**
   * WHERE THE WALL WENT (B1b). The budget is under two seconds and the whole
   * of this task's remaining work is spending less, so the split is measured
   * rather than argued: `composeMs` is decoding the channels and drawing the
   * output frame, `encodeMs` is handing that frame to every step's encoder.
   */
  composeMs: number
  encodeMs: number
  /**
   * How much busier the take is than the seconds the probe encoded, from the
   * raw channels' own packet sizes. 1.00 means the window it chose is the
   * take's average one. REPORTED, NEVER APPLIED — see `chooseWindow`.
   */
  activity: number
  /** 'activity' when the profile chose the window, 'middle' when it could not. */
  chosenBy: 'activity' | 'middle'
  /** What reading the index cost, ms — it is part of the budget too. */
  activityMs: number
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
 *
 * F15 MAKES IT A DURATION RATHER THAN A COUNT. A GOP is 5 SECONDS, not 150
 * frames — at 60 fps a 150-frame window is half a GOP, and half a GOP priced as
 * a whole one over-counts keyframes and would make every 60 fps step's estimate
 * read high. So the window is `GOP_SECONDS x the take's rate`, which is exactly
 * 150 on every 30 fps take and therefore on every take this probe was measured
 * against. It costs twice the frames on a 60 fps take, and that is what pricing
 * twice the frames costs.
 */
/** Read, never frozen: the estimate has to model the grid the render will use. */
const gopSeconds = (): number => keyframeIntervalSec()

/**
 * IS THE PROBE'S TEN SECONDS THE TAKE'S TEN SECONDS? (B1b, 2026-09-04)
 *
 * The probe encodes ONE window and prices the whole file from it, and that is
 * the last thing in it that can be wrong: a still page's cost is not constant.
 * Measured on the 160 s text fixture, the RENDERED file's own mean delta by
 * ten-second bucket ran 824 to 1,770 B — a factor of two across one take of one
 * content. A window landing at the top of that band prices the file half again
 * too high, which is exactly the 1.50x this task was authored on.
 *
 * The correction costs no encoding at all, because the take already carries a
 * measurement of its own activity: the RAW channels are encoded streams, and
 * how many bytes each of their frames took is readable from the container index
 * with `metadataOnly` — no decode, no payload read. So compare what the source
 * spent in the probe's window with what it spent over the whole take, and scale
 * the measured delta by the ratio.
 *
 * IT IS A RATIO OF ONE ENCODER AGAINST ITSELF, which is why it is allowed to
 * exist while "predict the export's bytes from the composite's bytes" (F7b) was
 * not: nothing here claims the source's bytes and the export's bytes are the
 * same, only that when the source's frames get twice as expensive, so do the
 * export's. And it is CLAMPED — a correction that can multiply by five is a new
 * failure mode wearing a fix's clothes.
 */
/** Output seconds per activity bin — the grid the window is chosen on. */
const ACTIVITY_BIN_SEC = 1

/**
 * AND IT IS BOUNDED, because the walk is per PACKET and a take is not.
 * 160 s of 30 fps costs 91-366 ms here; Robert's own 124-minute take is 46x
 * that many packets, and a profile nobody waited for is worse than no profile.
 * Past this budget the walk is abandoned and the window goes back to the middle
 * of the take — exactly what it was before, said out loud in `chosenBy`.
 */
const ACTIVITY_BUDGET_MS = 500

interface WindowChoice {
  /** Where to start the probe's window, output seconds. */
  atSec: number
  /** takeMean / windowMean of the chosen window, from the source's own bytes. */
  activity: number
  /** What the walk cost. */
  ms: number
  /** 'activity' when the profile decided it, 'middle' when it could not. */
  chosenBy: 'activity' | 'middle'
}

/**
 * WHERE THE WINDOW GOES, and it used to be "the middle of the take" for no
 * reason but symmetry.
 *
 * A still page's cost is not constant: on the 160 s text fixture the RENDERED
 * file's own mean delta ran 824-1,770 B by ten-second bucket, a factor of two
 * inside one take of one content, and a window landing at the top of that band
 * prices the whole file half again too high. That is the 1.50x this task was
 * authored on, and it is a SAMPLING error — the probe's encode of its own
 * seconds matches the render's to 1.00-1.09x (B1b, 2026-09-04).
 *
 * So choose the seconds instead of taking the middle ones, using a measurement
 * the take already carries and no encoding at all: the raw channels ARE encoded
 * streams, and what each of their frames cost is in the container index,
 * readable with `metadataOnly` — no decode, no payload. Bin those bytes per
 * output second, and take the window whose mean is CLOSEST TO THE TAKE'S.
 *
 * ONLY THE ORDERING IS TRUSTED, and that is the point. The source is encoded at
 * a bitrate TARGET, which spends its budget evenly and so compresses the
 * dynamic range: on a deliberately bimodal fixture the source called a busy
 * window 0.448x the take's average where the exported file called it 0.132x —
 * 3.4x apart. Scaling the measured delta by that ratio was built, measured and
 * REFUSED for exactly this reason. What survives the compression is which
 * stretch is busier than which, and picking a middling one needs nothing more.
 */
async function chooseWindow(
  recording: Recording,
  edit: EditState,
  durationSec: number,
  windowSec: number,
): Promise<WindowChoice> {
  const t0 = performance.now()
  const middle = Math.max(0, Math.min(Math.max(0, durationSec / 2 - windowSec / 2), durationSec - windowSec))
  const bins = Math.max(1, Math.ceil(durationSec / ACTIVITY_BIN_SEC))
  const bytes = new Float64Array(bins)
  const frames = new Float64Array(bins)
  let any = false
  let overBudget = false
  for (const channel of recording.channels) {
    if (channel.media !== 'video') continue
    if (overBudget) break
    let input: Input | null = null
    try {
      const blob = await blobStore.read(channel.blobKey)
      input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
      const track = await input.getPrimaryVideoTrack()
      if (!track) continue
      // Local time → bytes, one pass. Keyframes are excluded: the probe prices
      // keyframes with its own, and a source keyframe is a cadence artefact of
      // the recorder rather than a statement about the content.
      const localBytes = new Map<number, { b: number; n: number }>()
      const sink = new EncodedPacketSink(track)
      let seen = 0
      for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
        // The clock is read once every 512 packets, not once per packet: the
        // budget must not cost more than the thing it is bounding.
        if ((seen++ & 511) === 0 && performance.now() - t0 > ACTIVITY_BUDGET_MS) {
          overBudget = true
          break
        }
        if (p.type === 'key') continue
        const sec = Math.floor(p.timestamp / ACTIVITY_BIN_SEC)
        const row = localBytes.get(sec) ?? { b: 0, n: 0 }
        row.b += p.byteLength ?? 0
        row.n++
        localBytes.set(sec, row)
      }
      // A PARTIAL PROFILE IS NOT A CHEAP PROFILE, it is a profile of the take's
      // first seconds — which would pick a window from wherever the walk
      // happened to stop. Throw it away rather than choose from it.
      if (overBudget || localBytes.size === 0) continue
      // …and local time is not output time the moment there is a trim, so every
      // output bin asks the timeline where it came from.
      for (let i = 0; i < bins; i++) {
        const localMs = channelSourceTimeAt(recording, edit, channel.id, i * ACTIVITY_BIN_SEC * 1000)
        if (localMs === null) continue
        const row = localBytes.get(Math.floor(localMs / 1000 / ACTIVITY_BIN_SEC))
        if (!row) continue
        bytes[i] += row.b
        frames[i] += row.n
        any = true
      }
    } catch {
      /* an unreadable channel simply does not vote */
    } finally {
      input?.dispose()
    }
  }
  const ms = Math.round(performance.now() - t0)
  const span = Math.max(1, Math.round(windowSec / ACTIVITY_BIN_SEC))
  if (overBudget || !any || bins < span + 1) return { atSec: middle, activity: 1, ms, chosenBy: 'middle' }
  let totalB = 0
  let totalN = 0
  for (let i = 0; i < bins; i++) {
    totalB += bytes[i]!
    totalN += frames[i]!
  }
  if (!(totalN > 0) || !(totalB > 0)) return { atSec: middle, activity: 1, ms, chosenBy: 'middle' }
  const takeMean = totalB / totalN
  const lastStart = Math.max(0, Math.floor(durationSec - windowSec))
  // AWAY FROM THE START WHERE THERE IS ROOM, which is the one thing the old
  // "take the middle" rule got right: the first frames of a capture are often a
  // blank surface, and the file's own encoder is still warming through its
  // first GOP, so those seconds cost the RENDER more than they cost a probe
  // opening a fresh encoder on them.
  const firstStart = Math.min(gopSeconds(), lastStart)
  let bestStart = Math.round(middle)
  let bestMean = takeMean
  let bestGap = Number.POSITIVE_INFINITY
  let winB = 0
  let winN = 0
  for (let i = 0; i < bins; i++) {
    winB += bytes[i]!
    winN += frames[i]!
    if (i >= span) {
      winB -= bytes[i - span]!
      winN -= frames[i - span]!
    }
    if (i < span - 1) continue
    const start = (i - span + 1) * ACTIVITY_BIN_SEC
    if (start > lastStart) break
    if (start < firstStart || winN <= 0) continue
    const mean = winB / winN
    const gap = Math.abs(mean - takeMean)
    if (gap < bestGap) {
      bestGap = gap
      bestStart = start
      bestMean = mean
    }
  }
  return {
    atSec: Math.max(0, Math.min(bestStart, lastStart)),
    activity: bestMean > 0 ? takeMean / bestMean : 1,
    ms,
    chosenBy: 'activity',
  }
}

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
  /** Steps whose size is exact because they packet-copy — never encoded here. */
  const skippedExact: string[] = []
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
    // F13: "the take's own geometry" is now literally that — the 1080p step's
    // pixel budget at the take's aspect, which is 1920x1080 on every 16:9 take
    // and therefore on every take this probe was measured against.
    const composeBox = frameForAspect(frameAspectFor(recording), 1920)
    const canvas = new OffscreenCanvas(composeBox.width, composeBox.height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return null
    const frame: FrameCanvas = {
      ctx,
      width: composeBox.width,
      height: composeBox.height,
      scale: frameScale(composeBox.width, composeBox.height),
    }
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
    // F15: the take's own rate, so a window is a GOP whatever the rate is.
    const rate = takeRate(recording)
    const windowFrames = Math.round(gopSeconds() * rate)
    const totalFrames = warmPass ? 2 * windowFrames : windowFrames
    const windowSec = totalFrames / rate
    // WHERE, decided by the take's own activity rather than by the clock.
    const choice = await chooseWindow(recording, edit, durationSec, windowSec)
    const atSec = choice.atSec
    sampledAtSec.push(Math.round(atSec * 100) / 100)

    for (const tier of tiers) {
      // A STEP THAT PACKET-COPIES ALREADY KNOWS ITS SIZE EXACTLY, so encoding
      // 300 frames to estimate it is pure waste — and the panel does not even
      // use the answer: it says "that size is the file, not a guess" and shows
      // ChannelRecording.bytes (O3c). Skipping these is not a lost measurement,
      // it is a measurement that was never needed.
      // It matters most where it costs most: F18's Source step is the take's
      // own resolution, so on a 3024x1964 take this lane alone was encoding 300
      // frames of 5.9 Mpx — the bulk of the sixteen-second probe that runs
      // right before the user presses record again.
      if (copySourceForTier(recording, tier)) {
        skippedExact.push(tier.id)
        continue
      }
      const lane = openLane(
        tier,
        () => boundarySec,
        await constantQualityFor(tier),
        // B1b: THE BITRATE THE EXPORT WILL ACTUALLY BE GIVEN. `tier.videoBitrate`
        // is the declared ceiling; every real export is configured with
        // `settingsForTier`, which bounds it by what this take needed
        // (cappedTierBitrate). On the take that exposed this the two were
        // 14.00 and 3.50 Mbps — the probe was pricing a step at four times the
        // budget the render gets.
        cappedTierBitrate(tier, recording),
      )
      if (lane) lanes.push(lane)
    }
    if (lanes.length === 0) return null
    for (const lane of lanes) await lane.output.start()

    let composed = 0
    let composeMs = 0
    let encodeMs = 0
    for (let f = 0; f < totalFrames; f++) {
      if (aborted()) return null
      const t = atSec + f / rate
      // Past the end of the take there is nothing to measure. Stopping short is
      // honest; repeating the last frame is not — every mean below would then be
      // diluted by however much of the window fell off the end, which is exactly
      // the defect the spike shipped with.
      if (t > durationSec - 0.01) break
      const c0 = performance.now()
      const bitmap = await composeAt(frame, readers, recording, edit, t, cameraFull, cameraMoves)
      composeMs += performance.now() - c0
      if (!bitmap) break
      const e0 = performance.now()
      try {
        // ONE LANE AT A TIME, AND THAT IS THE FAST WAY — measured, against the
        // obvious guess (B1b, 2026-09-04). The lanes share nothing but the
        // frame, so feeding all four with `Promise.all` looks free and reads
        // like the wall should fall from the SUM of their backpressure to the
        // longest of them. It does the opposite: three runs each, same fixture,
        // same machine, encode 12,986 / 11,139 / 11,098 ms in turn against
        // 14,118 / 16,999 / 15,607 ms side by side — 40 % SLOWER. Four hardware
        // encoder sessions contending on an 8 GB machine cost more than they
        // save. Do not re-try it without re-measuring it.
        for (const lane of lanes) await addFrame(lane, bitmap, f % windowFrames === 0)
      } finally {
        encodeMs += performance.now() - e0
        bitmap.close()
      }
      composed = f + 1
      // Set before the second GOP's first frame is added, so a packet that
      // lands late still lands on the right side of the boundary.
      if (composed === windowFrames) boundarySec = windowFrames / rate - 1e-6
    }
    if (composed < 2) return null

    const steps: Record<string, StepMeasurement> = {}
    for (const lane of lanes) {
      const measured = await closeLane(lane)
      if (measured) steps[lane.tier.id] = measured
    }
    if (Object.keys(steps).length === 0) return null
    const wallMs = Math.round(performance.now() - t0)
    // One line, always: this is a MEASUREMENT the user is shown, so what it
    // actually measured has to be readable from a real take's console.
    console.info(
      `[quality] size probe: ${composed} frames from ${atSec.toFixed(1)}s of ${durationSec.toFixed(1)}s ` +
        `in ${wallMs} ms (compose ${Math.round(composeMs)} + encode ${Math.round(encodeMs)} + window ${choice.ms}) ` +
        `· window by ${choice.chosenBy}, the take is ${choice.activity.toFixed(2)}x as busy as it — ` +
        Object.values(steps)
          .map(
            (m) =>
              `${m.tierId} first ${m.firstKeyframeBytes}/${m.firstDeltaBytes} later ${m.laterKeyframeBytes}/${m.laterDeltaBytes}`,
          )
          .join(' · ') +
        (skippedExact.length
          ? ` · not encoded (their size is the file, not an estimate): ${skippedExact.join(', ')}`
          : ''),
    )
    return {
      steps,
      sampledAtSec,
      wallMs,
      composeMs: Math.round(composeMs),
      encodeMs: Math.round(encodeMs),
      activity: choice.activity,
      chosenBy: choice.chosenBy,
      activityMs: choice.ms,
    }
  } catch (err) {
    console.warn('[quality] size calibration failed, falling back to the estimate', err)
    return null
  } finally {
    for (const lane of lanes) {
      if (lane.output.state !== 'finalized' && lane.output.state !== 'canceled') {
        // THE SOURCE OWNS A VideoEncoder AND MUST BE CLOSED, NOT JUST THE
        // OUTPUT. `closeLane` closes both on the success path; this one
        // cancelled the muxer and walked away from the encoder, so every
        // ABANDONED probe stranded one hardware encoder per tier — and a probe
        // is abandoned every time the editor is left before it finishes, which
        // on a long take is sixteen seconds of work nobody waits for.
        // F18 made it worse by adding a fifth tier.
        // Why it matters beyond tidiness: the next take's picker and encoders
        // then open against a browser still holding those, and load at picker
        // time is a documented trigger of the screen wedge
        // (docs/SCREEN_WEDGE.md). Robert, 2026-08-30: "chrome screen and mic
        // wedges happend every second record after reopening chrome".
        try {
          lane.source.close()
        } catch {
          /* already closed by closeLane on the success path */
        }
        await lane.output.cancel().catch(() => undefined)
      }
    }
    for (const r of readers) r.dispose()
  }
}

/**
 * THE RATE CONTROL THE EXPORT ACTUALLY USES — B1b, 2026-09-01.
 *
 * The probe's own note says its encoder must be the export's encoder, and it
 * stopped being one the day constant quality shipped: render.ts drops the
 * bitrate target and drives the QP (CQ_DEFAULT 20), while this file kept
 * configuring `bitrate: tier.videoBitrate`. Those are not two settings of one
 * encoder, they are two different questions — a bitrate target SPENDS its
 * budget, a quantizer spends what the picture needs — and the gap is whatever
 * the content is easier than the budget.
 *
 * MEASURED, on a 159.6 s still-text take exported at 1440p: the probe promised
 * 64.92 MB, the file came out 21.51 MB, 3.02x. The model it replaced said 19.92
 * MB on the same take. So the panel was LESS accurate for having measured —
 * priced by a rate control the product no longer uses.
 *
 * Resolved per tier, because the codec string is per resolution, and returned
 * as the same two fields render.ts passes. Null everywhere constant quality is
 * unavailable, which is exactly where the render also keeps its bitrate target.
 */
async function constantQualityFor(
  tier: QualityTier,
): Promise<{ fullCodecString: string; onEncoderConfig: (c: VideoEncoderConfig) => void } | null> {
  const qp = constantQualityQp()
  if (qp === null) return null
  const codec = await constantQualityCodec('avc', tier.width, tier.height)
  if (!codec) return null
  // AND THE ENCODER ITSELF. Marking the config does nothing on its own: the QP
  // is honoured by a CUSTOM encoder mediabunny only uses once it is registered,
  // which render.ts does and this did not. Without this line the probe marked a
  // config nobody read and encoded against the bitrate target — measured on the
  // 159.6 s text take, that alone is the difference between a delta of 9,296 B
  // and the render's own 2,357 B. Idempotent, and this module runs on the main
  // thread while the render runs in a worker with its own registry.
  registerConstantQualityEncoder()
  return { fullCodecString: codec, onEncoderConfig: markConstantQuality(qp) }
}

function openLane(
  tier: QualityTier,
  boundary: () => number,
  cq: { fullCodecString: string; onEncoderConfig: (c: VideoEncoderConfig) => void } | null,
  bitrate: number,
): TierLane | null {
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
    bitrate,
    // THE PROBE'S ENCODER MUST BE THE EXPORT'S ENCODER, and a hand-rolled
    // config is not: the render passes RENDER_ENCODER_OPTIONS. Pricing the same
    // pixels with a different encoder is the exact mistake F7b made with the
    // composite, one level down.
    ...RENDER_ENCODER_OPTIONS,
    // B1b: and the same RATE CONTROL. The bitrate above stays as the fallback's
    // target, exactly as render.ts keeps it; where constant quality is on, the
    // QP is what decides the bytes and the probe has to be priced by it too.
    ...(cq ?? {}),
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
  const gopSec = gopSeconds()
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
