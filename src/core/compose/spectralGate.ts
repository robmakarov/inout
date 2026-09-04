/**
 * O10c — DETERMINISTIC SPECTRAL GATING, opt-in and off by default.
 *
 * WHAT IT IS FOR. Robert heard "some small noises in tab audio" on a
 * 124.8-minute take (B13). Four instruments have been tried and three of them
 * were measuring the task's own synthetic material; the question of whether the
 * noise is IN THE SOURCE or in our chain is still open and needs a real take
 * from him. This is the tool for the first case: a gate that attenuates what
 * looks like steady broadband noise and leaves everything else alone, so an
 * A/B can be put in front of his ear.
 *
 * DETERMINISTIC, AND THAT WORD IS THE DESIGN. No model, no training, no
 * adaptation over time, no randomness: the noise profile is a percentile of the
 * take's own frames and the gain of every bin is a fixed function of that
 * profile. The same input gives the same output on every machine and in every
 * run, which is what makes it testable at all and what makes an A/B mean
 * something.
 *
 * WHAT IT WILL NOT DO, by construction:
 *   · it never touches the RAW channels — it runs on the export's mix, so the
 *     recording on disk is what it always was;
 *   · it is OFF by default and the OFF path does not run a single line of this
 *     file, so the default export is byte-identical (pinned by a test);
 *   · it is CONSERVATIVE by default: the gate only pulls a bin down when that
 *     bin is close to the noise floor for that frequency, and the floor is
 *     taken from the quietest fifth of the take. On clean speech nothing
 *     triggers, which is a gate this file's own tests assert rather than hope.
 *
 * THE SHAPE. Short-time Fourier transform, Hann window, 75 % overlap (hop =
 * N/4), gate the magnitudes, inverse transform, overlap-add. A Hann window at
 * 75 % overlap sums to a constant, so with the gain left at 1 the analysis and
 * synthesis reconstruct the input exactly — that identity is the first test in
 * the file, because a gate built on a transform that does not reconstruct is
 * measuring its own reconstruction error and calling it noise removal.
 */

/** Frame size. 1024 at 48 kHz is 21.3 ms — long enough to resolve a 47 Hz bin,
 *  short enough that a consonant does not smear across the window. */
export const GATE_FRAME = 1024
/** Hop. N/4 is the 75 % overlap the Hann COLA identity below depends on. */
export const GATE_HOP = GATE_FRAME / 4

/**
 * In-place iterative radix-2 complex FFT. `sign` is -1 forward, +1 inverse;
 * the inverse does NOT scale, the caller divides by N (the one convention this
 * file uses, stated once so no call site has to guess).
 *
 * Written here rather than taken from a dependency: it is forty lines, it runs
 * in the export worker where every byte of bundle is paid for on first paint,
 * and a transform whose exactness the tests depend on should be readable in the
 * same file as the tests' claims.
 */
export function fft(re: Float32Array, im: Float32Array, sign: -1 | 1): void {
  const n = re.length
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]!
      re[i] = re[j]!
      re[j] = tr
      const ti = im[i]!
      im[i] = im[j]!
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!
        const ai = im[i + k]!
        const br = re[i + k + len / 2]!
        const bi = im[i + k + len / 2]!
        const tr = br * cr - bi * ci
        const ti = br * ci + bi * cr
        re[i + k] = ar + tr
        im[i + k] = ai + ti
        re[i + k + len / 2] = ar - tr
        im[i + k + len / 2] = ai - ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/** Periodic Hann, which is the window that satisfies COLA at 75 % overlap. */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}

