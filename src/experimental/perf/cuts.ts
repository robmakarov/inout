/**
 * EXPERIMENTAL — F1 evidence: mid-take cuts.
 *
 * Uses the oracle's fiducial rig, so the exported file still carries flashes
 * and clicks at known instants: cutting material out removes the same instants
 * from BOTH modalities, so if the engine maps output time correctly the
 * surviving pairs stay in sync. Any error in the piecewise mapping shows up as
 * a joint that drifts.
 *
 * Also measures what a cut does to the audio waveform at the joint — two
 * unrelated pieces butted together is a step discontinuity, i.e. a click.
 */

import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny'
import { exportRecording } from '@core/compose'
import {
  clampEditState,
  defaultEditState,
  isDefaultEdit,
  keptSegments,
  outputDurationMs,
  segmentJoinsMs,
} from '@core/timeline'
import type { EditState, KeptSegment } from '@core/types'
import { analyzeExport } from '../oracle/analyze'
import { recordFiducialSession, sweepStaleOracleBlobs } from '../oracle/rig'
import { resolveScheduleSkewMeanMs } from '../oracle/scheduleSkew'

/** Largest single-sample jump near each joint vs the file's typical jump. */
async function jointDiscontinuity(
  blob: Blob,
  joinsMs: number[],
): Promise<{ joinMaxDelta: number; baselineMaxDelta: number; ratio: number } | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return null
    const sink = new AudioBufferSink(track)
    let joinMax = 0
    let baseMax = 0
    const WINDOW_SEC = 0.01
    for await (const { buffer, timestamp } of sink.buffers()) {
      const ch = buffer.getChannelData(0)
      const rate = buffer.sampleRate
      for (let i = 1; i < ch.length; i++) {
        const d = Math.abs(ch[i]! - ch[i - 1]!)
        const t = timestamp + i / rate
        const nearJoin = joinsMs.some((j) => Math.abs(t - j / 1000) < WINDOW_SEC)
        if (nearJoin) {
          if (d > joinMax) joinMax = d
        } else if (d > baseMax) baseMax = d
      }
    }
    return {
      joinMaxDelta: Math.round(joinMax * 1e5) / 1e5,
      baselineMaxDelta: Math.round(baseMax * 1e5) / 1e5,
      ratio: baseMax > 0 ? Math.round((joinMax / baseMax) * 100) / 100 : 0,
    }
  } finally {
    input.dispose()
  }
}

export interface F1Report {
  recordMs: number
  noCut: {
    outputMs: number
    isDefaultEdit: boolean
    bytes: number
    syncMeanMs: number | null
    syncMaxAbsMs: number | null
  }
  cut: {
    segments: KeptSegment[]
    joinsMs: number[]
    outputMs: number
    isDefaultEdit: boolean
    bytes: number
    exportMs: number
    syncMeanMs: number | null
    syncMaxAbsMs: number | null
    flashes: number
    onsets: number
  }
  /** Sync must not degrade because of the cuts. */
  syncDeltaMs: number | null
  joints: { joinMaxDelta: number; baselineMaxDelta: number; ratio: number } | null
  noopSegmentsDropped: boolean
  notes: string[]
}

export async function runCutsEvidence(opts: { recordMs?: number } = {}): Promise<F1Report> {
  const recordMs = opts.recordMs ?? 12_000
  await sweepStaleOracleBlobs()
  const rig = await recordFiducialSession(recordMs, { flashClick: true })
  try {
    const recording = rig.recording
    const base = defaultEditState(recording)
    const skewMean = resolveScheduleSkewMeanMs({
      streamArrivalsRigMs: rig.debug.beepAnchorRigMs.length
        ? rig.debug.beepAnchorRigMs
        : rig.debug.beepStreamArrivalsRigMs,
      scheduleSkewSamplesMs: rig.debug.beepScheduleSkewMs,
      intervalMs: rig.debug.beepIntervalMs,
    })
    const flashSkew = resolveScheduleSkewMeanMs({
      streamArrivalsRigMs: rig.debug.flashStreamArrivalsRigMs,
      scheduleSkewSamplesMs: [],
      intervalMs: rig.debug.beepIntervalMs,
    })
    const analyzeOpts = {
      beepGridRigMs: rig.debug.beepStreamArrivalsRigMs,
      beepScheduleSkewMeanMs: skewMean,
      flashScheduleSkewMeanMs: flashSkew,
    }

    // Baseline: no cuts.
    const plain = await exportRecording({ recording, edit: base })
    const plainAnalysis = await analyzeExport(plain.blob, analyzeOpts)

    // Three cuts at deliberately non-round offsets, none on a beep instant.
    const total = recording.durationMs
    const raw: KeptSegment[] = [
      { startMs: 0, endMs: Math.round(total * 0.19) },
      { startMs: Math.round(total * 0.31), endMs: Math.round(total * 0.53) },
      { startMs: Math.round(total * 0.64), endMs: Math.round(total * 0.81) },
      { startMs: Math.round(total * 0.88), endMs: total },
    ]
    const cutEdit: EditState = clampEditState(recording, { ...base, segments: raw })
    const t0 = performance.now()
    const cutResult = await exportRecording({ recording, edit: cutEdit })
    const exportMs = Math.round(performance.now() - t0)
    const cutAnalysis = await analyzeExport(cutResult.blob, analyzeOpts)
    const joins = segmentJoinsMs(cutEdit)
    const joints = await jointDiscontinuity(cutResult.blob, joins)

    // A segment list covering the whole trim must vanish, so untouched takes
    // keep the old code path exactly.
    const noop = clampEditState(recording, {
      ...base,
      segments: [{ startMs: 0, endMs: recording.durationMs }],
    })

    const cutMean = cutAnalysis.flashSync?.meanOffsetMs ?? null
    const plainMean = plainAnalysis.flashSync?.meanOffsetMs ?? null

    return {
      recordMs,
      noCut: {
        outputMs: outputDurationMs(base),
        isDefaultEdit: isDefaultEdit(recording, base),
        bytes: plain.blob.size,
        syncMeanMs: plainMean === null ? null : Math.round(plainMean * 100) / 100,
        syncMaxAbsMs: plainAnalysis.flashSync
          ? Math.round(plainAnalysis.flashSync.maxAbsOffsetMs * 100) / 100
          : null,
      },
      cut: {
        segments: keptSegments(cutEdit),
        joinsMs: joins.map((j) => Math.round(j)),
        outputMs: outputDurationMs(cutEdit),
        isDefaultEdit: isDefaultEdit(recording, cutEdit),
        bytes: cutResult.blob.size,
        exportMs,
        syncMeanMs: cutMean === null ? null : Math.round(cutMean * 100) / 100,
        syncMaxAbsMs: cutAnalysis.flashSync
          ? Math.round(cutAnalysis.flashSync.maxAbsOffsetMs * 100) / 100
          : null,
        flashes: cutAnalysis.flashOnsetsSec.length,
        onsets: cutAnalysis.onsetsSec.length,
      },
      syncDeltaMs:
        cutMean === null || plainMean === null ? null : Math.round((cutMean - plainMean) * 100) / 100,
      joints,
      noopSegmentsDropped: noop.segments === undefined && isDefaultEdit(recording, noop),
      notes: [
        'cuts remove the same instants from video and audio, so surviving flash/click pairs must stay in sync — a mapping error shows as a drifting joint',
        'joint discontinuity compares the largest single-sample jump within 10 ms of a joint against the largest anywhere else; a click would tower over the baseline',
      ],
    }
  } finally {
    await rig.cleanup()
  }
}
