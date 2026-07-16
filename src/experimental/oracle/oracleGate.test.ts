import { describe, expect, it } from 'vitest'
// @ts-expect-error oracle gate is plain ESM in scripts/
import { gateOracleReport, oracleMetricsIncomplete } from '../../../scripts/oracle-gate.mjs'

describe('oracleMetricsIncomplete', () => {
  it('flags all-null metrics', () => {
    expect(oracleMetricsIncomplete({})).toBe(true)
    expect(
      oracleMetricsIncomplete({
        syncMeanMs: null,
        syncMaxAbsMs: 10,
        maxBoundaryJump: 0,
        spurPeakDb: -50,
      }),
    ).toBe(true)
  })

  it('accepts finite metrics', () => {
    expect(
      oracleMetricsIncomplete({
        syncMeanMs: 5,
        syncMaxAbsMs: 12,
        maxBoundaryJump: 0,
        spurPeakDb: -50,
      }),
    ).toBe(false)
  })
})

describe('gateOracleReport', () => {
  it('fails when flash+click and integrity are missing (load flake class)', () => {
    const r = gateOracleReport({ full: {}, audioIntegrity: null })
    expect(r.pass).toBe(false)
    expect(oracleMetricsIncomplete(r.metrics)).toBe(true)
  })
})