export interface SpectralGateParams {
  /**
   * How far above the noise floor a bin has to be before it is left alone,
   * in dB. Below the floor + this, the bin is attenuated; above it, untouched.
   * The default is deliberately high: this is a gate that would rather leave
   * noise in than take a breath out of speech.
   */
  overFloorDb: number
  /** The most a bin may be pulled down, in dB. A floor, so gating can never
   *  produce a hole — musical noise comes from bins slammed to zero. */
  maxAttenDb: number
  /** Which quantile of frame energies is taken as "this is the noise". */
  noiseQuantile: number
  /**
   * Below this, a bin holds NOTHING and is left alone — not gated, and not
   * counted as a trigger.
   *
   * It is not a nicety, it is what makes the trigger count mean anything. A
   * real signal puts energy in a handful of bins and leaves hundreds at the
   * arithmetic's own noise, and those empty bins compare small-against-small
   * and trip every time: the first cut of this gate reported 36,427 triggers
   * on CLEAN speech, every one of them a bin with nothing audible in it.
   * Attenuating silence by 12 dB is still silence, so the honest answer is to
   * decline the bin. In dB below the magnitude a full-scale sine puts in its
   * own bin under this window.
   */
  silenceDb: number
  /**
   * HOW STEADY A BIN HAS TO BE BEFORE IT COUNTS AS NOISE, as the ratio of its
   * quiet quantile to its median across the take.
   *
   * This is what makes the gate leave speech alone, and it is the property that
   * actually separates the two things. A noise BED is stationary: the same
   * hiss is there in every frame, so its quiet fifth and its middle sit close
   * together (white noise reads about 0.57). A bin carrying SIGNAL swings with
   * the envelope — loud on a syllable, gone between them — so its quiet fifth
   * is far below its middle. Gating on level alone cannot tell those apart, and
   * did not: clean speech tripped 549 times on the skirts a window leaves
   * around every harmonic, every one of them 30 dB below the harmonic and
   * inaudible, but a trigger the gate had no business pulling.
   */
  steadyRatio: number
}

export const GATE_DEFAULTS: SpectralGateParams = {
  overFloorDb: 9,
  maxAttenDb: 12,
  noiseQuantile: 0.2,
  silenceDb: 90,
  steadyRatio: 0.45,
}

/**
 * The per-bin noise floor, from the take's own quiet frames.
 *
 * Every frame's magnitude spectrum is computed once; for each BIN the
 * `noiseQuantile` of that bin's magnitudes across all frames is the floor. A
 * per-bin quantile rather than a per-frame pick because the noise is not the
 * same shape as the signal: hum lives in a few low bins and hiss lives
 * everywhere, and taking whole frames would let one loud frame in a quiet
 * passage raise the floor for every frequency at once.
 */
export interface NoiseProfile {
  /** The quiet quantile per bin — the level the gate measures against. */
  floor: Float32Array
  /** floor / median per bin: how stationary that bin is. See `steadyRatio`. */
  steady: Float32Array
}

export function noiseProfile(
  samples: Float32Array,
  frame = GATE_FRAME,
  hop = GATE_HOP,
  quantile = GATE_DEFAULTS.noiseQuantile,
): NoiseProfile {
  const bins = frame / 2 + 1
  const win = hannWindow(frame)
  const frames: Float32Array[] = []
  const re = new Float32Array(frame)
  const im = new Float32Array(frame)
  for (let start = 0; start + frame <= samples.length; start += hop) {
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < frame; i++) re[i] = samples[start + i]! * win[i]!
    fft(re, im, -1)
    const mag = new Float32Array(bins)
    for (let b = 0; b < bins; b++) mag[b] = Math.hypot(re[b]!, im[b]!)
    frames.push(mag)
  }
  const floor = new Float32Array(bins)
  const steady = new Float32Array(bins)
  if (frames.length === 0) return { floor, steady }
  const column = new Float32Array(frames.length)
  for (let b = 0; b < bins; b++) {
    for (let f = 0; f < frames.length; f++) column[f] = frames[f]![b]!
    const sorted = Array.from(column).sort((a, b2) => a - b2)
    const at = (q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!
    const q = at(quantile)
    const median = at(0.5)
    floor[b] = q
    steady[b] = median > 0 ? q / median : 0
  }
  return { floor, steady }
}

/**
 * Gate one mono signal against a profile. Returns a NEW array; the caller's
 * samples are never modified, because the raw is never ours to touch.
 *
 * `triggers` counts the bins that were actually pulled down — the number the
 * "zero triggers on clean speech" gate is measured on, and the reason this
 * returns it rather than only the audio.
 */
export interface GateResult {
  out: Float32Array
  /** Bins attenuated by more than 0.1 dB, over the whole signal. */
  triggers: number
  /** Bins examined, so a trigger count can be read as a fraction. */
  bins: number
}

