/**
 * THE EXTRACTION IS PINNED — task M1.
 *
 * The sampler came OUT of compositor.worker.ts so that rawVideo.worker.ts could
 * read the same instrument at max (where no composite exists). Moving code that
 * feeds the elastic system is exactly the kind of change that agrees with
 * itself and disagrees with the take, so this test carries the formulas as they
 * were shipped — copied from the compositor's `readSignals` before the move —
 * and asserts the class produces them, sample for sample, over a run with the
 * awkward cases in it: an interval with no arrivals, one with no outputs, one
 * where the source went quiet, and one where the burst absorber held frames.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_COUNTERS, LATE_TICK_MS, PressureSampler, TICKS_PER_POST, type PressureCounters } from './pressureSampler'
import { readPressure } from '../pressure'

/** compositor.worker.ts's readSignals, verbatim in its arithmetic. */
function shippedFormulas(
  prev: PressureCounters,
  s: PressureCounters,
  intervalMs: number,
  fps: number,
  queueCliff: number,
  gpuMeasured: boolean,
  lateMaxMs: number,
  lateMeanMs: number | null,
) {
  const p = prev
  const arrivals = s.framesIn - p.framesIn
  const outputs = s.outputs - p.outputs
  const queueSamples = s.queueSamples - p.queueSamples
  const encoded = s.framesEncoded - p.framesEncoded
  return {
    intervalMs,
    frameBudgetMs: 1000 / Math.max(1, fps),
    queueMean: queueSamples > 0 ? (s.queueSum - p.queueSum) / queueSamples : null,
    queueCliff,
    encodeLatencyMs: outputs > 0 ? (s.encodeLatencyMs - p.encodeLatencyMs) / outputs : null,
    workerLateMaxMs: lateMaxMs,
    workerLateMeanMs: lateMeanMs,
    perFrameCostMs: encoded > 0 ? (s.workMs - p.workMs) / encoded : null,
    gpuPerFrameMs: gpuMeasured && encoded > 0 ? (s.gpuMs - p.gpuMs) / encoded : null,
    stale: arrivals > 0 ? s.framesStale - p.framesStale : null,
    arrivals: arrivals > 0 ? arrivals : null,
    dropped: s.framesDropped - p.framesDropped,
    burst: s.framesBurst - p.framesBurst,
    platform: null,
  }
}

describe('the shared sampler reads what the compositor always read', () => {
  it('matches the shipped formulas over a run with every awkward window in it', () => {
    const windows: PressureCounters[] = [
      // healthy: 15 in, 15 encoded, queue sampled, outputs stamped
      { ...EMPTY_COUNTERS, framesIn: 15, framesEncoded: 15, queueSum: 6, queueSamples: 15, encodeLatencyMs: 150, outputs: 15, workMs: 90 },
      // a STATIC SCREEN: nothing arrived at all (the P0-ladder-static case)
      { ...EMPTY_COUNTERS, framesIn: 15, framesEncoded: 15, queueSum: 6, queueSamples: 15, encodeLatencyMs: 150, outputs: 15, workMs: 90 },
      // arrivals with NO outputs yet — the encoder is behind, nothing to divide by
      { ...EMPTY_COUNTERS, framesIn: 30, framesEncoded: 15, framesDropped: 4, queueSum: 30, queueSamples: 30, encodeLatencyMs: 150, outputs: 15, workMs: 90 },
      // the burst absorber holding frames, and the source going stale
      { ...EMPTY_COUNTERS, framesIn: 45, framesEncoded: 28, framesDropped: 4, framesStale: 3, framesBurst: 5, queueSum: 60, queueSamples: 45, encodeLatencyMs: 500, outputs: 28, workMs: 300, gpuMs: 60 },
    ]
    let prev = EMPTY_COUNTERS
    const sampler = new PressureSampler(0, EMPTY_COUNTERS)
    let t = 0
    for (const counters of windows) {
      // one posting window of ticks, each exactly on time
      let lateMax = 0
      let lateSum = 0
      let ticks = 0
      for (let i = 0; i < TICKS_PER_POST; i++) {
        t += LATE_TICK_MS
        const { lateMs } = sampler.tick(t)
        lateMax = Math.max(lateMax, lateMs)
        lateSum += lateMs
        ticks++
      }
      const windowStart = t - TICKS_PER_POST * LATE_TICK_MS
      const signals = sampler.read(t, counters, 60, 6, true)
      expect(signals).toEqual(
        shippedFormulas(
          prev,
          counters,
          Math.max(1, t - windowStart),
          60,
          6,
          true,
          lateMax,
          ticks > 0 ? lateSum / ticks : null,
        ),
      )
      prev = counters
    }
  })

  it('measures the tick’s own lateness, which is the signal a hidden tab has', () => {
    const sampler = new PressureSampler(0)
    // on time, then a 40 ms stall on a 16 ms budget
    sampler.tick(16)
    const { lateMs } = sampler.tick(72)
    expect(lateMs).toBe(40)
  })

  it('feeds the ONE detector, and a blind window is blind rather than nominal', () => {
    const sampler = new PressureSampler(0)
    for (let i = 0; i < TICKS_PER_POST; i++) sampler.tick((i + 1) * LATE_TICK_MS)
    // Nothing submitted, nothing encoded, nothing arrived: no reading at all.
    const signals = sampler.read(TICKS_PER_POST * LATE_TICK_MS, EMPTY_COUNTERS, 60, 6, false)
    expect(signals.queueMean).toBeNull()
    expect(signals.encodeLatencyMs).toBeNull()
    expect(signals.perFrameCostMs).toBeNull()
    const reading = readPressure(signals)
    expect(reading.blind).toBe(false) // the tick lateness IS a reading
    expect(reading.level).toBe('nominal')
  })
})
