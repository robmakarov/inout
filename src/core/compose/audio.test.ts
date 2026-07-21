import { describe, expect, it } from 'vitest'
import { audioMixInternals } from './audio'
import { AUDIO_SAMPLE_RATE } from './codecs'

const { hermite, sampleAt, softLimitSample, mixGainForChannels, makeupGainForLoudness } =
  audioMixInternals

describe('speech-loudness normalization (replaces peak rescue a real take defeated)', () => {
  it("PO's real take: voice at −24.7 dB under a 0.77 transient peak gets boosted to target", () => {
    // Measured from inout-20260716-101732.mp4: p90 window RMS 0.058, peak 0.7725
    // (one 3-sample mic bump). Peak-targeting returned 1 here — inaudible voice
    // shipped. Loudness targeting must boost ~2× and land near −18 dB RMS.
    const g = makeupGainForLoudness({ loudRms: 0.058, peak: 0.7725 })
    expect(g).toBeGreaterThan(1.8)
    expect(g * 0.058).toBeGreaterThan(0.1) // voice reaches ~target
    expect(g * 0.058).toBeLessThanOrEqual(0.125 + 1e-9)
  })

  it('healthy speech at target stays at unity — the fidelity oracle must not move', () => {
    expect(makeupGainForLoudness({ loudRms: 0.125, peak: 0.6 })).toBe(1)
    expect(makeupGainForLoudness({ loudRms: 0.3, peak: 0.7 })).toBe(1) // hot mix: never duck
  })

  it('noise-only takes are gated, never blown up', () => {
    // Room tone at −55 dB with no program: boosting it 8× would ship pure hiss.
    expect(makeupGainForLoudness({ loudRms: 0.0018, peak: 0.01 })).toBe(1)
    expect(makeupGainForLoudness({ loudRms: 0, peak: 0 })).toBe(1)
  })

  it('peak bound stops sustained program being driven deep into the limiter', () => {
    // Loud-crest music: quiet RMS but peaks already at 0.9. Unbounded loudness
    // gain (×4) would shape most samples; the bound keeps overdrive ≤ 2× knee.
    const g = makeupGainForLoudness({ loudRms: 0.03, peak: 0.9 })
    expect(g * 0.9).toBeLessThanOrEqual(2 * 0.95 + 1e-9)
  })

  it('boost is capped for heavily-AGCd-but-real signals', () => {
    expect(makeupGainForLoudness({ loudRms: 0.004, peak: 0.02 })).toBeLessThanOrEqual(8)
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
