import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Output,
  type VideoSample,
} from 'mediabunny'
import { blobStore } from '@core/store'
import {
  channelSourceTimeAt,
  clampEditState,
  defaultEditState,
  hasEnabledVideo,
  outputDurationMs,
} from '@core/timeline'
import {
  DEFAULT_EXPORT_SETTINGS,
  type ChannelRecording,
  type EditState,
  type ExportOptions,
  type ExportProgress,
  type ExportResult,
} from '@core/types'
import {
  makeupGainForLoudness,
  measureMixLoudness,
  mixGainForChannels,
  openAudioChannel,
  softLimitSample,
  type AudioChannelMixer,
} from './audio'
import {
  AUDIO_BITRATE,
  AUDIO_CHANNEL_COUNT,
  AUDIO_SAMPLE_RATE,
  VIDEO_BITRATE,
  pickEncodingTarget,
} from './codecs'
import { drawVideoFrame, type FrameCanvas } from './layout'
import { collectPeaks, createPeakBuffer, createWaveformRenderer } from './waveform'
import { openVideoChannel, type VideoChannelReader } from './video'

const YIELD_EVERY_FRAMES = 8

const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface ActiveWindow {
  /** [outStartMs, outEndMs) — where the channel is active on the output timeline. */
  outStartMs: number
  outEndMs: number
  /** Channel-local end of the kept region, ms. */
  localEndMs: number
}

/** Interval form of the types.ts time model (per-frame lookups use channelSourceTimeAt). */
function activeOutputWindowMs(edit: EditState, channel: ChannelRecording): ActiveWindow | null {
  const ce = edit.channels.find((c) => c.channelId === channel.id)
  if (!ce || !ce.enabled) return null
  const localStartMs = Math.max(0, ce.trimStartMs)
  const localEndMs = Math.min(channel.durationMs, ce.trimEndMs)
  const outStartMs =
    Math.max(channel.startOffsetMs + localStartMs, edit.globalTrimStartMs) - edit.globalTrimStartMs
  const outEndMs =
    Math.min(channel.startOffsetMs + localEndMs, edit.globalTrimEndMs) - edit.globalTrimStartMs
  return outEndMs > outStartMs ? { outStartMs, outEndMs, localEndMs } : null
}

/** Open a mixer per enabled audio channel (used for both the analysis pre-pass
 * and the real render — kept identical so the measured peak matches the mix). */
