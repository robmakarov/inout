import { describe, expect, it } from 'vitest'
import {
  ABSOLUTE_GATE_LUFS,
  DEFAULT_TARGET_LUFS,
  LufsAccumulator,
  gainForTargetLufs,
  measureIntegratedLufs,
} from './lufs'

const SR = 48_000

function sine(seconds: number, hz: number, amp: number): Float32Array {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR)
  return out
}

function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SR))
}

function concat(...parts: Float32Array[]): Float32Array {
  const n = parts.reduce((a, p) => a + p.length, 0)
  const out = new Float32Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

describe('measureIntegratedLufs', () => {
  it('lands on the standard’s own calibration: a 1 kHz stereo sine reads 20·log10(peak)', () => {
    // THIS IS WHERE BS.1770 IS CALIBRATED, and it is worth spelling out because
    // the first version of this test asserted the wrong thing. The formula
    // gives −0.691 + 10·log10(z), and for a stereo sine of peak A the summed
    // mean square z is A². That alone would read 20·log10(A) − 0.691. It does
    // NOT, because K-weighting is not 0 dB at 1 kHz — it is +0.69 dB there, and
    // the two cancel by construction. So the standard's reference tone reads
    // exactly its own peak level in dBFS, and measuring that checks the filter
    // and the offset together rather than either alone.
    for (const amp of [0.1, 0.0708, 0.25]) {
      const s = sine(3, 1000, amp)
      const r = measureIntegratedLufs(s, s, SR)
      expect(r.integratedLufs).not.toBeNull()
      expect(Math.abs(r.integratedLufs! - 20 * Math.log10(amp))).toBeLessThan(0.15)
    }
  })

  it('is a ratio measure: doubling amplitude adds 6.02 LU', () => {
    const a = sine(3, 1000, 0.05)
    const b = sine(3, 1000, 0.1)
    const la = measureIntegratedLufs(a, a, SR).integratedLufs!
    const lb = measureIntegratedLufs(b, b, SR).integratedLufs!
    expect(Math.abs(lb - la - 6.02)).toBeLessThan(0.1)
  })

  it('weights by frequency, in BOTH directions — that is why this is not RMS', () => {
    // The K curve's two halves. The RLB high-pass discounts the very low end
    // (20 Hz, not 50 — the −3 dB point is near 38 Hz, so 50 Hz is barely
    // touched and asserting otherwise was a wrong expectation, not a bug), and
    // the high shelf LIFTS the top, which is the half an RMS measure misses
    // entirely and the half that makes bright takes measure as loud as they
    // sound.
    const at = (hz: number): number => {
      const s = sine(3, hz, 0.1)
      return measureIntegratedLufs(s, s, SR).integratedLufs!
    }
    const mid = at(1000)
    expect(at(20)).toBeLessThan(mid - 5)
    expect(at(6000)).toBeGreaterThan(mid + 2)
  })

  it('returns null for digital silence rather than a very negative number', () => {
    const s = silence(2)
    const r = measureIntegratedLufs(s, s, SR)
    expect(r.integratedLufs).toBeNull()
    expect(r.aboveAbsoluteGate).toBe(0)
  })

  it('THE RELATIVE GATE: long pauses do not make a take read quiet', () => {
    // The property that matters for this product: "Tighten" removes silence,
    // and removing silence must not change how loud the take is measured to be.
    const speech = sine(2, 1000, 0.1)
    const withPauses = concat(speech, silence(4), speech, silence(4), speech)
    const dense = concat(speech, speech, speech)
    const a = measureIntegratedLufs(withPauses, withPauses, SR).integratedLufs!
    const b = measureIntegratedLufs(dense, dense, SR).integratedLufs!
    expect(Math.abs(a - b)).toBeLessThan(0.5)
  })

  it('reports how many blocks each gate kept, so a number can be audited', () => {
    const speech = sine(2, 1000, 0.1)
    const r = measureIntegratedLufs(concat(speech, silence(3)), concat(speech, silence(3)), SR)
    expect(r.blocks).toBeGreaterThan(r.aboveAbsoluteGate)
    expect(r.aboveAbsoluteGate).toBeGreaterThan(0)
    expect(r.relativeThresholdLufs).not.toBeNull()
  })

  it('refuses a sample rate its coefficients are not for', () => {
    const s = sine(1, 1000, 0.1)
    expect(() => measureIntegratedLufs(s, s, 44_100)).toThrow(/48 kHz/)
  })

  it('is quiet enough at the absolute gate that room tone is excluded', () => {
    // −70 LUFS is far below anything a microphone in a room produces, so this
    // pins the constant rather than the behaviour: a change to it should be a
    // decision, not an accident.
    expect(ABSOLUTE_GATE_LUFS).toBe(-70)
  })
})

describe('gainForTargetLufs', () => {
  it('asks for the gain that would land on the target', () => {
    expect(gainForTargetLufs(-20, -14)).toBeCloseTo(Math.pow(10, 6 / 20), 6)
  })

  it('is unity when there is nothing to measure', () => {
    expect(gainForTargetLufs(null)).toBe(1)
    expect(gainForTargetLufs(-Infinity)).toBe(1)
  })

  it('defaults to the streaming convention', () => {
    expect(DEFAULT_TARGET_LUFS).toBe(-14)
    expect(gainForTargetLufs(-14)).toBeCloseTo(1, 6)
  })
})

describe('LufsAccumulator', () => {
  it('gives the SAME answer chunked as the batch form does whole', () => {
    // The property the render depends on: it feeds ~1 s at a time, and a
    // loudness that moved with the chunk size would be a measurement of the
    // chunk size.
    const s = concat(sine(2, 1000, 0.12), silence(1), sine(2, 300, 0.08))
    const whole = measureIntegratedLufs(s, s, SR).integratedLufs!
    for (const chunk of [128, 4096, 48_000, 50_001]) {
      const acc = new LufsAccumulator(SR)
      for (let at = 0; at < s.length; at += chunk) {
        const part = s.subarray(at, Math.min(s.length, at + chunk))
        acc.add(part, part)
      }
      const got = acc.finish().integratedLufs!
      expect(Math.abs(got - whole)).toBeLessThan(0.05)
    }
  })

  it('costs one number per 100 ms, not one per sample', () => {
    // O1's rule: a 30-minute take must not put 690 MB of PCM in the heap. The
    // accumulator keeps a 400 ms ring and an array of block powers.
    const acc = new LufsAccumulator(SR)
    const s = sine(5, 1000, 0.1)
    acc.add(s, s)
    expect(acc.finish().blocks).toBeGreaterThan(40)
    expect(acc.finish().blocks).toBeLessThan(60)
  })

  it('refuses a sample rate its coefficients are not for', () => {
    expect(() => new LufsAccumulator(44_100)).toThrow(/48 kHz/)
  })
})
