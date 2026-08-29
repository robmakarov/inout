/**
 * EXPERIMENTAL — O2 evidence: capture-time loudness vs the probe pass.
 *
 * Records real synthetic takes through the PRODUCTION createCaptureSession (so
 * the stats come from the real worklet tap, not a fork), then:
 *  (a) accuracy — makeup gain from stored stats vs from the probe pass, in dB
 *  (b) cost     — how long the probe pass takes, per take length, i.e. what
 *                 every export used to pay before writing a single frame
 *  (c) fallback — a take with the stats stripped (what an Apple WebKit take or
 *                 any pre-O2 take looks like) still exports, via the probe
 */

import {
  AudioBufferSource,
  getFirstEncodableAudioCodec,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny'
import { isSyntheticMode } from '@core/capture'
import { createCaptureSession } from '@core/capture/session'
import { warmRigEncoder } from '../rigWarm'
import { canMeasureAudioCapture } from '@core/capture/measuredAudio'
import { isAppleWebKit } from '@core/capabilities'
import {
  busGainFor,
  loudnessFromCaptureEnvelope,
  loudnessFromCaptureStats,
  makeupGainForLoudness,
  measureMixLoudness,
  mixGainForChannels,
  openAudioMixers,
  NORMALIZE_FLOOR_CEILING_RMS,
  NORMALIZE_MAX_MAKEUP,
  NORMALIZE_PEAK_OVERDRIVE,
  NORMALIZE_TARGET_RMS,
  openAudioChannel,
  type AudioChannelMixer,
} from '@core/compose/audio'
import type { MixLoudness } from '@core/compose/audio'
import { AUDIO_BITRATE, AUDIO_CHANNEL_COUNT, AUDIO_SAMPLE_RATE } from '@core/compose/codecs'
import { exportRecording } from '@core/compose'
import { getLastRenderStats } from '@core/compose/render'
import { exportInstant } from '@core/compose/instant'
import { newId } from '@core/id'
import { blobStore, createPositionedWriter, recordingsRepo } from '@core/store'
import { defaultEditState, keptSegments, outputDurationMs } from '@core/timeline'
import type { CaptureConfig, EditState, Recording } from '@core/types'

const dB = (ratio: number): number => Math.round(20 * Math.log10(ratio) * 1000) / 1000
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6

/** Which term of makeupGainForLoudness actually bound the result. */
function bindingTerm(m: MixLoudness): string {
  const wanted = NORMALIZE_TARGET_RMS / m.loudRms
  const peakBound = m.peak > 0 ? (NORMALIZE_PEAK_OVERDRIVE * 0.95) / m.peak : Infinity
  const floorBound =
    m.floorRms && m.floorRms > 0 ? NORMALIZE_FLOOR_CEILING_RMS / m.floorRms : Infinity
  const picked = Math.min(NORMALIZE_MAX_MAKEUP, wanted, peakBound, floorBound)
  if (picked === floorBound) return 'floor(p20)'
  if (picked === peakBound) return 'peak'
  if (picked === NORMALIZE_MAX_MAKEUP) return 'cap'
  return 'target(p90)'
}

async function recordTake(config: CaptureConfig, ms: number): Promise<Recording> {
  const session = await createCaptureSession(config)
  session.start()
  await new Promise((r) => setTimeout(r, ms))
  return session.stop()
}

async function openMixers(recording: Recording): Promise<AudioChannelMixer[]> {
  const edit = defaultEditState(recording)
  const mixers: AudioChannelMixer[] = []
  for (const channel of recording.channels) {
    if (channel.media !== 'audio') continue
    const ce = edit.channels.find((c) => c.channelId === channel.id)
    if (!ce?.enabled) continue
    const blob = await blobStore.read(channel.blobKey)
    const outStart = Math.max(channel.startOffsetMs, edit.globalTrimStartMs) - edit.globalTrimStartMs
    const outEnd =
      Math.min(channel.startOffsetMs + channel.durationMs, edit.globalTrimEndMs) -
      edit.globalTrimStartMs
    if (outEnd <= outStart) continue
    const m = await openAudioChannel(
      blob,
      channel.id,
      outStart / 1000,
      outEnd / 1000,
      (edit.globalTrimStartMs - channel.startOffsetMs) / 1000,
    )
    if (m) mixers.push(m)
  }
  return mixers
}

/**
 * The probe pass exactly as the export runs it, timed.
 * `spanMs` defaults to the full output duration — which is what the export
 * uses, and which pads the mix with digital silence wherever the audio
 * channels are shorter than the take. Passing the audio span instead isolates
 * how much of any divergence that padding accounts for.
 */
async function probeMakeup(
  recording: Recording,
  spanMs?: number,
): Promise<{
  makeup: number
  loud: MixLoudness
  binding: string
  ms: number
  channels: number
}> {
  const mixers = await openMixers(recording)
  const baseGain = mixers.length > 1 ? mixGainForChannels(mixers.length) : 1
  const totalAudioFrames = Math.round(((spanMs ?? recording.durationMs) / 1000) * AUDIO_SAMPLE_RATE)
  const t0 = performance.now()
  try {
    const loud = await measureMixLoudness(mixers, baseGain, totalAudioFrames, () => {})
    return {
      makeup: makeupGainForLoudness(loud),
      loud,
      binding: bindingTerm(loud),
      ms: Math.round(performance.now() - t0),
      channels: mixers.length,
    }
  } finally {
    for (const m of mixers) m.dispose()
  }
}

function storedMakeup(
  recording: Recording,
): { makeup: number; loud: MixLoudness; binding: string } | null {
  const ids = recording.channels.filter((c) => c.media === 'audio').map((c) => c.id)
  const gain = ids.length > 1 ? mixGainForChannels(ids.length) : 1
  const stored = loudnessFromCaptureStats(recording.loudness, ids, gain)
  if (!stored) return null
  return { makeup: makeupGainForLoudness(stored), loud: stored, binding: bindingTerm(stored) }
}

/** Long audio-only fixture (no realtime capture) purely to time the probe. */
async function makeLongAudioRecording(durationSec: number): Promise<Recording> {
  const key = `perf-o2-${newId('a')}`
  const writer = await createPositionedWriter(key)
  let closed = false
  const closeOnce = async (): Promise<void> => {
    if (closed) return
    closed = true
    await writer.close()
  }
  const codec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
    numberOfChannels: AUDIO_CHANNEL_COUNT,
    sampleRate: AUDIO_SAMPLE_RATE,
    bitrate: AUDIO_BITRATE,
  })
  if (!codec) throw new Error('no audio encoder for the fixture')
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new StreamTarget(
      new WritableStream<StreamTargetChunk>({
        async write(chunk) {
          await writer.write(chunk.data, chunk.position)
        },
        close: closeOnce,
        abort: closeOnce,
      }),
      { chunked: true, chunkSize: 1 << 20 },
    ),
  })
  const source = new AudioBufferSource({ codec, bitrate: AUDIO_BITRATE })
  output.addAudioTrack(source)
  await output.start()
  const total = Math.round(durationSec * AUDIO_SAMPLE_RATE)
  const chunk = AUDIO_SAMPLE_RATE
  const left = new Float32Array(chunk)
  const right = new Float32Array(chunk)
  for (let start = 0; start < total; start += chunk) {
    const frames = Math.min(chunk, total - start)
    for (let k = 0; k < frames; k++) {
      const t = (start + k) / AUDIO_SAMPLE_RATE
      const env = Math.sin(2 * Math.PI * 0.7 * t) > 0 ? 0.3 : 0.004
      left[k] = env * Math.sin(2 * Math.PI * 220 * t)
      right[k] = env * Math.sin(2 * Math.PI * 277 * t)
    }
    const buffer = new AudioBuffer({
      length: frames,
      numberOfChannels: AUDIO_CHANNEL_COUNT,
      sampleRate: AUDIO_SAMPLE_RATE,
    })
    buffer.copyToChannel(left.subarray(0, frames), 0)
    buffer.copyToChannel(right.subarray(0, frames), 1)
    await source.add(buffer)
  }
  source.close()
  await output.finalize()
  await closeOnce()
  const durationMs = Math.round(durationSec * 1000)
  return {
    id: newId('rec'),
    createdAt: Date.now(),
    durationMs,
    channels: [
      {
        id: newId('ch'),
        kind: 'mic',
        media: 'audio',
        mimeType: 'audio/mp4',
        blobKey: key,
        startOffsetMs: 0,
        durationMs,
      },
    ],
  }
}

