/**
 * EXPERIMENTAL — F5b evidence: per-segment speed.
 *
 * Two gates, and they need two different takes, so this runs both.
 *
 * PITCH. The whole point of WSOLA over resampling is that a 2x span does not
 * raise the voice an octave, so the rig records a take whose pitch is known to
 * the hertz — a steady tone — speeds a span of it up, exports through the
 * PRODUCTION exporter, and measures the fundamental of the DECODED FILE inside
 * the sped stretch. Anything that resamples fails this by 1200 cents, so a
 * regression cannot hide.
 *
 * SYNC AT THE BOUNDARIES. A sped span moves every later instant earlier, and a
 * mapping that is right for video and wrong for audio (or the reverse) shows up
 * as flash and click drifting apart. So the second take is the oracle's own
 * flash+click fiducial, sped in the middle, measured with the oracle's analyser
 * — the same instrument CI gates on, so the number is comparable.
 *
 * And the cost: what speeding a span does to export time, reported.
 */

import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny'
import { newId } from '@core/id'
import { blobStore, recordingsRepo } from '@core/store'
import { exportRecording } from '@core/compose'
import {
  clampEditState,
  defaultEditState,
  isDefaultEdit,
  keptSegments,
  outputDurationMs,
} from '@core/timeline'
import type { ChannelRecording, EditState, KeptSegment, Recording } from '@core/types'
import { analyzeExport } from '../oracle/analyze'
import { recordFiducialSession, sweepStaleOracleBlobs } from '../oracle/rig'
import { resolveScheduleSkewMeanMs } from '../oracle/scheduleSkew'

const TONE_HZ = 440
const AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2']

/** A steady tone recorded as a raw audio channel — pitch known to the hertz. */
async function recordTone(takeMs: number): Promise<ChannelRecording> {
  const ctx = new AudioContext({ sampleRate: 48000 })
  await ctx.resume()
  const dest = ctx.createMediaStreamDestination()
  const osc = new OscillatorNode(ctx, { frequency: TONE_HZ, type: 'sine' })
  const gain = new GainNode(ctx, { gain: 0.25 })
  osc.connect(gain).connect(dest)
  const mime = AUDIO_MIMES.find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) throw new Error('no supported audio recorder mime')
  const blobKey = `exp-f5b-${newId('a')}.webm`
  const writer = (await blobStore.createWriteStream(blobKey)).getWriter()
  let chain = Promise.resolve()
  const recorder = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 128_000 })
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return
    chain = chain.then(() => writer.write(e.data).catch(() => undefined))
  }
  recorder.start(1000)
  osc.start()
  await new Promise((r) => setTimeout(r, takeMs))
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    recorder.requestData()
    recorder.stop()
  })
  await chain
  await writer.close().catch(() => undefined)
  for (const t of dest.stream.getTracks()) t.stop()
  try {
    osc.stop()
  } catch {
    /* already stopped */
  }
  await ctx.close().catch(() => undefined)
  return {
    id: newId('ch'),
    kind: 'mic',
    media: 'audio',
    mimeType: mime,
    blobKey,
    startOffsetMs: 0,
    durationMs: takeMs,
  }
}

/** Decoded mono samples of an exported file over an output-time window. */
async function decodeWindow(
  blob: Blob,
  fromSec: number,
  toSec: number,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return null
    const sink = new AudioBufferSink(track)
    const out: number[] = []
    let rate = 48_000
    for await (const { buffer, timestamp } of sink.buffers(fromSec, toSec)) {
      rate = buffer.sampleRate
      const ch = buffer.getChannelData(0)
      for (let i = 0; i < ch.length; i++) {
        const t = timestamp + i / rate
        if (t >= fromSec && t < toSec) out.push(ch[i]!)
      }
    }
    return { samples: Float32Array.from(out), sampleRate: rate }
  } finally {
    input.dispose()
  }
}

/** Fundamental by autocorrelation with parabolic refinement (see the unit test). */
function fundamentalHz(x: Float32Array, sampleRate: number): number | null {
  if (x.length < 4096) return null
  const minLag = Math.floor(sampleRate / 2000)
  const maxLag = Math.floor(sampleRate / 80)
  const score = (lag: number): number => {
    let dot = 0
    let energy = 0
    for (let i = 0; i + lag < x.length; i++) {
      dot += x[i]! * x[i + lag]!
      energy += x[i + lag]! * x[i + lag]!
    }
    return dot / Math.sqrt(energy + 1e-9)
  }
  let best = minLag
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = score(lag)
    if (s > bestScore) {
      bestScore = s
      best = lag
    }
  }
  const y0 = score(best - 1)
  const y2 = score(best + 1)
  const denom = y0 - 2 * bestScore + y2
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0
  return sampleRate / (best + shift)
}

