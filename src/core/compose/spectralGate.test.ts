import { describe, expect, it } from 'vitest'
import { GATE_DEFAULTS, fft, gate, hannWindow, noiseProfile } from './spectralGate'

/**
 * O10c's claims, each pinned by the measurement it is a claim about. The order
 * matters: a gate built on a transform that does not reconstruct is measuring
 * its own reconstruction error and calling it noise removal, so the identity
 * comes first and everything else stands on it.
 */

/** Deterministic pseudo-noise: the tests must not move run to run. */
function noise(n: number, amp: number, seed = 1): Float32Array {
  const out = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = ((s / 0xffffffff) * 2 - 1) * amp
  }
  return out
}

function tone(n: number, hz: number, amp: number, rate = 48000): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate) * amp
  return out
}

function add(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i]! + (b[i] ?? 0)
  return out
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0
  for (let i = from; i < to; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / Math.max(1, to - from))
}

const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, x))

describe('the transform underneath (O10c)', () => {
  it('round-trips a signal exactly — forward then inverse is the identity', () => {
    const n = 256
    const re = Float32Array.from(tone(n, 1000, 0.5))
    const im = new Float32Array(n)
    const original = Float32Array.from(re)
    fft(re, im, -1)
    fft(re, im, 1)
    for (let i = 0; i < n; i++) expect(re[i]! / n).toBeCloseTo(original[i]!, 5)
  })

  it('a Hann window at 75 % overlap sums to a constant — the COLA the gate stands on', () => {
    const n = 1024
    const hop = n / 4
    const w = hannWindow(n)
    const acc = new Float32Array(n * 4)
    for (let start = 0; start + n <= acc.length; start += hop) {
      for (let i = 0; i < n; i++) acc[start + i] = acc[start + i]! + w[i]! * w[i]!
    }
    // The interior, away from the ramp-up and ramp-down.
    for (let i = n; i < acc.length - n; i++) expect(acc[i]!).toBeCloseTo(1.5, 4)
  })
})

describe('the gate leaves a clean signal alone', () => {
  /**
   * THE GATE THE SPEC ASKS FOR IN SO MANY WORDS: zero triggers on clean
   * speech. Speech here is a sum of tones at speech frequencies with an
   * amplitude envelope — the shape that matters is that it is loud and varying,
   * with no steady broadband bed underneath.
   */
  function speechLike(n: number, breathy: boolean): Float32Array {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / 48000
      // A moving fundamental with harmonics, syllable-rate envelope.
      const f0 = 120 + 30 * Math.sin(2 * Math.PI * 2.5 * t)
      const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.5 * t)
      let v = 0
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h
      out[i] = v * env * 0.25
    }
    if (breathy) {
      // Breath is broadband and QUIET and rides with the speech, which is the
      // case a naive gate eats. It is added at the same syllable envelope so
      // it is never a steady bed the profile could learn.
      const b = noise(n, 0.03, 7)
      for (let i = 0; i < n; i++) {
        const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * 3.5 * i) / 48000)
        out[i] = out[i]! + b[i]! * env
      }
    }
    return out
  }

  it('does not trigger on clean speech', () => {
    const s = speechLike(48000, false)
    const profile = noiseProfile(s)
    const r = gate(s, profile, GATE_DEFAULTS)
    expect(r.triggers).toBe(0)
  })

  it('does not trigger on BREATHY speech either — the case a naive gate eats', () => {
    const s = speechLike(48000, true)
    const profile = noiseProfile(s)
    const r = gate(s, profile, GATE_DEFAULTS)
    expect(r.triggers).toBe(0)
  })

  it('a signal it does not gate comes back essentially unchanged', () => {
    const s = speechLike(24000, false)
    const profile = noiseProfile(s)
    const r = gate(s, profile, GATE_DEFAULTS)
    // Interior only: the first and last frame are the overlap-add ramp.
    const err = new Float32Array(s.length)
    for (let i = 0; i < s.length; i++) err[i] = r.out[i]! - s[i]!
    const errDb = db(rms(err, 2048, s.length - 2048))
    // Measured at -159 dB against a -16.7 dB signal: with nothing gated this is
    // the transform's own arithmetic and nothing else. 100 dB down is a band
    // that would catch a real regression and never a rounding difference.
    expect(r.triggers).toBe(0)
    expect(errDb).toBeLessThan(db(rms(s, 2048, s.length - 2048)) - 100)
  })
})

describe('the gate removes what it exists to remove', () => {
  /**
   * A KNOWN-NOISE RIG, as the spec asks: a tone burst with silence either side,
   * and a steady broadband bed underneath the whole thing. The number that
   * matters is the noise in the SILENCE, because that is the "small noise"
   * between sounds that a listener notices.
   */
  it('measures a real SNR gain on a steady noise bed', () => {
    const n = 48000 * 2
    const bed = noise(n, 0.02, 3)
    const speech = new Float32Array(n)
    // Two bursts, so the quiet stretches are a fifth of the signal or more and
    // the profile has something honest to learn from.
    for (const [from, to] of [
      [12000, 36000],
      [60000, 84000],
    ]) {
      const t = tone(to - from, 440, 0.3)
      for (let i = 0; i < t.length; i++) speech[from + i] = t[i]!
    }
    const dirty = add(speech, bed)
    const quietFrom = 40000
    const quietTo = 56000
    const before = db(rms(dirty, quietFrom, quietTo))

    // THE DEFAULT IS CONSERVATIVE ON PURPOSE, and this is what that costs and
    // buys: 2.0 dB out of the quiet stretch, with the burst untouched. A gate
    // that took 10 dB here would be one that takes breaths out of speech, and
    // the two tests above are the ones that would fail if it did.
    const gentle = gate(dirty, noiseProfile(dirty), GATE_DEFAULTS)
    const afterGentle = db(rms(gentle.out, quietFrom, quietTo))
    expect(before - afterGentle).toBeGreaterThan(1.5)

    // AND THE KNOB IS A KNOB: asking for more takes more, from the same
    // signal and the same profile, which is what says the number above is a
    // setting and not a ceiling.
    const firm = gate(dirty, noiseProfile(dirty), { ...GATE_DEFAULTS, overFloorDb: 18 })
    const afterFirm = db(rms(firm.out, quietFrom, quietTo))
    expect(before - afterFirm).toBeGreaterThan(before - afterGentle + 2)

    // The burst is still there in both, within a hair of where it was.
    const loudBefore = db(rms(dirty, 16000, 32000))
    for (const r of [gentle, firm]) {
      expect(Math.abs(db(rms(r.out, 16000, 32000)) - loudBefore)).toBeLessThan(1)
    }
  })

  it('never pulls a bin further down than its own floor allows', () => {
    const n = 48000
    const bed = noise(n, 0.05, 11)
    const profile = noiseProfile(bed)
    const r = gate(bed, profile, { ...GATE_DEFAULTS, maxAttenDb: 6 })
    const drop = db(rms(bed)) - db(rms(r.out))
    expect(drop).toBeGreaterThan(0)
    expect(drop).toBeLessThanOrEqual(6.5)
  })
})
