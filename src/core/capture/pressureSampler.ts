/**
 * THE SAMPLER BEHIND THE ONE PRESSURE INSTRUMENT — task M1.
 *
 * core/pressure.ts is the DETECTOR: signals in, a level and a leader out, one
 * implementation for every consumer. This is the other half — the thing that
 * turns a worker's raw counters into those signals — and until M1 it existed
 * once, inline, inside compositor.worker.ts.
 *
 * WHY IT HAD TO COME OUT. M1's emergency floor reads pressure at MAX, and max
 * opens no composite: two raw encoders, no compositor, nobody sampling. The
 * choice was to write a second sampler in rawVideo.worker.ts or to have one
 * both workers use, and a second one would have been the eighth adaptive system
 * in a task whose whole subject is that there were seven because nothing was
 * shared. So: one detector, one sampler, two threads that own counters.
 *
 * WHAT IT DELIBERATELY KEEPS FROM THE COMPOSITOR'S VERSION, because each is a
 * measured decision and not a style:
 *  · RATIOS OVER THE INTERVAL, NEVER TOTALS. A counter that has run since the
 *    start of a take answers a question about the whole take; the ladder is
 *    asking about NOW, and a take that recovers must stop being judged on how
 *    it began.
 *  · A NULL IS NOT A ZERO (R1's rule). Every quotient whose denominator is zero
 *    is null — a window in which nothing was submitted has not measured the
 *    queue, and saying 0 would be saying the encoder was empty when in truth
 *    nobody looked. The detector then reports it `unmeasured` rather than
 *    scoring it, which is the inversion R1 needs for a detector: a report card
 *    fails on missing data, a detector that fires because it cannot see is a
 *    detector that steps a healthy take down.
 *  · THE LATENESS IS THIS TIMER'S OWN. The tick that measures scheduling
 *    lateness IS the tick that posts, at a 60 fps budget, because a coarse
 *    250 ms timer cannot resolve a stall shorter than a quarter second and a
 *    second fast timer would be a second thing to keep alive on the one thread
 *    that must not be disturbed.
 */
import type { PressureSignals } from '../pressure'

/** The counters a worker keeps anyway. Deltas are taken here. */
export interface PressureCounters {
  framesIn: number
  framesEncoded: number
  framesDropped: number
  /** Frames re-encoded because the source went quiet, or arrivals with a stale
   *  stamp — whatever the worker's own notion of "this frame was not new" is.
   *  0 in a worker that has none. */
  framesStale: number
  /** Sum of `encodeQueueSize` sampled at submit, and how many samples. */
  queueSum: number
  queueSamples: number
  /** Sum of (output instant − submit instant), and how many outputs. */
  encodeLatencyMs: number
  outputs: number
  /** Wall-clock work this worker did on frames in the window (paint + encode). */
  workMs: number
  /** GPU time, when something measured it (gl.finish() behind a probe flag). */
  gpuMs: number
  /** Frames kept ONLY because the burst absorber was there (E2). */
  framesBurst: number
}

export const EMPTY_COUNTERS: PressureCounters = {
  framesIn: 0,
  framesEncoded: 0,
  framesDropped: 0,
  framesStale: 0,
  queueSum: 0,
  queueSamples: 0,
  encodeLatencyMs: 0,
  outputs: 0,
  workMs: 0,
  gpuMs: 0,
  framesBurst: 0,
}

/** The ticker's period, and the frame budget it is measured against: 16 ms is
 *  one 60 fps frame, which is the resolution a stall has to be seen at. */
export const LATE_TICK_MS = 16
/**
 * Sixteen ticks ≈ 256 ms per posted reading, and E1's reason for the cadence
 * moved here with it: the stats event is 1 Hz, which is a whole second of lost
 * frames before anything can react, and Robert's bar is "up and down very fast
 * and responsive". Four readings a second is also four inside the shortest
 * sustain window the ladder uses, which is what stops one bad quarter-second
 * from moving a take.
 *
 * The whole instrument costs a timestamp and a subtraction per tick, on a
 * thread measured to run a 16 ms ticker at 59 Hz with 2-4 ms of lateness while
 * the page is hidden (core/pressure.ts's probe).
 */
export const TICKS_PER_POST = 16

export class PressureSampler {
  private prev: PressureCounters
  private windowStartMs: number
  private lateMaxMs = 0
  private lateSumMs = 0
  private lateTicks = 0
  private lastTickMs: number

  constructor(
    startedAtMs: number,
    counters: PressureCounters = EMPTY_COUNTERS,
  ) {
    this.prev = { ...counters }
    this.windowStartMs = startedAtMs
    this.lastTickMs = startedAtMs
  }

  /**
   * One tick of the fast timer. Returns the lateness it observed, so the caller
   * can also keep it in its own cumulative stats, and `due` when enough ticks
   * have passed to post a reading.
   */
  tick(nowMs: number): { lateMs: number; due: boolean } {
    const lateMs = Math.max(0, nowMs - this.lastTickMs - LATE_TICK_MS)
    this.lastTickMs = nowMs
    if (lateMs > this.lateMaxMs) this.lateMaxMs = lateMs
    this.lateSumMs += lateMs
    this.lateTicks++
    return { lateMs, due: this.lateTicks >= TICKS_PER_POST }
  }

  /** The interval just ended, as the detector's signals. Resets the window. */
  read(nowMs: number, counters: PressureCounters, fps: number, queueCliff: number, gpuMeasured: boolean): PressureSignals {
    const p = this.prev
    const s = counters
    const intervalMs = Math.max(1, nowMs - this.windowStartMs)
    const arrivals = s.framesIn - p.framesIn
    const outputs = s.outputs - p.outputs
    const queueSamples = s.queueSamples - p.queueSamples
    const encoded = s.framesEncoded - p.framesEncoded
    const signals: PressureSignals = {
      intervalMs,
      frameBudgetMs: 1000 / Math.max(1, fps),
      queueMean: queueSamples > 0 ? (s.queueSum - p.queueSum) / queueSamples : null,
      queueCliff,
      encodeLatencyMs: outputs > 0 ? (s.encodeLatencyMs - p.encodeLatencyMs) / outputs : null,
      workerLateMaxMs: this.lateMaxMs,
      workerLateMeanMs: this.lateTicks > 0 ? this.lateSumMs / this.lateTicks : null,
      perFrameCostMs: encoded > 0 ? (s.workMs - p.workMs) / encoded : null,
      gpuPerFrameMs: gpuMeasured && encoded > 0 ? (s.gpuMs - p.gpuMs) / encoded : null,
      stale: arrivals > 0 ? s.framesStale - p.framesStale : null,
      arrivals: arrivals > 0 ? arrivals : null,
      dropped: s.framesDropped - p.framesDropped,
      burst: s.framesBurst - p.framesBurst,
      platform: null,
    }
    this.prev = { ...s }
    this.windowStartMs = nowMs
    this.lateMaxMs = 0
    this.lateSumMs = 0
    this.lateTicks = 0
    return signals
  }
}
