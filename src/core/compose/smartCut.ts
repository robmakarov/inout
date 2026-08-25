/**
 * Smart cut — export a TRIMMED take without re-encoding what the trim did not
 * touch (task O5c).
 *
 * WHY THIS AND NOT MORE PIPELINING. O5 was written expecting the render loop
 * to be badly overlapped, and the stage split measured for this task says it
 * is not: on a 12 s 1080p edited take the loop spends 1295 ms waiting on
 * decode, 450 ms drawing and 28 ms waiting on the encoder, against a
 * decode-ONLY floor of 962 ms for the same frames. There is no scheduling win
 * left — the render costs what it costs to decode every frame. The only way
 * past that floor is to decode fewer frames, and a trim-only edit needs to
 * decode almost none of them: the composite already holds exactly the pixels
 * the output wants, so most of the output is a byte copy.
 *
 * WHAT MAKES IT SAFE. A cut lands wherever the user put it, which is almost
 * never on a keyframe, so each kept span splits in two:
 *
 *     [span start .. next keyframe)      RE-ENCODED (decode + encode)
 *     [next keyframe .. span end)        COPIED, packet for packet
 *
 * Both halves live in ONE video track, and an MP4 track has ONE decoder
 * configuration — the avcC that carries H.264's SPS/PPS. Copied packets were
 * produced by the capture encoder and re-encoded ones by this encoder, so the
 * file is only correct if those two agree byte for byte about their parameter
 * sets. That is not assumed here, it is PROBED: the re-encoder's emitted
 * description is compared with the composite's before a single packet is
 * written, and a mismatch throws so the caller falls back to the full render.
 * We can afford to be strict because the capture encoder is ours (O4's v2
 * engine is a WebCodecs VideoEncoder), so matching its config is a matter of
 * asking for the same thing rather than a matter of luck.
 *
 * The audio is NOT copied. It is mixed and encoded exactly as the render and
 * the instant path mix it — same mixers, same loudness normalize, same limiter
 * — because audio is cheap, cuts need the join fade, and a second audio path
 * is how a certified pipeline stops being certified.
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
  VideoSampleSink,
  type VideoSample,
  type InputVideoTrack,
} from 'mediabunny'
import { blobStore } from '@core/store'
import { backgroundIsActive } from './background'
import {
  cameraTrackIsActive,
  hasSpeedChange,
  keptSegments,
  outputDurationMs,
  segmentJoinsMs,
  viewportTrackIsActive,
} from '@core/timeline'
import type { EditState, ExportProgress, ExportResult, Recording } from '@core/types'
import {
  busGainFor,
  loudnessFromCaptureStats,
  makeStereoSample,
  makeupGainForLoudness,
  measureMixLoudness,
  openAudioMixers,
  softLimitSample,
  type MixSource,
} from './audio'
import { AUDIO_BITRATE, AUDIO_CHANNEL_COUNT, AUDIO_SAMPLE_RATE, VIDEO_BITRATE } from './codecs'
import { BitsAudit, formatBits } from './bits'
import { buildCertification, certificationComment } from './certify'
import { compositeOffsetMs, recordingToCompositeSec } from './compositeTime'
import { createExportScratch, type ExportScratch } from './scratch'

/** Half-width of the fade at every cut join — identical to the render (F1). */
const JOIN_FADE_MS = 3

/** Timestamps within this of each other are the same instant (half a frame). */
const EPS_SEC = 1 / 120

export class SmartCutUnavailable extends Error {
  constructor(reason: string) {
    super(`smart cut: ${reason}`)
    this.name = 'SmartCutUnavailable'
  }
}

/**
 * True when the edit changes WHICH PARTS of the take are shown but not what
 * any of them looks like — the precondition for copying the composite's own
 * packets.
 *
 * This is deliberately NOT isDefaultEdit with the time bits removed: it is the
 * same list of pixel-changing features (note 9), asked about the composite.
 * Every one of them makes isDefaultEdit false too, so an edit that passes here
 * and has no cuts would already have taken the instant path.
 */
