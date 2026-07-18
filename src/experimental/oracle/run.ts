/**
 * EXPERIMENTAL — Oracle runner (Experiment 2), hardened per TD verdict item 3.
 *
 * Full loop: record a fiducial session -> export through the PRODUCTION
 * exportRecording (untouched) -> decode the export -> report numbers.
 *
 * Hardening in this revision:
 *  - trim parameter defaults to a NON-frame-aligned 1483 ms (1483/33.3 = 44.49
 *    frames; also off the 1 s audio chunk grid) — the earlier 1500 ms probe
 *    could hide rounding errors that frame alignment forgives;
 *  - maxAbsOffsetMs gated alongside |mean|;
 *  - sign convention surfaced in every verdict via SyncStats.leads
 *    (positive = audio late / video early — see fiducial.ts);
 *  - every production-storage touch wrapped so failures cannot strand
 *    exp-oracle-* keys, plus a stale-key sweep before each run.
 */

import { exportRecording } from '@core/compose'
import { defaultEditState } from '@core/timeline'
import type { EditState } from '@core/types'
import { analyzeAudioIntegrity, type AudioIntegrityReport } from './audioIntegrity'
import { analyzeExport, type ExportAnalysis } from './analyze'
import { recordFiducialSession, sweepStaleOracleBlobs, type RecordOptions } from './rig'
import { resolveScheduleSkewMeanMs } from './scheduleSkew'
import { diagnoseSyncOutlier, type SyncDiagnostics } from './syncDiagnostics'

export interface OracleVerdict {
  metric: string
  value: string
  pass: boolean | null
  note?: string
}

export interface OracleReport {
  recordMs: number
  trimStartMs: number
  sweptStaleKeys: string[]
  full: ExportAnalysis
  trimmed: ExportAnalysis
  audioIntegrity: AudioIntegrityReport | null
  /** alpha(trimmed) - alpha(full) - trimStartMs, ms. */
  trimErrorMs: number | null
  exportFullMs: number
  exportTrimmedMs: number
  verdicts: OracleVerdict[]
  /** Instrument vs product classification for flash+click outliers. */
  syncDiagnostics: SyncDiagnostics
  /** Measured-video anchor diagnostics (bimodal-sync investigation). */
  videoDiag?: unknown
}

/** Instrument gates — TD sync-fix review: flash+click is the sync verdict. */
export const MAX_SYNC_MEAN_MS = 30
export const MAX_SYNC_ABS_MS = 50
/** Barcode sync kept as drift/trim diagnostic only — not a pass/fail gate. */
export const MAX_BARCODE_SYNC_MEAN_MS = 80
export const MAX_DRIFT = 0.002 // 2ms/s
export const MAX_TRIM_ERROR_MS = 50
export const MIN_READABLE_RATIO = 0.9

/** Non-frame-aligned default (30 fps => 33.33 ms frames; 1483 ≈ 44.49 frames). */
export const DEFAULT_TRIM_MS = 1483

export async function runOracle(
  recordMs = 6000,
  trimStartMs: number = DEFAULT_TRIM_MS,
  opts?: RecordOptions,
): Promise<OracleReport> {
  const sweptStaleKeys = await sweepStaleOracleBlobs()
  // flash+click is the sync gate — default on unless explicitly disabled.
  const rig = await recordFiducialSession(recordMs, {
    flashClick: true,
    ...opts,
    ...(opts && 'flashClick' in opts ? { flashClick: opts.flashClick } : {}),
  })
  try {
    const edit = defaultEditState(rig.recording)
    // Prefer MediaStream arrival skew (when beeps hit the mic track) over
    // AudioContext schedule mapping — the latter was swinging 100–400ms/run
    // and poisoning the flash+click gate after a correct capture path.
    const streamArrivals = rig.debug.beepStreamArrivalsRigMs
    const skewMean = resolveScheduleSkewMeanMs({
      streamArrivalsRigMs: streamArrivals,
      scheduleSkewSamplesMs: rig.debug.beepScheduleSkewMs,
      intervalMs: rig.debug.beepIntervalMs,
    })
    const analyzeOpts = {
      beepGridRigMs: streamArrivals.length ? streamArrivals : rig.debug.beepTrueRigMs,
      beepScheduleSkewMeanMs: skewMean,
    }

    const t0 = performance.now()
    const fullResult = await exportRecording({ recording: rig.recording, edit })
    const exportFullMs = performance.now() - t0
    const full = await analyzeExport(fullResult.blob, analyzeOpts)
    const audioIntegrity = await analyzeAudioIntegrity(fullResult.blob)

    const trimmedEdit: EditState = {
      ...edit,
      globalTrimStartMs: trimStartMs,
      globalTrimEndMs: rig.recording.durationMs,
    }
    const t1 = performance.now()
    const trimmedResult = await exportRecording({ recording: rig.recording, edit: trimmedEdit })
    const exportTrimmedMs = performance.now() - t1
    const trimmed = await analyzeExport(trimmedResult.blob, analyzeOpts)

    const trimErrorMs =
      full.fit && trimmed.fit ? trimmed.fit.alphaMs - full.fit.alphaMs - trimStartMs : null

    const verdicts = buildVerdicts({
      recordMs,
      trimStartMs,
      full,
      trimmed,
      trimErrorMs,
      exportFullMs,
      audioIntegrity,
    })
    const syncDiagnostics = diagnoseSyncOutlier(full, rig.debug, skewMean)
    return {
      recordMs,
      trimStartMs,
      sweptStaleKeys,
      full,
      trimmed,
      audioIntegrity,
      trimErrorMs,
      exportFullMs,
      exportTrimmedMs,
      verdicts,
      syncDiagnostics,
      videoDiag: (globalThis as { __inoutVideoDiag?: unknown }).__inoutVideoDiag,
    }
  } finally {
    await rig.cleanup()
  }
}

