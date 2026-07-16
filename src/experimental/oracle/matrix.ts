/**
 * EXPERIMENTAL — Step 1: oracle characterization matrix.
 *
 * Cells: channel mixes (screen+mic / camera+mic / all-four / audio-only)
 * × durations, N runs each. Per cell: flash+click sync mean/max (GATE),
 * drift, trim error, with across-run variance. Barcode+grid is not gated.
 *
 * audio-only caveat (stated, not hidden): the export is a waveform video with
 * no barcodes, so the video-clock sync metric does not exist. The cell instead
 * reports beep-grid regularity (onset interval error) and an audio-domain trim
 * probe: firstOnset(full) − firstOnset(trimmed) must equal the trim.
 *
 * all-four caveat: the camera is a PiP in the export (24 % width) — its
 * barcode is below decode resolution; sync is measured against the SCREEN
 * barcode. Camera raw alignment is covered by the localization step instead.
 */

import { exportRecording } from '@core/compose'
import { defaultEditState } from '@core/timeline'
import type { EditState } from '@core/types'
import { analyzeExport } from './analyze'
import { DEFAULT_TRIM_MS } from './run'
import {
  BEEP_INTERVAL_MS,
  recordFiducialSession,
  RIG_MIXES,
  sweepStaleOracleBlobs,
} from './rig'

export interface MatrixRun {
  /** Sync offset mean/max, ms (video-clock convention: + = audio late). */
  syncMeanMs: number | null
  syncMaxAbsMs: number | null
  driftMsPerS: number | null
  trimErrorMs: number | null
  readableRatio: number | null
  /** audio-only cells: beep interval error vs 1000ms grid. */
  onsetIntervalMeanErrMs: number | null
  onsetCount: number
}

export interface MatrixCell {
  mix: string
  recordMs: number
  n: number
  runs: MatrixRun[]
  aggregate: {
    syncMeanOfMeansMs: number | null
    syncStdOfMeansMs: number | null
    syncWorstAbsMs: number | null
    driftMeanMsPerS: number | null
    trimWorstAbsMs: number | null
  }
}

export interface MatrixReport {
  trimStartMs: number
  startedAt: string
  wallMs: number
  cells: MatrixCell[]
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

function std(xs: number[]): number | null {
  if (xs.length < 2) return null
  const m = mean(xs) as number
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1))
}

async function runCellOnce(mixId: string, recordMs: number, trimStartMs: number): Promise<MatrixRun> {
  await sweepStaleOracleBlobs()
  const rig = await recordFiducialSession(recordMs, {
    mix: RIG_MIXES[mixId],
    flashClick: true,
  })
  try {
    const edit = defaultEditState(rig.recording)
    const skews = rig.debug.beepScheduleSkewMs
    const analyzeOpts = {
      beepGridRigMs: rig.debug.beepTrueRigMs,
      beepScheduleSkewMeanMs: skews.length
        ? skews.reduce((a, b) => a + b, 0) / skews.length
        : undefined,
    }
    const full = await analyzeExport(
      (await exportRecording({ recording: rig.recording, edit })).blob,
      analyzeOpts,
    )
    const trimmedEdit: EditState = {
      ...edit,
      globalTrimStartMs: trimStartMs,
      globalTrimEndMs: rig.recording.durationMs,
    }
    const trimmed = await analyzeExport(
      (await exportRecording({ recording: rig.recording, edit: trimmedEdit })).blob,
      analyzeOpts,
    )

    // Sync gate = flash+click (barcode+grid demoted to drift/trim).
    const flashMean = full.flashSync
      ? (full.flashSyncCorrectedMeanMs ?? full.flashSync.meanOffsetMs)
      : null
    const flashMax = full.flashSync
      ? (full.flashSyncCorrectedMaxAbsMs ?? full.flashSync.maxAbsOffsetMs)
      : null

    const trimErrorMs =
      full.fit && trimmed.fit ? trimmed.fit.alphaMs - full.fit.alphaMs - trimStartMs : null

    let onsetIntervalMeanErrMs: number | null = null
    if (full.onsetsSec.length >= 2) {
      const errs: number[] = []
      for (let i = 1; i < full.onsetsSec.length; i++) {
        const d = (full.onsetsSec[i] - full.onsetsSec[i - 1]) * 1000
        errs.push(d - Math.round(d / BEEP_INTERVAL_MS) * BEEP_INTERVAL_MS)
      }
      onsetIntervalMeanErrMs = mean(errs)
    }
    let audioTrimErrorMs: number | null = null
    if (!full.fit && full.onsetsSec.length > 0 && trimmed.onsetsSec.length > 0) {
      audioTrimErrorMs = (full.onsetsSec[0] - trimmed.onsetsSec[0]) * 1000 - trimStartMs
    }

    return {
      syncMeanMs: flashMean,
      syncMaxAbsMs: flashMax,
      driftMsPerS: full.fit ? (full.fit.beta - 1) * 1000 : null,
      trimErrorMs: trimErrorMs ?? audioTrimErrorMs,
      readableRatio: full.flow.frames ? full.flow.readable / full.flow.frames : null,
      onsetIntervalMeanErrMs,
      onsetCount: full.onsetsSec.length,
    }
  } finally {
    await rig.cleanup()
  }
}

export interface MatrixSpec {
  mixes?: string[]
  durationsMs?: number[]
  n?: number
  trimStartMs?: number
  onProgress?: (done: number, total: number, label: string) => void
}

export async function runOracleMatrix(spec?: MatrixSpec): Promise<MatrixReport> {
  const mixes = spec?.mixes ?? Object.keys(RIG_MIXES)
  const durations = spec?.durationsMs ?? [6000, 30_000]
  const n = spec?.n ?? 5
  const trimStartMs = spec?.trimStartMs ?? DEFAULT_TRIM_MS
  const startedAt = new Date().toISOString()
  const t0 = performance.now()

  const cells: MatrixCell[] = []
  const total = mixes.length * durations.length * n
  let done = 0
  for (const mix of mixes) {
    for (const recordMs of durations) {
      const runs: MatrixRun[] = []
      for (let i = 0; i < n; i++) {
        spec?.onProgress?.(done, total, `${mix} ${recordMs}ms run ${i + 1}/${n}`)
        runs.push(await runCellOnce(mix, recordMs, trimStartMs))
        done++
      }
      const syncMeans = runs.map((r) => r.syncMeanMs).filter((x): x is number => x !== null)
      const syncMaxes = runs.map((r) => r.syncMaxAbsMs).filter((x): x is number => x !== null)
      const drifts = runs.map((r) => r.driftMsPerS).filter((x): x is number => x !== null)
      const trims = runs.map((r) => r.trimErrorMs).filter((x): x is number => x !== null)
      cells.push({
        mix,
        recordMs,
        n,
        runs,
        aggregate: {
          syncMeanOfMeansMs: mean(syncMeans),
          syncStdOfMeansMs: std(syncMeans),
          syncWorstAbsMs: syncMaxes.length ? Math.max(...syncMaxes) : null,
          driftMeanMsPerS: mean(drifts),
          trimWorstAbsMs: trims.length ? Math.max(...trims.map(Math.abs)) : null,
        },
      })
    }
  }

  return { trimStartMs, startedAt, wallMs: performance.now() - t0, cells }
}
