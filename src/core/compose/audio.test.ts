import { describe, expect, it } from 'vitest'
import { audioMixInternals, LIMIT_USABLE_MAX, NORMALIZE_PEAK_OVERDRIVE } from './audio'
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
    // gain would shape most samples; the bound holds overdrive to the constant
    // rather than to a number written out here, so raising the constant on
    // evidence (2 → 4, 2026-08-23) does not silently rewrite what this proves.
    const g = makeupGainForLoudness({ loudRms: 0.03, peak: 0.9 })
    expect(g * 0.9).toBeLessThanOrEqual(NORMALIZE_PEAK_OVERDRIVE * 0.95 + 1e-9)
    // Whatever the bound is, it must stay inside the limiter's working range —
    // that is the invariant whose violation was audible as crackle.
    expect(NORMALIZE_PEAK_OVERDRIVE * 0.95).toBeLessThan(LIMIT_USABLE_MAX)
  })

  it('boost is capped for heavily-AGCd-but-real signals', () => {
    expect(makeupGainForLoudness({ loudRms: 0.004, peak: 0.02 })).toBeLessThanOrEqual(8)
  })

  it('noise-floor bound: a hissy take is not boosted into audible hiss', () => {
    // Faint speech (−30 dB) over a high floor (−46 dB, HFP mic hiss). Unbounded
    // rescue (×4) would lift the floor to −34 dB — "still some noises". The
    // floor bound keeps post-gain floor at ≤ −40 dBFS.
    const g = makeupGainForLoudness({ loudRms: 0.03, peak: 0.2, floorRms: 0.005 })
    expect(g * 0.005).toBeLessThanOrEqual(0.01 + 1e-9)
    expect(g).toBeGreaterThanOrEqual(1)
  })

  it('noise-floor bound: a clean-floor take still gets the full rescue', () => {
    // Same faint speech over near-digital-silence floor: full boost applies.
    const clean = makeupGainForLoudness({ loudRms: 0.03, peak: 0.2, floorRms: 0.0001 })
    const legacy = makeupGainForLoudness({ loudRms: 0.03, peak: 0.2 })
    expect(clean).toBeCloseTo(legacy, 10)
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

/**
 * PO 2026-08-23: "at some point tab audio broke and became just lag sounds".
 * Measured in the real export: 217 sample-step discontinuities from t≈12.5s,
 * peaks pinned at exactly ±1.0000 for ten straight seconds against a −28 dBFS
 * window RMS, longest full-scale run 1 sample. Not clipping and not stutter —
 * boosted transients whose tops were all mapped onto one output code by a
 * limiter that had saturated, so each one came out as a bare impulse.
 *
 * The defect was an inconsistency between two constants: the gain bound let
 * true peaks reach NORMALIZE_PEAK_OVERDRIVE × knee while the curve went
 * numerically flat far below that. These tests pin the relationship itself,
 * so neither constant can be retuned into the dead zone again.
 */
describe('limiter stays distinguishable across everything the gain bound permits', () => {
  it('the permitted peak sits inside the curve’s working range', () => {
    expect(NORMALIZE_PEAK_OVERDRIVE * 0.95).toBeLessThan(LIMIT_USABLE_MAX)
  })

  it('the top of the permitted range is not flat', () => {
    // Every limiter compresses hard near its ceiling — the defect was not
    // compression, it was going NUMERICALLY DEAD: under the old tanh every
    // input from 1.152 to the permitted 1.9 produced the identical 16-bit
    // code, so a whole family of transient peaks came out as one impulse.
    // Count distinct codes instead of policing a per-step slope.
    const codes = (lo: number, hi: number) => {
      const s = new Set<number>()
      for (let a = lo; a <= hi; a += 0.001) s.add(Math.round(softLimitSample(a) * 32768))
      return s.size
    }
    const top = NORMALIZE_PEAK_OVERDRIVE * 0.95
    // Measured at the shipped bound (4 × knee = 3.8): 495 codes across the
    // permitted range, 29 of them in its upper half. The old tanh managed 148
    // across a 1.9 range and spent every one below 1.152 — its upper half was
    // exactly ONE code, which is the crackle stated as a number.
    expect(codes(0.95, top)).toBeGreaterThan(400)
    expect(codes((0.95 + top) / 2, top)).toBeGreaterThan(20)
    // And the very top still is not full scale, or the flattening is back.
    expect(Math.round(softLimitSample(top) * 32768)).toBeLessThan(32768)
  })

  it('is monotonic and never reaches full scale', () => {
    let prev = -Infinity
    for (let a = 0.9; a <= 4; a += 0.005) {
      const y = softLimitSample(a)
      expect(y).toBeGreaterThan(prev)
      expect(y).toBeLessThan(1)
      prev = y
    }
  })

  it("PO's 2026-08-23 take reaches the loudness target instead of being held short by one click", () => {
    // Measured off the delivered export: p90 window RMS 0.1063 (1.4 dB under
    // the 0.125 target), p20 floor 0.0062 (the floor bound was NOT binding),
    // true peak pinned at 1.0. Only the peak bound could have stopped it — so
    // a single transient kept the whole take quiet. Back out the pre-makeup
    // numbers from a gain that was exactly peak-bound at the old overdrive.
    const gOld = 1.9 / 0.62 // old peakBound for this take's true peak
    const loudRms = 0.1063 / gOld
    const gNew = makeupGainForLoudness({ loudRms, peak: 0.62, floorRms: 0.0062 / gOld })
    expect(gNew).toBeGreaterThan(gOld) // the click no longer caps it
    expect(gNew * loudRms).toBeCloseTo(0.125, 3) // and it lands on target
  })

  it('a quiet take with one sharp transient keeps that transient a shape, not an impulse', () => {
    // The shape of PO's take: speech near −37 dBFS, isolated clicks far above
    // it, makeup gain bounded by the peak. Feed the boosted transient's own
    // neighbourhood through the limiter and require the waveform to survive as
    // distinct samples rather than a row of identical full-scale codes.
    const loudRms = 0.0138 // −37.2 dBFS window RMS
    const peak = 0.62
    const g = makeupGainForLoudness({ loudRms, peak })
    const transient = [0.44, 0.55, 0.62, 0.58, 0.47].map((s) => softLimitSample(s * g))
    const codes = transient.map((s) => Math.round(s * 32768))
    expect(new Set(codes).size).toBe(codes.length) // every sample distinct
    expect(Math.max(...codes)).toBeLessThan(32768) // nothing pinned to full scale
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