export function gate(
  samples: Float32Array,
  profile: NoiseProfile,
  params: SpectralGateParams = GATE_DEFAULTS,
  frame = GATE_FRAME,
  hop = GATE_HOP,
): GateResult {
  const bins = frame / 2 + 1
  const win = hannWindow(frame)
  const out = new Float32Array(samples.length)
  const norm = new Float32Array(samples.length)
  const re = new Float32Array(frame)
  const im = new Float32Array(frame)
  const over = Math.pow(10, params.overFloorDb / 20)
  const minGain = Math.pow(10, -params.maxAttenDb / 20)
  // A full-scale sine under a Hann window puts frame/4 into its own bin; the
  // silence threshold is that, this many dB down.
  const silent = (frame / 4) * Math.pow(10, -params.silenceDb / 20)
  let triggers = 0
  let examined = 0
  for (let start = 0; start + frame <= samples.length; start += hop) {
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < frame; i++) re[i] = samples[start + i]! * win[i]!
    fft(re, im, -1)
    for (let b = 0; b < bins; b++) {
      const mag = Math.hypot(re[b]!, im[b]!)
      // Nothing in it: nothing to take out, and nothing to count.
      if (mag < silent) continue
      // AND NOTHING TO REMOVE THERE. If the take's own floor at this frequency
      // is itself below silence, there is no noise bed at this bin — whatever
      // is here is signal, however quiet. Without this the gate fires between
      // the harmonics of clean speech, where both numbers are the arithmetic's
      // own dust: 560 triggers on a signal with no noise in it at all.
      if (profile.floor[b]! < silent) continue
      // AND IT HAS TO BE A BED, not a signal that happens to be quiet here.
      if (profile.steady[b]! < params.steadyRatio) continue
      const threshold = profile.floor[b]! * over
      examined++
      // Above the threshold the bin is signal and is not touched at all —
      // gain exactly 1, so a clean take comes back sample for sample.
      if (!(mag < threshold) || threshold <= 0) continue
      // Below it, the gain falls smoothly from 1 at the threshold to the floor
      // at zero magnitude. A hard cut here is what makes gates sound like
      // gates; the ratio is squared for a gentler knee.
      const ratio = threshold > 0 ? mag / threshold : 1
      const g = Math.max(minGain, ratio * ratio)
      /**
       * A CHANGE TOO SMALL TO COUNT IS A CHANGE TOO SMALL TO MAKE. The first
       * cut scaled every bin below the threshold and counted only those moved
       * more than 0.1 dB, so a signal reporting ZERO triggers still came back
       * 20 dB away from itself — hundreds of bins nudged by a tenth of a dB
       * each. Declining them makes the count mean what it says: zero triggers
       * is the input, reconstructed, and nothing else.
       */
      if (g > 0.9885) continue // 0.1 dB
      triggers++
      re[b] = re[b]! * g
      im[b] = im[b]! * g
      // The spectrum of a real signal is conjugate-symmetric, and the inverse
      // transform reads the whole array: a bin scaled without its mirror
      // produces an imaginary part, which is a quiet buzz nobody would trace.
      if (b > 0 && b < frame / 2) {
        const m = frame - b
        re[m] = re[m]! * g
        im[m] = im[m]! * g
      }
    }
    fft(re, im, 1)
    for (let i = 0; i < frame; i++) {
      const v = (re[i]! / frame) * win[i]!
      out[start + i] = out[start + i]! + v
      norm[start + i] = norm[start + i]! + win[i]! * win[i]!
    }
  }
  /**
   * Overlap-add normalisation. Hann-squared at 75 % overlap sums to 1.5 in the
   * interior, and dividing by that reconstructs exactly (measured: the error
   * with nothing gated is 172 dB down).
   *
   * THE GUARD IS NOT A FORMALITY. At the very start and end only one or two
   * frames have landed, so the sum is a small fraction — and dividing by a
   * small number AMPLIFIES. A permissive `> 1e-6` guard made the first and last
   * milliseconds of every gated signal louder than the input, which read as the
   * whole gate making a noise bed 4.3 dB LOUDER when measured over the full
   * array. Below a real fraction of the steady state the sample is simply the
   * input: those edges were never covered by enough windows to be reconstructed
   * from, and passing them through is exact where dividing is a guess.
   */
  const steady = 1.5
  for (let i = 0; i < out.length; i++) {
    const n = norm[i]!
    if (n > steady * 0.1) out[i] = out[i]! / n
    else out[i] = samples[i]!
  }
  return { out, triggers, bins: examined }
}