export interface O2Accuracy {
  mix: string
  takeMs: number
  audioChannels: number
  hasStats: boolean
  /** Full statistic both ways, so a divergence can be attributed. */
  stored: { peak: number; loudRms: number; floorRms: number; binding: string } | null
  probe: { peak: number; loudRms: number; floorRms: number; binding: string } | null
  /** Per-term divergence, dB (stored relative to probe). */
  peakDiffDb: number | null
  loudRmsDiffDb: number | null
  floorRmsDiffDb: number | null
  storedMakeup: number | null
  probeMakeup: number | null
  /** Difference of the applied gains, dB. Gate: |diff| ≤ 0.5. */
  makeupDiffDb: number | null
  /** Same comparison with the probe restricted to the audio span (no padding). */
  audioSpanMs: number
  outputSpanMs: number
  silentPadMs: number
  probeAudioSpanMakeup: number | null
  probeAudioSpan?: { peak: number; loudRms: number; floorRms: number; binding: string }
  makeupDiffAudioSpanDb: number | null
  probeMs: number | null
}

/**
 * X1 lane — the EDITED export, which is where the probe pass actually lived.
 *
 * O2's shortcut gates on isDefaultEdit, so every trim or cut paid a second full
 * decode of every audio channel purely to rebuild an envelope capture had
 * already measured and thrown away. This lane applies a real edit (a global trim
 * plus a middle cut), compares the makeup the kept windows give against the
 * makeup the probe gives on the SAME edit, and then exports twice — once with
 * the envelope and once with it stripped — reading the render's own count of
 * probe decodes. That count is the gate; the dB is the accuracy.
 */
