import {
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  WebMOutputFormat,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny'

export const VIDEO_BITRATE = 8_000_000
export const AUDIO_BITRATE = 128_000
export const AUDIO_SAMPLE_RATE = 48_000
export const AUDIO_CHANNEL_COUNT = 2

/**
 * Keyframe cadence of the RENDER path, seconds (task O11b).
 *
 * mediabunny's default is 2 s and nothing had ever overridden it, so this was
 * an unpriced choice. Keyframes are the one part of a video track that pays
 * full price for pixels that did not change, which is why they dominate a
 * static screen recording — and stretching the GOP changes no pixel, only how
 * coarsely a player can seek.
 *
 * MEASURED 2026-08-23, `npm run exp -- o11`, 12 s takes, sizes demuxed back out
 * of the exported files. On screen-like content (a still editor page that
 * scrolls) a keyframe costs 229 KB against a 5 KB delta frame, so at the 2 s
 * default 43.5 % of the video bytes were keyframes:
 *     1 s +41.6 % · 2 s baseline · 3 s −10.9 % · 5 s −23.8 % · 8 s −24.4 %
 * On full-motion content (a gradient repainting every pixel) the same ladder
 * moves the file by 0.3 % — nothing to win, and nothing to lose either.
 * PSNR against the 2 s render at three instants: 82-83 dB up to 5 s, 65 dB at
 * 8 s. Both are far above the ~45 dB where two files stop being the same
 * picture, which is the point: this changes no pixel, only how often the
 * encoder throws away its history.
 *
 * 5 s and not 8 s: 8 s buys another 0.6 pp and doubles the seek granularity a
 * player has to work with. This is the OUTPUT file's cadence only — the smart
 * cut in O5 needs a tight cadence on the CAPTURE encoder, which is O4's and
 * unaffected, and the instant path copies packets a MediaRecorder produced.
 */
export const KEYFRAME_INTERVAL_SEC = 5

/**
 * Encoder knobs the render passes straight through to WebCodecs (task O5).
 *
 * `hardwareAcceleration: 'prefer-hardware'` is the whole of the "hardware
 * decode+encode overlapped" half of O5 that is ours to ask for — the rest is
 * the pipeline in render.ts. It is a HINT: a platform without a hardware
 * encoder ignores it and encodes in software, exactly as before, which is why
 * it can be set unconditionally rather than probed.
 *
 * latencyMode stays 'quality' (the default) deliberately. 'realtime' is right
 * for CAPTURE, where a dropped frame beats a late one; an export has no clock
 * to keep and must not drop anything.
 */
export interface EncoderOptions {
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software'
  latencyMode?: 'quality' | 'realtime'
}

export const RENDER_ENCODER_OPTIONS: EncoderOptions = {
  hardwareAcceleration: 'prefer-hardware',
}

export interface EncodingTarget {
  format: OutputFormat
  videoCodec: VideoCodec
  audioCodec: AudioCodec
  mimeType: string
  /** Includes the leading dot, e.g. ".mp4". */
  fileExtension: string
  /** Which rung of the ladder this is, for the certification tag (O11d). */
  rung: string
  encoderOptions: EncoderOptions
}

interface FallbackChain {
  /** Name in the certification tag; also what the O11d evidence is keyed by. */
  rung: string
  makeFormat: () => OutputFormat
  video: VideoCodec
  audio: AudioCodec
  /**
   * Above the AVC floor a rung only counts if the platform encodes it in
   * HARDWARE: a software hevc/av1 encode is slower than the avc it replaces,
   * which loses O5's whole point to save bytes nobody asked to save.
   */
  hardwareOnly?: boolean
}

/**
 * The ladder, in preference order (task O5d, extending O11d).
 *
 * THE DEFAULT FILE STAYS AVC AND THAT IS A DECISION, NOT AN OVERSIGHT — the
 * rungs above the floor are present but not reachable unless a caller opts in
 * via `allowAboveFloor`. Verified 2026-08-23 and unchanged: the ENCODE side is
 * broad (Chrome 130+ hardware hevc, VideoToolbox, Safari) but real-world
 * DECODE of hevc is near-absent on Firefox/Edge and av1 is absent on pre-M3
 * Safari. Our file is BLIND-SHARED: no probe can ask the recipient what they
 * can play, so shipping a non-avc default trades a size win for a file that
 * some recipients cannot open at all.
 *
 * Where the recipient IS known the rung flips, and that is what this seam is
 * for: raw channels post-O4 (internal, no recipient) and the cloud player
 * (we control playback). `pickEncodingTarget(..., { allowAboveFloor: true })`
 * is how those callers ask, and the certification tag records which rung ran.
 */
const FALLBACK_CHAINS: FallbackChain[] = [
  { rung: 'av1-hw', makeFormat: () => new Mp4OutputFormat(), video: 'av1', audio: 'aac', hardwareOnly: true },
  { rung: 'hevc-hw', makeFormat: () => new Mp4OutputFormat(), video: 'hevc', audio: 'aac', hardwareOnly: true },
  { rung: 'avc', makeFormat: () => new Mp4OutputFormat(), video: 'avc', audio: 'aac' },
  { rung: 'avc-opus', makeFormat: () => new Mp4OutputFormat(), video: 'avc', audio: 'opus' },
  { rung: 'vp9-webm', makeFormat: () => new WebMOutputFormat(), video: 'vp9', audio: 'opus' },
]

/** The floor everything blind-shared lands on. Rungs before it are opt-in. */
const FLOOR_RUNG = 'avc'

export interface PickTargetOptions {
  /**
   * Let the ladder try the rungs ABOVE the avc floor. Only for files whose
   * recipient is known (internal channels, our own player) — never for a
   * download the user will send to someone we cannot probe.
   */
  allowAboveFloor?: boolean
}

/**
 * Is this codec encodable IN HARDWARE here? WebCodecs answers by refusing the
 * config outright when `hardwareAcceleration: 'require-hardware'` cannot be
 * met, which is a real probe and not a table.
 */
async function hasHardwareVideoEncoder(
  codec: VideoCodec,
  width: number,
  height: number,
  bitrate: number,
): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false
  const codecString = await getFirstEncodableVideoCodec([codec], { width, height, bitrate })
  if (!codecString) return false
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: HW_PROBE_STRINGS[codec] ?? '',
      width,
      height,
      bitrate,
      hardwareAcceleration: 'prefer-hardware',
    } as VideoEncoderConfig)
    return support.supported === true
  } catch {
    return false
  }
}

