import { describe, expect, it } from 'vitest'
import { TimeStretcher, sourceFramesFor } from './timeStretch'

const SR = 48_000

function tone(frames: number, hz: number, amp = 0.5): [Float32Array, Float32Array] {
  const l = new Float32Array(frames)
  const r = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    l[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR)
    r[i] = l[i]!
  }
  return [l, r]
}

/**
 * Fundamental by autocorrelation over the plausible voice/tone range. Cheaper
 * and more robust here than an FFT: we already know roughly what to expect and
 * only need to catch a pitch SHIFT, which would be a whole ratio away.
 */
function fundamentalHz(x: Float32Array): number {
  const minLag = Math.floor(SR / 2000)
  const maxLag = Math.floor(SR / 80)
  let best = minLag
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0
    let energy = 0
    for (let i = 0; i + lag < x.length; i++) {
      dot += x[i]! * x[i + lag]!
      energy += x[i + lag]! * x[i + lag]!
    }
    const score = dot / Math.sqrt(energy + 1e-9)
    if (score > bestScore) {
      bestScore = score
      best = lag
    }
  }
  // Parabolic refinement around the winning lag — an integer lag alone
  // quantises 440 Hz to ~4 Hz steps, which is 16 cents of instrument error on
  // a 10-cent gate (the rig is wrong before the product is).
  const at = (lag: number): number => {
    let dot = 0
    let energy = 0
    for (let i = 0; i + lag < x.length; i++) {
      dot += x[i]! * x[i + lag]!
      energy += x[i + lag]! * x[i + lag]!
    }
    return dot / Math.sqrt(energy + 1e-9)
  }
  const y0 = at(best - 1)
  const y1 = bestScore
  const y2 = at(best + 1)
  const denom = y0 - 2 * y1 + y2
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0
  return SR / (best + shift)
}

function cents(a: number, b: number): number {
  return 1200 * Math.log2(a / b)
}

/** Run a whole signal through the stretcher, pulling as it goes. */
function stretch(l: Float32Array, r: Float32Array, speed: number): [Float32Array, Float32Array] {
  const st = new TimeStretcher(speed)
  const outFrames = Math.floor(l.length / speed)
  const outL = new Float32Array(outFrames)
  const outR = new Float32Array(outFrames)
  let pushed = 0
  let produced = 0
  const CHUNK = 4096
  while (produced < outFrames) {
    const want = st.wants(Math.min(CHUNK, outFrames - produced))
    if (want > 0) {
      if (pushed >= l.length) {
        st.end()
      } else {
        const n = Math.min(want, l.length - pushed)
        st.push(l.subarray(pushed), r.subarray(pushed), n)
        pushed += n
      }
    }
    const got = st.pull(outL, outR, produced, Math.min(CHUNK, outFrames - produced))
    if (got === 0) {
      if (pushed >= l.length) {
        st.end()
        if (st.pull(outL, outR, produced, Math.min(CHUNK, outFrames - produced)) === 0) break
      }
      continue
    }
    produced += got
  }
  return [outL.subarray(0, produced), outR.subarray(0, produced)]
}

describe('TimeStretcher', () => {
  it('shortens by exactly the requested factor', () => {
    const [l, r] = tone(SR * 2, 440)
    for (const speed of [1.25, 1.5, 2, 3]) {
      const [out] = stretch(l, r, speed)
      const expected = Math.floor(l.length / speed)
      // Within one synthesis block: output is produced in whole blocks.
      expect(Math.abs(out.length - expected)).toBeLessThanOrEqual(512)
    }
  })

  it('holds pitch through a 2x span (the F5b gate: within 10 cents)', () => {
    const [l, r] = tone(SR * 2, 440)
    const [out] = stretch(l, r, 2)
    // Skip the first block: it is the un-matched priming block.
    const measured = fundamentalHz(out.subarray(4096, 4096 + SR))
    expect(Math.abs(cents(measured, 440))).toBeLessThan(10)
  })

  it('holds pitch at every speed the editor offers', () => {
    for (const speed of [1.25, 1.5, 2, 3]) {
      const [l, r] = tone(SR * 2, 220)
      const [out] = stretch(l, r, speed)
      const measured = fundamentalHz(out.subarray(4096, 4096 + Math.min(SR, out.length - 4096)))
      expect(Math.abs(cents(measured, 220))).toBeLessThan(10)
    }
  })

  it('does not click: no sample step larger than the signal itself has', () => {
    const [l, r] = tone(SR, 440)
    const [out] = stretch(l, r, 2)
    let maxStep = 0
    for (let i = 4097; i < out.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(out[i]! - out[i - 1]!))
    }
    // One step of a 440 Hz sine at 48 kHz is 0.5 * 2π * 440/48000 ≈ 0.029.
    // A butt-joined splice would show a step near the amplitude itself (0.5).
    expect(maxStep).toBeLessThan(0.06)
  })

  it('keeps the two channels together', () => {
    const frames = SR
    const l = new Float32Array(frames)
    const r = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      l[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR)
      // Same wave, opposite sign: any per-channel search drift shows up as the
      // sum failing to cancel.
      r[i] = -l[i]!
    }
    const [outL, outR] = stretch(l, r, 2)
    let worst = 0
    for (let i = 4096; i < outL.length; i++) worst = Math.max(worst, Math.abs(outL[i]! + outR[i]!))
    expect(worst).toBeLessThan(1e-6)
  })

  it('preserves level — a stretch must not duck the audio', () => {
    const [l, r] = tone(SR * 2, 440, 0.5)
    const [out] = stretch(l, r, 2)
    let sum = 0
    const from = 4096
    for (let i = from; i < out.length; i++) sum += out[i]! * out[i]!
    const rms = Math.sqrt(sum / (out.length - from))
    // A 0.5-amplitude sine is 0.3536 RMS; the cross-fade must not lose more
    // than a whisker of it.
    expect(rms).toBeGreaterThan(0.33)
    expect(rms).toBeLessThan(0.38)
  })

  it('sourceFramesFor matches what the stretcher consumes', () => {
    expect(sourceFramesFor(1000, 2)).toBe(2000)
    expect(sourceFramesFor(1000, 1.5)).toBe(1500)
  })
})
