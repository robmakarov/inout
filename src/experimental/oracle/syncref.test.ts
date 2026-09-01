import { describe, expect, it } from 'vitest'
// @ts-expect-error the G5 analyser is plain ESM in scripts/
import { gridSkews, sharedDiffs, perEvent } from '../../../scripts/syncref.mjs'

/**
 * G5's analyser decides which correction the sync gate subtracts, so its own
 * arithmetic needs pinning: an instrument that picks between estimators must
 * not be the thing that is wrong. Every case here has a hand-computable answer.
 */

/** A run as readRun() shapes it, built from series with known properties. */
function makeRun(opts: {
  beepSkews: number[]
  flashSkews: number[]
  beepK0?: number
  flashK0?: number
  offsetsMs?: number[]
  pairSec?: number[]
  intervalMs?: number
}) {
  const beepK0 = opts.beepK0 ?? 1
  const flashK0 = opts.flashK0 ?? 1
  return {
    intervalMs: opts.intervalMs,
    schedules: {
      anchor: { k0: beepK0, skews: opts.beepSkews },
      flash: { k0: flashK0, skews: opts.flashSkews },
    },
    lanes: {
      render:
        opts.offsetsMs && opts.pairSec
          ? { unbiasedMeanMs: 0, offsetsMs: opts.offsetsMs, pairSec: opts.pairSec }
          : null,
    },
  }
}

describe('gridSkews — the index arithmetic the shipped estimator uses', () => {
  it('indexes a late schedule by floor(arrival / interval)', () => {
    // Beeps 1..3 with a flat 200 ms stall: 1200, 2200, 3200.
    const s = gridSkews([1200, 2200, 3200])
    expect(s.k0).toBe(1)
    expect(s.skews).toEqual([200, 200, 200])
  })

  it('keeps the residuals right when the first beep was missed', () => {
    // The probe missed beep 1; k becomes 2 and the stall is still 200.
    const s = gridSkews([2200, 3200, 4200])
    expect(s.k0).toBe(2)
    expect(s.skews).toEqual([200, 200, 200])
  })

  it('refuses a series that cannot be indexed', () => {
    expect(gridSkews([900])).toBeNull()
    expect(gridSkews([])).toBeNull()
  })
})

describe('sharedDiffs — the correction over events BOTH schedules recorded', () => {
  it('pairs by absolute event index, not by array position', () => {
    // Beep series starts at k=2, flash at k=1: position 0 of one is event 2,
    // position 0 of the other is event 1. Pairing by position would subtract
    // the wrong events — this is the mismatch the shipped constant carries.
    const run = makeRun({
      beepK0: 2,
      beepSkews: [110, 120, 130],
      flashK0: 1,
      flashSkews: [10, 20, 30, 40],
    })
    const shared = sharedDiffs(run, 'anchor')
    expect(shared.map((x: { k: number }) => x.k)).toEqual([2, 3, 4])
    // k=2 → 110−20, k=3 → 120−30, k=4 → 130−40. All 90.
    expect(shared.map((x: { d: number }) => x.d)).toEqual([90, 90, 90])
  })

  it('drops events only one side recorded', () => {
    const run = makeRun({
      beepK0: 1,
      beepSkews: [100, 100, 100, 100],
      flashK0: 1,
      flashSkews: [50, 50],
    })
    expect(sharedDiffs(run, 'anchor')).toHaveLength(2)
  })

  it('refuses when fewer than two events are shared', () => {
    const run = makeRun({ beepK0: 5, beepSkews: [100, 100], flashK0: 1, flashSkews: [50, 50] })
    expect(sharedDiffs(run, 'anchor')).toBeNull()
  })
})

describe('perEvent — alignment must be earned, not assumed', () => {
  it('cancels a wander the export really carries', () => {
    // The reference wanders; the export shows the same wander plus a constant
    // 40 ms of its own. Per-event correction must leave exactly the 40.
    const wander = [0, 30, -20, 50, -10, 25]
    const beepSkews = wander.map((w) => 100 + w)
    const flashSkews = [10, 10, 10, 10, 10, 10]
    const offsets = wander.map((w) => 90 + w + 40)
    const run = makeRun({
      beepSkews,
      flashSkews,
      offsetsMs: offsets,
      pairSec: [1, 2, 3, 4, 5, 6],
    })
    const p = perEvent(run, 'render', 'anchor')
    expect(p.n).toBe(6)
    expect(p.syncMeanMs).toBeCloseTo(40, 6)
    expect(p.residualSdMs).toBeCloseTo(0, 6)
    expect(p.r).toBeCloseTo(1, 6)
  })

  it('does not manufacture agreement when the export is flat', () => {
    // The export's offsets are identical to the decimal (what a 6 s cell
    // actually looks like) while the reference wanders. Subtracting per event
    // would INJECT that wander, and the residual says so: it comes back at the
    // reference's own spread rather than at zero.
    const beepSkews = [100, 130, 80, 150, 90, 125]
    const flashSkews = [10, 10, 10, 10, 10, 10]
    const run = makeRun({
      beepSkews,
      flashSkews,
      offsetsMs: [162, 162, 162, 162, 162, 162],
      pairSec: [1, 2, 3, 4, 5, 6],
    })
    const p = perEvent(run, 'render', 'anchor')
    expect(p.exportSdMs).toBe(0)
    expect(p.residualSdMs).toBeGreaterThan(20)
    expect(Math.abs(p.r)).toBeLessThan(0.01)
  })

  it('finds the right shift when the export starts mid-take', () => {
    // A trimmed lane: its first pair is event 4, and its own clock starts at 0.
    const wander = [0, 30, -20, 50, -10, 25, 15, -35]
    const beepSkews = wander.map((w) => 100 + w)
    const flashSkews = wander.map(() => 10)
    const run = makeRun({
      beepSkews,
      flashSkews,
      // events 4..8 only, on a clock that restarts at the trim
      offsetsMs: [90 + wander[3]! + 40, 90 + wander[4]! + 40, 90 + wander[5]! + 40, 90 + wander[6]! + 40],
      pairSec: [0.2, 1.2, 2.2, 3.2],
    })
    const p = perEvent(run, 'render', 'anchor')
    expect(p.n).toBe(4)
    expect(p.syncMeanMs).toBeCloseTo(40, 6)
  })

  it('refuses a lane with too few pairs to align', () => {
    const run = makeRun({
      beepSkews: [100, 100, 100, 100],
      flashSkews: [10, 10, 10, 10],
      offsetsMs: [130, 130],
      pairSec: [1, 2],
    })
    expect(perEvent(run, 'render', 'anchor')).toBeNull()
  })
})

describe('the grid is read from the run, never assumed', () => {
  it('aligns export events spaced by the rig\'s own interval, not by one second', () => {
    // G5 moved the rig's grid to 987 ms. An analyser that still divides by 1000
    // maps every export pair to the wrong event as the take goes on — by pair 8
    // it is a whole event out — and then reports a per-event correction built
    // from mismatched pairs as if it were a measurement.
    const wander = [0, 30, -20, 50, -10, 25, 15, -35]
    const run = makeRun({
      intervalMs: 987,
      beepSkews: wander.map((w) => 100 + w),
      flashSkews: wander.map(() => 10),
      offsetsMs: wander.map((w) => 90 + w + 40),
      pairSec: wander.map((_, i) => 1.0 + i * 0.987),
    })
    const p = perEvent(run, 'render', 'anchor')
    expect(p.n).toBe(8)
    expect(p.syncMeanMs).toBeCloseTo(40, 6)
    expect(p.residualSdMs).toBeCloseTo(0, 6)
  })
})
