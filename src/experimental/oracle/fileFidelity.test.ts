import { describe, expect, it } from 'vitest'
import { synthesizeFidelityStereo } from './audioFidelity'
import { analyzeDecodedAudio, injectFileDefects } from './fileFidelity'

const SR = 48_000

describe('fileFidelity', () => {
  it('is green on clean multitone', () => {
    const { left, right } = synthesizeFidelityStereo(SR, 2)
    const r = analyzeDecodedAudio(left, right, SR, 2)
    expect(r.clickCount).toBe(0)
    expect(r.spliceCount).toBe(0)
    expect(r.pass).toBe(true)
  })

  it('detects injected splice + spur (red gate)', () => {
    const n = SR * 2
    const left = new Float32Array(n)
    const right = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const s = 0.25 * Math.sin((2 * Math.PI * 440 * i) / SR)
      left[i] = s
      right[i] = s
    }
    injectFileDefects(left, right, SR, { spliceAtSec: 0.5, spurHz: 3100, spurAmp: 0.2 })
    const r = analyzeDecodedAudio(left, right, SR, 2)
    expect(r.clickCount + r.spliceCount).toBeGreaterThan(0)
    expect(r.spurPeakDb).not.toBeNull()
    expect(r.spurPeakDb!).toBeGreaterThan(-40)
    expect(r.pass).toBe(false)
  })
})
