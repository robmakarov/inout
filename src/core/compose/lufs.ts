/**
 * EBU R128 / ITU-R BS.1770-4 integrated loudness (task O10a).
 *
 * WHY THIS AND NOT THE p90 WINDOW RMS THE EXPORT ALREADY USES. The shipped
 * makeup gain normalises the 90th percentile of 100 ms window RMS, which is a
 * reasonable "how loud is the speech" statistic and is NOT a loudness standard:
 * it has no frequency weighting, so a bass-heavy take and a bright one with the
 * same RMS land at the same gain and do not sound equally loud; and it has no
 * gating, so a take with long silences is measured partly on its silence. R128
 * fixes both, and it is the number every other tool in the user's life is
 * normalised to — which is the actual product argument: a take exported from
 * INOUT should sit at the same loudness as everything else they watch.
 *
 * WHAT BS.1770 ACTUALLY SPECIFIES, and each piece is here because leaving it
 * out changes the answer:
 *   K-WEIGHTING   two biquads — a high shelf that models the head's acoustic
 *                 effect, then an RLB high-pass that discounts the very low end
 *                 the ear does not weigh as loudness.
 *   400 ms BLOCKS at 75 % overlap (a 100 ms hop), so a transient cannot sit on
 *                 a block boundary and be counted twice or not at all.
 *   ABSOLUTE GATE at −70 LUFS: digital silence and room tone are not programme.
 *   RELATIVE GATE at 10 LU below the ungated mean: this is the one that matters
 *                 for us, because it is what stops a take with long pauses from
 *                 reading quiet. Without it, "tighten the silences" would change
 *                 a take's measured loudness, which would be absurd.
 *
 * The coefficients are the standard's own, for 48 kHz — which is
 * AUDIO_SAMPLE_RATE everywhere in this codebase. `measureIntegratedLufs`
 * refuses another rate rather than resampling behind the caller's back: a
 * loudness number computed with the wrong filter is worse than no number.
 */

/** BS.1770-4 stage 1: high-shelf pre-filter, 48 kHz. */
const PRE = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
}
/** BS.1770-4 stage 2: RLB high-pass, 48 kHz. */
const RLB = {
  b0: 1.0,
  b1: -2.0,
  b2: 1.0,
  a1: -1.99004745483398,
  a2: 0.99007225036621,
}

/** The standard's offset, which makes a full-scale reference read 0 LKFS. */
const OFFSET_DB = -0.691
/** Silence and room tone are not programme (BS.1770-4 §, absolute gate). */
export const ABSOLUTE_GATE_LUFS = -70
/** 10 LU below the ungated mean — what keeps pauses from lowering the answer. */
export const RELATIVE_GATE_LU = 10
export const BLOCK_MS = 400
export const HOP_MS = 100
export const REQUIRED_SAMPLE_RATE = 48_000

function biquad(input: Float32Array, c: typeof PRE): Float32Array {
  const out = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]!
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
    out[i] = y0
  }
  return out
}

export interface LoudnessResult {
  /** Integrated loudness, LUFS. null when nothing survived the gates. */
  integratedLufs: number | null
  /** Blocks measured, and how many each gate kept — the audit trail. */
  blocks: number
  aboveAbsoluteGate: number
  aboveRelativeGate: number
  /** The relative threshold that was applied, LUFS. */
  relativeThresholdLufs: number | null
}

/**
 * Integrated loudness of a stereo pair. Channels are weighted 1.0 each, which
 * is the standard's weighting for L and R (only surround channels differ).
 */
export function measureIntegratedLufs(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): LoudnessResult {
  if (sampleRate !== REQUIRED_SAMPLE_RATE) {
    throw new Error(
      `measureIntegratedLufs: BS.1770 coefficients here are 48 kHz only, got ${sampleRate}`,
    )
  }
  const n = Math.min(left.length, right.length)
  const blockLen = Math.round((BLOCK_MS / 1000) * sampleRate)
  const hop = Math.round((HOP_MS / 1000) * sampleRate)
  if (n < blockLen) {
    return {
      integratedLufs: null,
      blocks: 0,
      aboveAbsoluteGate: 0,
      aboveRelativeGate: 0,
      relativeThresholdLufs: null,
    }
  }

  const kl = biquad(biquad(left.subarray(0, n), PRE), RLB)
  const kr = biquad(biquad(right.subarray(0, n), PRE), RLB)

  // z = mean square per block, summed over channels.
  const z: number[] = []
  for (let start = 0; start + blockLen <= n; start += hop) {
    let sl = 0
    let sr = 0
    for (let i = start; i < start + blockLen; i++) {
      sl += kl[i]! * kl[i]!
      sr += kr[i]! * kr[i]!
    }
    z.push(sl / blockLen + sr / blockLen)
  }
  if (z.length === 0) {
    return {
      integratedLufs: null,
      blocks: 0,
      aboveAbsoluteGate: 0,
      aboveRelativeGate: 0,
      relativeThresholdLufs: null,
    }
  }

  return gateBlocks(z)
}

