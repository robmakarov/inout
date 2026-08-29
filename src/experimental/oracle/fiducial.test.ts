import { describe, expect, it } from 'vitest'
import {
  decodeBits,
  encodeBits,
  feedOnsetDetector,
  FID_BITS,
  fitClock,
  frameFlowStats,
  newOnsetDetector,
  parity,
  syncStats,
  type BlockReader,
  type FrameReading,
} from './fiducial'

/** Simulated block reader from encoded bits, with optional noise/degradation. */
function readerFor(ms: number, opts?: { noise?: number; flipBit?: number; washout?: boolean }): BlockReader {
  const bits = encodeBits(ms)
  return {
    luma(i: number): number {
      const noise = opts?.noise ?? 0
      const jitter = (Math.sin(i * 999.7) * 0.5 + 0.5) * noise * 2 - noise
      if (i === 0) return (opts?.washout ? 140 : 235) + jitter // white ref
      if (i === 1) return (opts?.washout ? 110 : 16) + jitter // black ref
      let bit = bits[i - 2]
      if (opts?.flipBit === i - 2) bit = 1 - bit
      return (bit ? 220 : 30) + jitter
    },
  }
}

describe('oracle barcode', () => {
  it('roundtrips timestamps exactly', () => {
    for (const ms of [0, 1, 33, 1000, 123456, 2 ** FID_BITS - 1]) {
      expect(decodeBits(readerFor(ms))).toBe(ms)
    }
  })

  it('tolerates realistic encoder noise', () => {
    for (const ms of [16, 700, 999999]) {
      expect(decodeBits(readerFor(ms, { noise: 40 }))).toBe(ms)
    }
  })

  it('rejects single-bit corruption via parity', () => {
    expect(decodeBits(readerFor(123456, { flipBit: 5 }))).toBeNull()
  })

  it('rejects washed-out strips instead of guessing', () => {
    expect(decodeBits(readerFor(123456, { washout: true }))).toBeNull()
  })

  it('parity is the xor of bits', () => {
    expect(parity(0)).toBe(0)
    expect(parity(1)).toBe(1)
    expect(parity(0b1011)).toBe(1)
    expect(parity(0b1111)).toBe(0)
  })
})

describe('oracle clock fit', () => {
  it('recovers a perfect 1:1 clock', () => {
    const readings: FrameReading[] = []
    for (let f = 0; f < 90; f++) {
      readings.push({ outSec: f / 30, rigMs: 500 + (f / 30) * 1000 })
    }
    const fit = fitClock(readings)!
    expect(fit.beta).toBeCloseTo(1, 9)
    expect(fit.alphaMs).toBeCloseTo(500, 6)
    expect(fit.rmsMs).toBeCloseTo(0, 6)
  })

  it('detects drift (beta != 1) and reports residuals with jitter', () => {
    const readings: FrameReading[] = []
    for (let f = 0; f < 300; f++) {
      const outSec = f / 30
      const jitter = ((f * 7919) % 13) - 6 // deterministic pseudo-noise ±6ms
      readings.push({ outSec, rigMs: 100 + outSec * 1000 * 1.002 + jitter, ...(f % 17 === 0 ? { rigMs: null } : {}) })
    }
    const fit = fitClock(readings)!
    expect(fit.beta).toBeCloseTo(1.002, 3)
    expect(fit.rmsMs).toBeGreaterThan(0)
    expect(fit.rmsMs).toBeLessThan(10)
    expect(fit.usedPoints).toBeLessThan(300)
  })

  it('rejects gross outliers without letting them drag alpha (review item 3)', () => {
    const readings: FrameReading[] = []
    for (let f = 0; f < 120; f++) {
      const outSec = f / 30
      // Perfect 1:1 clock with alpha 400…
      let rigMs = 400 + outSec * 1000
      // …except four wild misdecodes (bit-flip scale errors).
      if (f === 10 || f === 40 || f === 41 || f === 90) rigMs += 8_000_000
      readings.push({ outSec, rigMs })
    }
    const fit = fitClock(readings)!
    expect(fit.rejectedPoints).toBe(4)
    expect(fit.alphaMs).toBeCloseTo(400, 3)
    expect(fit.beta).toBeCloseTo(1, 6)
    expect(fit.maxAbsMs).toBeLessThan(12)
  })

  it('counts duplicates and gaps in frame flow', () => {
    // 30ms cadence with one stall (dup) and one 100ms gap.
    const rig = [0, 33, 33, 66, 99, 199, 233]
    const readings: FrameReading[] = rig.map((r, i) => ({ outSec: i / 30, rigMs: r }))
    const stats = frameFlowStats(readings)
    expect(stats.duplicates).toBe(1)
    expect(stats.gaps).toBe(1)
    expect(stats.readable).toBe(7)
  })
})

