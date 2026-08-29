/**
 * WallClockHold — decides when a sample-counted audio timeline has come loose
 * from the wall clock, in EITHER direction, and by how much.
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
 * rendered stays missing forever. So the correction is the MINIMUM deficit
 * observed across a trailing settle window — a burst erases it, a real loss
 * stands — and it is granted only once the window truly covers that much wall
 * time, because at the first late batch the two cases are indistinguishable.
 * Cost accepted: a real loss is padded up to `settleMs` after the choke,
 * instead of instantly and sometimes wrongly.
 *
 * THE MIN IS THE RIGHT ESTIMATOR IN BOTH DIRECTIONS, which is what makes the
 * symmetry below cheap: arrival error is one-sided (a batch can be delivered
 * late, never early), so `min` over the window strips the jitter and leaves
 * the true offset whatever its sign.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT TRIMS AS WELL AS PADS (PO 2026-08-29: "in long video more than hour
 * the sound gets a little slower than screen video, about a second after one
 * hour" — preview and export alike).
 *
 * Until now this only ever padded, and said so: "the wall only ever moves it
 * FORWARD". That is half a guard. Video is wall-stamped and audio is
 * sample-counted at the context's NOMINAL rate, so an audio clock running
 * slower than the wall was repaid and one running FASTER was invisible —
 * unbounded, and in the direction a listener hears as the sound lagging the
 * picture. Driven over an hour of quanta, the old class read:
 *
 *     clock -278 ppm   padded 960 ms   ends   -41 ms    in sync
 *     clock  -50 ppm   padded 160 ms   ends   -20 ms    in sync
 *     clock  +50 ppm   padded   0 ms   ends  +180 ms    LATE
 *     clock +278 ppm   padded   0 ms   ends +1001 ms    LATE   ← PO's second
 *
 * 278 ppm is an utterly ordinary crystal difference between an audio device
 * and the system clock. Nothing in the pipeline could see it: the file's own
 * timestamps stay self-consistent, they are merely stretched, so the preview's
 * per-element slew reads zero drift while the CONTENT sits a second late.
 *
 * A TRIM IS NOT A PAD MIRRORED. Padding fills time where nothing was rendered,
 * so silence is the honest content. Trimming removes time that DOES hold
 * audio, so a spliced-out chunk would delete speech and click on the way out.
 * Two things keep it inaudible instead:
 *
 *   1. It is RATE-LIMITED, not a snap-back. `maxTrimRatio` caps how much of
 *      any one batch may be removed — 2000 ppm by default, 3.5 cents of pitch,
 *      an order of magnitude under what anyone can hear and 7× the error it
 *      has to track. The timeline is walked back over tens of seconds rather
 *      than yanked, so there is never a moment that sounds like a correction.
 *   2. The caller REMOVES the frames by resampling the batch shorter
 *      (`compressInterleaved` / `compressPlanar` below), not by cutting them
 *      out. There is no splice, so there is no click to fade — the batch is
 *      continuously time-compressed by at most 0.2 % and everything in it
 *      survives.
 *
 * The dead band is symmetric (`trimMinMs` = `padMinMs` = 80 ms, inside the
 * 90 ms sync bound this build certifies), so ordinary jitter still corrects
 * nothing and a healthy take is bit-identical to before.
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
  /** Below this much AHEAD of the wall, do nothing. Symmetric with padMinMs. */
  trimMinMs?: number
  /**
   * Hard ceiling on how much of a batch may be removed, as a fraction. This is
   * a rate limit and not a budget: it is what keeps a trim inaudible, so it is
   * the one number here that must not be raised without listening.
   */
  maxTrimRatio?: number
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
  private readonly trimMinMs: number
  private readonly maxTrimRatio: number
  private originMs = Infinity
  private prevArrivalMs = -Infinity
  private readonly seen: Seen[] = []
  /** Sub-sample remainder of the rate limit, so a slow drift is still tracked
   *  when the per-batch allowance is less than one whole frame. */
  private trimCarry = 0

  constructor(opts: WallClockHoldOpts) {
    this.rate = opts.sampleRate
    this.originWindowFrames = Math.round((opts.originWindowS ?? 3) * opts.sampleRate)
    this.padMinMs = opts.padMinMs ?? 80
    this.padMaxMs = opts.padMaxMs ?? 1000
    this.settleMs = opts.settleMs ?? 1000
    this.trimMinMs = opts.trimMinMs ?? 80
    this.maxTrimRatio = opts.maxTrimRatio ?? 0.002
  }

  /**
   * Call once per batch, BEFORE placing it. `timelineFrames` is the number of
   * frames already placed (real + padded − trimmed).
   *
   * Returns a SIGNED frame count, usually 0:
   *   > 0  insert this many frames of silence ahead of the batch
   *   < 0  remove this many frames FROM the batch, by resampling it shorter
   */
  correctionFramesFor(arrivalMs: number, timelineFrames: number, batchFrames: number): number {
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

    // The offset is what EVERY batch in the window agrees on. One late batch
    // is a scheduling spike; the floor across a settle window is the truth —
    // positive, time the context never rendered; negative, a timeline running
    // ahead of the wall because the audio clock is fast.
    let offsetMs = Infinity
    for (const s of this.seen) if (s.behindMs < offsetMs) offsetMs = s.behindMs
    // The window must actually span the settle time before it may convict —
    // at the first batch after a long stall, a burst about to drain and a real
    // loss look identical, and only the next stretch of arrivals tells them apart.
    const coveredMs = arrivalMs - this.seen[0]!.atMs
    if (coveredMs < this.settleMs * 0.75) return 0

    let correctionFrames = 0
    if (offsetMs > this.padMinMs) {
      correctionFrames = Math.round((Math.min(offsetMs, this.padMaxMs) / 1000) * this.rate)
      this.trimCarry = 0
    } else if (offsetMs < -this.trimMinMs) {
      // Ahead of the wall. Walk it back at the rate limit, never in one step —
      // see note 1 above for why this is the number that must not be raised.
      const aheadFrames = (-offsetMs / 1000) * this.rate
      // The rate limit is a HARD per-batch bound, not an average with a
      // fractional loan: one batch borrowing from the next would let a single
      // batch exceed the ceiling that is the whole reason a trim is inaudible.
      // The carry exists only for the case where the allowance is less than a
      // whole frame per batch — without it a slow drift could never be tracked
      // at all, because every batch would floor to zero.
      const perBatch = this.maxTrimRatio * batchFrames
      const allowance = perBatch >= 1 ? Math.floor(perBatch) : perBatch + this.trimCarry
      const want = Math.min(aheadFrames, allowance, batchFrames - 1)
      const take = Math.floor(want)
      this.trimCarry = perBatch >= 1 ? 0 : want - take
      correctionFrames = -take
    } else {
      this.trimCarry = 0
    }
    if (correctionFrames === 0) return 0

    // The timeline is about to move by the correction, so every recorded
    // offset shifts by it — without this the same loss would be padded twice,
    // and the same excess trimmed twice.
    const correctionMs = (correctionFrames / this.rate) * 1000
    for (const s of this.seen) s.behindMs -= correctionMs
    return correctionFrames
  }
}