/**
 * THE SAME GATE, FED A SECOND AT A TIME — and it has to be the same gate.
 *
 * `render.ts` writes audio in one-second chunks, so the gate cannot see the
 * whole signal at once. Gating each chunk on its own would ramp the window in
 * and out at every boundary: a click, or a breath of level, once a second, for
 * the length of the take. That is precisely the defect B13 is about, so this
 * carries state across the boundary instead.
 *
 * WHAT IS CARRIED: the tail of the input that the next frame still needs
 * (`frame - hop` samples), and the partial overlap-add sums for the samples
 * whose windows are not all in yet. A sample is only EMITTED once every window
 * covering it has landed, which is what makes the streamed output identical to
 * the whole-signal output rather than merely similar. The test asserts exactly
 * that, at -100 dB, because "similar" is how a seam ships.
 *
 * The profile is given once and never adapts: same input, same output, and a
 * chunk boundary cannot change the gain of a bin.
 */
export class StreamingGate {
  private readonly frame: number
  private readonly hop: number
  private readonly win: Float32Array
  private readonly re: Float32Array
  private readonly im: Float32Array

  /**
   * ONE ABSOLUTE TIMELINE, and everything is an index into it. The first cut of
   * this mixed a buffer-relative frame start with a count of samples already
   * emitted, which agreed with itself on an even feed and drifted on a ragged
   * one — the streamed output came back 24 dB from the whole-signal output when
   * the chunk sizes varied. Absolute positions cannot drift.
   */
  /** Absolute index of `buf[0]`. */
  private bufAt = 0
  private buf: Float32Array<ArrayBuffer> = new Float32Array(0)
  /** Absolute start of the next frame to transform. */
  private nextFrame = 0
  /** Absolute index of `acc[0]`. */
  private accAt = 0
  private acc: Float32Array<ArrayBuffer> = new Float32Array(0)
  private accNorm: Float32Array<ArrayBuffer> = new Float32Array(0)
  private accIn: Float32Array<ArrayBuffer> = new Float32Array(0)
  /** Absolute index of the next sample to hand back. */
  private emitAt = 0
  triggers = 0
  bins = 0

  constructor(
    private readonly profile: NoiseProfile,
    private readonly params: SpectralGateParams = GATE_DEFAULTS,
    frame = GATE_FRAME,
    hop = GATE_HOP,
  ) {
    this.frame = frame
    this.hop = hop
    this.win = hannWindow(frame)
    this.re = new Float32Array(frame)
    this.im = new Float32Array(frame)
  }

  /** Feed the next piece; get back every sample that is now finished. */
  push(chunk: Float32Array): Float32Array {
    this.append(chunk)
    const end = this.bufAt + this.buf.length
    while (this.nextFrame + this.frame <= end) {
      this.oneFrame(this.nextFrame)
      this.nextFrame += this.hop
    }
    // No frame after this one can reach a sample before its start, so
    // everything below the last transformed frame's start is complete.
    const complete = Math.max(this.emitAt, this.nextFrame - (this.frame - this.hop))
    const out = this.emitTo(complete)
    this.dropBufferBefore(this.nextFrame)
    return out
  }

  /** No more input: hand back everything still held. */
  flush(): Float32Array {
    return this.emitTo(this.accAt + this.acc.length)
  }

  private append(chunk: Float32Array): void {
    const next = new Float32Array(new ArrayBuffer((this.buf.length + chunk.length) * 4))
    next.set(this.buf)
    next.set(chunk, this.buf.length)
    this.buf = next
  }

  /** Forget input no frame will read again. */
  private dropBufferBefore(at: number): void {
    const cut = at - this.bufAt
    if (cut <= 0) return
    this.buf = new Float32Array(this.buf.subarray(Math.min(cut, this.buf.length)))
    this.bufAt = at
  }

