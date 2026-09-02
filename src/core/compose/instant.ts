/**
 * Instant + certified export (the WebCodecs-v2 path 4637bca deferred).
 *
 * For an UNEDITED take some file on disk already holds the exact default
 * composition as encoded H.264. So we COPY its video packets straight into a
 * fresh MP4 — no decode, no re-encode, near instant — and mux them with an
 * audio track mixed through the SAME certified mixer the full render uses
 * (openAudioChannel + mixGainForChannels + softLimitSample). That gives back
 * instant export without the composite's uncertified MediaRecorder audio,
 * which was the pervasive-noise cause.
 *
 * WHICH file is compose/copySource.ts's decision, not this one's (task O3b).
 * It is usually the live composite. On a take with exactly one video channel
 * already at the export geometry it is that RAW CHANNEL instead — the same
 * picture one 4:2:0 generation earlier, which X15(d) measured as about a third
 * of the take's whole colour loss, for strictly less work. Everything below is
 * identical either way: this path copies packets and certifies audio, and it
 * has never cared where the packets came from.
 *
 * Any edit (trim / disabled channel / global trim) still falls through to the
 * full render in pipeline.ts — which this file deliberately does not touch, so
 * the certified render path keeps its exact, oracle-gated behaviour.
 */
import {
  ALL_FORMATS,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  EncodedPacket,
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
  makeStereoSample,
  makeupGainForLoudness,
  measureMixLoudness,
  mixGainForChannels,
  openAudioChannel,
  softLimitSample,
  type AudioChannelMixer,
} from './audio'
import { AUDIO_BITRATE, AUDIO_CHANNEL_COUNT, AUDIO_SAMPLE_RATE, VIDEO_BITRATE } from './codecs'
import { chooseCopySource, type CopySource } from './copySource'
import { compositeOffsetMs, copyPlacement } from './compositeTime'
import { BitsAudit, formatBits } from './bits'
import { buildCertification, certificationComment } from './certify'
import { createExportScratch, type ExportScratch } from './scratch'
import { exportFileName } from './fileName'

/** B9: float slack when testing a placed packet against output zero. One
 *  microsecond — finer than any timestamp this container can hold. */
const PLACE_EPS_SEC = 1e-6

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


export interface InstantExportOptions {
  recording: Recording
  edit: EditState
  /**
   * The file to copy packets out of. The caller normally passes what
   * compose/choose.ts already resolved, so the path it REPORTS and the path it
   * RAN cannot disagree; omitted, this resolves it the same way.
   */
  source?: CopySource
  onProgress?: (p: ExportProgress) => void
  signal?: AbortSignal
}

/**
 * Precondition (caller-checked): a copy source exists and `edit` is the
 * default edit. Throws on any incompatibility (no video track, no audio
 * encoder, empty blob) so the caller can fall back to the full render.
 */
