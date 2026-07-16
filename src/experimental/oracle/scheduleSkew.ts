/**
 * EXPERIMENTAL — AudioContext startup-stall estimate for flash+click correction.
 *
 * Beep stream-arrival probes can miss the first onset on a cold run; naively
 * mapping arrival[i] → (i+1)·interval aliases the stall by ±one beep period
 * (~±1000 ms). The STATE round3 flake (−960 ms "corrected" sync) was exactly
 * this: skewMean ≈ +1000 ms subtracted from a ~+40 ms raw flash offset.
 */

import { BEEP_INTERVAL_MS } from './rig'

/** AudioContext startup stall is machine-dependent but stays well below half a grid. */
export const MAX_SCHEDULE_STALL_MS = 450
/** Residual variance (ms²) above which grid alignment is rejected. */
export const MAX_ALIGN_VARIANCE_MS2 = 120 ** 2

export interface ScheduleSkewEstimate {
  /** Mean startup stall, ms; null when unreliable. */
  skewMeanMs: number | null
  /** 1-based index of the beep matched to arrivals[0]. */
  firstBeepIndex: number | null
  /** Residual variance after alignment, ms². */
  varianceMs2: number | null
}

/**
 * Grid-align rig-time beep arrivals to the nominal k·interval schedule and
 * return the mean stall (actual − nominal). Tries every candidate first-beep
 * index and picks the alignment with lowest residual variance.
 */
export function estimateScheduleSkewFromArrivals(
  arrivalsRigMs: number[],
  intervalMs: number = BEEP_INTERVAL_MS,
): ScheduleSkewEstimate {
  if (arrivalsRigMs.length < 2) {
    return { skewMeanMs: null, firstBeepIndex: null, varianceMs2: null }
  }

  let best: { mean: number; variance: number; firstIndex: number } | null = null

  const maxFirst = arrivalsRigMs.length + 2
  for (let firstIndex = 1; firstIndex <= maxFirst; firstIndex++) {
    const skews = arrivalsRigMs.map((t, i) => t - (firstIndex + i) * intervalMs)
    const mean = skews.reduce((a, b) => a + b, 0) / skews.length
    const variance = skews.reduce((a, s) => a + (s - mean) ** 2, 0) / skews.length
    if (variance > MAX_ALIGN_VARIANCE_MS2) continue
    if (Math.abs(mean) > MAX_SCHEDULE_STALL_MS) continue
    if (
      !best ||
      variance < best.variance ||
      (variance === best.variance && firstIndex < best.firstIndex)
    ) {
      best = { mean, variance, firstIndex }
    }
  }

  if (!best) {
    return { skewMeanMs: null, firstBeepIndex: null, varianceMs2: null }
  }

  return {
    skewMeanMs: best.mean,
    firstBeepIndex: best.firstIndex,
    varianceMs2: best.variance,
  }
}

/**
 * Median of per-beep schedule skew samples (rig path). Drops samples whose
 * |skew| exceeds MAX_SCHEDULE_STALL_MS — those usually mean ctxSecToRigMs had
 * too few clock pairs at cold start.
 */
export function medianScheduleSkewFromSamples(
  skewSamplesMs: number[],
): number | null {
  const sane = skewSamplesMs.filter((s) => Math.abs(s) <= MAX_SCHEDULE_STALL_MS)
  if (sane.length < 2) return null
  const sorted = [...sane].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Pick the best stall estimate for flash+click correction. Prefers
 * grid-aligned stream arrivals; falls back to median of rig clock samples.
 */
export function resolveScheduleSkewMeanMs(args: {
  streamArrivalsRigMs: number[]
  scheduleSkewSamplesMs: number[]
  intervalMs?: number
}): number | undefined {
  const interval = args.intervalMs ?? BEEP_INTERVAL_MS
  const fromArrivals = estimateScheduleSkewFromArrivals(args.streamArrivalsRigMs, interval)
  if (fromArrivals.skewMeanMs !== null) return fromArrivals.skewMeanMs

  const fromSamples = medianScheduleSkewFromSamples(args.scheduleSkewSamplesMs)
  return fromSamples ?? undefined
}

/** Sync CI band — correcting an already-in-band raw reading out of band is aliasing. */
export const SYNC_BAND_MS = 60

/** True when schedule correction would alias the sync metric by ~one grid period. */
export function isAliasedScheduleCorrection(
  rawFlashMeanMs: number,
  skewMeanMs: number,
  intervalMs: number = BEEP_INTERVAL_MS,
): boolean {
  const corrected = rawFlashMeanMs - skewMeanMs
  const grid = intervalMs
  if (Math.abs(skewMeanMs) > MAX_SCHEDULE_STALL_MS) return true
  if (Math.abs(corrected - rawFlashMeanMs) > grid * 0.5) return true
  // Cold-run flake class (runs 8/9): raw already ~±30ms but a bad stall
  // estimate (~450ms) is subtracted → corrected ≈ −400ms. Never apply that.
  if (Math.abs(rawFlashMeanMs) <= SYNC_BAND_MS && Math.abs(corrected) > SYNC_BAND_MS) {
    return true
  }
  if (Math.abs(corrected) > MAX_SCHEDULE_STALL_MS && Math.abs(rawFlashMeanMs) <= MAX_SCHEDULE_STALL_MS) {
    return true
  }
  // Correction must not inflate |offset| past the sync band.
  if (Math.abs(corrected) > Math.abs(rawFlashMeanMs) + 15 && Math.abs(corrected) > SYNC_BAND_MS) {
    return true
  }
  return false
}