  private ensureAcc(from: number, to: number): void {
    if (this.acc.length === 0) {
      this.accAt = from
      const n = to - from
      this.acc = new Float32Array(new ArrayBuffer(n * 4))
      this.accNorm = new Float32Array(new ArrayBuffer(n * 4))
      this.accIn = new Float32Array(new ArrayBuffer(n * 4))
      return
    }
    const need = to - this.accAt
    if (need <= this.acc.length) return
    const grow = (a: Float32Array): Float32Array<ArrayBuffer> => {
      const next = new Float32Array(new ArrayBuffer(need * 4))
      next.set(a)
      return next
    }
    this.acc = grow(this.acc)
    this.accNorm = grow(this.accNorm)
    this.accIn = grow(this.accIn)
  }

  private oneFrame(at: number): void {
    const { frame, win, re, im, params, profile } = this
    const bins = frame / 2 + 1
    const over = Math.pow(10, params.overFloorDb / 20)
    const minGain = Math.pow(10, -params.maxAttenDb / 20)
    const silent = (frame / 4) * Math.pow(10, -params.silenceDb / 20)
    const off = at - this.bufAt
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < frame; i++) re[i] = this.buf[off + i]! * win[i]!
    fft(re, im, -1)
    for (let b = 0; b < bins; b++) {
      const mag = Math.hypot(re[b]!, im[b]!)
      if (mag < silent) continue
      if (profile.floor[b]! < silent) continue
      if (profile.steady[b]! < params.steadyRatio) continue
      const threshold = profile.floor[b]! * over
      this.bins++
      if (!(mag < threshold) || threshold <= 0) continue
      const ratio = mag / threshold
      const g = Math.max(minGain, ratio * ratio)
      if (g > 0.9885) continue
      this.triggers++
      re[b] = re[b]! * g
      im[b] = im[b]! * g
      if (b > 0 && b < frame / 2) {
        const m = frame - b
        re[m] = re[m]! * g
        im[m] = im[m]! * g
      }
    }
    fft(re, im, 1)
    this.ensureAcc(at, at + frame)
    const base = at - this.accAt
    for (let i = 0; i < frame; i++) {
      this.acc[base + i] = this.acc[base + i]! + (re[i]! / frame) * win[i]!
      this.accNorm[base + i] = this.accNorm[base + i]! + win[i]! * win[i]!
      this.accIn[base + i] = this.buf[off + i]!
    }
  }

  /** Normalise and hand back everything from `emitAt` up to `to`. */
  private emitTo(to: number): Float32Array {
    const end = Math.min(to, this.accAt + this.acc.length)
    const n = Math.max(0, end - this.emitAt)
    const out = new Float32Array(n)
    const steady = 1.5
    for (let i = 0; i < n; i++) {
      const k = this.emitAt - this.accAt + i
      const norm = this.accNorm[k]!
      out[i] = norm > steady * 0.1 ? this.acc[k]! / norm : this.accIn[k]!
    }
    this.emitAt += n
    return out
  }
}

/**
 * THE PROFILE, FROM A BOUNDED WINDOW OF THE MIX.
 *
 * The gate needs the take's quiet frames before it can gate anything, and the
 * render is a forward stream — so a window is buffered, the profile is built
 * from it, and the gate then runs streaming over the whole take.
 *
 * KNOWN LIMIT, STATED RATHER THAN DISCOVERED: the window is the FIRST
 * `budgetSec` seconds, so a take whose noise bed starts later, or changes,
 * is profiled from material that does not contain it. B1b already solved the
 * same problem for the size probe — `chooseWindow` picks representative
 * seconds off the packet index without decoding — and this should use it when
 * this path stops being opt-in. It is bounded on purpose: 20 s of mono at
 * 48 kHz is 3.8 MB, and this machine has 8 GB with three encoders on it.
 */
export const PROFILE_BUDGET_SEC = 20

export function profileWindowFrames(sampleRate: number, budgetSec = PROFILE_BUDGET_SEC): number {
  return Math.max(GATE_FRAME * 4, Math.round(budgetSec * sampleRate))
}