export interface X1Edited {
  /** The kept spans the lane actually exported — a global trim plus a middle cut. */
  keptSpans: { startMs: number; endMs: number }[]
  outputMs: number
  audioChannels: number
  stored: { peak: number; peakRobust: number; loudRms: number; floorRms: number } | null
  probe: { peak: number; peakRobust: number; loudRms: number; floorRms: number } | null
  storedMakeup: number | null
  probeMakeup: number | null
  /** Gate, same tolerances as O2's: p90 ≤0.4 dB, peak ≤0.03 dB. */
  loudRmsDiffDb: number | null
  peakDiffDb: number | null
  makeupDiffDb: number | null
  /** Cost of the pass X1 removes, on this edit. */
  probeMs: number | null
  /** The render's own count, with the envelope and with it stripped. */
  probeDecodesWithEnvelope: number | null
  probeDecodesWithout: number | null
  exportMsWithEnvelope: number | null
  exportMsWithout: number | null
  /** Bytes the envelope costs on this take, and per 30 minutes. */
  envelopeBytes: number
  envelopeBytesPer30Min: number | null
  passed: boolean
}

export interface O2Report {
  syntheticMode: boolean
  /** UA the run saw — the Apple WebKit smoke asserts stats are absent there. */
  userAgent: string
  appleWebKit: boolean
  measuredAudioAvailable: boolean
  accuracy: O2Accuracy[]
  /** Probe cost by take length — the decode every export used to pay. */
  probeCost: { takeSec: number; probeMs: number }[]
  probeMsPerMinute: number | null
  projected10MinProbeMs: number | null
  instant: {
    withStatsMs: number
    withoutStatsMs: number
    savedMs: number
    bothPlay: boolean
  } | null
  fallback: { statsStripped: boolean; exported: boolean; error?: string } | null
  edited: X1Edited | null
  notes: string[]
}

/** A real edit: drop the first second, cut a second out of the middle. */
function editedState(recording: Recording): EditState {
  const base = defaultEditState(recording)
  const end = recording.durationMs
  const mid = Math.round(end / 2)
  return {
    ...base,
    globalTrimStartMs: 1000,
    segments: [
      { startMs: 1000, endMs: mid - 500 },
      { startMs: mid + 500, endMs: end },
    ],
  }
}

