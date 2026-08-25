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
 * return the mean stall (actual − nominal).
 *
 * A STALL IS A DELAY, WHICH MAKES THE INDEX ARITHMETIC RATHER THAN A SEARCH
 * (task GATE-alias, 2026-08-25). Beep k is SCHEDULED at k·interval and can only
 * ever render LATE — an AudioContext that has not finished starting cannot make
 * a sound early. So every arrival satisfies
 *
 *     arrival = k · interval + stall,  with stall ∈ [0, interval)
 *
 * and k is simply floor(arrival / interval). That holds whether or not the
 * probe missed the first beep, because a missed beep changes k and not the
 * relation. The old code searched candidate first-indices and threw the answer
 * away when |mean| exceeded MAX_SCHEDULE_STALL_MS — which is how a cold run
 * with a MEASURED, perfectly regular 537 ms stall (arrivals 1537, 2537, 3537,
 * 4537, 5537 — residual 537 on every one) produced no estimate at all, dropped
 * the gate to its raw rung, and failed the run at −438.7 ms. The clamp was
 * protecting against a whole-period alias that this arithmetic cannot produce.
 *
 * WHAT IS STILL UNRESOLVABLE, and it is now the only case: a stall of a FULL
 * interval or more wraps, and nothing in this signal can see it. The variance
 * check below catches an irregular schedule; a uniformly-wrapped one it cannot.
 */
export function estimateScheduleSkewFromArrivals(
  arrivalsRigMs: number[],
  intervalMs: number = BEEP_INTERVAL_MS,
): ScheduleSkewEstimate {
  if (arrivalsRigMs.length < 2) {
    return { skewMeanMs: null, firstBeepIndex: null, varianceMs2: null }
  }

  const firstIndex = Math.floor(arrivalsRigMs[0]! / intervalMs)
  if (firstIndex < 1) return { skewMeanMs: null, firstBeepIndex: null, varianceMs2: null }
  const skews = arrivalsRigMs.map((t, i) => t - (firstIndex + i) * intervalMs)
  const mean = skews.reduce((a, b) => a + b, 0) / skews.length
  const variance = skews.reduce((a, s) => a + (s - mean) ** 2, 0) / skews.length
  // An irregular schedule means the arrivals are not one beep per interval —
  // a dropped beep in the MIDDLE, or a probe measuring something else. Refuse.
  const best =
    variance <= MAX_ALIGN_VARIANCE_MS2 && mean >= -MAX_SCHEDULE_STALL_MS && mean < intervalMs
      ? { mean, variance, firstIndex }
      : null

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

/**
 * THE SYMMETRIC METRIC SUBTRACTS A DIFFERENT NUMBER THAN THE GUARD USED TO VET
 * (task GATE-alias, 2026-08-25).
 *
 * The gate bands `flashSyncSymmetricMeanMs`, which is
 *
 *     unbiasedRaw − (beepSkew − flashSkew)
 *
 * i.e. it removes the rig's audio-vs-video reference skew, not just its audio
 * half. But the only aliasing guard in the chain vetted `beepSkew` ALONE. Each
 * half is individually clamped to ±MAX_SCHEDULE_STALL_MS, so each looks sane on
 * its own — and their DIFFERENCE can still reach ±900 ms with nothing checking
 * it. Measured: three cold runs in fifteen came back at −453, −465 and −909 ms
 * with `aliased=false` on every one, from raw readings that were inside the
 * band, and the correction is the only term big enough to do that.
 *
 * So vet the sum that is actually applied. This is the same predicate as
 * isAliasedScheduleCorrection — deliberately, because "is this correction
 * credible" is one question — applied to the total instead of one half of it.
 */
export function isAliasedSymmetricCorrection(
  unbiasedRawMeanMs: number,
  beepSkewMeanMs: number,
  flashSkewMeanMs: number,
  intervalMs: number = BEEP_INTERVAL_MS,
): boolean {
  const total = beepSkewMeanMs - flashSkewMeanMs
  // Each half is a startup stall in [0, interval); their difference has no more
  // room than that either. Beyond it, at least one half is measuring something
  // that is not a stall.
  if (Math.abs(total) >= intervalMs) return true
  return isAliasedScheduleCorrection(unbiasedRawMeanMs, total, intervalMs)
}

/** True when schedule correction would alias the sync metric by ~one grid period. */
export function isAliasedScheduleCorrection(
  rawFlashMeanMs: number,
  skewMeanMs: number,
  intervalMs: number = BEEP_INTERVAL_MS,
): boolean {
  const corrected = rawFlashMeanMs - skewMeanMs
  /**
   * THE MAGNITUDE CLAMPS WERE THE BUG, NOT THE PROTECTION (GATE-alias,
   * 2026-08-25). Both of these used to reject any correction bigger than
   * MAX_SCHEDULE_STALL_MS or half a grid — which is right if the estimator can
   * alias by a whole period, and wrong now that it cannot: the stall is derived
   * arithmetically as arrival mod interval, so it is in [0, interval) by
   * construction. A cold run with a genuine, perfectly regular 537 ms stall was
   * being thrown away by exactly these two lines, dropping the gate to its raw
   * rung and failing the run at −438.7 ms.
   *
   * What actually distinguishes an alias from a stall is not size, it is
   * CONSISTENCY WITH THE RAW READING: a real stall shows up in the raw offset
   * too (raw ≈ stall + a small true error), while an alias corrects an already
   * in-band raw out of band. That is the clause below, and it is the one that
   * caught every historical flake.
   */
  if (Math.abs(skewMeanMs) >= intervalMs) return true
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