export async function exportInstant(opts: InstantExportOptions): Promise<ExportResult> {
  const { recording, edit, onProgress, signal } = opts
  const source = opts.source ?? chooseCopySource(recording).source
  if (!source) throw new Error('instant export: nothing to copy')
  // P0-tail: the encoder was still behind when capture stopped, so this file is
  // missing an unknown amount of its end. Copying it would ship a take that
  // ends early — the exact thing Robert named as unacceptable. The caller falls
  // back to the full render from the raw channels: slower, and correct.
  // Same call the liveness work made for a frozen source.
  if (source.tailIncomplete) {
    throw new Error(`instant export: ${source.origin} tail incomplete (encoder did not drain)`)
  }

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError')
  }
  const report = (phase: ExportProgress['phase'], ratio: number): void => {
    onProgress?.({ phase, ratio: Math.min(1, Math.max(0, ratio)) })
  }

  report('preparing', 0)
  throwIfAborted()

  const compBlob = await blobStore.read(source.blobKey)
  if (compBlob.size === 0) throw new Error(`instant export: ${source.origin} blob empty`)

  const input = new Input({ source: new BlobSource(compBlob), formats: ALL_FORMATS })
  const audioMixers: AudioChannelMixer[] = []
  let output: Output | null = null
  let scratch: ExportScratch | null = null
  let certified: {
    makeup: number
    loudRms: number
    peak: number
    fromCaptureStats: boolean
  } | null = null
  try {
    // ---- video: copy the source's encoded packets, no re-encode ----
    const videoTrack = await input.getPrimaryVideoTrack()
    if (!videoTrack) throw new Error(`instant export: ${source.origin} has no video track`)
    const videoCodec = videoTrack.codec
    if (!videoCodec) throw new Error(`instant export: unknown ${source.origin} video codec`)
    const decoderConfig = await videoTrack.getDecoderConfig()
    const packetSink = new EncodedPacketSink(videoTrack)

    // ---- audio: certified mixers over the (default) edit window ----
    // P0-instant-sync: the audio is mixed from the RAW channels, whose clock is
    // the recording timeline, and the copied file's clock does not start where
    // that one does — a composite's begins when the first thing reached its
    // worker, a raw channel's at its own first frame. Both declare the
    // difference the same way (copySource.startOffsetMs). The output keeps the
    // recording's timeline — same convention as the render, which is the file
    // this one has to agree with — so the copied video is placed at its true
    // instant and the output covers the take from 0.
    //
    // B9 — THE OFFSET IS SIGNED, AND THE SHIFT IS FLOORED BY THE FILE ITSELF.
    // A composite whose clock started before the earliest raw channel declares
    // a NEGATIVE offset: its picture belongs EARLIER than where it sits in its
    // own file, and the old `> 0` placement left every one of those takes with
    // the picture 64-198 ms late against its own sound. The one thing that
    // cannot be represented is a packet before output zero, so the shift is
    // floored at the copied file's first KEY packet — which is also the first
    // packet of a well-formed track, so in practice nothing is dropped and the
    // whole declared lead is recovered (measured: the composite's video track
    // starts 133-300 ms into a file that leads by 64-198 ms). Whatever a
    // pathological file would push past that floor is given up here and said
    // out loud, rather than silently absorbed the way the clamp absorbed it.
    const declaredOffsetMs = compositeOffsetMs({ startOffsetMs: source.startOffsetMs })
    const placement =
      declaredOffsetMs < 0
        ? copyPlacement(
            declaredOffsetMs,
            (await packetSink.getFirstKeyPacket({ metadataOnly: true }))?.timestamp ?? null,
          )
        : copyPlacement(declaredOffsetMs, null)
    const compOffsetSec = placement.shiftSec
    if (declaredOffsetMs < 0) {
      console.info(
        `[export] instant: ${source.origin} leads the take by ${-declaredOffsetMs}ms — placing its picture ` +
          `${Math.round(-compOffsetSec * 1000)}ms earlier` +
          (placement.unrepresentableMs > 0
            ? ` (${placement.unrepresentableMs}ms unrepresentable, floored at the first key packet)`
            : ''),
      )
    }
    const compOffsetMs = compOffsetSec * 1000
    const outDurationMs = source.durationMs + compOffsetMs
    const durationSec = outDurationMs / 1000
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
        certified = { makeup, loudRms: stored.loudRms, peak: stored.peak, fromCaptureStats: true }
        console.info(
          `instant: audio loudness from capture stats p90rms ${stored.loudRms.toFixed(4)} peak ${stored.peak.toFixed(3)} → makeup ${makeup.toFixed(2)}× (no probe decode)`,
        )
      } else {
        const probe = await openAudioMixers(recording, edit)
        try {
          const loud = await measureMixLoudness(probe, baseGain, totalAudioFrames, throwIfAborted)
          const makeup = makeupGainForLoudness(loud)
          if (makeup !== 1) for (const m of audioMixers) m.gain = baseGain * makeup
          certified = { makeup, loudRms: loud.loudRms, peak: loud.peak, fromCaptureStats: false }
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
    out.setMetadataTags({
      title: 'INOUT recording',
      comment: certificationComment(
        buildCertification({
          recording,
          path: 'instant',
          copiedFrom: source.origin,
          settings: { width: source.width, height: source.height },
          audioChannels: audioMixers.length,
          makeup: certified?.makeup,
          loudRms: certified?.loudRms,
          peak: certified?.peak,
          fromCaptureStats: certified?.fromCaptureStats,
          codec: {
            container: format.mimeType,
            video: videoCodec,
            audio: needAudio && audioCodec ? audioCodec : undefined,
            // The GOP belongs to whichever encoder wrote the copied file —
            // MediaRecorder's to choose on a v1 composite — so it is recorded
            // as absent rather than asserted as 2 s.
          },
        }),
      ),
    })
    // O11a on the path users actually take: the packets are already in hand
    // here, so the composite's real keyframe share and achieved bitrate come
    // out of a real screen take instead of a synthetic render.
    const bits = new BitsAudit(VIDEO_BITRATE, 0)
    const videoSource = new EncodedVideoPacketSource(videoCodec)
    out.addVideoTrack(videoSource)
    let audioSource: AudioSampleSource | null = null
    if (needAudio && audioCodec) {
      audioSource = new AudioSampleSource({
        codec: audioCodec,
        bitrate: AUDIO_BITRATE,
        onEncodedPacket: (p) => bits.audio(p.byteLength),
      })
      out.addAudioTrack(audioSource)
    }
    await out.start()
    report('preparing', 0.1)

    // Copy every video packet (decode order). The first add carries the decoder
    // config (avcC) so the muxer can describe the copied H.264 track.
    let first = true
    let droppedBeforeZero = 0
    for await (const packet of packetSink.packets()) {
      throwIfAborted()
      // Bytes untouched — only the presentation time moves, and only when the
      // source declared an origin (old takes keep the exact packets they
      // always got, including their offset; nothing can recover their origin —
      // and a take that declares 0 keeps the very packet object it always got).
      const placedSec = packet.timestamp + compOffsetSec
      // B9: nothing may land before output zero. The shift was floored at the
      // first key packet, so the only packets this can reach are ones that sit
      // BEFORE their own track's first sync sample — undecodable where they
      // are, and dropping them leaves that key packet first, which is what the
      // muxed track has to open with.
      if (placedSec < -PLACE_EPS_SEC) {
        droppedBeforeZero++
        continue
      }
      const placed =
        compOffsetSec !== 0
          ? new EncodedPacket(
              packet.data,
              packet.type,
              Math.max(0, placedSec),
              packet.duration,
              packet.sequenceNumber,
            )
          : packet
      bits.video(placed.byteLength, placed.type)
      await videoSource.add(placed, first && decoderConfig ? { decoderConfig } : undefined)
      first = false
    }
    if (droppedBeforeZero > 0) {
      console.info(
        `[export] instant: dropped ${droppedBeforeZero} packet(s) that fell before the take's t=0`,
      )
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
        const sample = makeStereoSample(left, right, chunkOutStartSec)
        try {
          await audioSource.add(sample)
        } finally {
          sample.close()
        }
        report('rendering', 0.5 + 0.45 * ((c + 1) / audioChunks))
      }
      audioSource.close()
    }

    report('finalizing', 0.97)
    await out.finalize()
    console.info(
      formatBits(bits.summarize(durationSec), `instant copy ${videoCodec} from ${source.origin}`),
    )
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
      durationMs: outDurationMs,
      width: source.width,
      height: source.height,
      scratchKey: scratch?.key,
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
