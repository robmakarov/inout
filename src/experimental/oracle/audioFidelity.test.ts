import { describe, expect, it } from 'vitest'
import {
  analyzeStereoBuffers,
  applyLegacyLimiter,
  applyLegacyTanhBus,
  applyMonoDownmix,
  findOnsetSec,
  synthesizeFidelityStereo,
} from './audioFidelity'

const SR = 48_000

describe('audioFidelity metric', () => {
  it('is green on clean stereo multitone (current main)', () => {
    const { left, right } = synthesizeFidelityStereo(SR, 2)
    const r = analyzeStereoBuffers(left, right, SR)
    expect(r.maxToneErrorDb).toBeLessThanOrEqual(1)
    expect(r.separationDb).toBeGreaterThanOrEqual(40)
    expect(r.limiterHits).toBe(0)
    expect(r.pass).toBe(true)
  })

  it('detects legacy tanh bus as red (tone error)', () => {
    const { left, right } = synthesizeFidelityStereo(SR, 2)
    const r = analyzeStereoBuffers(applyLegacyTanhBus(left), applyLegacyTanhBus(right), SR)
    expect(r.maxToneErrorDb).toBeGreaterThan(1)
    expect(r.tonePass).toBe(false)
    expect(r.pass).toBe(false)
  })

  it('detects mono downmix as red (separation)', () => {
    const { left, right } = synthesizeFidelityStereo(SR, 2)
    const mono = applyMonoDownmix(left, right)
    const r = analyzeStereoBuffers(mono.left, mono.right, SR)
    expect(r.separationDb).toBeLessThan(40)
    expect(r.separationPass).toBe(false)
    expect(r.pass).toBe(false)
  })

  // A mix bus is a flat gain, and the fidelity oracle's delivered-file lanes
  // gate on the RESIDUAL past it (scripts/oracle-fidelity.mjs): raw tone error
  // on a multi-source take is dominated by a documented design choice, and a
  // gate on it would gate the design. These pin both halves of that arithmetic
  // — what each bus reads, and that the residual past it is ~0.
  it.each([
    ['the composite live mix (shared 0.7)', 0.7, 3.098],
    ['the render/instant mix at N=2 (1/N)', 0.5, 6.021],
  ])('reads %s as a flat level shift, residual ~0', (_label, busGain, expectedDb) => {
    const { left, right } = synthesizeFidelityStereo(SR, 2)
    const bus = (x: Float32Array): Float32Array => x.map((s) => s * busGain)
    const r = analyzeStereoBuffers(bus(left), bus(right), SR)
    expect(r.maxToneErrorDb).toBeCloseTo(expectedDb, 1)
    const residual = Math.max(
      ...r.tones.map((t) => Math.abs(t.errorDb - 20 * Math.log10(busGain))),
    )
    expect(residual).toBeLessThan(0.1)
    expect(r.separationDb).toBeGreaterThanOrEqual(40)
    expect(r.limiterHits).toBe(0)
  })

  // The window has to find the signal: silence at the front of a file (a
  // channel that started late, a generator whose AudioContext was still
  // stalling) reads as a flat level defect on every tone at once, which is the
  // costume a mix-bus regression wears. Twice a phantom 0.5 dB, once a 1.3 dB
  // gate failure on green code.
  it('finds where the programme starts, and reports null on silence', () => {
    const { left, right } = synthesizeFidelityStereo(SR, 2)
    const padSec = 0.4
    const pad = Math.floor(padSec * SR)
    const delay = (x: Float32Array): Float32Array => {
      const out = new Float32Array(pad + x.length)
      out.set(x, pad)
      return out
    }
    expect(findOnsetSec(delay(left), delay(right), SR)).toBeCloseTo(padSec, 2)
    expect(findOnsetSec(left, right, SR)).toBeLessThan(0.02)
    expect(findOnsetSec(new Float32Array(SR), new Float32Array(SR), SR)).toBeNull()
  })

  it('detects −6dB/20:1 limiter as red (tone error + dynamics)', () => {
    const { left, right } = synthesizeFidelityStereo(SR, 2)
    // Heat the signal so the −6dB threshold engages (program near full scale).
    const hotL = left.map((x) => x * 1.6)
    const hotR = right.map((x) => x * 1.6)
    const r = analyzeStereoBuffers(applyLegacyLimiter(hotL), applyLegacyLimiter(hotR), SR)
    expect(r.maxToneErrorDb).toBeGreaterThan(1)
    expect(r.pass).toBe(false)
  })
})
