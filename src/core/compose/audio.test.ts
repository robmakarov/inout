import { describe, expect, it } from 'vitest'
import {
  audioMixInternals,
  interpolatorFor,
  makeSincInterpolator,
  measureMixLoudness,
  LIMIT_USABLE_MAX,
  NORMALIZE_PEAK_OVERDRIVE,
  NORMALIZE_PEAK_OVERDRIVE_RAW,
  type MixSource,
} from './audio'
import { AUDIO_SAMPLE_RATE } from './codecs'

const { hermite, sampleAt, softLimitSample, mixGainForChannels, makeupGainForLoudness } =
  audioMixInternals

describe('speech-loudness normalization (replaces peak rescue a real take defeated)', () => {
  it("Robert's real take: voice at −24.7 dB under a 0.77 transient peak gets boosted to target", () => {
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
    // No peakRobust here, so this is the LEGACY licence by construction.
    const g = makeupGainForLoudness({ loudRms: 0.03, peak: 0.9 })
    expect(g * 0.9).toBeLessThanOrEqual(NORMALIZE_PEAK_OVERDRIVE_RAW * 0.95 + 1e-9)
    // Whatever the bound is, it must stay inside the limiter's working range —
    // that is the invariant whose violation was audible as crackle.
    expect(NORMALIZE_PEAK_OVERDRIVE * 0.95).toBeLessThan(LIMIT_USABLE_MAX)
    expect(NORMALIZE_PEAK_OVERDRIVE_RAW * 0.95).toBeLessThan(LIMIT_USABLE_MAX)
  })

  it('ONE TRANSIENT NO LONGER OWNS THE TAKE — the defect the overdrive raise was papering over', () => {
    // Robert's 2026-08-23 take, back-solved: p90 window RMS 0.0868, one sharp
    // transient at peak 1.18, but the take's SUSTAINED ceiling (p99 of window
    // peaks) only 0.42. Bounding on the raw peak capped the gain and left the
    // take 1.4 dB under target — which is why the licence was doubled instead.
    const stray = { loudRms: 0.0868, peak: 1.18, peakRobust: 0.42 }
    const g = makeupGainForLoudness(stray)
    // The target is reached: the stray sample does not hold the take quiet.
    expect(g * stray.loudRms).toBeGreaterThan(0.124)
    // …and it is reached WITHOUT the extra crushing that bought it before.
    // At overdrive 4 on the raw peak this take was licensed to 3.8; the
    // sustained programme now lands barely over the knee instead.
    expect(g * stray.peakRobust).toBeLessThanOrEqual(NORMALIZE_PEAK_OVERDRIVE * 0.95 + 1e-9)
    expect(g * stray.peakRobust).toBeLessThan(2.0)
  })

  it('a take recorded before the statistic existed keeps the behaviour it was made under', () => {
    // No peakRobust ⇒ fall back to peak. Same inputs, same answer as always.
    const old = makeupGainForLoudness({ loudRms: 0.03, peak: 0.9 })
    expect(old * 0.9).toBeLessThanOrEqual(NORMALIZE_PEAK_OVERDRIVE_RAW * 0.95 + 1e-9)
    // …and identically to what it returned before the statistic was added.
    expect(old).toBeCloseTo(Math.min(8, 0.125 / 0.03, (NORMALIZE_PEAK_OVERDRIVE_RAW * 0.95) / 0.9), 9)
  })

  it('the robust ceiling still binds when the programme itself is loud', () => {
    // Sustained loud music: p99 window peak is genuinely high, so the bound
    // must still hold. Robustness must not become "ignore the ceiling".
    const loud = { loudRms: 0.03, peak: 0.95, peakRobust: 0.9 }
    expect(makeupGainForLoudness(loud) * loud.peakRobust).toBeLessThanOrEqual(
      NORMALIZE_PEAK_OVERDRIVE * 0.95 + 1e-9,
    )
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
 * Robert 2026-08-23: "at some point tab audio broke and became just lag sounds".
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
    expect(NORMALIZE_PEAK_OVERDRIVE_RAW * 0.95).toBeLessThan(LIMIT_USABLE_MAX)
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

  it("Robert's 2026-08-23 take reaches the loudness target instead of being held short by one click", () => {
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
    // The shape of Robert's take: speech near −37 dBFS, isolated clicks far above
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

describe('the probe pass carries the robust ceiling (X1 found it dropping it)', () => {
  /** One MixSource over a synthetic signal — the mixer contract, nothing else. */
  const sourceOf = (amp: (t: number) => number): MixSource => ({
    gain: 1,
    channelIds: ['a'],
    channelId: 'a',
    async mixInto(left, right, startSec) {
      for (let i = 0; i < left.length; i++) {
        const v = amp(startSec + i / AUDIO_SAMPLE_RATE) * this.gain
        left[i]! += v
        right[i]! += v
      }
    },
    dispose() {},
  })

  it('measureMixLoudness returns peakRobust, so the render bounds on it and not on one sample', async () => {
    // Sustained programme at 0.2 with a single full-scale spike — the exact
    // shape that made one transient define a take's headroom.
    const spikeAt = 1.5
    const amp = (t: number): number =>
      Math.abs(t - spikeAt) < 1 / AUDIO_SAMPLE_RATE ? 0.95 : 0.2 * Math.sin(2 * Math.PI * 220 * t)
    // 20 s = 200 windows, so p99 can actually exclude the one window the spike
    // lands in; at 3 s it is 30 windows and p99 IS the maximum.
    const frames = AUDIO_SAMPLE_RATE * 20
    const loud = await measureMixLoudness([sourceOf(amp)], 1, frames, () => {})
    expect(loud.peak).toBeGreaterThan(0.9)
    expect(loud.peakRobust).toBeDefined()
    // The spike owns `peak` and must NOT own the ceiling the gain bounds on.
    expect(loud.peakRobust!).toBeLessThan(0.25)
    // …and that is the whole point: the tight licence now applies.
    const g = makeupGainForLoudness(loud)
    expect(g * loud.peakRobust!).toBeLessThanOrEqual(NORMALIZE_PEAK_OVERDRIVE * 0.95 + 1e-9)
  })
})

/**
 * B13(3) — THE EXPORT RESAMPLER.
 *
 * Robert, on a 124.8-minute take: "some small noises in tab audio". Measured to
 * the 4-point Hermite interpolator the mix uses whenever a channel is not
 * already 48 kHz: its error rises 12 dB per octave and reaches -10.6 dB at
 * 16 kHz. These pin the replacement's two properties and, more importantly, the
 * one thing that must not move: a take that never resamples is untouched.
 */
describe('B13 band-limited resampling', () => {
  const errDb = (at: (c: Float32Array, p: number) => number, f: number, inRate = 44100, outRate = 48000) => {
    const n = inRate
    const src = new Float32Array(n)
    for (let i = 0; i < n; i++) src[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / inRate)
    const outN = Math.floor((n * outRate) / inRate) - 40
    let sig = 0
    let err = 0
    for (let i = 40; i < outN; i++) {
      const got = at(src, (i * inRate) / outRate)
      const ideal = 0.5 * Math.sin((2 * Math.PI * f * i) / outRate)
      sig += ideal * ideal
      err += (got - ideal) * (got - ideal)
    }
    return 10 * Math.log10(err / sig)
  }

  it('reconstructs the top octaves the shipped interpolator cannot', () => {
    const sinc = makeSincInterpolator(44100, 48000)
    // The number that matters: at 16 kHz the shipped path leaves a companion
    // 11 dB down. This one must be far below anything audible under program.
    expect(errDb(sinc, 16000)).toBeLessThan(-70)
    expect(errDb(sinc, 8000)).toBeLessThan(-70)
    // And it must not have traded the bottom away to get it.
    expect(errDb(sinc, 100)).toBeLessThan(-70)
    expect(errDb(sinc, 1000)).toBeLessThan(-70)
  })

  it('is a large improvement exactly where the defect is, and no worse anywhere', () => {
    const sinc = makeSincInterpolator(44100, 48000)
    // Equal rates always return the OLD interpolator, so this is the honest
    // handle on it without reaching past the module's exports.
    const hermite = interpolatorFor(48000, 48000)
    expect(errDb(sinc, 16000)).toBeLessThan(errDb(hermite, 16000) - 50)
    expect(errDb(sinc, 8000)).toBeLessThan(errDb(hermite, 8000) - 20)
  })

  it('leaves a 48 kHz channel bit-identical — the path the flag must never touch', () => {
    // Equal rates return the shipped interpolator whatever the flag says, and
    // at integer positions that is the sample itself. A take with nothing to
    // resample cannot change by one byte when the flag flips.
    const same = interpolatorFor(48000, 48000)
    const src = new Float32Array(256)
    for (let i = 0; i < src.length; i++) src[i] = Math.sin(i / 3) * 0.7
    for (let i = 4; i < 200; i++) expect(same(src, i)).toBe(src[i])
  })

  /**
   * THE DEFAULT IS THE FIX. It shipped off for about an hour and Robert said
   * the obvious thing — a defect fix that is disabled has fixed nothing. The
   * old interpolator is what carries the switch now, so it can be put back for
   * an A/B; this pins which way round that is.
   */
  it('resamples properly BY DEFAULT — the old maths is what needs the switch', () => {
    const hermite = interpolatorFor(48000, 48000)
    expect(interpolatorFor(44100, 48000)).not.toBe(hermite)
    expect(errDb(interpolatorFor(44100, 48000), 16000)).toBeLessThan(-70)
  })
})