describe('oracle audio onsets + sync', () => {
  function toneBurstSignal(sampleRate: number, durSec: number, beepStartsSec: number[]): Float32Array {
    const out = new Float32Array(Math.round(durSec * sampleRate))
    for (const t0 of beepStartsSec) {
      const s0 = Math.round(t0 * sampleRate)
      const s1 = Math.min(out.length, s0 + Math.round(0.05 * sampleRate))
      for (let s = s0; s < s1; s++) {
        out[s] = 0.6 * Math.sin((2 * Math.PI * 880 * (s - s0)) / sampleRate)
      }
    }
    return out
  }

  it('detects burst onsets across chunk boundaries within ~3ms', () => {
    const sr = 48_000
    const sig = toneBurstSignal(sr, 3, [0.5, 1.5, 2.5])
    const st = newOnsetDetector()
    // Feed in uneven chunks to exercise boundary handling.
    let pos = 0
    for (const len of [10_000, 50_000, 30_000, sig.length]) {
      const end = Math.min(sig.length, pos + len)
      feedOnsetDetector(st, sig.subarray(pos, end), pos / sr, sr)
      pos = end
      if (pos >= sig.length) break
    }
    expect(st.onsetsSec).toHaveLength(3)
    expect(Math.abs(st.onsetsSec[0] - 0.5)).toBeLessThan(0.003)
    expect(Math.abs(st.onsetsSec[1] - 1.5)).toBeLessThan(0.003)
    expect(Math.abs(st.onsetsSec[2] - 2.5)).toBeLessThan(0.003)
  })

  it('measures A/V offset against the video clock (positive = audio late)', () => {
    // Video clock: rig = 200 + out*1000 (alpha 200ms). Beeps every 1000ms rig.
    const fit = { alphaMs: 200, beta: 1, rmsMs: 0, maxAbsMs: 0, usedPoints: 100, rejectedPoints: 0 }
    // Beep at rig 1000 should appear at out (1000-200)/1 = 800ms; simulate
    // audio arriving 25ms late.
    const onsets = [0.825, 1.825, 2.825]
    const s = syncStats(onsets, fit, 1000)
    expect(s.matched).toBe(3)
    expect(s.meanOffsetMs).toBeCloseTo(25, 6)
    expect(s.maxAbsOffsetMs).toBeCloseTo(25, 6)
    expect(s.leads).toBe('audio-late/video-early')
  })

  it('labels the sign convention symmetrically (audio early => video late)', () => {
    const fit = { alphaMs: 0, beta: 1, rmsMs: 0, maxAbsMs: 0, usedPoints: 100, rejectedPoints: 0 }
    const early = syncStats([0.95, 1.95], fit, 1000)
    expect(early.meanOffsetMs).toBeCloseTo(-50, 6)
    expect(early.leads).toBe('audio-early/video-late')
    const tight = syncStats([1.001, 2.001], fit, 1000)
    expect(tight.leads).toBe('in-sync')
  })
})
