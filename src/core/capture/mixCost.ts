/**
 * X11 — WHAT THE COMPOSITE'S AUDIO ACTUALLY COSTS THE MAIN THREAD.
 *
 * X11's row promised two prizes: "the last main-thread capture cost" and "the
 * ~430 ms PCM port lag". Neither has ever been a number on this build, and one
 * of them is already spent — the lag was an ANCHOR defect (a batch wall-clocked
 * when it arrived rather than when its first sample was taken) and it was fixed
 * by carrying `contextTime` in the batch, which liveCompositeV2's own header
 * says in as many words. X11a's gate then asked for the lag to be re-measured
 * after and no such number was ever reported. So this meter exists to answer
 * the task's first gate BEFORE its heavy half is built, because the alternative
 * is re-implementing a tuned limiter in plain DSP against a prize nobody priced.
 *
 * WHAT IS ACTUALLY LEFT ON THE MAIN THREAD, and it is smaller than the row
 * implies: the mix graph — per-source gain, the DynamicsCompressor limiter, the
 * quantum copies, the planar interleave — runs on the AUDIO RENDERING THREAD,
 * inside an AudioWorklet. The main thread's whole share is one port handler per
 * batch that stamps an arrival, samples liveness and transfers the buffer on.
 * That handler is what this prices.
 *
 * TWO NUMBERS, AND THE SECOND IS THE ONE THAT MATTERS:
 *
 *   handlerMs   main-thread milliseconds per second of capture. The budget this
 *               repo holds itself to is G7's: under 1 ms of main thread per
 *               second. If the handler is already far under it, X11's speed
 *               half has nothing to win and should be said so out loud.
 *
 *   lag         `recvMs - atMs` — how long after a batch's FIRST SAMPLE the
 *               main thread got hold of it. Its floor is structural (1024
 *               frames of batching = 21.3 ms at 48 kHz, plus the context's
 *               render-ahead), so the number to read is not the floor but what
 *               a busy main thread does to it. This is X11's real stake:
 *               `recvMs` is the stamp compositor.worker.ts hands WallClockHold,
 *               and a stamp taken on a thread that stalls is the mechanism
 *               behind B13's one unexplained signal — `paddedMs` of 0, 0, 91
 *               and 366 ms across identical takes, tracking nothing but how
 *               busy the machine was. WallClockHold defends against it with a
 *               persistence window (a stall queues batches, they drain in one
 *               wake, the deficit collapses); whether that defence HOLDS under
 *               dose is a measurement, and it has never been taken.
 *
 * An instrument, and nothing else: nothing here decides anything, no default
 * moves, and the numbers reach a rig the way every other one in this codebase
 * does — a module-level last-value and one global wired in main.tsx.
 */

/** 1 ms buckets; the last one is everything at or above `LAG_BUCKETS - 1` ms. */
const LAG_BUCKETS = 512

export interface MixCost {
  /** Batches of PCM the main thread carried from the audio thread to the worker. */
  batches: number
  /** Liveness ticks on the same port (a take with no audio, or before its first live sample). */
  ticks: number
  /** Cumulative self-time of the port handler, milliseconds. */
  handlerMs: number
  /** The same, per second of capture — read against G7's < 1 ms/s budget. */
  handlerMsPerSec: number
  /** Delivery lag `recvMs - atMs`, milliseconds. */
  lagP50: number
  lagP95: number
  lagMax: number
  lagMean: number
  /** What the take's wall-clock hold did about it, from CompositorStats. */
  paddedFrames: number
  trimmedFrames: number
  sampleRate: number
  /** Wall milliseconds the composite ran. */
  wallMs: number
}

export interface MixCostMeter {
  /** Called from inside the port handler. `lagMs` is absent for a liveness tick. */
  note(handlerMs: number, lagMs: number | null): void
  /** Freeze this take's numbers and publish them. */
  finish(input: {
    wallMs: number
    paddedFrames: number
    trimmedFrames: number
    sampleRate: number
  }): MixCost
}

let last: MixCost | null = null

/** The newest composite's mix cost, or null if none has run this session. */
export function lastCompositeMixCost(): MixCost | null {
  return last
}

export function createMixCostMeter(): MixCostMeter {
  const hist = new Uint32Array(LAG_BUCKETS)
  let batches = 0
  let ticks = 0
  let handlerMs = 0
  let lagMax = 0
  let lagSum = 0

  const quantile = (q: number): number => {
    if (batches === 0) return 0
    const target = q * batches
    let seen = 0
    for (let i = 0; i < LAG_BUCKETS; i++) {
      seen += hist[i]!
      if (seen >= target) return i
    }
    return LAG_BUCKETS - 1
  }

  return {
    note(ms, lagMs) {
      handlerMs += ms
      if (lagMs === null) {
        ticks++
        return
      }
      batches++
      lagSum += lagMs
      if (lagMs > lagMax) lagMax = lagMs
      // A negative lag is not physical — the batch's first sample cannot be
      // taken after it arrived — but the two clocks are correlated through one
      // reference point, so clamp rather than pretend it cannot happen.
      const bucket = Math.min(LAG_BUCKETS - 1, Math.max(0, Math.round(lagMs)))
      hist[bucket]!++
    },
    finish({ wallMs, paddedFrames, trimmedFrames, sampleRate }) {
      const cost: MixCost = {
        batches,
        ticks,
        handlerMs,
        handlerMsPerSec: handlerMs / Math.max(0.001, wallMs / 1000),
        lagP50: quantile(0.5),
        lagP95: quantile(0.95),
        lagMax,
        lagMean: batches ? lagSum / batches : 0,
        paddedFrames,
        trimmedFrames,
        sampleRate,
        wallMs,
      }
      last = cost
      return cost
    },
  }
}