function cents(a: number, b: number): number {
  return 1200 * Math.log2(a / b)
}

export interface F5bReport {
  takeMs: number
  toneHz: number
  pitch: {
    speed: number
    /** Output window measured, seconds — inside the sped span. */
    windowSec: [number, number]
    measuredHz: number | null
    errorCents: number | null
    /** The same measurement on the UNSPED export: the instrument's own error. */
    baselineHz: number | null
    baselineErrorCents: number | null
    pass: boolean | null
  }
  duration: {
    plainOutputMs: number
    spedOutputMs: number
    expectedSpedOutputMs: number
    /** File duration as decoded, not as declared. */
    plainFileSec: number | null
    spedFileSec: number | null
  }
  sync: {
    plainMeanMs: number | null
    spedMeanMs: number | null
    plainMaxAbsMs: number | null
    spedMaxAbsMs: number | null
    deltaMs: number | null
    flashes: number
    onsets: number
  }
  cost: {
    plainExportMs: number
    spedExportMs: number
    /** Sped export time ÷ plain, per second of OUTPUT — the honest ratio. */
    perOutputSecondRatio: number | null
  }
  isDefaultEdit: { plain: boolean; sped: boolean }
  notes: string[]
}

async function fileDurationSec(blob: Blob): Promise<number | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    return Math.round((await input.computeDuration()) * 1000) / 1000
  } catch {
    return null
  } finally {
    input.dispose()
  }
}