/**
 * Remove `drop` frames from an INTERLEAVED batch by resampling it shorter.
 *
 * Linear interpolation across the whole batch rather than a cut: `drop` is at
 * most `maxTrimRatio` of `frames`, so this is a ≤0.2 % time compression with no
 * discontinuity anywhere in it — nothing to click, nothing to fade. Returns a
 * new buffer of `(frames - drop) * channels`.
 */
export function compressInterleaved(
  src: Float32Array,
  channels: number,
  frames: number,
  drop: number,
) {
  const out = frames - drop
  const dst = new Float32Array(out * channels)
  // Map [0, out-1] onto [0, frames-1] so both endpoints are preserved exactly.
  const step = out > 1 ? (frames - 1) / (out - 1) : 0
  for (let i = 0; i < out; i++) {
    const pos = i * step
    const i0 = Math.min(frames - 1, Math.floor(pos))
    const i1 = Math.min(frames - 1, i0 + 1)
    const t = pos - i0
    for (let c = 0; c < channels; c++) {
      const a = src[i0 * channels + c]!
      const b = src[i1 * channels + c]!
      dst[i * channels + c] = a + (b - a) * t
    }
  }
  return dst
}

/** `compressInterleaved` for a PLANAR batch (channel 0 then channel 1, …). */
export function compressPlanar(
  src: Float32Array,
  channels: number,
  frames: number,
  drop: number,
) {
  const out = frames - drop
  const dst = new Float32Array(out * channels)
  const step = out > 1 ? (frames - 1) / (out - 1) : 0
  for (let c = 0; c < channels; c++) {
    const sBase = c * frames
    const dBase = c * out
    for (let i = 0; i < out; i++) {
      const pos = i * step
      const i0 = Math.min(frames - 1, Math.floor(pos))
      const i1 = Math.min(frames - 1, i0 + 1)
      const t = pos - i0
      const a = src[sBase + i0]!
      const b = src[sBase + i1]!
      dst[dBase + i] = a + (b - a) * t
    }
  }
  return dst
}
