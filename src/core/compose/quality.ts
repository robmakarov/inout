/**
 * Export quality steps (task F7, ladder widened by F7b).
 *
 * The default tier is the current settings, and it MUST keep the instant
 * packet-copy path — a user who does not touch the slider pays nothing for its
 * existence. Every other tier re-encodes, and the UI says so rather than
 * letting the export silently take a hundred times longer.
 *
 * Size estimates: our encoder targets a fixed bitrate, so output is
 * min(what the content needs, what the bitrate allows). Estimating from the
 * bitrate alone overshoots badly on simple content (a waveform render spends
 * ~1 Mbps of an 8 Mbps budget), and estimating from the source alone ignores
 * the ceiling. So take the smaller of the two, with the source term scaled off
 * this very take's own encoded size — the best evidence available about how
 * compressible its content is.
 *
 * Scaling is by the SQUARE ROOT of the pixel ratio, not the ratio itself.
 * Content-limited encoding does not double in size when you double the pixels:
 * measured on a 6 s take whose composite is 1920×1080, the same content came
 * out 1.61 MB at 720p, 1.99 MB at 1080p and 2.61 MB at 1440p — pixel ratios of
 * 0.44 / 1 / 1.78 against size ratios of 0.81 / 1 / 1.31, which √ tracks and
 * linear does not (linear was −40 % and +36 % out). F7b measured the limits of
 * that model on other content — see the note above estimateExportBytes.
 */
import { AUDIO_BITRATE, VIDEO_BITRATE } from './codecs'
import { chooseCopySource, type CopySource } from './copySource'
import { frameAspectFor, frameForAspect, sourceResEnabled } from '@core/frame'
import { DEFAULT_FRAME_RATE, normalizeRate, takeRate } from '@core/rate'
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings, type Recording } from '@core/types'

export type QualityTierId = '540p' | '720p' | '1080p' | '1440p' | 'source'

export interface QualityTier {
  id: QualityTierId
  label: string
  width: number
  height: number
  fps: number
  videoBitrate: number
  /**
   * WHAT THE STEP ACTUALLY IS (task F13): a pixel budget, expressed as the
   * frame's long edge. `width`/`height` below are that budget resolved against
   * 16:9 — the shape every take had before F13 and the shape every take still
   * has until the frame follows the source. `resolveTier` re-resolves them
   * against a take's own aspect and is the identity on 16:9.
   */
  longEdge: number
  /** Honest one-liner for this step, shown when it is selected. */
  note?: string
}

/**
 * THE TOP STEP, AND IT HAS NO NUMBER OF ITS OWN — task F18, Robert: "i want
 * 3024x1964 or whatever users resolution is".
 *
 * `longEdge: 0` is the sentinel for "this take's own", resolved by
 * `resolveTier` against the long edge `tiersForTake` measures off the take. It
 * cannot be a constant: "source" is a different number on every machine, which
 * is exactly why the remembered step is an ID and not a size — a 3024-wide take
 * followed by a 1920-wide one has to survive, and it does, because the id
 * re-resolves against whatever take is in hand.
 *
 * The bitrate is a bits-per-pixel scale of 1440p's, applied by `resolveTier`
 * from the nominal below — the same rule every other step's ceiling follows.
 */
export const SOURCE_TIER: QualityTier = {
  id: 'source',
  label: 'Source',
  width: 2560,
  height: 1440,
  longEdge: 0,
  fps: DEFAULT_EXPORT_SETTINGS.fps,
  videoBitrate: 14_000_000,
  // NO PROMISE HERE. The panel appends the PATH's own verdict underneath this
  // line ("INSTANT … that size is the file" or "Re-renders …"), and O3c's rule
  // is that the badge is the path's to give. A note claiming "no re-encode"
  // sat on prod directly above the panel saying it re-renders.
  note: 'Your screen’s own resolution, exactly as it was recorded.',
}

