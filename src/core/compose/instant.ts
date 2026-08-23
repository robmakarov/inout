/**
 * Instant + certified export (the WebCodecs-v2 path 4637bca deferred).
 *
 * For an UNEDITED take the live composite already holds the exact default
 * composition (screen contain + camera PiP) as encoded H.264. So we COPY its
 * video packets straight into a fresh MP4 — no decode, no re-encode, near
 * instant — and mux them with an audio track mixed through the SAME certified
 * mixer the full render uses (openAudioChannel + mixGainForChannels +
 * softLimitSample). That gives back instant export without the composite's
 * uncertified MediaRecorder audio, which was the pervasive-noise cause.
 *
 * Any edit (trim / disabled channel / global trim) still falls through to the
 * full render in pipeline.ts — which this file deliberately does not touch, so
 * the certified render path keeps its exact, oracle-gated behaviour.
 */
import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  getFirstEncodableAudioCodec,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'
import { blobStore } from '@core/store'
import type {
  ChannelRecording,
  EditState,
  ExportProgress,
  ExportResult,
  Recording,
} from '@core/types'
import {
  loudnessFromCaptureStats,
  makeupGainForLoudness,
  measureMixLoudness,
  mixGainForChannels,
  openAudioChannel,
  softLimitSample,
  type AudioChannelMixer,
} from './audio'
import { AUDIO_BITRATE, AUDIO_CHANNEL_COUNT, AUDIO_SAMPLE_RATE } from './codecs'
import { createExportScratch, type ExportScratch } from './scratch'

/**
 * A channel's active window on the output timeline. Kept local (mirrors
 * pipeline.activeOutputWindowMs) so the certified render file stays untouched;
 * the caller gates on isDefaultEdit, so in practice this is the full window.
 */
function activeOutputWindowMs(
  edit: EditState,
  channel: ChannelRecording,
): { outStartMs: number; outEndMs: number } | null {
  const ce = edit.channels.find((c) => c.channelId === channel.id)
  if (!ce || !ce.enabled) return null
  const localStartMs = Math.max(0, ce.trimStartMs)
  const localEndMs = Math.min(channel.durationMs, ce.trimEndMs)
  const outStartMs =
    Math.max(channel.startOffsetMs + localStartMs, edit.globalTrimStartMs) - edit.globalTrimStartMs
  const outEndMs =
    Math.min(channel.startOffsetMs + localEndMs, edit.globalTrimEndMs) - edit.globalTrimStartMs
  return outEndMs > outStartMs ? { outStartMs, outEndMs } : null
}

/** Open a certified mixer per enabled audio channel — used for both the render
 * and the loudness analysis pre-pass, kept identical so the measured peak
 * matches the mix. */
async function openAudioMixers(recording: Recording, edit: EditState): Promise<AudioChannelMixer[]> {
  const mixers: AudioChannelMixer[] = []
  for (const channel of recording.channels) {
    if (channel.media !== 'audio') continue
    const window = activeOutputWindowMs(edit, channel)
    if (!window) continue
    const blob = await blobStore.read(channel.blobKey)
    const localOffsetSec = (edit.globalTrimStartMs - channel.startOffsetMs) / 1000
    const mixer = await openAudioChannel(
      blob,
      channel.id,
      window.outStartMs / 1000,
      window.outEndMs / 1000,
      localOffsetSec,
    )
    if (mixer) mixers.push(mixer)
  }
  return mixers
}

function exportFileName(createdAt: number, ext: string): string {
  const d = new Date(createdAt)
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `inout-${date}-${time}${ext}`
}

export interface InstantExportOptions {
  recording: Recording
  edit: EditState
  onProgress?: (p: ExportProgress) => void
  signal?: AbortSignal
}

/**
 * Precondition (caller-checked): `recording.composite` exists and `edit` is the
 * default edit. Throws on any incompatibility (no composite video track, no
 * audio encoder, empty blob) so the caller can fall back to the full render.
 */