export function isPixelDefaultEdit(recording: Recording, edit: EditState): boolean {
  if (cameraTrackIsActive(edit.camera)) return false
  if (backgroundIsActive(edit.background)) return false
  if (viewportTrackIsActive(edit.viewport)) return false
  // A sped span is not a time SELECTION, it is a resampling of the material —
  // packets cannot be copied through it.
  if (hasSpeedChange(edit)) return false
  for (const c of recording.channels) {
    // Audio channels may be trimmed or disabled freely: the audio is re-mixed
    // from the raw channels either way, and the composite's own audio is never
    // used (it is not the certified mix).
    if (c.media !== 'video') continue
    const ce = edit.channels.find((x) => x.channelId === c.id)
    if (!ce) continue
    // A trimmed or disabled VIDEO channel changes the composition — the
    // composite still shows it, so its packets are the wrong pixels.
    if (!ce.enabled || ce.trimStartMs > 0 || ce.trimEndMs < c.durationMs) return false
  }
  return true
}

function exportFileName(createdAt: number, ext: string): string {
  const d = new Date(createdAt)
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `inout-${date}-${time}${ext}`
}

function sameBytes(a: AllowSharedBufferSource | undefined, b: AllowSharedBufferSource | undefined): boolean {
  if (!a || !b) return false
  const x = a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(ArrayBuffer.isView(a) ? a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) : a)
  const y = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(ArrayBuffer.isView(b) ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b)
  if (x.byteLength !== y.byteLength) return false
  for (let i = 0; i < x.byteLength; i++) if (x[i] !== y[i]) return false
  return true
}

/**
 * Re-encodes the frames of one span head — the part between the cut and the
 * next keyframe, which cannot be copied because its first frame is not a
 * keyframe.
 *
 * The encoder is configured from the COMPOSITE's own decoder config, and its
 * first emitted description is checked against it. That check is the whole
 * safety argument of this file and it runs before any packet is written.
 */
class BoundaryEncoder {
  private encoder: VideoEncoder | null = null
  private readonly out: { chunk: EncodedVideoChunk; keyFrame: boolean }[] = []
  private error: Error | null = null
  private configChecked = false

  constructor(
    private readonly config: VideoEncoderConfig,
    private readonly expectedDescription: AllowSharedBufferSource | undefined,
  ) {}

  private ensure(): VideoEncoder {
    if (this.encoder) return this.encoder
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (!this.configChecked) {
          this.configChecked = true
          const got = meta?.decoderConfig?.description
          if (!sameBytes(got, this.expectedDescription)) {
            // The two encoders describe their bitstreams differently, so the
            // one avcC this track can carry would be wrong for half the file.
            // Refuse rather than ship a video that decodes to garbage after
            // every cut — the caller renders it properly instead.
            this.error = new SmartCutUnavailable(
              'boundary encoder produced a different decoder description than the composite',
            )
            return
          }
        }
        this.out.push({ chunk, keyFrame: chunk.type === 'key' })
      },
      error: (e) => {
        this.error = e instanceof Error ? e : new Error(String(e))
      },
    })
    encoder.configure(this.config)
    this.encoder = encoder
    return encoder
  }

  encode(frame: VideoFrame, keyFrame: boolean): void {
    this.ensure().encode(frame, { keyFrame })
  }

  async drain(): Promise<EncodedPacket[]> {
    if (this.encoder) await this.encoder.flush()
    if (this.error) throw this.error
    const packets = this.out.map(({ chunk }) => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      return new EncodedPacket(
        data,
        chunk.type === 'key' ? 'key' : 'delta',
        (chunk.timestamp ?? 0) / 1e6,
        (chunk.duration ?? 0) / 1e6,
      )
    })
    this.out.length = 0
    return packets
  }

  close(): void {
    try {
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close()
    } catch {
      /* already gone */
    }
    this.encoder = null
  }
}

export interface SmartCutOptions {
  recording: Recording
  edit: EditState
  onProgress?: (p: ExportProgress) => void
  signal?: AbortSignal
}

export interface SmartCutStats {
  spans: number
  copiedPackets: number
  copiedBytes: number
  reencodedFrames: number
  /** Frames the full render would have decoded and encoded for this output. */
  totalFrames: number
  /** 1 − reencoded/total: how much of the video never touched a codec. */
  copiedFraction: number
}

let lastStats: SmartCutStats | null = null
export function getLastSmartCutStats(): SmartCutStats | null {
  return lastStats
}

/**
 * Export a cut/trimmed take by copying the composite's packets wherever the
 * edit did not change the pixels. Throws SmartCutUnavailable whenever anything
 * is not exactly right, so the caller falls back to the certified render.
 */
