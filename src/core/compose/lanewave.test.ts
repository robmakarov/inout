import { describe, expect, it } from 'vitest'
import { columnTimes, waveScale } from './lanewave'

describe('columnTimes', () => {
  it('samples cell centres, ascending, inside the take', () => {
    const t = columnTimes(10, 5)
    expect(t).toHaveLength(5)
    expect(t[0]).toBeCloseTo(1, 6)
    expect(t[4]).toBeCloseTo(9, 6)
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!)
  })

  it('never asks for an instant at or past the end', () => {
    for (const t of columnTimes(4, 64)) expect(t).toBeLessThan(4)
  })
})

describe('waveScale', () => {
  it('has nothing to draw for an empty channel', () => {
    expect(waveScale([])).toEqual({ peak: 0, reference: 0, scale: 0 })
  })

  it('draws a quiet take at full height — the lane says WHERE, not how loud', () => {
    const quiet = new Array(100).fill(0.04)
    const { scale } = waveScale(quiet)
    expect(0.04 * scale).toBeCloseTo(1, 6)
  })

  /**
   * THE REAL TAKE THAT CHANGED THIS. A system-audio channel whose steady tone
   * sits near 0.05 opened with a 2.2 transient. Against the MAXIMUM every other
   * column draws at 2 % of the lane and the channel looks empty.
   */
  it('is not flattened by a single opening transient', () => {
    const columns = [2.2, ...new Array(99).fill(0.05)]
    const { peak, scale } = waveScale(columns)
    expect(peak).toBeCloseTo(2.2, 6) // still reported honestly
    // The steady tone fills the lane; against the max it would have been 2 %.
    expect(0.05 * scale).toBeGreaterThan(0.9)
    expect(0.05 / peak).toBeLessThan(0.03)
  })

  it('lets a real dynamic range still read as one', () => {
    const columns = [...new Array(50).fill(0.1), ...new Array(50).fill(0.8)]
    const { scale } = waveScale(columns)
    // Loud stretch full height, quiet stretch visibly shorter — a ratio, not a
    // flat line and not a clipped block.
    expect(0.8 * scale).toBeGreaterThan(0.9)
    expect(0.1 * scale).toBeLessThan(0.2)
  })

  it('treats a silent channel as silent rather than amplifying its noise floor', () => {
    expect(waveScale(new Array(100).fill(0.0001)).scale).toBe(0)
  })
})