async function runX1Edited(recording: Recording): Promise<X1Edited> {
  const edit = editedState(recording)
  const outputMs = outputDurationMs(edit)
  const ids = recording.channels.filter((c) => c.media === 'audio').map((c) => c.id)
  const gain = ids.length > 1 ? mixGainForChannels(ids.length) : 1
  const stored = loudnessFromCaptureEnvelope(recording.loudness, recording, edit, ids, gain)

  const probeMixers = await openAudioMixers(recording, edit, () => {})
  const baseGain = busGainFor(probeMixers)
  const t0 = performance.now()
  let probe: MixLoudness | null = null
  try {
    probe = await measureMixLoudness(
      probeMixers,
      baseGain,
      Math.round((outputMs / 1000) * AUDIO_SAMPLE_RATE),
      () => {},
    )
  } finally {
    for (const m of probeMixers) m.dispose()
  }
  const probeMs = Math.round(performance.now() - t0)

  // The count that is the gate: run the real export both ways.
  const stripped: Recording = { ...recording, loudness: { ...recording.loudness! } }
  delete stripped.loudness!.envelope
  const settings = { width: 960, height: 540, fps: 30 }
  const te0 = performance.now()
  await exportRecording({ recording, edit, settings })
  const exportMsWithEnvelope = Math.round(performance.now() - te0)
  const withEnv = getLastRenderStats()?.probeDecodes ?? null
  const te1 = performance.now()
  await exportRecording({ recording: stripped, edit, settings })
  const exportMsWithout = Math.round(performance.now() - te1)
  const without = getLastRenderStats()?.probeDecodes ?? null

  const env = recording.loudness?.envelope
  const envelopeBytes = env ? env.windowRms.byteLength + env.windowPeak.byteLength : 0
  const loudDiff = stored && probe ? dB(stored.loudRms / probe.loudRms) : null
  const peakDiff = stored && probe ? dB(stored.peak / probe.peak) : null
  const storedMakeup = stored ? makeupGainForLoudness(stored) : null
  const probeMakeup = probe ? makeupGainForLoudness(probe) : null
  const view = (m: MixLoudness | null): X1Edited['stored'] =>
    m
      ? {
          peak: r6(m.peak),
          peakRobust: r6(m.peakRobust ?? 0),
          loudRms: r6(m.loudRms),
          floorRms: r6(m.floorRms ?? 0),
        }
      : null
  return {
    keptSpans: keptSegments(edit).map((g) => ({
      startMs: Math.round(g.startMs),
      endMs: Math.round(g.endMs),
    })),
    outputMs: Math.round(outputMs),
    audioChannels: ids.length,
    stored: view(stored),
    probe: view(probe),
    storedMakeup: storedMakeup === null ? null : Math.round(storedMakeup * 1000) / 1000,
    probeMakeup: probeMakeup === null ? null : Math.round(probeMakeup * 1000) / 1000,
    loudRmsDiffDb: loudDiff,
    peakDiffDb: peakDiff,
    makeupDiffDb:
      storedMakeup !== null && probeMakeup !== null ? dB(storedMakeup / probeMakeup) : null,
    probeMs,
    probeDecodesWithEnvelope: withEnv,
    probeDecodesWithout: without,
    exportMsWithEnvelope,
    exportMsWithout,
    envelopeBytes,
    envelopeBytesPer30Min: recording.durationMs
      ? Math.round((envelopeBytes * 1_800_000) / recording.durationMs)
      : null,
    passed:
      withEnv === 0 &&
      (without ?? 0) > 0 &&
      loudDiff !== null &&
      Math.abs(loudDiff) <= 0.4 &&
      peakDiff !== null &&
      Math.abs(peakDiff) <= 0.03,
  }
}