/**
 * THE STEPS ARE RESOLUTION, NOT BITRATE (task F7b, measured 2026-08-23 with
 * `npm run exp -- o11` on a 12 s screen-like take, every size demuxed out of
 * the rendered file):
 *
 *   540p    582 KB          720p  1,134 KB  (+94.9 % on the step below)
 *   900p  1,896 KB (+67.1 %)  1080p  2,767 KB (+45.9 %)  1440p  3,755 KB (+35.7 %)
 *
 * Every adjacent pair is 35–95 % apart, far past F7b's "adjacent steps must
 * differ by more than the estimator's ±20 % band" rule. BITRATE rungs at a
 * fixed resolution were measured too and REJECTED as steps: at 1080p the same
 * content came out 2.77 MB at the 8 Mbps ceiling, 2.20 MB at 3 Mbps and
 * 1.72 MB at 1.5 Mbps — and the achieved rate was only 1.84 Mbps at the top
 * ceiling, so those rungs are not "less bitrate", they are the encoder being
 * squeezed below what the content needs. That is a quality lever wearing a
 * size label, and O9 (text sharpness) owns it.
 *
 * 900p WAS a step and was DROPPED on its own evidence: it is the one rung the
 * size estimator misses, +29.0 % and +30.5 % on two production-rig runs where
 * every other step landed inside ±20 %. A step whose number is noise is worse
 * than no step, which is exactly F7b's own rule.
 *
 * Bitrate ceilings still scale with pixel count so a busy take cannot blow
 * past its step.
 */
export const QUALITY_TIERS: QualityTier[] = [
  {
    id: '540p',
    label: '540p',
    width: 960,
    height: 540,
    longEdge: 960,
    fps: 30,
    videoBitrate: 2_000_000,
    note: 'Smallest file. Fine for a talking head; small screen text will be soft.',
  },
  { id: '720p', label: '720p', width: 1280, height: 720, longEdge: 1280, fps: 30, videoBitrate: 4_000_000 },
  {
    id: '1080p',
    label: '1080p',
    width: DEFAULT_EXPORT_SETTINGS.width,
    height: DEFAULT_EXPORT_SETTINGS.height,
    longEdge: DEFAULT_EXPORT_SETTINGS.width,
    fps: DEFAULT_EXPORT_SETTINGS.fps,
    videoBitrate: VIDEO_BITRATE,
  },
  { id: '1440p', label: '1440p', width: 2560, height: 1440, longEdge: 2560, fps: 30, videoBitrate: 14_000_000 },
]

export const DEFAULT_TIER_ID: QualityTierId = '1080p'

/**
 * This step at THIS take's aspect and rate (tasks F13, F15).
 *
 * The step keeps its name, its long edge and its bits-per-pixel; only the shape
 * and the rate move. The bitrate ceiling is re-scaled by the pixel ratio AND by
 * the rate ratio, for the same reason it differs between steps at all — a
 * taller or a faster frame at the same ceiling would be a quieter encode
 * wearing the same label. Both scales are LINEAR, which is the convention this
 * ceiling already used for pixels (the √ elsewhere in this file belongs to the
 * SIZE ESTIMATE, a different quantity). A ceiling is generous on purpose:
 * squeezing an encoder below what its content needs is a quality lever wearing
 * a size label, and this file refuses those as steps.
 *
 * IDEMPOTENT AND THE IDENTITY ON A 16:9 30 fps TAKE: it is computed from
 * `longEdge`, the aspect and the rate, never from the width/height/fps it is
 * replacing, so resolving twice changes nothing and resolving the take this
 * product made before F13 and F15 returns this exact tier.
 */
export function resolveTier(
  tier: QualityTier,
  aspect: number,
  fps: number = DEFAULT_FRAME_RATE,
  /** F18: the take's OWN pixels, for the step that has no size of its own.
   *  Ignored by every other step. */
  source: SourceStep | null = null,
): QualityTier {
  // F18: THE SOURCE STEP TAKES THE TAKE'S PIXELS VERBATIM and never goes
  // through the aspect — see SourceStep for the two-pixel drift that cost the
  // packet copy on prod. With no take in hand it stays the declared 1440p box,
  // so a caller that never learned about the source step still gets a valid
  // tier rather than a 0x0 one.
  const exact = tier.longEdge === 0 ? source : null
  const { width, height } = exact
    ? { width: exact.width, height: exact.height }
    : frameForAspect(aspect, tier.longEdge === 0 ? tier.width : tier.longEdge)
  const rate = normalizeRate(fps)
  if (width === tier.width && height === tier.height && rate === tier.fps) return tier
  const nominal = tier.width * tier.height * tier.fps
  return {
    ...tier,
    width,
    height,
    fps: rate,
    videoBitrate: Math.round((tier.videoBitrate * (width * height * rate)) / nominal),
  }
}

