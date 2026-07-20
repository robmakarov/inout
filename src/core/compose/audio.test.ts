import { describe, expect, it } from 'vitest'
import { audioMixInternals } from './audio'
import { AUDIO_SAMPLE_RATE } from './codecs'

const { hermite, sampleAt, softLimitSample, mixGainForChannels, makeupGainForPeak } =
  audioMixInternals

describe('loudness rescue (quiet Safari-mic / -6dB multi-source fix)', () => {
  it('boosts a faint capture toward the target, without clipping', () => {
    const peak = 0.05 // near-silent Safari mic
    const g = makeupGainForPeak(peak)
    expect(g).toBeGreaterThan(1)
    expect(peak * g).toBeLessThanOrEqual(0.45 + 1e-9) // lands at/below target
    expect(peak * g).toBeLessThan(0.95) // never into the limiter knee
  })

  it('leaves a healthy mix at unity — the fidelity oracle must not move', () => {
    // Fidelity rig tones sum to ~0.6 peak; that must pass through untouched.
    expect(makeupGainForPeak(0.6)).toBe(1)
    expect(makeupGainForPeak(0.45)).toBe(1)
    expect(makeupGainForPeak(0.9)).toBe(1)
  })

  it('caps makeup so near-silence (and its noise) is not blown up unbounded', () => {
    expect(makeupGainForPeak(1e-6)).toBe(1) // treated as silence → no gain
    expect(makeupGainForPeak(0.0001)).toBeLessThanOrEqual(12)
  })
})

describe('render mix-bus headroom (pervasive-noise fix 2026-07-16)', () => {
  // Reproduces the exact export sum: N sources summed with the bus gain, then
  // softLimitSample. Two loud sources (mic + system audio) at unity clip into
  // the limiter across the whole signal — that was the "noise in all sound".
  function summedPeakAndLimiterHits(sources: Float32Array[], gain: number) {
    const n = sources[0]!.length
    let peak = 0
    let limiterHits = 0
    for (let k = 0; k < n; k++) {
      let s = 0
      for (const src of sources) s += src[k]! * gain
      if (Math.abs(s) > 0.95) limiterHits++
      const out = softLimitSample(s)
      peak = Math.max(peak, Math.abs(out))
    }
    return { peak, limiterHits }
  }

  // Two decorrelated full-scale tones = worst realistic mic+music overlap.
  const N = 48_000
  const a = new Float32Array(N)
  const b = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    a[i] = 0.9 * Math.sin((2 * Math.PI * 440 * i) / 48_000)
    b[i] = 0.9 * Math.sin((2 * Math.PI * 587 * i) / 48_000)
  }

  it('single source is untouched — unity gain, never limited', () => {
    expect(mixGainForChannels(1)).toBe(1)
    const { limiterHits } = summedPeakAndLimiterHits([a], mixGainForChannels(1))
    expect(limiterHits).toBe(0)
  })

  it('unity-summing two loud sources hammers the limiter (the bug)', () => {
    const { limiterHits } = summedPeakAndLimiterHits([a, b], 1)
    expect(limiterHits).toBeGreaterThan(N / 10) // pervasive, not occasional
  })

  it('1/N headroom eliminates limiting entirely for two full-scale sources', () => {
    const g = mixGainForChannels(2)
    expect(g).toBe(0.5)
    const { peak, limiterHits } = summedPeakAndLimiterHits([a, b], g)
    // Hard guarantee: worst-case in-phase sum stays under the knee. Zero
    // limiter engagement = zero pervasive distortion.
    expect(limiterHits).toBe(0)
    expect(peak).toBeLessThan(0.95)
  })
})

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