export async function runO2Evidence(
  opts: { takeMs?: number; probeSecs?: number[] } = {},
): Promise<O2Report> {
  // NOTE 6: prearm warms production's first VideoEncoder at mount; a rig that
  // opens a session directly does not, and a cold first encoder eats the take.
  await warmRigEncoder()
  const takeMs = opts.takeMs ?? 8000
  const probeSecs = opts.probeSecs ?? [60, 180]
  const notes: string[] = [
    'takes are recorded through the production createCaptureSession in synthetic mode — stats come from the real worklet tap',
    'probe cost is measured on audio-only fixtures so a 10-minute number does not need a 10-minute recording',
    'X1 (edited): the shortcut now covers a TRIMMED AND CUT take — probeDecodes is the render\'s own count of channels opened purely to measure, and it must be 0 with the envelope and >0 without it',
  ]
  const accuracy: O2Accuracy[] = []
  const mixes: { name: string; config: CaptureConfig }[] = [
    { name: 'screen+mic', config: { screen: true, camera: false, mic: true, systemAudio: false } },
    {
      name: 'screen+mic+system',
      config: { screen: true, camera: false, mic: true, systemAudio: true },
    },
  ]

  let instant: O2Report['instant'] = null
  let fallback: O2Report['fallback'] = null
  let edited: X1Edited | null = null

  for (const { name, config } of mixes) {
    const recording = await recordTake(config, takeMs)
    try {
      const stored = storedMakeup(recording)
      const probe = await probeMakeup(recording)
      const audioSpanMs = recording.channels
        .filter((c) => c.media === 'audio')
        .reduce((m, c) => Math.max(m, c.startOffsetMs + c.durationMs), 0)
      const probeAudio = await probeMakeup(recording, audioSpanMs)
      accuracy.push({
        mix: name,
        takeMs: recording.durationMs,
        audioChannels: recording.channels.filter((c) => c.media === 'audio').length,
        hasStats: !!recording.loudness,
        stored: stored
          ? {
              peak: r6(stored.loud.peak),
              loudRms: r6(stored.loud.loudRms),
              floorRms: r6(stored.loud.floorRms ?? 0),
              binding: stored.binding,
            }
          : null,
        probe: {
          peak: r6(probe.loud.peak),
          loudRms: r6(probe.loud.loudRms),
          floorRms: r6(probe.loud.floorRms ?? 0),
          binding: probe.binding,
        },
        peakDiffDb: stored ? dB(stored.loud.peak / probe.loud.peak) : null,
        loudRmsDiffDb: stored ? dB(stored.loud.loudRms / probe.loud.loudRms) : null,
        floorRmsDiffDb:
          stored && stored.loud.floorRms && probe.loud.floorRms
            ? dB(stored.loud.floorRms / probe.loud.floorRms)
            : null,
        storedMakeup: stored ? Math.round(stored.makeup * 1000) / 1000 : null,
        probeMakeup: Math.round(probe.makeup * 1000) / 1000,
        makeupDiffDb: stored ? dB(stored.makeup / probe.makeup) : null,
        audioSpanMs,
        outputSpanMs: recording.durationMs,
        silentPadMs: recording.durationMs - audioSpanMs,
        probeAudioSpanMakeup: Math.round(probeAudio.makeup * 1000) / 1000,
        probeAudioSpan: {
          peak: r6(probeAudio.loud.peak),
          loudRms: r6(probeAudio.loud.loudRms),
          floorRms: r6(probeAudio.loud.floorRms ?? 0),
          binding: probeAudio.binding,
        },
        makeupDiffAudioSpanDb: stored ? dB(stored.makeup / probeAudio.makeup) : null,
        probeMs: probe.ms,
      })

      // Instant export A/B on the first mix that has a composite.
      if (!instant && recording.composite) {
        const edit = defaultEditState(recording)
        const t0 = performance.now()
        const withStats = await exportInstant({ recording, edit })
        const withStatsMs = Math.round(performance.now() - t0)
        const stripped: Recording = { ...recording }
        delete stripped.loudness
        const t1 = performance.now()
        const withoutStats = await exportInstant({ recording: stripped, edit })
        const withoutStatsMs = Math.round(performance.now() - t1)
        instant = {
          withStatsMs,
          withoutStatsMs,
          savedMs: withoutStatsMs - withStatsMs,
          bothPlay: withStats.blob.size > 0 && withoutStats.blob.size > 0,
        }
        fallback = { statsStripped: true, exported: withoutStats.blob.size > 0 }
      }

      // X1: the edited lane, on the first take that carries an envelope.
      if (!edited && recording.loudness?.envelope) {
        edited = await runX1Edited(recording)
      }
    } catch (err) {
      accuracy.push({
        mix: name,
        takeMs: recording.durationMs,
        audioChannels: recording.channels.filter((c) => c.media === 'audio').length,
        hasStats: !!recording.loudness,
        stored: null,
        probe: null,
        peakDiffDb: null,
        loudRmsDiffDb: null,
        floorRmsDiffDb: null,
        storedMakeup: null,
        probeMakeup: null,
        makeupDiffDb: null,
        audioSpanMs: 0,
        outputSpanMs: recording.durationMs,
        silentPadMs: 0,
        probeAudioSpanMakeup: null,
        makeupDiffAudioSpanDb: null,
        probeMs: null,
      })
      fallback ??= {
        statsStripped: false,
        exported: false,
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      await recordingsRepo.remove(recording.id).catch(() => undefined)
    }
  }

  // ---- probe cost by length ----
  const probeCost: { takeSec: number; probeMs: number }[] = []
  for (const sec of probeSecs) {
    const rec = await makeLongAudioRecording(sec)
    try {
      const p = await probeMakeup(rec)
      probeCost.push({ takeSec: sec, probeMs: p.ms })
    } finally {
      for (const c of rec.channels) await blobStore.remove(c.blobKey).catch(() => undefined)
    }
  }
  let probeMsPerMinute: number | null = null
  if (probeCost.length >= 2) {
    const first = probeCost[0]!
    const last = probeCost[probeCost.length - 1]!
    probeMsPerMinute =
      Math.round(((last.probeMs - first.probeMs) / (last.takeSec - first.takeSec)) * 60)
  } else if (probeCost.length === 1) {
    probeMsPerMinute = Math.round((probeCost[0]!.probeMs / probeCost[0]!.takeSec) * 60)
  }

  return {
    syntheticMode: isSyntheticMode(),
    userAgent: navigator.userAgent,
    appleWebKit: isAppleWebKit(),
    measuredAudioAvailable: canMeasureAudioCapture(),
    accuracy,
    probeCost,
    probeMsPerMinute,
    projected10MinProbeMs: probeMsPerMinute === null ? null : probeMsPerMinute * 10,
    instant,
    fallback,
    edited,
    notes,
  }
}
