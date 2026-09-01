/**
 * WHAT ONE SECOND OF A TAKE COSTS IN BYTES, AS THE PRODUCT ITSELF CONFIGURES IT.
 *
 * These were private to session.ts, which is in the lazy capture chunk and must
 * stay out of first paint. B5's pre-flight check runs on the IDLE capture
 * screen — before any take, before that chunk is warm — and it needs the same
 * numbers. Copying them would give the repo two homes for one fact and let them
 * drift the first time O11c moves the PiP number again; this file is the one
 * home, and session.ts reads it too.
 *
 * X6 reads the same function for its VideoEncoder bitrate, so a raw channel
 * costs the same whichever encoder writes it.
 */
import type { ChannelKind } from '@core/types'

/** The screen's raw channel. */
export const SCREEN_BITS = 8_000_000
/** A camera recorded as a corner PiP — O11c priced this one. */
export const CAMERA_PIP_BITS = 2_500_000
/** A camera that is the whole picture. */
export const CAMERA_FULL_BITS = 4_000_000
/** Every audio channel, both lanes (MediaRecorder aac and measured opus). */
export const AUDIO_BITS = 128_000
/** The live composite, when one is written beside the channels. */
export const COMPOSITE_BITS = 8_000_000

export function videoBitsFor(kind: ChannelKind, cameraIsPip: boolean): number {
  return kind === 'screen' ? SCREEN_BITS : kind === 'camera' && cameraIsPip ? CAMERA_PIP_BITS : CAMERA_FULL_BITS
}

/**
 * The bytes-per-second a take with these channels is CONFIGURED to write —
 * every raw channel plus the composite that is written beside them.
 *
 * It is a plan, not a measurement: a still screen codes far under its target
 * and a 60 fps game tab sits on it. B5 prefers this machine's own measured
 * history and falls back here, saying which it used, because a fresh profile
 * has no history and a full disk is still a full disk.
 */
export function plannedBytesPerSec(config: {
  screen: boolean
  camera: boolean
  mic: boolean
  systemAudio: boolean
  /** False on the single-generation capture path, where no composite is written. */
  composite?: boolean
}): number {
  const cameraIsPip = config.screen
  let bits = 0
  if (config.screen) bits += videoBitsFor('screen', cameraIsPip)
  if (config.camera) bits += videoBitsFor('camera', cameraIsPip)
  if (config.mic) bits += AUDIO_BITS
  if (config.systemAudio) bits += AUDIO_BITS
  if (config.composite !== false && (config.screen || config.camera)) {
    bits += COMPOSITE_BITS + (config.mic || config.systemAudio ? AUDIO_BITS : 0)
  }
  return bits / 8
}