/**
 * The four steps as this take would export them, and THE ONE PLACE a step is
 * resolved against a shape. `aspect` overrides what the recording claims — the
 * editor passes what its decoder actually opened, which is the only statement
 * about a take's shape that cannot be wrong (F13).
 *
 * The RATE is never overridden that way and is always the take's own (F15):
 * unlike shape, nothing downstream re-measures it — the take's files carry the
 * rate they were written at, and that is the only claim there is.
 *
 * Byte-identical to QUALITY_TIERS whenever the frame does not follow the source
 * and the take was recorded at 30.
 */
export function tiersForTake(recording: Recording, aspect?: number): QualityTier[] {
  const a = aspect ?? frameAspectFor(recording)
  const rate = takeRate(recording)
  const tiers = QUALITY_TIERS.map((t) => resolveTier(t, a, rate))
  const source = sourceStepFor(recording)
  return source ? [...tiers, resolveTier(SOURCE_TIER, a, rate, source)] : tiers
}

/**
 * DOES THIS TAKE GET A SOURCE STEP, AND HOW BIG — task F18.
 *
 * Two conditions, and the second one is the one that keeps this honest.
 *
 * 1. The take is actually bigger than the ladder's top. Otherwise "Source"
 *    would be a duplicate of a step already on the list, or worse, smaller than
 *    one — a step that is not a step.
 *
 * 2. THE STEP CAN ACTUALLY BE DELIVERED AT THAT SIZE. The composite is written
 *    at 1920 whatever the screen was, so the only thing that holds a take's own
 *    resolution is the RAW channel, and the only path that hands it over
 *    untouched is O3c's single-generation packet copy — which needs exactly one
 *    video channel. A screen+camera take therefore gets NO source step, and
 *    that refusal is the feature: offering one would promise 3024 and hand back
 *    the 1920 composite upscaled, which is the badge disagreeing with the path
 *    — the exact bug shape O3c's wiring exists to make impossible, and the one
 *    F13 hit when `allowComposite` silently meant "1920x1080".
 *
 * Returns 0 for "no source step".
 */
export function sourceStepFor(recording: Recording): SourceStep | null {
  if (!sourceResEnabled()) return null
  const video = recording.channels.filter((c) => c.media === 'video')
  if (video.length !== 1) return null
  const ch = video[0]!
  const w = ch.width ?? 0
  const h = ch.height ?? 0
  if (!(w > 0) || !(h > 0)) return null
  const top = QUALITY_TIERS.reduce((m, t) => Math.max(m, t.longEdge), 0)
  return Math.max(w, h) > top ? { width: w, height: h } : null
}

/**
 * THE TAKE'S OWN PIXELS, NOT A RECONSTRUCTION OF THEM — and this pair exists
 * because a long edge alone was not enough. Every other step is a pixel budget
 * resolved against the take's ASPECT (F13), which is right for them: 1440p is a
 * size we chose and the shape follows the take. The source step is the opposite
 * — the SIZE is the take's and there is nothing to resolve.
 *
 * Going through the aspect lost it. A 3024x1964 channel has aspect 1.53971…,
 * and `frameForAspect(1.53971…, 3024)` comes back 3024x1962: two pixels of
 * float drift, which is enough for the copy fence to refuse the raw channel and
 * send the whole take to a full render. Found on prod, where the panel said
 * "Re-renders the whole video at 3024x1962" directly underneath a note
 * promising no re-encode.
 */
export interface SourceStep {
  width: number
  height: number
}

export function tierById(id: string | null | undefined): QualityTier {
  // F18: 'source' is remembered like any other id. It resolves to a real size
  // only once a take is in hand (`tiersForTake`); on its own it answers the
  // declared 1440p box, which is what a caller with no take can use.
  if (id === 'source') return SOURCE_TIER
  return QUALITY_TIERS.find((t) => t.id === id) ?? QUALITY_TIERS.find((t) => t.id === DEFAULT_TIER_ID)!
}

/** True when this tier is exactly the default export settings. */
export function isDefaultTier(tier: QualityTier): boolean {
  return tier.id === DEFAULT_TIER_ID
}

/**
 * The copy source THIS tier's export would use, or null (O3c). This is the
 * panel's and the estimator's question — "is this step instant, and is its
 * number the file?" — answered by the same function the export ladder answers
 * it with, so the badge and the path can never disagree about capability.
 * (An edit can still demote instant to smart cut or the render; that half is
 * the ladder's at export time, as it always was.)
 */