export async function exportSmartCut(opts: SmartCutOptions): Promise<ExportResult> {
  const { recording, edit, onProgress, signal } = opts
  const composite = recording.composite
  if (!composite) throw new SmartCutUnavailable('no composite')
  if (composite.tailIncomplete) throw new SmartCutUnavailable('composite tail incomplete')
  // A BOUNDARY SPLICE NEEDS AN ENCODER WE OWN. v1's composite comes from
  // MediaRecorder, whose avcC we cannot reproduce, so the byte-for-byte
  // description check below would refuse it after decoding and encoding a
  // GOP's worth of frames for nothing — measured on the v1 oracle:
  // "boundary encoder produced a different decoder description". Refuse here
  // instead, cheaply and with a reason that says what actually happened.
  if (composite.engine === 'v1') {
    throw new SmartCutUnavailable('composite was recorded by MediaRecorder (v1) — its decoder description is not ours to match')
  }
  if (!isPixelDefaultEdit(recording, edit)) throw new SmartCutUnavailable('edit changes pixels')

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError')
  }
  const report = (phase: ExportProgress['phase'], ratio: number): void => {
    onProgress?.({ phase, ratio: Math.min(1, Math.max(0, ratio)) })
  }

  report('preparing', 0)
  const compBlob = await blobStore.read(composite.blobKey)
  if (compBlob.size === 0) throw new SmartCutUnavailable('composite blob empty')

  const input = new Input({ source: new BlobSource(compBlob), formats: ALL_FORMATS })
  const audioMixers: MixSource[] = []
  let output: Output | null = null
  let scratch: ExportScratch | null = null
  let boundary: BoundaryEncoder | null = null
  const stats: SmartCutStats = {
    spans: 0,
    copiedPackets: 0,
    copiedBytes: 0,
    reencodedFrames: 0,
    totalFrames: 0,
    copiedFraction: 0,
  }

  try {
    const videoTrack: InputVideoTrack | null = await input.getPrimaryVideoTrack()
    if (!videoTrack) throw new SmartCutUnavailable('composite has no video track')
    const videoCodec = videoTrack.codec
    if (!videoCodec) throw new SmartCutUnavailable('unknown composite video codec')
    const decoderConfig = await videoTrack.getDecoderConfig()
    if (!decoderConfig) throw new SmartCutUnavailable('composite has no decoder config')
    // Only in-band-parameterless codecs where we can compare descriptions are
    // in scope. avc is what the composite is, by O11d's standing decision.
    if (videoCodec !== 'avc') throw new SmartCutUnavailable(`composite codec ${videoCodec} not supported`)

    const packetSink = new EncodedPacketSink(videoTrack)
    const frameSink = new VideoSampleSink(videoTrack)
    const width = composite.width
    const height = composite.height
    // P0-instant-sync: smart cut copies the same composite the instant path
    // does, so it inherited the same wrong assumption — that composite time is
    // recording time. It is not; the file declares where its zero sits.
    const compOffsetMs = compositeOffsetMs(composite)

    // ---- audio: the certified mix over the edited window, exactly as the
    // render builds it (openAudioMixers already understands kept spans) ----
    const durationMs = outputDurationMs(edit)
    if (durationMs <= 0) throw new SmartCutUnavailable('export window is empty')
    const durationSec = durationMs / 1000
    const totalAudioFrames = Math.round(durationSec * AUDIO_SAMPLE_RATE)
    audioMixers.push(...(await openAudioMixers(recording, edit, throwIfAborted)))
    const needAudio = audioMixers.length > 0
    const baseGain = busGainFor(audioMixers)
    for (const m of audioMixers) m.gain = baseGain

    let certified: { makeup: number; loudRms: number; peak: number; fromCaptureStats: boolean } | null =
      null
    if (needAudio) {
      // A cut changes the mix, so the capture-time shortcut does not describe
      // it — same rule the render applies (O2). Probe.
      const probe = await openAudioMixers(recording, edit, throwIfAborted)
      try {
        const loud = await measureMixLoudness(probe, baseGain, totalAudioFrames, throwIfAborted, (r) =>
          report('preparing', 0.05 * r),
        )
        const makeup = makeupGainForLoudness(loud)
        if (makeup !== 1) for (const m of audioMixers) m.gain = baseGain * makeup
        certified = { makeup, loudRms: loud.loudRms, peak: loud.peak, fromCaptureStats: false }
      } finally {
        for (const m of probe) m.dispose()
      }
      void loudnessFromCaptureStats
    }

    const audioCodec = needAudio
      ? await getFirstEncodableAudioCodec(['aac', 'opus'], {
          numberOfChannels: AUDIO_CHANNEL_COUNT,
          sampleRate: AUDIO_SAMPLE_RATE,
          bitrate: AUDIO_BITRATE,
        })
      : null
    if (needAudio && !audioCodec) throw new SmartCutUnavailable('no audio encoder available')

    // ---- the boundary encoder, configured to match the composite exactly ----
    boundary = new BoundaryEncoder(
      {
        codec: decoderConfig.codec,
        width,
        height,
        bitrate: VIDEO_BITRATE,
        latencyMode: 'realtime',
        avc: { format: 'avc' },
      } as VideoEncoderConfig,
      decoderConfig.description,
    )

    const format = new Mp4OutputFormat()
    scratch = await createExportScratch()
    const bufferTarget = scratch ? null : new BufferTarget()
    const out = new Output({ format, target: scratch ? scratch.target : bufferTarget! })
    output = out
    out.setMetadataTags({
      title: 'INOUT recording',
      comment: certificationComment(
        buildCertification({
          recording,
          path: 'render',
          settings: { width, height },
          audioChannels: audioMixers.length,
          makeup: certified?.makeup,
          loudRms: certified?.loudRms,
          peak: certified?.peak,
          fromCaptureStats: certified?.fromCaptureStats,
          cuts: Math.max(0, keptSegments(edit).length - 1),
          codec: {
            container: format.mimeType,
            video: videoCodec,
            audio: needAudio && audioCodec ? audioCodec : undefined,
            rung: 'avc-smartcut',
          },
        }),
      ),
    })
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

    // ---- video: span by span ----
    let first = true
    let outCursorSec = 0
    const spans = keptSegments(edit)
    stats.spans = spans.length
    for (const span of spans) {
      throwIfAborted()
      // KEPT SPANS ARE RECORDING TIME; THE COMPOSITE HAS ITS OWN CLOCK, and it
      // starts compOffsetMs into the take (P0-instant-sync). Everything below
      // works in COMPOSITE time — negative means the span begins before the
      // composite's first frame, which is a real hole in it, not a reason to
      // slide its first frame backwards.
      const spanStartSec = recordingToCompositeSec(span.startMs / 1000, compOffsetMs)
      const spanEndSec = Math.min(
        recordingToCompositeSec(span.endMs / 1000, compOffsetMs),
        composite.durationMs / 1000,
      )
      if (spanEndSec <= spanStartSec) continue
      /** The earliest instant the composite can actually answer for. */
      const readFromSec = Math.max(0, spanStartSec)
      if (spanEndSec <= readFromSec) {
        outCursorSec += spanEndSec - spanStartSec
        continue
      }
      /** Composite time → this export's output time. */
      const outAt = (compSec: number): number => outCursorSec + (compSec - spanStartSec)

      // Where copying may begin: the first key packet at or after the cut.
      const keyAtStart = await packetSink.getKeyPacket(readFromSec, { metadataOnly: true })
      let copyFrom = keyAtStart
      if (!copyFrom || copyFrom.timestamp < readFromSec - EPS_SEC) {
        // The cut is mid-GOP: copying can only start at the NEXT keyframe, and
        // the frames in between have to be re-encoded.
        copyFrom = keyAtStart
          ? await packetSink.getNextKeyPacket(keyAtStart, { metadataOnly: true })
          : await packetSink.getFirstKeyPacket({ metadataOnly: true })
      }
      const reencodeUntilSec =
        copyFrom && copyFrom.timestamp < spanEndSec ? copyFrom.timestamp : spanEndSec

      // (1) the head: decode the frames the copy cannot reach, re-encode them.
      if (reencodeUntilSec > readFromSec + EPS_SEC) {
        let firstOfHead = true
        const emit = (sample: VideoSample, outSec: number): void => {
          const frame = sample.toVideoFrame()
          try {
            // The head must open with a keyframe: it is the start of a cut.
            boundary!.encode(
              new VideoFrame(frame, {
                timestamp: Math.round(outSec * 1e6),
                duration: Math.max(1, Math.round(sample.duration * 1e6)),
              }),
              firstOfHead,
            )
          } finally {
            frame.close()
          }
          firstOfHead = false
          stats.reencodedFrames++
        }
        /**
         * The frame VISIBLE AT the cut, held back rather than skipped.
         *
         * A cut almost never lands on a frame boundary, so the picture on
         * screen at that instant belongs to a frame that STARTED earlier. The
         * first version of this dropped it as "before the span" and the output
         * began one frame late — a 33 ms hole the decode probe caught as a
         * missing frame at t=0. It is emitted at output time 0 of the span
         * instead, which is exactly what the full render draws there.
         */
        let covering: VideoSample | null = null
        for await (const sample of frameSink.samples(readFromSec, reencodeUntilSec)) {
          throwIfAborted()
          if (sample.timestamp <= readFromSec + EPS_SEC) {
            covering?.close()
            covering = sample
            continue
          }
          if (covering) {
            emit(covering, outAt(readFromSec))
            covering.close()
            covering = null
          }
          emit(sample, outAt(sample.timestamp))
          sample.close()
        }
        if (covering) {
          emit(covering, outAt(readFromSec))
          covering.close()
        }
        for (const p of await boundary.drain()) {
          bits.video(p.byteLength, p.type)
          await videoSource.add(p, first ? { decoderConfig } : undefined)
          first = false
        }
      }

      // (2) the body: packets copied byte for byte, timestamps rebased.
      if (copyFrom && copyFrom.timestamp < spanEndSec) {
        const startPacket = await packetSink.getPacket(copyFrom.timestamp)
        if (!startPacket) throw new SmartCutUnavailable('composite key packet vanished')
        for await (const packet of packetSink.packets(startPacket)) {
          throwIfAborted()
          if (packet.timestamp >= spanEndSec - EPS_SEC) break
          const shifted = new EncodedPacket(
            packet.data,
            packet.type,
            outAt(packet.timestamp),
            packet.duration,
          )
          bits.video(shifted.byteLength, shifted.type)
          stats.copiedPackets++
          stats.copiedBytes += shifted.byteLength
          await videoSource.add(shifted, first ? { decoderConfig } : undefined)
          first = false
        }
      }

      outCursorSec += spanEndSec - spanStartSec
      report('rendering', 0.1 + 0.6 * (outCursorSec / Math.max(durationSec, 1e-6)))
    }
    videoSource.close()

    // ---- audio: identical math to the render, including the join fade ----
    if (audioSource) {
      const joinFrames = segmentJoinsMs(edit).map((ms) => Math.round((ms / 1000) * AUDIO_SAMPLE_RATE))
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
        if (joinFrames.length) {
          const half = Math.max(1, Math.round((JOIN_FADE_MS / 1000) * AUDIO_SAMPLE_RATE))
          for (const joinFrame of joinFrames) {
            const from = Math.max(startFrame, joinFrame - half)
            const to = Math.min(startFrame + frames, joinFrame + half)
            for (let f = from; f < to; f++) {
              const k = f - startFrame
              const g = Math.min(1, Math.abs(f - joinFrame) / half)
              left[k] *= g
              right[k] *= g
            }
          }
        }
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
        report('rendering', 0.7 + 0.25 * ((c + 1) / audioChunks))
      }
      audioSource.close()
    }

    report('finalizing', 0.97)
    await out.finalize()
    stats.totalFrames = Math.round(durationSec * 30)
    stats.copiedFraction =
      stats.totalFrames > 0
        ? Math.round((1 - stats.reencodedFrames / stats.totalFrames) * 1000) / 1000
        : 0
    lastStats = stats
    console.info(
      `[smart cut] ${stats.spans} spans · ${stats.copiedPackets} packets copied (${(stats.copiedBytes / 1024 / 1024).toFixed(1)} MB) · ${stats.reencodedFrames} frames re-encoded · ${(100 * stats.copiedFraction).toFixed(1)}% of the video never touched a codec`,
    )
    console.info(formatBits(bits.summarize(durationSec), `smart cut ${width}×${height} ${videoCodec}`))

    let blob: Blob
    if (scratch) {
      blob = await scratch.finish(format.mimeType)
    } else {
      const buffer = bufferTarget?.buffer
      if (!buffer) throw new SmartCutUnavailable('muxer produced no output')
      blob = new Blob([buffer], { type: format.mimeType })
    }
    report('finalizing', 1)

    return {
      blob,
      mimeType: format.mimeType,
      fileName: exportFileName(recording.createdAt, format.fileExtension),
      durationMs: Math.round(durationMs),
      width,
      height,
    }
  } catch (err) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => undefined)
    }
    await scratch?.discard().catch(() => undefined)
    throw err
  } finally {
    boundary?.close()
    for (const m of audioMixers) m.dispose()
    input.dispose()
  }
}
