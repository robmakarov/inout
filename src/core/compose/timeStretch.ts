/**
 * WSOLA time-stretch — playing a span faster without turning the voice into a
 * chipmunk (task F5b).
 *
 * Resampling is the obvious way to speed audio up and it is the wrong one: it
 * multiplies every frequency by the same factor, so a 2x span raises the voice
 * an octave. WSOLA (waveform-similarity overlap-add) instead keeps the sample
 * rate and DROPS material, choosing where to drop it by finding the point where
 * the waveform best continues itself — so periods line up, the pitch is
 * untouched by construction, and the joins do not click.
 *
 * The algorithm, per synthesis step:
 *   · we hold a TAIL — the Ov frames that naturally follow the block just
 *     emitted, i.e. what the sound "wants" to do next;
 *   · we look around the next analysis position, within ±SEARCH frames, for the
 *     Ov-frame window that best matches that tail (normalised cross-correlation
 *     on the mono sum, so the two channels can never drift apart);
 *   · we cross-fade the tail into it over Ov frames and emit those;
 *   · the new tail is the Ov frames straight after the window we chose.
 * Output advances Ov frames per step while input advances Ov × speed, which is
 * exactly the requested rate. No frequency is ever scaled.
 *
 * Streaming, because the export is: push source frames in, pull output frames
 * out, and the buffer keeps only what the search window still needs.
 */

/** Synthesis hop and cross-fade length, frames at 48 kHz (~10.7 ms). */
const OVERLAP = 512
/** How far either side of the analysis point to look for the best match (~5 ms). */
const SEARCH = 256
/** Correlate on every other sample: half the work, no measurable difference. */
const CORR_STRIDE = 2

function raisedCosineRamp(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((Math.PI * (i + 1)) / (n + 1))
  return w
}

/** A growable, compacting mono-pair buffer addressed by ABSOLUTE frame index. */
class InputBuffer {
  private left = new Float32Array(0)
  private right = new Float32Array(0)
  /** Absolute frame index of element 0. */
  private base = 0
  private length = 0

  get first(): number {
    return this.base
  }

  get end(): number {
    return this.base + this.length
  }

  push(l: Float32Array, r: Float32Array, frames: number): void {
    if (frames <= 0) return
    if (this.length + frames > this.left.length) {
      const grown = Math.max(this.length + frames, this.left.length * 2, OVERLAP * 8)
      const nl = new Float32Array(grown)
      const nr = new Float32Array(grown)
      nl.set(this.left.subarray(0, this.length))
      nr.set(this.right.subarray(0, this.length))
      this.left = nl
      this.right = nr
    }
    this.left.set(l.subarray(0, frames), this.length)
    this.right.set(r.subarray(0, frames), this.length)
    this.length += frames
  }

  /** Forget everything before `at` — the search window never looks back. */
  compact(at: number): void {
    const drop = Math.min(this.length, Math.max(0, at - this.base))
    if (drop <= 0) return
    this.left.copyWithin(0, drop, this.length)
    this.right.copyWithin(0, drop, this.length)
    this.length -= drop
    this.base += drop
  }

  l(at: number): number {
    const i = at - this.base
    return i >= 0 && i < this.length ? this.left[i]! : 0
  }

  r(at: number): number {
    const i = at - this.base
    return i >= 0 && i < this.length ? this.right[i]! : 0
  }

  /** Mono sum at an absolute index — what the similarity search runs on. */
  mono(at: number): number {
    const i = at - this.base
    if (i < 0 || i >= this.length) return 0
    return this.left[i]! + this.right[i]!
  }
}

export class TimeStretcher {
  private readonly ramp = raisedCosineRamp(OVERLAP)
  private readonly buf = new InputBuffer()
  private readonly tailL = new Float32Array(OVERLAP)
  private readonly tailR = new Float32Array(OVERLAP)
  private readonly tailM = new Float32Array(OVERLAP)
  private tailValid = false
  /** Synthesis step counter — the analysis position is derived from it. */
  private step = 0
  /** Output frames produced but not yet pulled. */
  private readonly outL: number[] = []
  private ready = new Float32Array(0)
  private readyR = new Float32Array(0)
  private readyLen = 0
  private readyRead = 0
  private ended = false
  /** Absolute input frames consumed, for the caller's own bookkeeping. */
  private consumed = 0

  constructor(readonly speed: number) {}

  /** Analysis position of the next step, in absolute input frames. */
  private get analysisAt(): number {
    return Math.round(this.step * OVERLAP * this.speed)
  }