export function copySourceForTier(recording: Recording, tier: QualityTier): CopySource | null {
  // The tier is taken AS GIVEN — `tiersForTake` is the one place a step is
  // resolved against a take's shape, and re-resolving here would quietly
  // disagree with a caller that resolved against a better answer (the editor's
  // measured aspect, F13). The badge must be the path's own verdict.
  return chooseCopySource(recording, settingsForTier(tier), {
    allowComposite: isDefaultTier(tier),
  }).source
}

/**
 * What this step asks the export for. Passing the recording resolves the step
 * against the take's own shape first (F13) — omit it and the step answers with
 * the landscape box it was declared as, which is what every caller without a
 * take in hand wants.
 */
export function settingsForTier(tier: QualityTier, recording?: Recording): ExportSettings {
  // F18: the source step MUST be re-resolved with the take's own long edge
  // here too. Without it a 'source' tier resolves to its declared 1440p box and
  // the export asks for 1440p while the panel says Source — the badge and the
  // path disagreeing, which is the one failure this whole area is built to
  // prevent.
  const t = recording
    ? resolveTier(tier, frameAspectFor(recording), takeRate(recording), sourceStepFor(recording))
    : tier
  return {
    width: t.width,
    height: t.height,
    fps: t.fps,
    // Bounded by what this take actually needed — see cappedTierBitrate. With
    // no recording in hand there is nothing to bound it with, and the declared
    // ceiling stands.
    videoBitrate: recording ? cappedTierBitrate(t, recording) : t.videoBitrate,
  }
}

/** Bytes per second the take's own video already needed, and at what size. */
function sourceVideoRate(recording: Recording): { bytesPerSec: number; pixels: number } | null {
  const durationSec = recording.durationMs / 1000
  if (durationSec <= 0) return null
  if (recording.composite && recording.composite.width && recording.composite.height) {
    // The composite is the closest thing to what an export looks like.
    const bytes = recording.composite.bytes
    if (bytes && bytes > 0) {
      return {
        bytesPerSec: bytes / durationSec,
        pixels: recording.composite.width * recording.composite.height,
      }
    }
  }
  // NO COMPOSITE IS NOW A NORMAL TAKE, not an odd one — max mode and native
  // resolution both stop recording it, because it is a second encode of a
  // picture the raw channel already holds. Before this, such a take had no
  // anchor at all and every size on the panel fell back to the MODEL, which is
  // what let a 3024x1964@60 export be advertised at 245 MB (Robert,
  // 2026-08-30, against ~20 MB for his usual take).
  // The biggest raw video channel is a better anchor than the model in every
  // case: it is this exact content, at a known size, already encoded once.
  const video = recording.channels.filter((c) => c.media === 'video' && c.width && c.height && c.bytes)
  let best: { bytesPerSec: number; pixels: number } | null = null
  for (const c of video) {
    const px = (c.width ?? 0) * (c.height ?? 0)
    const secs = (c.durationMs || recording.durationMs) / 1000
    if (px <= 0 || secs <= 0 || !c.bytes) continue
    if (!best || px > best.pixels) best = { bytesPerSec: c.bytes / secs, pixels: px }
  }
  return best
}

/**
 * WHAT THE ENCODER MAY BE ASKED FOR, bounded by what this take actually needed.
 *
 * `resolveTier` scales a step's bitrate ceiling LINEARLY by pixels and by rate
 * from a 1440p/30 anchor. That was measured at 1080p and 1440p and is fine
 * there; extrapolated to 3024x1964 at 60 it asks for 45 Mbps — a 645 MB ceiling
 * for two minutes, against a standing objective of "couple minutes video can be
 * around 10 mb with good quality". Robert's take came back advertised at 245 MB
 * and the render that followed froze his machine and failed.
 *
 * The take itself is the better authority: its own raw channel encoded THIS
 * content, at a known size, once already. So the ceiling is capped at that rate
 * scaled to the output's pixels, with generous headroom — a re-render legitimately
 * costs more than a capture (it is a second generation, and an edit can add
 * motion the capture never had), but not five times more.
 *
 * Never raises a ceiling, only lowers it: a take with no measurable source keeps
 * exactly the number it had before this existed.
 */
export const RERENDER_HEADROOM = 2

export function cappedTierBitrate(tier: QualityTier, recording: Recording): number {
  const src = sourceVideoRate(recording)
  if (!src || src.pixels <= 0 || src.bytesPerSec <= 0) return tier.videoBitrate
  const outPixels = tier.width * tier.height
  const scaled = src.bytesPerSec * 8 * (outPixels / src.pixels) * RERENDER_HEADROOM
  // A floor so a nearly-static take cannot squeeze a busy edit down to nothing:
  // the model is still the authority on how little is too little.
  const floor = tier.videoBitrate / 4
  return Math.round(Math.max(floor, Math.min(tier.videoBitrate, scaled)))
}

