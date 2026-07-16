/**
 * EXPERIMENTAL — oracle sync outlier diagnostics (task 3a: −473ms class).
 *
 * Surfaces whether a bad flash+click residual is instrument (skew correction
 * dropout / pairing) vs capture product offset.
 */

import type { ExportAnalysis } from './analyze'
import {
  estimateScheduleSkewFromArrivals,
  isAliasedScheduleCorrection,
  MAX_SCHEDULE_STALL_MS,
} from './scheduleSkew'
import type { RigDebug } from './rig'

export type SyncOutlierVerdict = 'instrument' | 'product-suspect' | 'in-band'

export interface SyncDiagnostics {
  rawFlashMeanMs: number | null
  correctedFlashMeanMs: number | null
  correctionApplied: boolean
  correctionRejectedAliased: boolean
  skewMeanMs: number | null
  skewFromArrivals: ReturnType<typeof estimateScheduleSkewFromArrivals>
  flashMatchedPairs: number
  flashCount: number
  verdict: SyncOutlierVerdict
  note: string
}

export function diagnoseSyncOutlier(
  full: ExportAnalysis,
  rigDebug: RigDebug,
  skewMeanMs: number | undefined,
): SyncDiagnostics {
  const flash = full.flashSync
  const raw = flash?.meanOffsetMs ?? null
  const corrected = full.flashSyncCorrectedMeanMs
  const correctionApplied = corrected !== null
  const skewFromArrivals = estimateScheduleSkewFromArrivals(rigDebug.beepStreamArrivalsRigMs)
  const skewMean =
    skewMeanMs ??
    skewFromArrivals.skewMeanMs ??
    (rigDebug.beepScheduleSkewMs.length
      ? rigDebug.beepScheduleSkewMs.reduce((a, b) => a + b, 0) /
        rigDebug.beepScheduleSkewMs.length
      : null)

  const correctionRejectedAliased =
    raw !== null &&
    skewMean !== null &&
    isAliasedScheduleCorrection(raw, skewMean)

  let verdict: SyncOutlierVerdict = 'in-band'
  let note = 'flash+click in band or corrected'

  const used = correctionApplied ? corrected! : raw
  if (used !== null && Math.abs(used) > 60) {
    if (!correctionApplied && skewMean === null) {
      verdict = 'instrument'
      note = `raw |${used.toFixed(0)}|ms with NO skew estimate (arrivals=${rigDebug.beepStreamArrivalsRigMs.length}) — correction dropout, not capture`
    } else if (!correctionApplied && skewMean !== null && Math.abs(skewMean) > MAX_SCHEDULE_STALL_MS) {
      verdict = 'instrument'
      note = `raw |${used.toFixed(0)}|ms; skew=${skewMean.toFixed(0)}ms exceeds stall cap — correction refused`
    } else if (correctionRejectedAliased) {
      verdict = 'instrument'
      note = 'aliased correction rejected; raw exposed'
    } else if (correctionApplied && raw !== null && Math.abs(raw) > 200 && Math.abs(used) <= 60) {
      verdict = 'in-band'
      note = 'large raw corrected in-band — AC stall class'
    } else {
      verdict = 'product-suspect'
      note = `|${used.toFixed(0)}|ms after correction with valid skew — investigate capture epoch`
    }
  }

  return {
    rawFlashMeanMs: raw,
    correctedFlashMeanMs: corrected,
    correctionApplied,
    correctionRejectedAliased,
    skewMeanMs: skewMean,
    skewFromArrivals,
    flashMatchedPairs: flash?.matchedPairs ?? 0,
    flashCount: full.flashOnsetsSec.length,
    verdict,
    note,
  }
}
