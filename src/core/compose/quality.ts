/**
 * Export quality tiers (task F7).
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
 * linear does not (linear was −40 % and +36 % out).
 */
import { AUDIO_BITRATE, VIDEO_BITRATE } from './codecs'
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings, type Recording } from '@core/types'

export type QualityTierId = '540p' | '720p' | '900p' | '1080p' | '1440p'

export interface QualityTier {
  id: QualityTierId
  label: string
  width: number
  height: number
  fps: number
  videoBitrate: number
  /** Honest one-liner for this step, shown when it is selected. */
  note?: string
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
 * Bitrate ceilings still scale with pixel count so a busy take cannot blow
 * past its step.
 */
export const QUALITY_TIERS: QualityTier[] = [
  {
    id: '540p',
    label: '540p',
    width: 960,
    height: 540,
    fps: 30,
    videoBitrate: 2_000_000,
    note: 'Smallest file. Fine for a talking head; small screen text will be soft.',
  },
  { id: '720p', label: '720p', width: 1280, height: 720, fps: 30, videoBitrate: 4_000_000 },
  { id: '900p', label: '900p', width: 1600, height: 900, fps: 30, videoBitrate: 6_000_000 },
  {
    id: '1080p',
    label: '1080p',
    width: DEFAULT_EXPORT_SETTINGS.width,
    height: DEFAULT_EXPORT_SETTINGS.height,
    fps: DEFAULT_EXPORT_SETTINGS.fps,
    videoBitrate: VIDEO_BITRATE,
  },
  { id: '1440p', label: '1440p', width: 2560, height: 1440, fps: 30, videoBitrate: 14_000_000 },
]

export const DEFAULT_TIER_ID: QualityTierId = '1080p'

export function tierById(id: string | null | undefined): QualityTier {
  return QUALITY_TIERS.find((t) => t.id === id) ?? QUALITY_TIERS.find((t) => t.id === DEFAULT_TIER_ID)!
}

/** True when this tier is exactly the default export settings. */
export function isDefaultTier(tier: QualityTier): boolean {
  return tier.id === DEFAULT_TIER_ID
}

export function settingsForTier(tier: QualityTier): ExportSettings {
  return {
    width: tier.width,
    height: tier.height,
    fps: tier.fps,
    videoBitrate: tier.videoBitrate,
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
  return null
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
  const seconds = Math.max(0, outputDurationMs / 1000)
  const hasAudio = recording.channels.some((c) => c.media === 'audio')
  const audioBytes = hasAudio ? (AUDIO_BITRATE / 8) * seconds : 0
  const ceiling = (tier.videoBitrate / 8) * seconds

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