export interface SizeEstimate {
  bytes: number
  /** True when the estimate came from this take's own encoded size. */
  fromSource: boolean
  /** True when this step IS the composite (the instant copy) and the number is
   *  therefore the file itself, not a prediction. */
  exact: boolean
}

/**
 * HOW GOOD IS THE NUMBER — measured 2026-08-23, and it is worse than F7's own
 * gate suggested, because F7 only ever measured it on one kind of content.
 *
 * The DEFAULT step is exact: an unedited take copies the composite's packets,
 * so the shown size is the composite's own size plus a certified audio track.
 *
 * Every re-encoding step is a prediction from that composite, and the composite
 * was made by a different encoder. On a still, text-heavy screen take
 * MediaRecorder's AVC spends 0.97 Mbps where the export's AVC spends 1.84 Mbps
 * for the same pixels, so the prediction came in 47 % LOW at 1440p. On
 * full-motion content the two encoders agree within 7 % and the same model is
 * within 8 %. Worse, the way size follows resolution is content-dependent too:
 * text scales about linearly with pixel count (detail is thrown away), motion
 * scales like √ (the bits are spent on change, not detail), and the composite's
 * keyframe share separates the two cases cleanly (68.8 % vs 1.1 %).
 *
 * So F7b's "±20 % on every step" gate is NOT met by any model that only reads
 * the composite, and no exponent tweak fixes it — the missing quantity is how
 * the EXPORT encoder prices this content, which nothing short of encoding it
 * can know. The follow-on with a chance of meeting it is a single-frame
 * calibration probe (encode one frame of the take at each step, compare it
 * with the composite's mean keyframe) — designed, not built. Until then the
 * number stays marked as an estimate and the ladder is honest about it.
 */

export function estimateExportBytes(
  recording: Recording,
  tier: QualityTier,
  outputDurationMs: number,
): SizeEstimate {
  // The tier is taken AS GIVEN: `tiersForTake` resolved it against the take's
  // shape, and a second opinion here could only disagree with the step the
  // panel is showing and the export will use.
  const seconds = Math.max(0, outputDurationMs / 1000)
  const hasAudio = recording.channels.some((c) => c.media === 'audio')
  const audioBytes = hasAudio ? (AUDIO_BITRATE / 8) * seconds : 0
  const ceiling = (tier.videoBitrate / 8) * seconds

  // O3c: a tier that packet-copies a single RAW channel is exact the same way
  // the default tier is — the number is that file's own byte rate, not a
  // model. This also corrects the default step on a single-generation take,
  // where the file copied is the raw channel and not the composite.
  const single = copySourceForTier(recording, tier)
  if (single?.origin === 'single-generation' && single.durationMs > 0) {
    const channelBytes = recording.channels.find((c) => c.id === single.channelId)?.bytes
    if (channelBytes && channelBytes > 0) {
      const rate = channelBytes / (single.durationMs / 1000)
      return { bytes: Math.round(rate * seconds + audioBytes), fromSource: true, exact: true }
    }
  }

  const src = sourceVideoRate(recording)
  if (!src || src.pixels <= 0) {
    return { bytes: Math.round(ceiling + audioBytes), fromSource: false, exact: false }
  }

  const tierPixels = tier.width * tier.height
  // The default step does not re-encode: the composite's own video bytes ARE
  // the file's video bytes, so there is nothing to model.
  if (isDefaultTier(tier) && tierPixels === src.pixels) {
    return {
      bytes: Math.round(src.bytesPerSec * seconds + audioBytes),
      fromSource: true,
      exact: true,
    }
  }
  const scaled = src.bytesPerSec * Math.sqrt(tierPixels / src.pixels) * seconds
  return { bytes: Math.round(Math.min(ceiling, scaled) + audioBytes), fromSource: true, exact: false }
}

const PREFS_KEY = 'inout.export.tier'

export function loadQualityTier(): QualityTier {
  try {
    return tierById(localStorage.getItem(PREFS_KEY))
  } catch {
    return tierById(DEFAULT_TIER_ID)
  }
}

export function saveQualityTier(tier: QualityTier): void {
  try {
    localStorage.setItem(PREFS_KEY, tier.id)
  } catch {
    /* storage unavailable — the slider still works for this session */
  }
}