export async function exportInstant(opts: InstantExportOptions): Promise<ExportResult> {
  const { recording, edit, onProgress, signal } = opts
  const composite = recording.composite
  if (!composite) throw new Error('instant export: no composite')

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError')
  }
  const report = (phase: ExportProgress['phase'], ratio: number): void => {
    onProgress?.({ phase, ratio: Math.min(1, Math.max(0, ratio)) })
  }

  report('preparing', 0)
  throwIfAborted()

  const compBlob = await blobStore.read(composite.blobKey)
  if (compBlob.size === 0) throw new Error('instant export: composite blob empty')

  const input = new Input({ source: new BlobSource(compBlob), formats: ALL_FORMATS })
  const audioMixers: AudioChannelMixer[] = []
  let output: Output | null = null
  let scratch: ExportScratch | null = null
  try {
    // ---- video: copy the composite's encoded packets, no re-encode ----
    const videoTrack = await input.getPrimaryVideoTrack()
    if (!videoTrack) throw new Error('instant export: composite has no video track')
    const videoCodec = videoTrack.codec
    if (!videoCodec) throw new Error('instant export: unknown composite video codec')
    const decoderConfig = await videoTrack.getDecoderConfig()
    const packetSink = new EncodedPacketSink(videoTrack)

    // ---- audio: certified mixers over the (default) edit window ----
    const durationSec = composite.durationMs / 1000
    const totalAudioFrames = Math.round(durationSec * AUDIO_SAMPLE_RATE)
    audioMixers.push(...(await openAudioMixers(recording, edit)))
    const needAudio = audioMixers.length > 0
    // Same headroom rule as the render sum: single source stays full-scale;
    // multiple sources mix equal-power so mic + system audio can't clip.
    const baseGain = audioMixers.length > 1 ? mixGainForChannels(audioMixers.length) : 1
    for (const m of audioMixers) m.gain = baseGain

    // Loudness normalize — identical to the full render: measure SPEECH
    // loudness (p90 window RMS, transient-proof) on a throwaway set and drive
    // it to target. Without this the instant path would ship the same
    // near-inaudible voice the render path fixes.
    // O2: the certified mix's loudness was measured live during capture, so the
    // instant path no longer decodes every audio channel a second time just to
    // learn it. Takes without stats (recorded before O2, or on a browser whose
    // audio goes through MediaRecorder) fall back to the probe pass.
    if (needAudio) {
      const stored = loudnessFromCaptureStats(
        recording.loudness,
        audioMixers.map((m) => m.channelId),
        baseGain,
      )
      if (stored) {
        const makeup = makeupGainForLoudness(stored)
        if (makeup !== 1) for (const m of audioMixers) m.gain = baseGain * makeup
        console.info(
          `instant: audio loudness from capture stats p90rms ${stored.loudRms.toFixed(4)} peak ${stored.peak.toFixed(3)} → makeup ${makeup.toFixed(2)}× (no probe decode)`,
        )
      } else {
        const probe = await openAudioMixers(recording, edit)
        try {
          const loud = await measureMixLoudness(probe, baseGain, totalAudioFrames, throwIfAborted)
          const makeup = makeupGainForLoudness(loud)
          if (makeup !== 1) for (const m of audioMixers) m.gain = baseGain * makeup
          console.info(
            `instant: audio loudness p90rms ${loud.loudRms.toFixed(4)} peak ${loud.peak.toFixed(3)} → makeup ${makeup.toFixed(2)}×`,
          )
        } finally {
          for (const m of probe) m.dispose()
        }
      }
    }

    const audioCodec = needAudio
      ? await getFirstEncodableAudioCodec(['aac', 'opus'], {
          numberOfChannels: AUDIO_CHANNEL_COUNT,
          sampleRate: AUDIO_SAMPLE_RATE,
          bitrate: AUDIO_BITRATE,
        })
      : null
    if (needAudio && !audioCodec) throw new Error('instant export: no audio encoder available')

    const format = new Mp4OutputFormat()
    // Same O(1)-memory rule as the render path: packet-copying a 30-min take
    // into an ArrayBuffer was the instant path's own OOM.
    scratch = await createExportScratch()
    const bufferTarget = scratch ? null : new BufferTarget()
    const out = new Output({ format, target: scratch ? scratch.target : bufferTarget! })
    output = out
    const videoSource = new EncodedVideoPacketSource(videoCodec)
    out.addVideoTrack(videoSource)
    let audioSource: AudioBufferSource | null = null
    if (needAudio && audioCodec) {
      audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: AUDIO_BITRATE })
      out.addAudioTrack(audioSource)
    }
    await out.start()
    report('preparing', 0.1)

    // Copy every video packet (decode order). The first add carries the decoder
    // config (avcC) so the muxer can describe the copied H.264 track.
    let first = true
    for await (const packet of packetSink.packets()) {
      throwIfAborted()
      await videoSource.add(packet, first && decoderConfig ? { decoderConfig } : undefined)
      first = false
    }
    videoSource.close()
    report('rendering', 0.5)

    // Certified audio render, 1s chunks — identical math to the full render.
    if (audioSource) {
      const audioChunks = Math.max(1, Math.ceil(totalAudioFrames / AUDIO_SAMPLE_RATE))
      for (let c = 0; c < audioChunks; c++) {
        throwIfAborted()
        const startFrame = c * AUDIO_SAMPLE_RATE
        const frames = Math.min(AUDIO_SAMPLE_RATE, totalAudioFrames - startFrame)
        if (frames <= 0) break
        const left = new Float32Array(frames)
        const right = new Float32Array(frames)
        const chunkOutStartSec = startFrame / AUDIO_SAMPLE_RATE
        for (const mixer of audioMixers) await mixer.mixInto(left, right, chunkOutStartSec)
        for (let k = 0; k < frames; k++) {
          left[k] = softLimitSample(left[k])
          right[k] = softLimitSample(right[k])
        }
        const buffer = new AudioBuffer({
          length: frames,
          numberOfChannels: AUDIO_CHANNEL_COUNT,
          sampleRate: AUDIO_SAMPLE_RATE,
        })
        buffer.copyToChannel(left, 0)
        buffer.copyToChannel(right, 1)
        await audioSource.add(buffer)
        report('rendering', 0.5 + 0.45 * ((c + 1) / audioChunks))
      }
      audioSource.close()
    }

    report('finalizing', 0.97)
    await out.finalize()
    let blob: Blob
    if (scratch) {
      blob = await scratch.finish(format.mimeType)
    } else {
      const buffer = bufferTarget?.buffer
      if (!buffer) throw new Error('instant export: muxer produced no output')
      blob = new Blob([buffer], { type: format.mimeType })
    }
    report('finalizing', 1)

    return {
      blob,
      mimeType: format.mimeType,
      fileName: exportFileName(recording.createdAt, format.fileExtension),
      durationMs: composite.durationMs,
      width: composite.width,
      height: composite.height,
    }
  } catch (err) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => undefined)
    }
    // Includes the fall-through to the full render: no orphan scratch behind it.
    await scratch?.discard().catch(() => undefined)
    throw err
  } finally {
    for (const m of audioMixers) m.dispose()
    input.dispose()
  }
}
