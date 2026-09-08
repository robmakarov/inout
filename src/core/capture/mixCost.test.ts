import { describe, expect, it } from 'vitest'
import { createMixCostMeter, lastCompositeMixCost } from './mixCost'

describe('X11 mix cost meter', () => {
  it('separates batches from liveness ticks and bills both to the main thread', () => {
    const m = createMixCostMeter()
    m.note(0.5, null)
    m.note(0.25, null)
    m.note(1.0, 30)
    const cost = m.finish({ wallMs: 1000, paddedFrames: 0, trimmedFrames: 0, sampleRate: 48000 })
    expect(cost.ticks).toBe(2)
    expect(cost.batches).toBe(1)
    // A tick is main-thread time like any other: all three notes are billed.
    expect(cost.handlerMs).toBeCloseTo(1.75, 6)
    expect(cost.handlerMsPerSec).toBeCloseTo(1.75, 6)
  })

  it('reads percentiles off the lag histogram', () => {
    const m = createMixCostMeter()
    for (let i = 0; i < 100; i++) m.note(0.01, 20 + i)
    const cost = m.finish({ wallMs: 2000, paddedFrames: 0, trimmedFrames: 0, sampleRate: 48000 })
    expect(cost.batches).toBe(100)
    expect(cost.lagP50).toBe(69)
    expect(cost.lagP95).toBe(114)
    expect(cost.lagMax).toBe(119)
    expect(cost.lagMean).toBeCloseTo(69.5, 6)
  })

  it('keeps a lag past the histogram in the overflow bucket and exact in the max', () => {
    const m = createMixCostMeter()
    m.note(0.01, 10)
    m.note(0.01, 4300)
    const cost = m.finish({ wallMs: 1000, paddedFrames: 0, trimmedFrames: 0, sampleRate: 48000 })
    // The bucket saturates; the number that would name a 430 ms class defect
    // must not be the one that saturates.
    expect(cost.lagP95).toBe(511)
    expect(cost.lagMax).toBe(4300)
  })

  it('clamps a negative lag rather than dropping the batch', () => {
    const m = createMixCostMeter()
    m.note(0.01, -3)
    const cost = m.finish({ wallMs: 1000, paddedFrames: 0, trimmedFrames: 0, sampleRate: 48000 })
    expect(cost.batches).toBe(1)
    expect(cost.lagP50).toBe(0)
  })

  it('publishes the newest take, so a reader can never answer with an older one', () => {
    createMixCostMeter().finish({ wallMs: 1, paddedFrames: 7, trimmedFrames: 0, sampleRate: 48000 })
    expect(lastCompositeMixCost()?.paddedFrames).toBe(7)
    createMixCostMeter().finish({ wallMs: 1, paddedFrames: 0, trimmedFrames: 9, sampleRate: 48000 })
    expect(lastCompositeMixCost()?.trimmedFrames).toBe(9)
    expect(lastCompositeMixCost()?.paddedFrames).toBe(0)
  })
})
