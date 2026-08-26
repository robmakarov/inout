/**
 * WallClockHold — decides when a sample-counted audio timeline must be padded
 * with silence to stay honest against the wall clock, and by how much.
 *
 * WHY IT EXISTS (PO 2026-08-25 game take; measured by `npm run exp -- syncload`):
 * a starved AudioContext renders fewer quanta than wall time, sample counting
 * cannot see the missing quanta by construction, and everything after the loss
 * slides EARLY against the picture, growing through the take.
 *
 * WHY IT IS A CLASS AND NOT TWO INLINE BLOCKS (2026-08-26, from PO's recheck —
 * "mic and camera unsynch 1-2 s at 6 min", "tab audio worse and worse"): the
 * two inline copies of this logic had diverged into one dead and one harmful.
 * measuredAudio.ts updated its arrival stamp before comparing against it, so
 * `steady` was always false, the origin was never set and THE PAD NEVER FIRED
 * on the channels every export mixes from. compositor.worker.ts had the
 * ordering right but padded on INSTANTANEOUS lateness — and an arrival stamp
 * taken at main-thread receipt reads late whenever the main thread stalls,
 * even though the queued batches deliver every sample moments later. Padding
 * there splices silence into audio that lost nothing and walks the rest late.
 *
 * THE DISCRIMINATOR IS PERSISTENCE. A main-thread stall queues batches; when
 * the thread wakes they drain within the same wake, the timeline catches up,
 * and the apparent deficit collapses to zero. A quantum the context never
 * rendered stays missing forever. So the pad is the MINIMUM deficit observed
 * across a trailing settle window — a burst erases it, a real loss stands —
 * and it is granted only once the window truly covers that much wall time,
 * because at the first late batch the two cases are indistinguishable.
 * Cost accepted: a real loss is padded up to `settleMs` after the choke,
 * instead of instantly and sometimes wrongly.
 */

export interface WallClockHoldOpts {
  sampleRate: number
  /** The origin min-filter closes after this much PLACED audio — a filter that
   *  runs forever ratchets onto the luckiest batch of the take, and every
   *  ratchet pads silence for time nothing lost. */
  originWindowS?: number
  /** Below this, do nothing: normal batching jitter must not pad. */
  padMinMs?: number
  /** One batch may not conjure more than this much silence, whatever the stamps say. */
  padMaxMs?: number
  /** How long an apparent deficit must persist before it is believed. */
  settleMs?: number
}

interface Seen {
  atMs: number
  behindMs: number
}

export class WallClockHold {
  private readonly rate: number
  private readonly originWindowFrames: number
  private readonly padMinMs: number
  private readonly padMaxMs: number
  private readonly settleMs: number
  private originMs = Infinity
  private prevArrivalMs = -Infinity
  private readonly seen: Seen[] = []

  constructor(opts: WallClockHoldOpts) {
    this.rate = opts.sampleRate
    this.originWindowFrames = Math.round((opts.originWindowS ?? 3) * opts.sampleRate)
    this.padMinMs = opts.padMinMs ?? 80
    this.padMaxMs = opts.padMaxMs ?? 1000
    this.settleMs = opts.settleMs ?? 1000
  }

  /**
   * Call once per batch, BEFORE placing it. `timelineFrames` is the number of
   * frames already placed (real + padded); returns whole frames of silence to
   * insert ahead of this batch, usually 0.
   */
  padFramesFor(arrivalMs: number, timelineFrames: number, batchFrames: number): number {
    const timelineMs = (timelineFrames / this.rate) * 1000
    const batchMs = (batchFrames / this.rate) * 1000
    const sincePrevMs = arrivalMs - this.prevArrivalMs
    this.prevArrivalMs = arrivalMs

    // Only STEADY-STATE batches may date the origin: a catch-up burst delivers
    // back to back, and its arrivals date the origin falsely early — which
    // would pad silence for time that was never lost. The first batch ever is
    // steady by definition (sincePrevMs is Infinite) and cannot date it early:
    // its arrival is at or after its own last sample's render.
    const steady = sincePrevMs >= batchMs / 2
    if (steady && timelineFrames < this.originWindowFrames) {
      const cand = arrivalMs - timelineMs
      if (cand < this.originMs) this.originMs = cand
    }
    if (this.originMs === Infinity) return 0

    const behindMs = arrivalMs - this.originMs - timelineMs
    this.seen.push({ atMs: arrivalMs, behindMs })
    const cutoff = arrivalMs - this.settleMs
    while (this.seen.length > 0 && this.seen[0]!.atMs < cutoff) this.seen.shift()

    // The deficit is what EVERY batch in the window agrees on. One late batch
    // is a scheduling spike; the floor across a settle window is time the
    // context genuinely never rendered.
    let deficitMs = Infinity
    for (const s of this.seen) if (s.behindMs < deficitMs) deficitMs = s.behindMs
    // The window must actually span the settle time before it may convict —
    // at the first batch after a long stall, a burst about to drain and a real
    // loss look identical, and only the next stretch of arrivals tells them apart.
    const coveredMs = arrivalMs - this.seen[0]!.atMs
    if (coveredMs < this.settleMs * 0.75 || deficitMs <= this.padMinMs) return 0

    const padFrames = Math.round((Math.min(deficitMs, this.padMaxMs) / 1000) * this.rate)
    if (padFrames <= 0) return 0
    // The timeline is about to advance by the pad, so every recorded deficit
    // shrinks by it — without this the same loss would be padded twice.
    const padMs = (padFrames / this.rate) * 1000
    for (const s of this.seen) s.behindMs -= padMs
    return padFrames
  }
}
