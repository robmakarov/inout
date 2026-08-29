import { describe, expect, it, vi, afterEach } from 'vitest'
import { LongTaskWatch, SchedulingDelayWatch } from './mainThreadWatch'

/**
 * G3. The instrument that REPLACED the long-task count in two gates, so it now
 * carries verdicts and needs the same scrutiny the counter never got.
 *
 * The property that matters is the one the counter fails: it must report a
 * blocked thread even when the blocking work never forms a single >=50 ms task.
 * Measured on the 4K compositor row, the counter INVERTS — v1 reads 0 ms of
 * long tasks while losing 4731 ms of a 16 ms ticker, v2 reads 295 ms while
 * losing 1463. That is the failure this class exists to make impossible.
 */
describe('SchedulingDelayWatch', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function fakeClock() {
    vi.useFakeTimers()
    let now = 0
    vi.stubGlobal('performance', { now: () => now })
    return {
      /** Advance the clock by `ms` while letting timers fire every `stepMs`. */
      run(ms: number, stepMs: number) {
        for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
          now += stepMs
          vi.advanceTimersByTime(stepMs)
        }
      },
      set(ms: number) {
        now = ms
      },
    }
  }

  it('reads ~0 lateness on a thread that is keeping up', () => {
    const c = fakeClock()
    const w = new SchedulingDelayWatch()
    w.start()
    c.run(320, 16)
    const d = w.stop()
    expect(d.ticks).toBeGreaterThan(10)
    expect(d.totalLateMs).toBe(0)
    expect(d.maxLateMs).toBe(0)
  })

  it('reports a stall that never forms a single long task — the case the counter misses', () => {
    const c = fakeClock()
    const w = new SchedulingDelayWatch()
    w.start()
    c.run(160, 16)
    // The thread disappears for 400 ms and comes back. No single task is
    // observed; the ticker simply did not get its slots.
    c.set(560)
    vi.advanceTimersByTime(400)
    const d = w.stop()
    expect(d.totalLateMs).toBeGreaterThan(300)
    expect(d.maxLateMs).toBeGreaterThan(300)
  })

  it('separates an even hog from a hitching one at the same total', () => {
    const even = new SchedulingDelayWatch()
    const c = fakeClock()
    even.start()
    // 20 ticks each 20 ms late = 400 ms total, 20 ms worst.
    for (let i = 0; i < 20; i++) {
      c.set((i + 1) * 36)
      vi.advanceTimersByTime(36)
    }
    const evenD = even.stop()

    const hitch = new SchedulingDelayWatch()
    hitch.start()
    for (let i = 0; i < 19; i++) {
      c.set(720 + (i + 1) * 16)
      vi.advanceTimersByTime(16)
    }
    c.set(720 + 19 * 16 + 416)
    vi.advanceTimersByTime(416)
    const hitchD = hitch.stop()

    expect(evenD.totalLateMs).toBeGreaterThan(300)
    expect(hitchD.totalLateMs).toBeGreaterThan(300)
    // Same order of total, wildly different worst stall: that distinction is
    // the whole reason maxLateMs is reported next to the total.
    expect(hitchD.maxLateMs).toBeGreaterThan(evenD.maxLateMs * 5)
  })
})

describe('LongTaskWatch', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports supported:false rather than a zero, where the API is absent', () => {
    vi.stubGlobal('PerformanceObserver', undefined)
    const w = new LongTaskWatch()
    w.start()
    const s = w.stop()
    // A zero that means "no instrument" is the shape of every gate G3 exists
    // to remove: it must be distinguishable from a measured zero.
    expect(s.supported).toBe(false)
    expect(s.count).toBe(0)
  })
})