function buildVerdicts(args: {
  recordMs: number
  trimStartMs: number
  full: ExportAnalysis
  trimmed: ExportAnalysis
  trimErrorMs: number | null
  exportFullMs: number
  audioIntegrity: AudioIntegrityReport | null
}): OracleVerdict[] {
  const { recordMs, trimStartMs, full, trimErrorMs, exportFullMs, audioIntegrity } = args
  const verdicts: OracleVerdict[] = []
  const readableRatio = full.flow.frames ? full.flow.readable / full.flow.frames : 0
  verdicts.push({
    metric: 'fiducial readability',
    value: `${(readableRatio * 100).toFixed(1)}% of ${full.flow.frames} frames (${full.fit?.rejectedPoints ?? 0} fit outliers rejected)`,
    pass: readableRatio >= MIN_READABLE_RATIO,
    note: 'below threshold the remaining metrics lose confidence',
  })
  verdicts.push({
    metric: 'A/V sync barcode+grid (diagnostic only)',
    value: full.sync
      ? `${full.sync.meanOffsetMs.toFixed(1)}ms over ${full.sync.matched} beeps — ${full.sync.leads}`
      : 'n/a',
    pass: null,
    note:
      'NOT a sync gate — measured grid absorbs constant A/V offset (see analyze.ts). Use for drift/trim only. ' +
      `beep grid: ${full.gridCorrected ? 'measured' : 'NOMINAL'}`,
  })
  if (full.flashSync) {
    const flashMean = full.flashSyncCorrectedMeanMs ?? full.flashSync.meanOffsetMs
    const flashMax =
      full.flashSyncCorrectedMaxAbsMs ?? full.flashSync.maxAbsOffsetMs
    const skewNote =
      full.flashSyncCorrectedMeanMs !== null ? ' (schedule-skew corrected)' : ''
    verdicts.push({
      metric: 'A/V sync (flash+click mean) — GATE',
      value: `${flashMean.toFixed(1)}ms over ${full.flashSync.matchedPairs} pairs${skewNote}`,
      pass: Math.abs(flashMean) <= MAX_SYNC_MEAN_MS,
      note: 'barcode-free; sole sync acceptance gate (|mean|≤30ms)',
    })
    verdicts.push({
      metric: 'A/V sync (flash+click max abs) — GATE',
      value: `${flashMax.toFixed(1)}ms${skewNote}`,
      pass: flashMax <= MAX_SYNC_ABS_MS,
      note: 'sole sync acceptance gate (maxAbs≤50ms)',
    })
  } else {
    verdicts.push({
      metric: 'A/V sync (flash+click) — GATE',
      value: 'n/a — enable flashClick',
      pass: false,
      note: 'sync gate requires flash+click; barcode alone is insufficient',
    })
  }
  if (audioIntegrity) {
    verdicts.push({
      metric: 'audio integrity (chunk-boundary jumps)',
      value: `max |Δ|=${audioIntegrity.maxBoundaryJump.toFixed(4)} over ${audioIntegrity.boundaryJumps.length} seams`,
      pass: audioIntegrity.boundaryPass,
      note: 'Task 3b gate: discontinuities >0.1 at 1s mix seams = click/buzz',
    })
    verdicts.push({
      metric: 'audio integrity (spurious spectrum)',
      value:
        audioIntegrity.spurPeakDb === null
          ? 'n/a'
          : `${audioIntegrity.spurPeakDb.toFixed(1)} dB vs tone`,
      pass: audioIntegrity.spectrumPass,
      note: 'Task 3b gate: content outside beep freq must be ≤ −40 dB',
    })
  }
  verdicts.push({
    metric: 'clock drift (beta-1)',
    value: full.fit ? `${((full.fit.beta - 1) * 1000).toFixed(3)}ms/s` : 'n/a',
    pass: full.fit ? Math.abs(full.fit.beta - 1) <= MAX_DRIFT : null,
  })
  verdicts.push({
    metric: 'frame timing jitter (rms)',
    value: full.fit ? `${full.fit.rmsMs.toFixed(1)}ms` : 'n/a',
    pass: null,
    note: 'informational — encoder frame reuse shows up here',
  })
  verdicts.push({
    metric: 'frame flow',
    value: `${full.flow.duplicates} dups, ${full.flow.gaps} gaps, median Δ ${full.flow.medianDeltaMs.toFixed(1)}ms`,
    pass: null,
    note: 'informational — synthetic source is rAF-driven',
  })
  verdicts.push({
    metric: 'trim accuracy (non-frame-aligned probe)',
    value:
      trimErrorMs === null ? 'n/a' : `${trimErrorMs.toFixed(1)}ms error at ${trimStartMs}ms trim`,
    pass: trimErrorMs === null ? null : Math.abs(trimErrorMs) <= MAX_TRIM_ERROR_MS,
  })
  verdicts.push({
    metric: 'export speed',
    value: `${(recordMs / exportFullMs).toFixed(2)}x realtime (${Math.round(exportFullMs)}ms for ${recordMs}ms)`,
    pass: null,
    note: 'baseline for streaming-export comparison (Experiment 5)',
  })
  return verdicts
}
