import { describe, expect, it } from 'vitest'
import {
  estimateScheduleSkewFromArrivals,
  isAliasedScheduleCorrection,
  resolveScheduleSkewMeanMs,
} from './scheduleSkew'

/**
 * Every fixture below is a series recorded on a 1000 ms grid — two of them
 * verbatim from dumped runs — so each call names that grid explicitly (task
 * G5, 2026-09-01, which moved the rig's own grid off 1000). A test whose
 * fixture is re-interpreted by whatever constant the rig happens to carry is
 * not pinning the arithmetic it was written to pin.
 */
const GRID = 1000

describe('estimateScheduleSkewFromArrivals', () => {
  it('recovers ~200 ms stall when all beeps are present', () => {
    const stall = 200
    const arrivals = [1200, 2200, 3200, 4200, 5200]
    const est = estimateScheduleSkewFromArrivals(arrivals, GRID)
    expect(est.skewMeanMs).toBeCloseTo(stall, 0)
    expect(est.firstBeepIndex).toBe(1)
  })

  it('fixes missed-first-beep aliasing (+1000 ms stall artifact)', () => {
    // Cold run: probe misses beep 1; first arrival is beep 2 at rig ~2200 ms.
    const stall = 200
    const arrivals = [2200, 3200, 4200, 5200]
    const naiveSkew = arrivals.map((t, i) => t - (i + 1) * 1000)
    expect(naiveSkew[0]).toBeCloseTo(1200, 0) // would alias corrected sync by ~−960 ms

    const est = estimateScheduleSkewFromArrivals(arrivals, GRID)
    expect(est.skewMeanMs).toBeCloseTo(stall, 0)
    expect(est.firstBeepIndex).toBe(2)
  })

  it('rejects wild misalignment', () => {
    const est = estimateScheduleSkewFromArrivals([50, 5000], GRID)
    expect(est.skewMeanMs).toBeNull()
  })

  /**
   * THE COLD RUN THAT FAILED THE GATE (GATE-alias, 2026-08-25). Measured
   * arrivals, verbatim from a dumped failing run: a perfectly regular schedule
   * stalled by 537 ms. The old estimator refused it because 537 > 450 and the
   * gate then fell to its raw rung and failed the run at −438.7 ms.
   */
  it('measures a stall larger than the old 450 ms clamp', () => {
    const est = estimateScheduleSkewFromArrivals([1537, 2537, 3537, 4537, 5537], GRID)
    expect(est.skewMeanMs).toBeCloseTo(537, 0)
    expect(est.firstBeepIndex).toBe(1)
  })

  it('still measures it when the first beep was missed as well', () => {
    const est = estimateScheduleSkewFromArrivals([2537, 3537, 4537], GRID)
    expect(est.skewMeanMs).toBeCloseTo(537, 0)
    expect(est.firstBeepIndex).toBe(2)
  })

  it('refuses an irregular schedule rather than averaging it', () => {
    // One beep missing from the MIDDLE: not one arrival per interval.
    expect(estimateScheduleSkewFromArrivals([1200, 2200, 4200, 5200], GRID).skewMeanMs).toBeNull()
  })
})

describe('isAliasedScheduleCorrection', () => {
  it('flags the round3 −960 ms corrected artifact', () => {
    expect(isAliasedScheduleCorrection(40, 1000, GRID)).toBe(true)
  })

  it('flags in-band raw corrected out of band (runs 8/9 flake class)', () => {
    // raw ≈ +33, bad stall ≈ 450 → corrected ≈ −417
    expect(isAliasedScheduleCorrection(33, 450, GRID)).toBe(true)
    // same class: raw already in sync band, any large stall subtract is aliasing
    expect(isAliasedScheduleCorrection(40, 200, GRID)).toBe(true)
    // legitimate: stall visible in raw, correction lands in band
    expect(isAliasedScheduleCorrection(292, 280, GRID)).toBe(false)
  })
})

describe('resolveScheduleSkewMeanMs', () => {
  it('prefers aligned stream arrivals over bad schedule samples', () => {
    const skew = resolveScheduleSkewMeanMs({
      streamArrivalsRigMs: [2200, 3200, 4200],
      scheduleSkewSamplesMs: [1000, 1000, 1000],
      intervalMs: GRID,
    })
    expect(skew).toBeCloseTo(200, 0)
  })
})