async function openAudioMixers(
  recording: ExportOptions['recording'],
  edit: EditState,
  throwIfAborted: () => void,
): Promise<AudioChannelMixer[]> {
  const mixers: AudioChannelMixer[] = []
  for (const channel of recording.channels) {
    if (channel.media !== 'audio') continue
    throwIfAborted()
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

/**
 * Loudness makeup the export will apply to this recording (default edit) —
 * used by the editor preview for parity: what you hear while editing is the
 * loudness the exported file will have. Safe fallback: unity on any failure.
 */
export async function measureRecordingMakeup(
  recording: ExportOptions['recording'],
): Promise<number> {
  try {
    const edit = clampEditState(recording, defaultEditState(recording))
    const probe = await openAudioMixers(recording, edit, () => {})
    if (probe.length === 0) return 1
    const baseGain = probe.length > 1 ? mixGainForChannels(probe.length) : 1
    try {
      const totalAudioFrames = Math.round((outputDurationMs(edit) / 1000) * AUDIO_SAMPLE_RATE)
      const loud = await measureMixLoudness(probe, baseGain, totalAudioFrames, () => {})
      const makeup = makeupGainForLoudness(loud)
      console.info(
        `preview: loudness p90rms ${loud.loudRms.toFixed(4)} peak ${loud.peak.toFixed(3)} → makeup ${makeup.toFixed(2)}×`,
      )
      return makeup
    } finally {
      for (const m of probe) m.dispose()
    }
  } catch (err) {
    console.warn('preview loudness measurement failed, using unity', err)
    return 1
  }
}

function exportFileName(createdAt: number, fileExtension: string): string {
  const d = new Date(createdAt)
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `inout-${date}-${time}${fileExtension}`
}

export async function exportRecording(opts: ExportOptions): Promise<ExportResult> {
  const { recording, edit, settings = DEFAULT_EXPORT_SETTINGS, onProgress, signal } = opts
  const { width, height, fps } = settings

  const report = (phase: ExportProgress['phase'], ratio: number): void => {
    onProgress?.({ phase, ratio: Math.min(1, Math.max(0, ratio)) })
  }
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError')
  }

  report('preparing', 0)
  throwIfAborted()

  const durationMs = outputDurationMs(edit)
  if (durationMs <= 0) throw new Error('Export window is empty')
  const durationSec = durationMs / 1000

  const waveformMode = !hasEnabledVideo(recording, edit)
  const videoReaders: VideoChannelReader[] = []
  const audioMixers: AudioChannelMixer[] = []
  let output: Output | null = null

  try {
    for (const channel of recording.channels) {
      if (channel.media !== 'video' || waveformMode) continue
      throwIfAborted()
      const window = activeOutputWindowMs(edit, channel)
      if (!window) continue
      const blob = await blobStore.read(channel.blobKey)
      const reader = await openVideoChannel(blob, channel.id, channel.kind, window.localEndMs / 1000)
      if (reader) videoReaders.push(reader)
    }

    audioMixers.push(...(await openAudioMixers(recording, edit, throwIfAborted)))
    const needAudio = audioMixers.length > 0
    const totalAudioFrames = Math.round(durationSec * AUDIO_SAMPLE_RATE)
    // Headroom for the render sum: a single source stays full-scale (gain 1,
    // never limited); multiple sources (mic + system audio) mix equal-power so
    // their sum does not clip into softLimitSample. Unity summing here was the
    // pervasive-noise cause after the composite export path was removed.
    const baseGain = audioMixers.length > 1 ? mixGainForChannels(audioMixers.length) : 1
    for (const m of audioMixers) m.gain = baseGain

    // Loudness normalize: quiet captures (real case: PO's take had voice at
    // −25 dB window-RMS under a 0.77 transient peak) export near-inaudible.
    // Measure SPEECH loudness (p90 window RMS) on a throwaway mixer set — the
    // render streams forward and can't rewind — and drive it to target. Peak
    // targeting was defeated by a single mic bump; percentile loudness isn't.
    // No-op for a healthy mix, so the fidelity oracle is untouched.
    if (needAudio) {
      const probe = await openAudioMixers(recording, edit, throwIfAborted)
      try {
        const loud = await measureMixLoudness(probe, baseGain, totalAudioFrames, throwIfAborted, (r) =>
          report('preparing', 0.04 * r),
        )
        const makeup = makeupGainForLoudness(loud)
        if (makeup !== 1) for (const m of audioMixers) m.gain = baseGain * makeup
        console.info(
          `compose: audio loudness p90rms ${loud.loudRms.toFixed(4)} peak ${loud.peak.toFixed(3)} → makeup ${makeup.toFixed(2)}×`,
        )
      } finally {
        for (const m of probe) m.dispose()
      }
    }
    // Layout slot is decided once for the whole export: camera only fills the
    // frame when no screen channel contributes anywhere in the output window.
    const cameraFull = !videoReaders.some((r) => r.kind === 'screen')
    const target = await pickEncodingTarget(width, height, needAudio)
    throwIfAborted()

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    const frame: FrameCanvas = { ctx, width, height, scale: width / 1920 }

    const out = new Output({ format: target.format, target: new BufferTarget() })
    output = out
    const videoSource = new CanvasSource(canvas, { codec: target.videoCodec, bitrate: VIDEO_BITRATE })
    out.addVideoTrack(videoSource, { frameRate: fps })
    let audioSource: AudioBufferSource | null = null
    if (needAudio) {
      audioSource = new AudioBufferSource({ codec: target.audioCodec, bitrate: AUDIO_BITRATE })
      out.addAudioTrack(audioSource)
    }
    await out.start()
    report('preparing', 0.05)

    const totalFrames = Math.max(1, Math.ceil(durationSec * fps - 1e-9))
    const audioChunks = Math.ceil(totalAudioFrames / AUDIO_SAMPLE_RATE)
    const peaks = createPeakBuffer(waveformMode ? durationSec : 0)

    const writeAudioChunk = async (chunkIndex: number): Promise<void> => {
      if (!audioSource) return
      const startFrame = chunkIndex * AUDIO_SAMPLE_RATE
      const frames = Math.min(AUDIO_SAMPLE_RATE, totalAudioFrames - startFrame)
      if (frames <= 0) return
      const left = new Float32Array(frames)
      const right = new Float32Array(frames)
      const chunkOutStartSec = startFrame / AUDIO_SAMPLE_RATE
      for (const mixer of audioMixers) await mixer.mixInto(left, right, chunkOutStartSec)
      for (let k = 0; k < frames; k++) {
        left[k] = softLimitSample(left[k])
        right[k] = softLimitSample(right[k])
      }
      if (waveformMode) collectPeaks(peaks, left, right, startFrame, AUDIO_SAMPLE_RATE)
      const buffer = new AudioBuffer({
        length: frames,
        numberOfChannels: AUDIO_CHANNEL_COUNT,
        sampleRate: AUDIO_SAMPLE_RATE,
      })
      buffer.copyToChannel(left, 0)
      buffer.copyToChannel(right, 1)
      await audioSource.add(buffer)
    }

    const renderFrame = async (frameIndex: number, drawWaveform: ((t: number) => void) | null): Promise<void> => {
      const tSec = frameIndex / fps
      if (drawWaveform) {
        drawWaveform(tSec)
      } else {
        let screen: VideoSample | null = null
        let camera: VideoSample | null = null
        for (const reader of videoReaders) {
          const localMs = channelSourceTimeAt(recording, edit, reader.channelId, tSec * 1000)
          if (localMs === null) continue
          const sample = await reader.sampleAt(localMs / 1000)
          if (!sample) continue
          if (reader.kind === 'screen') screen = sample
          else camera = sample
        }
        drawVideoFrame(frame, screen, camera, cameraFull)
      }
      await videoSource.add(tSec, 1 / fps)
    }

    if (waveformMode) {
      // Audio pass first: the mixed peaks drive every waveform frame.
      if (audioSource) {
        for (let c = 0; c < audioChunks; c++) {
          throwIfAborted()
          await writeAudioChunk(c)
          report('rendering', 0.05 + 0.45 * ((c + 1) / audioChunks))
          await yieldToUi()
        }
        audioSource.close()
      }
      const base = audioSource ? 0.5 : 0.05
      const drawWaveform = createWaveformRenderer(frame, peaks)
      for (let f = 0; f < totalFrames; f++) {
        throwIfAborted()
        await renderFrame(f, drawWaveform)
        report('rendering', base + (0.95 - base) * ((f + 1) / totalFrames))
        if (f % YIELD_EVERY_FRAMES === 0) await yieldToUi()
      }
    } else {
      // Alternate ~1s of audio with that second's video frames (interleaving).
      let frameIndex = 0
      const chunks = Math.max(1, Math.ceil(durationSec))
      for (let c = 0; c < chunks; c++) {
        throwIfAborted()
        await writeAudioChunk(c)
        const chunkEndSec = Math.min(durationSec, c + 1)
        while (frameIndex < totalFrames && frameIndex / fps < chunkEndSec) {
          throwIfAborted()
          await renderFrame(frameIndex, null)
          frameIndex++
          report('rendering', 0.05 + 0.9 * (frameIndex / totalFrames))
          if (frameIndex % YIELD_EVERY_FRAMES === 0) await yieldToUi()
        }
      }
      // Float-rounding safety: never drop trailing frames.
      for (; frameIndex < totalFrames; frameIndex++) {
        throwIfAborted()
        await renderFrame(frameIndex, null)
      }
      audioSource?.close()
    }
    videoSource.close()

    report('finalizing', 0.95)
    await out.finalize()
    const buffer = out.target.buffer
    if (!buffer) throw new Error('Muxer produced no output')
    report('finalizing', 1)

    return {
      blob: new Blob([buffer], { type: target.mimeType }),
      mimeType: target.mimeType,
      fileName: exportFileName(recording.createdAt, target.fileExtension),
      durationMs: Math.round(durationMs),
      width,
      height,
    }
  } catch (err) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => undefined)
    }
    throw err
  } finally {
    for (const reader of videoReaders) reader.dispose()
    for (const mixer of audioMixers) mixer.dispose()
  }
}
