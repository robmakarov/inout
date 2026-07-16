import { describe, expect, it } from 'vitest'
import { audioMixInternals } from './audio'
import { AUDIO_SAMPLE_RATE } from './codecs'

const { hermite, sampleAt, softLimitSample } = audioMixInternals

describe('compose audio resampling', () => {
  it('hermite is exact at endpoints and continuous mid-point', () => {
    expect(hermite(0, 1, 2, 3, 0)).toBeCloseTo(1, 10)
    expect(hermite(0, 1, 2, 3, 1)).toBeCloseTo(2, 10)
    const mid = hermite(0, 1, 2, 3, 0.5)
    expect(mid).toBeGreaterThan(1)
    expect(mid).toBeLessThan(2)
  })

  it('sampleAt on a 440 Hz sine at 44.1 kHz stays continuous under 48 kHz stepping', () => {
    const srcRate = 44_100
    const secs = 0.05
    const n = Math.floor(srcRate * secs)
    const src = new Float32Array(n)
    for (let i = 0; i < n; i++) src[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / srcRate)

    const step = srcRate / AUDIO_SAMPLE_RATE
    let pos = 0
    let prev = sampleAt(src, pos)
    let maxJump = 0
    const outN = Math.floor(secs * AUDIO_SAMPLE_RATE)
    for (let i = 1; i < outN; i++) {
      pos += step
      if (pos >= n - 1) break
      const s = sampleAt(src, pos)
      maxJump = Math.max(maxJump, Math.abs(s - prev))
      prev = s
    }
    // 440 Hz @ 0.6 amp → natural max Δ ≈ 0.6 * 2π * 440 / 48000 ≈ 0.035
    expect(maxJump).toBeLessThan(0.1)
  })

  it('softLimitSample is transparent below the knee and soft above it', () => {
    // Normal program passes untouched — shaping it was the music-distortion bug.
    expect(softLimitSample(0)).toBe(0)
    expect(softLimitSample(0.5)).toBe(0.5)
    expect(softLimitSample(-0.9)).toBe(-0.9)
    // Overs fold into the remaining headroom, never exceeding ±1.
    expect(softLimitSample(1)).toBeGreaterThan(0.95)
    expect(softLimitSample(1)).toBeLessThan(1)
    expect(Math.abs(softLimitSample(2))).toBeLessThanOrEqual(1)
    expect(Math.abs(softLimitSample(-2))).toBeLessThanOrEqual(1)
    // C1 at the knee: no slope discontinuity a listener could hear as a click.
    const eps = 1e-6
    const below = (softLimitSample(0.95) - softLimitSample(0.95 - eps)) / eps
    const above = (softLimitSample(0.95 + eps) - softLimitSample(0.95)) / eps
    expect(above).toBeCloseTo(below, 3)
  })
})

describe('mix chunk seam indices', () => {
  it('floor/ceil indexing shares no skipped frame across 1 s chunks', () => {
    const sr = AUDIO_SAMPLE_RATE
    // Chunk 0 covers [0, 1), chunk 1 covers [1, 2)
    const kEnd0 = Math.ceil((1 - 0) * sr - 1e-9) // 48000
    const kStart1 = Math.floor((1 - 1) * sr + 1e-9) // 0 within chunk 1
    // Global frame after chunk 0 = kEnd0; first global frame of chunk 1 = sr + kStart1
    expect(kEnd0).toBe(sr)
    expect(sr + kStart1).toBe(sr)
    // Adjacent samples are global sr-1 and sr — no gap, no dup.
  })
})
