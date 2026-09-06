import { describe, expect, it } from 'vitest'
import { RealmOffset } from './realmClock'

/**
 * THE REGRESSION THIS FILE EXISTS FOR is at the bottom: the arithmetic that
 * turned Robert's 46-minute take into 553 minutes, replayed with the numbers
 * his own take carries.
 */
describe('RealmOffset', () => {
  it('converts nothing before its first sample', () => {
    const r = new RealmOffset()
    expect(r.samples).toBe(0)
    expect(r.offsetMs).toBe(0)
    expect(r.toLocal(1234)).toBe(1234)
    expect(r.fromLocal(1234)).toBe(1234)
  })

  it('takes the MAXIMUM of (their now − my now), because delivery only delays', () => {
    // True offset: the other realm's clock reads 500 ms ahead of ours.
    const OFFSET = 500
    const r = new RealmOffset()
    // Each sample is the truth minus that message's delivery delay.
    for (const delay of [12, 3, 41, 0.4, 7]) r.note(1000 + OFFSET - delay, 1000)
    expect(r.offsetMs).toBeCloseTo(OFFSET - 0.4, 6)
    expect(r.samples).toBe(5)
  })

  it('reads a stamp from the other realm on the local clock', () => {
    const r = new RealmOffset()
    r.note(5000, 4000) // their 5000 is our 4000
    expect(r.toLocal(5000)).toBe(4000)
    expect(r.toLocal(6000)).toBe(5000)
    expect(r.fromLocal(4000)).toBe(5000)
  })

  it('ignores a stamp that is not a number', () => {
    const r = new RealmOffset()
    r.note(Number.NaN, 10)
    r.note(Number.POSITIVE_INFINITY, 10)
    expect(r.samples).toBe(0)
  })

  it('holds its estimate across a long take — the offset is a constant', () => {
    const r = new RealmOffset()
    for (let i = 0; i < 5_000; i++) r.note(i * 21 + 250 - (i % 7), i * 21)
    expect(r.offsetMs).toBe(250)
  })

  /**
   * rec_cff9nmm7trmh, 2026-09-06: screen + tab audio, 46.1 min recorded, the
   * editor opened 553.6 min. The tab had been open across a night of macOS
   * sleep totalling 8 h 27 min (30,445,750 ms). `performance.now()` stops
   * during sleep and `performance.timeOrigin` does not, so the audio tap
   * worker — built at the record press, AFTER the sleep — and the document —
   * loaded BEFORE it — disagreed about "absolute time" by exactly the sleep.
   */
  describe('the 553-minute take', () => {
    const SLEEP_MS = 30_445_750
    /** Wall-clock ms when the document loaded. */
    const DOC_ORIGIN = 1_757_000_000_000
    /** Monotonic ms the document has actually run (sleep excluded). */
    const DOC_NOW = 120_000
    /** The worker was created now, so its origin is the true wall clock. */
    const WORKER_ORIGIN = DOC_ORIGIN + DOC_NOW + SLEEP_MS
    const WORKER_NOW = 40

    it('is what timeOrigin arithmetic produces, and it is the whole sleep', () => {
      const stampedByTimeOrigin = WORKER_ORIGIN + WORKER_NOW - DOC_ORIGIN
      // What the old code handed the anchor, against what the page's own clock
      // read at the same instant.
      expect(stampedByTimeOrigin - DOC_NOW).toBeCloseTo(SLEEP_MS + WORKER_NOW, 6)
    })

    it('is not what a measured offset produces', () => {
      const r = new RealmOffset()
      // One batch: the worker stamped WORKER_NOW as it posted; the page read
      // DOC_NOW + 1.2 ms of delivery when it arrived.
      r.note(WORKER_NOW, DOC_NOW + 1.2)
      const stamped = r.toLocal(WORKER_NOW)
      // The anchor lands within a delivery of the page's own clock — not eight
      // and a half hours away from it.
      expect(Math.abs(stamped - DOC_NOW)).toBeLessThan(2)
    })
  })
})