/** The two gates and the final mean — shared so the two forms cannot drift. */
function gateBlocks(z: number[]): LoudnessResult {
  const loudnessOf = (power: number): number =>
    power > 0 ? OFFSET_DB + 10 * Math.log10(power) : -Infinity
  if (z.length === 0) {
    return {
      integratedLufs: null,
      blocks: 0,
      aboveAbsoluteGate: 0,
      aboveRelativeGate: 0,
      relativeThresholdLufs: null,
    }
  }
  const absKept = z.filter((p) => loudnessOf(p) > ABSOLUTE_GATE_LUFS)
  if (absKept.length === 0) {
    return {
      integratedLufs: null,
      blocks: z.length,
      aboveAbsoluteGate: 0,
      aboveRelativeGate: 0,
      relativeThresholdLufs: null,
    }
  }
  const ungatedMean = absKept.reduce((a, p) => a + p, 0) / absKept.length
  const relThreshold = loudnessOf(ungatedMean) - RELATIVE_GATE_LU
  const relKept = absKept.filter((p) => loudnessOf(p) > relThreshold)
  if (relKept.length === 0) {
    return {
      integratedLufs: null,
      blocks: z.length,
      aboveAbsoluteGate: absKept.length,
      aboveRelativeGate: 0,
      relativeThresholdLufs: Math.round(relThreshold * 100) / 100,
    }
  }
  const gatedMean = relKept.reduce((a, p) => a + p, 0) / relKept.length
  return {
    integratedLufs: Math.round(loudnessOf(gatedMean) * 100) / 100,
    blocks: z.length,
    aboveAbsoluteGate: absKept.length,
    aboveRelativeGate: relKept.length,
    relativeThresholdLufs: Math.round(relThreshold * 100) / 100,
  }
}

/**
 * The same measurement, fed in chunks — which is how the export has to use it.
 *
 * `measureIntegratedLufs` needs the whole signal in memory, and a 30-minute
 * stereo take is ~690 MB of Float32. That is precisely the memory story O1
 * spent a task removing from the export, so the render's probe uses this
 * instead: biquad state is carried across chunks, blocks are accumulated as
 * scalars, and the gating happens once at the end over an array of block
 * POWERS — one number per 100 ms, i.e. 18,000 numbers for half an hour.
 *
 * The block boundary does not care where a chunk ends: samples are buffered
 * into the current block and the hop advances independently, so feeding the
 * same signal in one chunk or a thousand gives the same answer (pinned by test).
 */
export class LufsAccumulator {
  private readonly blockLen: number
  private readonly hop: number
  private readonly powers: number[] = []
  /** Ring of K-weighted squares awaiting a full block, per channel summed. */
  private readonly ring: Float32Array
  private ringFill = 0
  private ringAt = 0
  private sinceHop = 0
  private preL = { x1: 0, x2: 0, y1: 0, y2: 0 }
  private preR = { x1: 0, x2: 0, y1: 0, y2: 0 }
  private rlbL = { x1: 0, x2: 0, y1: 0, y2: 0 }
  private rlbR = { x1: 0, x2: 0, y1: 0, y2: 0 }

  constructor(readonly sampleRate: number = REQUIRED_SAMPLE_RATE) {
    if (sampleRate !== REQUIRED_SAMPLE_RATE) {
      throw new Error(`LufsAccumulator: 48 kHz only, got ${sampleRate}`)
    }
    this.blockLen = Math.round((BLOCK_MS / 1000) * sampleRate)
    this.hop = Math.round((HOP_MS / 1000) * sampleRate)
    this.ring = new Float32Array(this.blockLen)
  }

  private step(x0: number, st: { x1: number; x2: number; y1: number; y2: number }, c: typeof PRE): number {
    const y0 = c.b0 * x0 + c.b1 * st.x1 + c.b2 * st.x2 - c.a1 * st.y1 - c.a2 * st.y2
    st.x2 = st.x1
    st.x1 = x0
    st.y2 = st.y1
    st.y1 = y0
    return y0
  }

  add(left: Float32Array, right: Float32Array, count = Math.min(left.length, right.length)): void {
    for (let i = 0; i < count; i++) {
      const l = this.step(this.step(left[i]!, this.preL, PRE), this.rlbL, RLB)
      const r = this.step(this.step(right[i]!, this.preR, PRE), this.rlbR, RLB)
      // Both channels weighted 1.0, summed — the same z the batch form builds.
      this.ring[this.ringAt] = l * l + r * r
      this.ringAt = (this.ringAt + 1) % this.blockLen
      if (this.ringFill < this.blockLen) this.ringFill++
      this.sinceHop++
      if (this.ringFill === this.blockLen && this.sinceHop >= this.hop) {
        this.sinceHop = 0
        let sum = 0
        for (let k = 0; k < this.blockLen; k++) sum += this.ring[k]!
        this.powers.push(sum / this.blockLen)
      }
    }
  }

  finish(): LoudnessResult {
    return gateBlocks(this.powers)
  }
}

/** R128's own target. −14 is the streaming convention Robert's viewers live in. */
export const DEFAULT_TARGET_LUFS = -14

/**
 * Linear gain that would move `measured` to `target`.
 *
 * BOUNDED, and the bound is the point: an R128 target applied to a quiet take
 * asks for a gain that would lift its noise floor into audibility, which is the
 * exact failure the shipped makeup already guards against with its p20 floor
 * rule. This returns the ASKED-FOR gain and leaves the bounding to the caller
 * that owns the floor — see audio.ts — rather than inventing a second policy.
 */
export function gainForTargetLufs(measured: number | null, target = DEFAULT_TARGET_LUFS): number {
  if (measured === null || !Number.isFinite(measured)) return 1
  return Math.pow(10, (target - measured) / 20)
}