  /** Input frames this stretcher needs before it can take another step. */
  private get needsUpTo(): number {
    return this.analysisAt + SEARCH + 2 * OVERLAP
  }

  /**
   * How many more input frames to push before `outFrames` can be pulled. An
   * upper bound, deliberately: pushing a little extra costs a copy, pushing too
   * little would deadlock the caller.
   */
  wants(outFrames: number): number {
    const pending = this.readyLen - this.readyRead
    if (pending >= outFrames) return 0
    const steps = Math.ceil((outFrames - pending) / OVERLAP)
    const need = Math.round((this.step + steps - 1) * OVERLAP * this.speed) + SEARCH + 2 * OVERLAP
    return Math.max(0, need - this.buf.end)
  }

  push(l: Float32Array, r: Float32Array, frames: number): void {
    this.buf.push(l, r, frames)
    this.consumed += frames
  }

  /** No more input is coming: later steps use whatever is there (zeros past it). */
  end(): void {
    this.ended = true
  }

  /** Fill out[at .. at+n) and return how many frames were actually produced. */
  pull(outLeft: Float32Array, outRight: Float32Array, at: number, n: number): number {
    let written = 0
    while (written < n) {
      if (this.readyRead >= this.readyLen) {
        if (!this.stepOnce()) break
      }
      const take = Math.min(n - written, this.readyLen - this.readyRead)
      for (let i = 0; i < take; i++) {
        outLeft[at + written + i] = this.ready[this.readyRead + i]!
        outRight[at + written + i] = this.readyR[this.readyRead + i]!
      }
      this.readyRead += take
      written += take
    }
    return written
  }

  /** Produce one synthesis block, or false when there is not enough input. */
  private stepOnce(): boolean {
    if (!this.ended && this.buf.end < this.needsUpTo) return false
    if (this.ended && this.buf.end <= this.analysisAt) return false
    if (this.ready.length < OVERLAP) {
      this.ready = new Float32Array(OVERLAP)
      this.readyR = new Float32Array(OVERLAP)
    }
    const a = this.analysisAt
    if (!this.tailValid) {
      // First block: nothing to match against, so take the material as it is.
      for (let i = 0; i < OVERLAP; i++) {
        this.ready[i] = this.buf.l(a + i)
        this.readyR[i] = this.buf.r(a + i)
      }
      this.storeTail(a + OVERLAP)
    } else {
      const delta = this.bestDelta(a)
      const from = a + delta
      for (let i = 0; i < OVERLAP; i++) {
        const w = this.ramp[i]!
        this.ready[i] = this.tailL[i]! * (1 - w) + this.buf.l(from + i) * w
        this.readyR[i] = this.tailR[i]! * (1 - w) + this.buf.r(from + i) * w
      }
      this.storeTail(from + OVERLAP)
    }
    this.readyLen = OVERLAP
    this.readyRead = 0
    this.step++
    // The next search never looks further back than this.
    this.buf.compact(this.analysisAt - SEARCH - OVERLAP)
    return true
  }

  private storeTail(from: number): void {
    for (let i = 0; i < OVERLAP; i++) {
      this.tailL[i] = this.buf.l(from + i)
      this.tailR[i] = this.buf.r(from + i)
      this.tailM[i] = this.buf.mono(from + i)
    }
    this.tailValid = true
  }

  /**
   * The offset within ±SEARCH whose window best continues the tail. Normalised
   * cross-correlation, so a loud passage cannot out-score a well-matched quiet
   * one — that asymmetry is what puts clicks in a naive implementation.
   */
  private bestDelta(a: number): number {
    let bestScore = -Infinity
    let best = 0
    const lo = Math.max(-SEARCH, this.buf.first - a)
    const hi = SEARCH
    for (let d = lo; d <= hi; d += CORR_STRIDE) {
      let dot = 0
      let energy = 0
      for (let i = 0; i < OVERLAP; i += CORR_STRIDE) {
        const x = this.buf.mono(a + d + i)
        dot += x * this.tailM[i]!
        energy += x * x
      }
      const score = dot / Math.sqrt(energy + 1e-9)
      if (score > bestScore) {
        bestScore = score
        best = d
      }
    }
    return best
  }
}

/**
 * Frames of source material a span of `outFrames` at this speed consumes.
 * The pipeline uses it to size its pulls; kept here so the two cannot disagree.
 */
export function sourceFramesFor(outFrames: number, speed: number): number {
  return Math.ceil(outFrames * speed)
}
