import { describe, expect, it } from 'vitest'
import { flashSyncStats } from './analyze'
import { audioFileEpochRig } from './localize'

describe('audioFileEpochRig', () => {
  it('recovers the epoch from onsets with k disambiguated by expectation', () => {
    // File t=0 corresponds to rig 940ms => beep k=1 (rig 1000) at file 0.060s.
    const onsets = [0.06, 1.06, 2.06, 3.06]
    expect(audioFileEpochRig(onsets, 950)).toBeCloseTo(940, 6)
    // Expectation off by ±300ms must not flip k (grid is 1000ms).
    expect(audioFileEpochRig(onsets, 650)).toBeCloseTo(940, 6)
    expect(audioFileEpochRig(onsets, 1250)).toBeCloseTo(940, 6)
  })

  it('is median-robust to one spurious onset', () => {
    const onsets = [0.06, 1.06, 1.37 /* spurious */, 2.06, 3.06]
    const epoch = audioFileEpochRig(onsets, 950)!
    expect(Math.abs(epoch - 940)).toBeLessThan(1)
  })

  it('returns null with no onsets', () => {
    expect(audioFileEpochRig([], 0)).toBeNull()
  })
})

describe('flashSyncStats (barcode-free cross-check)', () => {
  it('pairs onsets to nearest flash and reports audio-minus-flash', () => {
    const flashes = [1.0, 2.0, 3.0]
    const audio = [1.17, 2.17, 3.17] // audio 170ms late
    const s = flashSyncStats(audio, flashes)!
    expect(s.matchedPairs).toBe(3)
    expect(s.meanOffsetMs).toBeCloseTo(170, 6)
  })

  it('ignores unpairable onsets and handles missing flashes', () => {
    expect(flashSyncStats([1.0], [])).toBeNull()
    const s = flashSyncStats([0.9, 7.7], [1.0])!
    expect(s.matchedPairs).toBe(1)
    expect(s.meanOffsetMs).toBeCloseTo(-100, 6)
  })

  it('does not alias when the first flash is missing (off-by-one)', () => {
    // True offset +170ms; flash at 1.0 dropped. Greedy nearest maps 1.17→2.0 (−830,
    // rejected) or can poison the mean; sequential alignment keeps the rest.
    const flashes = [2.0, 3.0, 4.0]
    const audio = [1.17, 2.17, 3.17, 4.17]
    const s = flashSyncStats(audio, flashes)!
    expect(s.matchedPairs).toBeGreaterThanOrEqual(3)
    expect(Math.abs(s.meanOffsetMs - 170)).toBeLessThan(1)
  })

  it('drops a spurious onset that would pull nearest-neighbor off grid', () => {
    const flashes = [1.0, 2.0, 3.0]
    const audio = [1.17, 1.55 /* spurious */, 2.17, 3.17]
    const s = flashSyncStats(audio, flashes)!
    expect(Math.abs(s.meanOffsetMs - 170)).toBeLessThan(40)
  })
})
