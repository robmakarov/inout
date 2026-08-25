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

  /**
   * GATE-alias (2026-08-25). Every event in this rig is a beep and a flash on
   * the SAME uniform 1 s grid, so a wrong alignment is a self-consistent story
   * about the same file rather than a noisy one — and the old estimator, which
   * kept whichever alignment produced the MOST pairs, would take it. Three cold
   * oracle runs in fifteen came back at −453, −465 and −909 ms with every pair
   * agreeing to the decimal (maxAbs == |mean| exactly, the signature of a
   * constant shift). These are that failure written down.
   */
  describe('grid aliasing', () => {
    it('keeps the true offset when a doubled detector tempts a shifted alignment', () => {
      // Each beep detected twice: the real onset at +50 ms and an echo ~600 ms
      // later that reads as −400 against the NEXT flash. The shifted story is
      // consistent across three events; the true one across four.
      const flashes = [1.0, 2.0, 3.0, 4.0]
      const audio = [1.05, 1.6, 2.05, 2.6, 3.05, 3.6, 4.05]
      const s = flashSyncStats(audio, flashes)!
      expect(Math.abs(s.meanOffsetMs - 50)).toBeLessThan(5)
    })

    it('breaks a tie toward the smaller offset, not toward the first alignment', () => {
      // One real onset (+50) and one echo (−400 against the next flash): equal
      // support. The band under test is ±90 ms and the grid is 1000, so the
      // in-band hypothesis is the one that needs less evidence.
      const flashes = [1.0, 2.0]
      const audio = [1.05, 1.6]
      const s = flashSyncStats(audio, flashes)!
      expect(Math.abs(s.meanOffsetMs - 50)).toBeLessThan(5)
    })

    it('never invents a pair beyond half the grid period', () => {
      const flashes = [1.0, 2.0, 3.0]
      const audio = [1.7, 2.7, 3.7] // +700 is unrepresentable; −300 is the only reading
      const s = flashSyncStats(audio, flashes)!
      expect(s.meanOffsetMs).toBeLessThanOrEqual(0)
      expect(Math.abs(s.meanOffsetMs)).toBeLessThanOrEqual(500)
    })

    /**
     * THE RUN THAT FAILED THE GATE, REPRODUCED FROM ITS OWN DUMP.
     *
     * Cold run, 2026-08-25: the AudioContext startup stall was 537 ms (beep
     * arrivals 1537/2537/3537/4537/5537 against a nominal k·1000 grid, residual
     * 537 on every one) while the flash side stalled 20 ms. The audio in that
     * export therefore genuinely sat +562 ms behind the flashes — and a pairing
     * window centred on ZERO cannot represent +562, so it reported the
     * complement against the next flash, −438.7, and the gate failed the run.
     *
     * Told where to look, the same numbers give the right answer, and the
     * correction (537 − 20 = 517) then lands it inside the band at ~+45 ms.
     */
    it('finds the offset a 537 ms stall really produced, given the expectation', () => {
      const flashes = [0.833, 1.833, 2.833, 3.833, 4.833]
      const audio = [1.395, 2.395, 3.395, 4.395, 5.395]

      // What the gate saw. The run's own figure was −438.7; these onsets are
      // its dump rounded to the millisecond, so this reads −438.
      const blind = flashSyncStats(audio, flashes)!
      expect(blind.meanOffsetMs).toBeCloseTo(-438, 0)

      const told = flashSyncStats(audio, flashes, 517)!
      expect(told.meanOffsetMs).toBeCloseTo(562, 0)
      expect(told.matchedPairs).toBe(5)
      // And that is in band once the reference skew is removed.
      expect(Math.abs(told.meanOffsetMs - 517)).toBeLessThan(90)
    })

    it('reports a genuine constant shift rather than hiding it', () => {
      // The estimator must not be so eager to find zero that it masks a real
      // defect: an export whose audio really is 300 ms early still reads −300.
      const flashes = [1.0, 2.0, 3.0, 4.0]
      const audio = [0.7, 1.7, 2.7, 3.7]
      const s = flashSyncStats(audio, flashes)!
      expect(Math.abs(s.meanOffsetMs + 300)).toBeLessThan(5)
      expect(s.matchedPairs).toBeGreaterThanOrEqual(3)
    })
  })
})
