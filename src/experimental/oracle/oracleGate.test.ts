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

/**
 * THE STATISTIC IS THE THING UNDER TEST (task G1 + LC1, 2026-09-01).
 *
 * The old gate failed on an extreme over the take's pairs, so a longer take of
 * the SAME file read worse — measured, 6 s read 62-78 ms and 120 s read 112.2
 * with an identical mean. These cases pin the replacement: the length may not
 * change the verdict, and every defect the extreme could catch must still be
 * caught by the location and dispersion bands that replaced it.
 */
/** One pair per second, so the index IS the take second. */
function fitDrift(offsetsMs: number[], mean: number) {
  const n = offsetsMs.length
  if (n <= 2) return { driftMsPerSec: null, driftR2: null, spanSec: n > 1 ? n - 1 : null }
  const tm = (n - 1) / 2
  const sxx = offsetsMs.reduce((a, _, i) => a + (i - tm) ** 2, 0)
  const slope = offsetsMs.reduce((a, x, i) => a + (i - tm) * (x - mean), 0) / sxx
  const ssTot = offsetsMs.reduce((a, x) => a + (x - mean) ** 2, 0)
  const ssRes = offsetsMs.reduce((a, x, i) => a + (x - (mean + slope * (i - tm))) ** 2, 0)
  return {
    driftMsPerSec: slope,
    driftR2: ssTot > 0 ? 1 - ssRes / ssTot : null,
    spanSec: n - 1,
  }
}

function reportWith(offsetsMs: number[], frameIntervalMs = 1000 / 30) {
  const n = offsetsMs.length
  const mean = offsetsMs.reduce((s, x) => s + x, 0) / n
  const devs = offsetsMs.map((x) => Math.abs(x - mean)).sort((a, b) => a - b)
  const flashSync = {
    flashes: n,
    matchedPairs: n,
    meanOffsetMs: mean,
    maxAbsOffsetMs: Math.max(...offsetsMs.map(Math.abs)),
    offsetsMs,
    pairSec: offsetsMs.map((_, i) => i),
    sdMs:
      n > 1
        ? Math.sqrt(offsetsMs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1))
        : 0,
    p90DevMs: devs[Math.min(devs.length - 1, Math.ceil(n * 0.9) - 1)]!,
    droppedPairs: 0,
    ...fitDrift(offsetsMs, mean),
  }
  return {
    full: {
      flashSync,
      flashSyncUnbiased: flashSync,
      flashSyncSymmetricMeanMs: mean,
      flashSyncSymmetricMaxAbsMs: flashSync.maxAbsOffsetMs,
      outFrameIntervalMs: frameIntervalMs,
    },
    audioIntegrity: { maxBoundaryJump: 0, spurPeakDb: -50 },
  }
}

/** Offsets quantised to the frame grid around `mean` — the honest instrument. */
function quantised(mean: number, n: number, frames = [0, 1, -1]) {
  const T = 1000 / 30
  return Array.from({ length: n }, (_, i) => mean + frames[i % frames.length]! * T)
}

const syncFailures = (r: { failures: string[] }) =>
  r.failures.filter((f) => f.includes('sync'))

describe('sync gate is length-invariant (G1 + LC1)', () => {
  it('passes frame-quantised offsets at 6 s and at 120 s alike', () => {
    const short = gateOracleReport(reportWith(quantised(62, 5)))
    const long = gateOracleReport(reportWith(quantised(62, 119)))
    expect(syncFailures(short)).toEqual([])
    expect(syncFailures(long)).toEqual([])
    // The old statistic is still reported, and it is exactly what grew.
    expect(long.metrics.syncMaxAbsMs).toBeGreaterThan(90)
  })

  it('still fails a real systematic offset', () => {
    const r = gateOracleReport(reportWith(quantised(140, 20)))
    expect(syncFailures(r).some((f) => f.includes('mean'))).toBe(true)
  })

  it('still fails a real scatter the mean hides', () => {
    // Mean ~0, but every event is up to 150 ms out of place.
    const jitter = Array.from({ length: 40 }, (_, i) => (i % 2 ? 150 : -150))
    const r = gateOracleReport(reportWith(jitter))
    expect(Math.abs(r.metrics.syncMeanMs)).toBeLessThan(10)
    expect(syncFailures(r).some((f) => f.includes('spread'))).toBe(true)
  })

  it('fails a drift the old extreme also missed, and measures the one it does not', () => {
    // 1 ms/s over 120 s: mean centred, ends 60 ms out. maxAbs reads 60 against
    // a 90 band, so the OLD gate passed this too — it is measured now, not
    // banded, and the number is in the report.
    const slow = gateOracleReport(reportWith(Array.from({ length: 120 }, (_, i) => i - 60)))
    expect(slow.metrics.syncMaxAbsMs).toBeLessThan(90)
    expect(slow.metrics.renderDriftMsPerSec).toBeCloseTo(1, 1)
    // 5 ms/s is 15 seconds of desync on a 50-minute take, and it goes red.
    const fast = gateOracleReport(
      reportWith(Array.from({ length: 120 }, (_, i) => 5 * (i - 60))),
    )
    expect(syncFailures(fast).some((f) => f.includes('drifts'))).toBe(true)
  })

  it('does not fit a slope to a take too short to have one', () => {
    const r = gateOracleReport(reportWith([0, 40, -40, 80, -80]))
    expect(r.metrics.renderSpanSec).toBe(4)
    expect(syncFailures(r).some((f) => f.includes('drifts'))).toBe(false)
  })

  it('refuses to pass a lane that paired almost nothing', () => {
    const one = reportWith([12])
    one.full.flashSync.flashes = 6
    one.full.flashSyncUnbiased.flashes = 6
    const r = gateOracleReport(one)
    expect(syncFailures(r).some((f) => f.includes('too few'))).toBe(true)
  })

  it('reads dispersion in frame intervals, not milliseconds', () => {
    // The same 90 ms scatter: under three frames at 30 fps, over five at 60.
    const scatter = Array.from({ length: 30 }, (_, i) => (i % 2 ? 45 : -45))
    expect(syncFailures(gateOracleReport(reportWith(scatter, 1000 / 30)))).toEqual([])
    expect(syncFailures(gateOracleReport(reportWith(scatter, 1000 / 60))).length).toBeGreaterThan(0)
  })
})
