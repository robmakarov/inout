import { describe, expect, it, vi, afterEach } from 'vitest'
import { paintLoop } from './synthetic'

/**
 * G2. The painter behind every synthetic source. Two properties decide whether
 * a rig's numbers mean anything, and both are pinned here because both were
 * assumed rather than checked for months:
 *   1. a HEALTHY rAF must carry the lane alone, or a headed run stops being the
 *      control it exists to be (double paints change the source's rate);
 *   2. a SILENT rAF must not stop the source, or the band downstream reads the
 *      harness and calls it the product.
 */
describe('paintLoop', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Drive rAF and setInterval from fake timers with an explicit rAF cadence. */
  function harness(rafPeriodMs: number | null) {
    vi.useFakeTimers()
    let now = 0
    vi.stubGlobal('performance', { now: () => now })
    let nextRafId = 1
    const rafTimers = new Map<number, ReturnType<typeof setTimeout>>()
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      const id = nextRafId++
      // rAFPeriodMs === null models a clock that never fires again.
      if (rafPeriodMs !== null) {
        rafTimers.set(
          id,
          setTimeout(() => cb(now), rafPeriodMs),
        )
      }
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      const t = rafTimers.get(id)
      if (t) clearTimeout(t)
      rafTimers.delete(id)
    })
    return {
      advance(ms: number, stepMs = 1) {
        for (let i = 0; i < ms; i += stepMs) {
          now += stepMs
          vi.advanceTimersByTime(stepMs)
        }
      },
    }
  }

  it('paints once before anything can attach — an unpainted captureStream delivers nothing', () => {
    harness(16)
    const draw = vi.fn()
    const loop = paintLoop(draw, 30)
    expect(draw).toHaveBeenCalledTimes(1)
    loop.stop()
  })

  it('leaves a healthy rAF alone: the watchdog never fires at 60 Hz against a 30 fps lane', () => {
    const h = harness(16)
    const loop = paintLoop(() => undefined, 30)
    h.advance(1000)
    expect(loop.watchdogPaints()).toBe(0)
    loop.stop()
  })

  it('leaves a 30 Hz display alone against a 30 fps lane — the case the slack exists for', () => {
    const h = harness(33)
    const loop = paintLoop(() => undefined, 30)
    h.advance(1000)
    expect(loop.watchdogPaints()).toBe(0)
    loop.stop()
  })

  it('carries the source when rAF goes silent, at the rate asked for', () => {
    const h = harness(null)
    const loop = paintLoop(() => undefined, 30)
    h.advance(1000)
    // 33 ms watchdog period over 1 s, minus the slack before the first one.
    expect(loop.watchdogPaints()).toBeGreaterThanOrEqual(25)
    expect(loop.paints()).toBeGreaterThanOrEqual(26)
    loop.stop()
  })

  it('stops both clocks — a rig that leaks a painter poisons the next run in the page', () => {
    const h = harness(null)
    const loop = paintLoop(() => undefined, 30)
    h.advance(200)
    const atStop = loop.paints()
    loop.stop()
    h.advance(1000)
    expect(loop.paints()).toBe(atStop)
  })
})
