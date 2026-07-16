/**
 * EXPERIMENTAL — Oracle fidelity runner (task oracle-audio-fidelity).
 *
 * Stereo multitone through production measured-audio capture → exportRecording
 * → decode → fidelity metrics. Separate from sync oracle so CI stays focused.
 */

import { exportRecording } from '@core/compose'
import { blobStore, createDurablePositionedWriter } from '@core/store'
import { canMeasureAudioCapture, startMeasuredAudioCapture } from '@core/capture/measuredAudio'
import { defaultEditState } from '@core/timeline'
import type { ChannelRecording, Recording } from '@core/types'
import { analyzeAudioFidelity, FIDELITY_TONES, type AudioFidelityReport } from './audioFidelity'
import { sweepStaleOracleBlobs } from './rig'

export interface FidelityOracleReport {
  recordMs: number
  sweptStaleKeys: string[]
  exportMs: number
  fidelity: AudioFidelityReport
  pass: boolean
}

function makeStereoFidelityStream(audioCtx: AudioContext): {
  stream: MediaStream
  stop: () => void
} {
  const merger = audioCtx.createChannelMerger(2)
  const dest = audioCtx.createMediaStreamDestination()
  const teardowns: (() => void)[] = []

  for (const tone of FIDELITY_TONES) {
    const osc = new OscillatorNode(audioCtx, { frequency: tone.freqHz, type: 'sine' })
    const gain = new GainNode(audioCtx, { gain: tone.amp })
    osc.connect(gain)
    gain.connect(merger, 0, tone.channel === 'L' ? 0 : 1)
    osc.start()
    teardowns.push(() => {
      try {
        osc.stop()
      } catch {
        /* already */
      }
    })
  }
  merger.connect(dest)

  return {
    stream: dest.stream,
    stop: () => {
      for (const t of teardowns) t()
      try {
        merger.disconnect()
      } catch {
        /* */
      }
    },
  }
}

async function recordFidelityAudio(durationMs: number): Promise<{
  recording: Recording
  cleanup: () => Promise<void>
}> {
  if (!canMeasureAudioCapture()) {
    throw new Error('fidelity oracle requires measured audio capture (WebCodecs + worklet)')
  }
  const runId = `exp-oracle-fidelity-${Date.now()}`
  const blobKey = `${runId}_system-audio.webm`
  // Generator context is separate from capture — measuredAudio prewarms its own
  // worklet-bearing AudioContext from the track (passing ours skips addModule).
  const genCtx = new AudioContext()
  await genCtx.resume()
  const src = makeStereoFidelityStream(genCtx)
  const epoch = performance.now()
  const writer = await createDurablePositionedWriter(blobKey)
  const handle = await startMeasuredAudioCapture({
    stream: src.stream,
    epoch,
    writer,
  })

  await new Promise((r) => setTimeout(r, durationMs))
  const result = await handle.stop()
  src.stop()
  await genCtx.close().catch(() => undefined)

  const channel: ChannelRecording = {
    id: `${runId}_sys`,
    kind: 'system-audio',
    media: 'audio',
    mimeType: handle.mimeType,
    blobKey,
    startOffsetMs: Math.round(result.startOffsetMs),
    durationMs: Math.round(result.durationMs),
  }
  const recording: Recording = {
    id: runId,
    createdAt: Date.now(),
    durationMs: channel.startOffsetMs + channel.durationMs,
    channels: [channel],
  }

  return {
    recording,
    cleanup: async () => {
      await blobStore.remove(blobKey).catch(() => undefined)
    },
  }
}

export async function runOracleFidelity(recordMs = 6000): Promise<FidelityOracleReport> {
  const sweptStaleKeys = await sweepStaleOracleBlobs()
  const { recording, cleanup } = await recordFidelityAudio(recordMs)
  try {
    const edit = defaultEditState(recording)
    const t0 = performance.now()
    const exported = await exportRecording({ recording, edit })
    const exportMs = performance.now() - t0
    const fidelity = await analyzeAudioFidelity(exported.blob)
    return {
      recordMs,
      sweptStaleKeys,
      exportMs,
      fidelity,
      pass: fidelity.pass,
    }
  } finally {
    await cleanup()
  }
}
