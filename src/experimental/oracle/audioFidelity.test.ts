import { describe, expect, it } from 'vitest'
import {
  analyzeStereoBuffers,
  applyLegacyLimiter,
  applyLegacyTanhBus,
  applyMonoDownmix,
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