export async function runSegmentSpeed(
  opts: { takeMs?: number; speed?: number } = {},
): Promise<F5bReport> {
  const takeMs = opts.takeMs ?? 12_000
  const speed = opts.speed ?? 2
  const notes = [
    'pitch is measured on the DECODED EXPORT inside the sped span, not on the stretcher in isolation — a resampling regression would read ~1200 cents off',
    'baselineErrorCents is the same measurement on the unsped export: the instrument’s own error, which the sped number has to be judged against',
    'sync uses the oracle’s flash+click analyser, the same instrument CI gates on, so the numbers are comparable with the bands in STATE',
    'the sped take is a MIDDLE span so there is unsped material either side of both boundaries',
  ]

  // ---- gate 1: pitch, on a tone take -------------------------------------
  const toneChannel = await recordTone(takeMs)
  const toneRecording: Recording = {
    id: newId('rec'),
    createdAt: Date.now(),
    durationMs: takeMs,
    channels: [toneChannel],
  }
  const plainEdit = defaultEditState(toneRecording)
  const from = Math.round(takeMs * 0.3)
  const to = Math.round(takeMs * 0.7)
  const segments: KeptSegment[] = [
    { startMs: 0, endMs: from },
    { startMs: from, endMs: to, speed },
    { startMs: to, endMs: takeMs },
  ]
  const spedEdit: EditState = clampEditState(toneRecording, { ...plainEdit, segments })

  // A window WELL inside the sped span, so neither cross-fade at a boundary is
  // in the measurement.
  const spanOutStart = from / 1000
  const spanOutEnd = spanOutStart + (to - from) / 1000 / speed
  const pad = Math.min(0.4, (spanOutEnd - spanOutStart) / 4)
  const windowSec: [number, number] = [spanOutStart + pad, spanOutEnd - pad]

  // Each export is CONSUMED before the next one starts: an ExportResult.blob is
  // a disk-backed OPFS scratch file (O1), and holding one across a second
  // export reads a file that is no longer there.
  const t0 = performance.now()
  const plainOut = await exportRecording({ recording: toneRecording, edit: plainEdit })
  const plainExportMs = Math.round(performance.now() - t0)
  const plainAudio = await decodeWindow(plainOut.blob, windowSec[0], windowSec[1])
  const plainFileSec = await fileDurationSec(plainOut.blob)

  const t1 = performance.now()
  const spedOut = await exportRecording({ recording: toneRecording, edit: spedEdit })
  const spedExportMs = Math.round(performance.now() - t1)
  const spedAudio = await decodeWindow(spedOut.blob, windowSec[0], windowSec[1])
  const spedFileSec = await fileDurationSec(spedOut.blob)

  const measuredHz = spedAudio ? fundamentalHz(spedAudio.samples, spedAudio.sampleRate) : null
  const baselineHz = plainAudio ? fundamentalHz(plainAudio.samples, plainAudio.sampleRate) : null
  const errorCents = measuredHz === null ? null : Math.round(cents(measuredHz, TONE_HZ) * 100) / 100
  const baselineErrorCents =
    baselineHz === null ? null : Math.round(cents(baselineHz, TONE_HZ) * 100) / 100
  await recordingsRepo.remove(toneRecording.id).catch(() => undefined)
  await blobStore.remove(toneChannel.blobKey).catch(() => undefined)

  // ---- gate 2: sync across the boundaries, on the fiducial take ----------
  await sweepStaleOracleBlobs()
  const rig = await recordFiducialSession(takeMs, { flashClick: true })
  let sync: F5bReport['sync'] = {
    plainMeanMs: null,
    spedMeanMs: null,
    plainMaxAbsMs: null,
    spedMaxAbsMs: null,
    deltaMs: null,
    flashes: 0,
    onsets: 0,
  }
  try {
    const recording = rig.recording
    const base = defaultEditState(recording)
    const analyzeOpts = {
      beepGridRigMs: rig.debug.beepStreamArrivalsRigMs,
      beepScheduleSkewMeanMs: resolveScheduleSkewMeanMs({
        streamArrivalsRigMs: rig.debug.beepAnchorRigMs.length
          ? rig.debug.beepAnchorRigMs
          : rig.debug.beepStreamArrivalsRigMs,
        scheduleSkewSamplesMs: rig.debug.beepScheduleSkewMs,
        intervalMs: rig.debug.beepIntervalMs,
      }),
      flashScheduleSkewMeanMs: resolveScheduleSkewMeanMs({
        streamArrivalsRigMs: rig.debug.flashStreamArrivalsRigMs,
        scheduleSkewSamplesMs: [],
        intervalMs: rig.debug.beepIntervalMs,
      }),
    }
    const plainFid = await exportRecording({ recording, edit: base })
    const plainAnalysis = await analyzeExport(plainFid.blob, analyzeOpts)
    const total = recording.durationMs
    // (analysed before the next export, for the same reason as above)
    const fidEdit = clampEditState(recording, {
      ...base,
      segments: [
        { startMs: 0, endMs: Math.round(total * 0.3) },
        { startMs: Math.round(total * 0.3), endMs: Math.round(total * 0.7), speed },
        { startMs: Math.round(total * 0.7), endMs: total },
      ],
    })
    const spedFid = await exportRecording({ recording, edit: fidEdit })
    const spedAnalysis = await analyzeExport(spedFid.blob, analyzeOpts)
    const pm = plainAnalysis.flashSync?.meanOffsetMs ?? null
    const sm = spedAnalysis.flashSync?.meanOffsetMs ?? null
    sync = {
      plainMeanMs: pm === null ? null : Math.round(pm * 100) / 100,
      spedMeanMs: sm === null ? null : Math.round(sm * 100) / 100,
      plainMaxAbsMs: plainAnalysis.flashSync
        ? Math.round(plainAnalysis.flashSync.maxAbsOffsetMs * 100) / 100
        : null,
      spedMaxAbsMs: spedAnalysis.flashSync
        ? Math.round(spedAnalysis.flashSync.maxAbsOffsetMs * 100) / 100
        : null,
      deltaMs: pm === null || sm === null ? null : Math.round((sm - pm) * 100) / 100,
      flashes: spedAnalysis.flashOnsetsSec.length,
      onsets: spedAnalysis.onsetsSec.length,
    }
  } finally {
    await rig.cleanup?.()
  }

  const plainOutputMs = outputDurationMs(plainEdit)
  const spedOutputMs = outputDurationMs(spedEdit)
  return {
    takeMs,
    toneHz: TONE_HZ,
    pitch: {
      speed,
      windowSec,
      measuredHz: measuredHz === null ? null : Math.round(measuredHz * 100) / 100,
      errorCents,
      baselineHz: baselineHz === null ? null : Math.round(baselineHz * 100) / 100,
      baselineErrorCents,
      pass: errorCents === null ? null : Math.abs(errorCents) < 10,
    },
    duration: {
      plainOutputMs: Math.round(plainOutputMs),
      spedOutputMs: Math.round(spedOutputMs),
      expectedSpedOutputMs: Math.round(from + (to - from) / speed + (takeMs - to)),
      plainFileSec,
      spedFileSec,
    },
    sync,
    cost: {
      plainExportMs,
      spedExportMs,
      perOutputSecondRatio:
        plainExportMs > 0 && plainOutputMs > 0 && spedOutputMs > 0
          ? Math.round(
              ((spedExportMs / spedOutputMs) / (plainExportMs / plainOutputMs)) * 100,
            ) / 100
          : null,
    },
    isDefaultEdit: {
      plain: isDefaultEdit(toneRecording, plainEdit),
      sped: isDefaultEdit(toneRecording, spedEdit),
    },
    notes: [...notes, `kept spans: ${JSON.stringify(keptSegments(spedEdit))}`],
  }
}
