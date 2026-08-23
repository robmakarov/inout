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
 * The number below is set from measurement, not taste: `npm run exp -- o11`
 * renders the same take across a cadence ladder and reports the size delta and
 * the keyframe share behind it. Raise it only with a fresh run in hand.
 */
export const KEYFRAME_INTERVAL_SEC = 2

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
