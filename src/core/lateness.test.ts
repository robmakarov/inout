import { describe, expect, it } from 'vitest'
import { FRAME_MS, LatenessTally, LATENESS_BUCKETS_MS, WINDOW_MS } from './lateness'

/**
 * The sampler's arithmetic, without a browser, a worker or a clock — which is
 * the whole reason the accumulator is a separate object. What is NOT testable
 * here is the one thing the design turns on (a hidden tab clamping a
 * main-thread timer): that is measured on a real Chrome by
 * scripts/g7-lateness.mjs and quoted in .ai/TASKS.
 */
describe('G7 lateness tally', () => {
  /** A quiet second at 60 Hz, starting at `from`. */
  const quiet = (t: LatenessTally, from: number, lateMs = 0.4, seqFrom = 1): number => {
    let seq = seqFrom
    for (let i = 0; i < 62; i++) t.push(from + i * 16, lateMs, seq++)
    return seq
  }

  it('is empty until something is pushed, and never invents a window', () => {
    const s = new LatenessTally(16).summary('worker-beat', false)
    expect(s.samples).toBe(0)
    expect(s.worstWindows).toEqual([])
    expect(s.maxMs).toBe(0)
    expect(s.spanMs).toBe(0)
  })

  it('names the worst SECOND, not the worst sample’s second only', () => {
    const t = new LatenessTally(16)
    let seq = quiet(t, 0)
    // A B10-shaped stall at 11.0 s: one long block, then the catch-up.
    seq = quiet(t, 1_000, 0.4, seq)
    t.push(11_000, 201.4, seq++)
    t.push(11_020, 35.2, seq++)
    quiet(t, 12_000, 0.5, seq)
    const s = t.summary('worker-beat', false)
    expect(s.maxMs).toBe(201.4)
    expect(s.maxAtMs).toBe(11_000)
    expect(s.worstWindows[0].startMs).toBe(11_000)
    expect(s.worstWindows[0].maxMs).toBe(201.4)
    // Both samples in that second are counted, and the sum is the second fact:
    // one spike and a second of stutter are not the same defect.
    expect(s.worstWindows[0].samples).toBe(2)
    expect(s.worstWindows[0].lateMs).toBe(236.6)
    // Worst first, at most three, so a long take carries a fixed size.
    expect(s.worstWindows.length).toBeLessThanOrEqual(3)
    expect(s.worstWindows[0].maxMs).toBeGreaterThanOrEqual(s.worstWindows[1].maxMs)
  })

  it('counts what a frame is, and where the samples fell', () => {
    const t = new LatenessTally(16)
    t.push(0, 1, 1)
    t.push(16, FRAME_MS + 0.1, 2)
    t.push(32, 40, 3)
    const s = t.summary('worker-beat', false)
    expect(s.overFrame).toBe(2)
    expect(s.samples).toBe(3)
    // One count per bucket edge, plus the unbounded tail.
    expect(s.histogram).toHaveLength(LATENESS_BUCKETS_MS.length + 1)
    expect(s.histogram.reduce((a, b) => a + b, 0)).toBe(3)
  })

  it('reads a hole in the schedule as missed beats, not as silence', () => {
    const t = new LatenessTally(16)
    t.push(0, 0.2, 10)
    // The page was frozen: the worker kept counting, the main thread did not.
    t.push(4_000, 3_800, 260)
    const s = t.summary('worker-beat', false)
    expect(s.missed).toBe(249)
    expect(s.maxMs).toBe(3_800)
  })

  it('a stall longer than a window leaves the windows it covered empty', () => {
    const t = new LatenessTally(16)
    t.push(0, 0.3, 1)
    t.push(3_500, 3_400, 2)
    const s = t.summary('worker-beat', false)
    // Windows 1 and 2 were never sampled, so they are not reported as clean.
    expect(s.worstWindows.map((w) => w.startMs).sort((a, b) => a - b)).toEqual([0, 3_000])
    expect(s.worstWindows[0].startMs).toBe(3_000)
  })

  it('percentiles are bucket-interpolated and bounded by the buckets', () => {
    const t = new LatenessTally(16)
    for (let i = 0; i < 95; i++) t.push(i * 16, 0.5, i + 1)
    for (let i = 0; i < 5; i++) t.push(1_520 + i * 16, 60, 96 + i)
    const s = t.summary('worker-beat', false)
    expect(s.p50Ms).toBeLessThanOrEqual(1)
    expect(s.p95Ms).toBeGreaterThan(0)
    expect(s.p95Ms).toBeLessThanOrEqual(60)
    // The MAX is exact — a defect is argued from it, so it is never estimated.
    expect(s.maxMs).toBe(60)
  })

  it('negative lateness is zero, not a credit', () => {
    // A beat that arrives before it was due (clock skew between the threads)
    // must not pay for a later one.
    const t = new LatenessTally(16)
    t.push(0, -5, 1)
    t.push(16, 20, 2)
    const s = t.summary('worker-beat', false)
    expect(s.maxMs).toBe(20)
    expect(s.worstWindows[0].lateMs).toBe(20)
  })

  it('reports how much of the span the document was hidden', () => {
    const t = new LatenessTally(16)
    quiet(t, 0)
    t.noteHidden(500)
    const s = t.summary('worker-beat', false)
    expect(s.hiddenRatio).toBeGreaterThan(0.4)
    expect(s.hiddenRatio).toBeLessThanOrEqual(1)
  })

  it('keeps only the five worst owners, worst first', () => {
    const t = new LatenessTally(16)
    for (let i = 1; i <= 8; i++) t.noteOwner({ atMs: i * 100, durationMs: i * 10, name: `t${i}` })
    const s = t.summary('worker-beat', false)
    expect(s.owners).toHaveLength(5)
    expect(s.owners[0].name).toBe('t8')
  })

  it('charges its own cost per second of span, scaled from the sampled beats', () => {
    const t = new LatenessTally(16)
    for (let i = 0; i < 1_000; i++) t.push(i * 16, 0.2, i + 1)
    // Two timed beats at 0.01 ms each over ~16 s of span.
    t.noteCost(0.01)
    t.noteCost(0.01)
    const s = t.summary('worker-beat', false)
    expect(s.selfCostMsPerSec).toBeGreaterThan(0)
    expect(s.selfCostMsPerSec).toBeLessThan(1)
  })

  it('the window is a second, and the constant says so', () => {
    expect(WINDOW_MS).toBe(1_000)
  })
})

/**
 * A CORRECTION A READING MADE. The take rig printed a card whose worst sample
 * was 2.0 ms and whose "worst task" was a 487.4 ms animation frame — one with
 * `blockingDuration: 0`, i.e. a frame that took wall time without ever holding
 * the thread. Ranking owners by duration names a frame that stalled nobody.
 */
describe('G7 owners are ranked by what stalls, not by what is long', () => {
  it('a long frame that blocked nothing loses to a short one that blocked', () => {
    const t = new LatenessTally(16)
    t.noteOwner({ atMs: 100, durationMs: 487.4, blockingMs: 0, name: 'a long idle frame' })
    t.noteOwner({ atMs: 200, durationMs: 60, blockingMs: 55, name: 'the size probe' })
    const s = t.summary('worker-beat', false)
    expect(s.owners[0].name).toBe('the size probe')
  })

  it('falls back to duration for an entry type that reports no blocking', () => {
    const t = new LatenessTally(16)
    t.noteOwner({ atMs: 100, durationMs: 90, name: 'longtask' })
    t.noteOwner({ atMs: 200, durationMs: 51, name: 'shorter longtask' })
    const s = t.summary('worker-beat', false)
    expect(s.owners[0].name).toBe('longtask')
  })
})