/**
 * Full codec strings for the hardware probe. isConfigSupported needs a
 * concrete string, and mediabunny's own probe only tells us the family is
 * encodable somehow. Kept minimal and conservative: main-profile rungs only.
 */
const HW_PROBE_STRINGS: Partial<Record<VideoCodec, string>> = {
  hevc: 'hvc1.1.6.L123.B0',
  av1: 'av01.0.08M.08',
}

/** Picks the first container/codec chain whose encoders this browser supports. */
export async function pickEncodingTarget(
  width: number,
  height: number,
  needAudio: boolean,
  videoBitrate: number = VIDEO_BITRATE,
  options: PickTargetOptions = {},
): Promise<EncodingTarget> {
  let reachedFloor = false
  for (const chain of FALLBACK_CHAINS) {
    if (chain.rung === FLOOR_RUNG) reachedFloor = true
    // Above the floor: skip entirely unless the caller owns the recipient.
    if (!reachedFloor && !options.allowAboveFloor) continue
    const video = await getFirstEncodableVideoCodec([chain.video], {
      width,
      height,
      bitrate: videoBitrate,
    })
    if (!video) continue
    if (chain.hardwareOnly && !(await hasHardwareVideoEncoder(chain.video, width, height, videoBitrate))) {
      console.info(`compose: ladder rung ${chain.rung} skipped — no hardware encoder here`)
      continue
    }
    if (needAudio) {
      const audio = await getFirstEncodableAudioCodec([chain.audio], {
        numberOfChannels: AUDIO_CHANNEL_COUNT,
        sampleRate: AUDIO_SAMPLE_RATE,
        bitrate: AUDIO_BITRATE,
      })
      if (!audio) continue
    }
    const format = chain.makeFormat()
    return {
      format,
      videoCodec: chain.video,
      audioCodec: chain.audio,
      mimeType: format.mimeType,
      fileExtension: format.fileExtension,
      rung: chain.rung,
      encoderOptions: RENDER_ENCODER_OPTIONS,
    }
  }
  throw new Error('No supported encoder configuration in this browser')
}
