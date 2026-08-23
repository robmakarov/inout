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

export type QualityTierId = '720p' | '1080p' | '1440p'

export interface QualityTier {
  id: QualityTierId
  label: string
  width: number
  height: number
  fps: number
  videoBitrate: number
}

/** Bitrates scale with pixel count from the 1080p default (8 Mbps). */
export const QUALITY_TIERS: QualityTier[] = [
  { id: '720p', label: '720p', width: 1280, height: 720, fps: 30, videoBitrate: 4_000_000 },
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
}

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
  if (!src || src.pixels <= 0) return { bytes: Math.round(ceiling + audioBytes), fromSource: false }

  const tierPixels = tier.width * tier.height
  const scaled = src.bytesPerSec * Math.sqrt(tierPixels / src.pixels) * seconds
  return { bytes: Math.round(Math.min(ceiling, scaled) + audioBytes), fromSource: true }
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
