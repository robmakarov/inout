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

export interface EncodingTarget {
  format: OutputFormat
  videoCodec: VideoCodec
  audioCodec: AudioCodec
  mimeType: string
  /** Includes the leading dot, e.g. ".mp4". */
  fileExtension: string
}

interface FallbackChain {
  makeFormat: () => OutputFormat
  video: VideoCodec
  audio: AudioCodec
}

const FALLBACK_CHAINS: FallbackChain[] = [
  { makeFormat: () => new Mp4OutputFormat(), video: 'avc', audio: 'aac' },
  { makeFormat: () => new Mp4OutputFormat(), video: 'avc', audio: 'opus' },
  { makeFormat: () => new WebMOutputFormat(), video: 'vp9', audio: 'opus' },
]

/** Picks the first container/codec chain whose encoders this browser supports. */
export async function pickEncodingTarget(
  width: number,
  height: number,
  needAudio: boolean,
  videoBitrate: number = VIDEO_BITRATE,
): Promise<EncodingTarget> {
  for (const chain of FALLBACK_CHAINS) {
    const video = await getFirstEncodableVideoCodec([chain.video], {
      width,
      height,
      bitrate: videoBitrate,
    })
    if (!video) continue
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
    }
  }
  throw new Error('No supported encoder configuration in this browser')
}
