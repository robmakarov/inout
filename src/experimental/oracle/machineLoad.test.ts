import { describe, expect, it } from 'vitest'
// @ts-expect-error the machine-load helpers are plain ESM in scripts/
import { dimensionOf, dimensionsOf, disagreement } from '../../../scripts/lib/machine.mjs'
// @ts-expect-error oracle gate is plain ESM in scripts/
import { gateOracleReport } from '../../../scripts/oracle-gate.mjs'

/**
 * THE PART THAT DECIDES `FAIL` FROM `INCONCLUSIVE` (task G6a-d, 2026-09-02).
 *
 * Four gates were measured flipping with machine load rather than with the
 * code: v1 export throughput (0.46-0.94x loaded against 0.51-0.82x idle), the
 * fidelity render lane, the spur gate (25 dB of movement), and the 120 s cell's
 * CDP death. The fix is a second reading and a comparison BY DIMENSION — the
 * failure strings carry measured numbers, so `spur -35.1 dB` and `spur -50.2 dB`
 * have to compare equal or every confirmation would disagree with itself.
 *
 * These cases pin that grouping against the gate's OWN wording, not against
 * copies of it: if someone rewords a failure, this test says whether the
 * confirmation logic still groups it.
 */
describe('load-flake adjudication (G6)', () => {
  it('groups a failure by its dimension, not its reading', () => {
    expect(dimensionOf('export throughput 0.71x < 1x realtime')).toBe('export throughput')
    expect(dimensionOf('export throughput 0.94x < 1x realtime')).toBe('export throughput')
    expect(dimensionOf('spur -35.1 dB > -40 dB')).toBe('spur')
    expect(dimensionOf('tone error 8.69 > 1 dB')).toBe('tone error')
    // Distinct dimensions must not collapse into one another.
    expect(
      dimensionsOf(['spur -35.1 dB > -40 dB', 'export throughput 0.71x < 1x realtime']).size,
    ).toBe(2)
  })

  it('two readings of the SAME defect agree, whatever the numbers were', () => {
    const a = ['export throughput 0.46x < 1x realtime', 'spur -35.1 dB > -40 dB']
    const b = ['export throughput 0.94x < 1x realtime', 'spur -14.9 dB > -40 dB']
    const cmp = disagreement(a, b)
    expect(cmp.disagreed).toEqual([])
    expect(cmp.agreed.sort()).toEqual(['export throughput', 'spur'])
  })

  it('a dimension red in only one reading is the coin flip, and is named', () => {
    const cmp = disagreement(
      ['export throughput 0.46x < 1x realtime', 'spur -35.1 dB > -40 dB'],
      ['export throughput 0.94x < 1x realtime'],
    )
    expect(cmp.agreed).toEqual(['export throughput'])
    expect(cmp.disagreed).toEqual(['spur'])
  })

  it('a red that vanishes entirely on the second reading is a full disagreement', () => {
    const cmp = disagreement(['spur -35.1 dB > -40 dB'], [])
    expect(cmp.agreed).toEqual([])
    expect(cmp.disagreed).toEqual(['spur'])
  })

  /**
   * The wording under test is the gate's, produced here rather than copied, so
   * this case fails if the two ever drift apart.
   */
  it('groups the strings the oracle gate actually emits', () => {
    const base = {
      full: {},
      audioIntegrity: { maxBoundaryJump: 0, spurPeakDb: -35.1 },
      exportRealtimeFactor: 0.46,
    }
    const slow = gateOracleReport(base)
    const slower = gateOracleReport({
      ...base,
      audioIntegrity: { maxBoundaryJump: 0, spurPeakDb: -14.9 },
      exportRealtimeFactor: 0.94,
    })
    const dims = dimensionsOf(slow.failures)
    expect(dims.has('export throughput')).toBe(true)
    expect(dims.has('spur')).toBe(true)
    // Same defects, different readings: nothing may disagree.
    expect(disagreement(slow.failures, slower.failures).disagreed).toEqual([])
  })
})
