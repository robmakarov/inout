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

describe('columnTimes over a window', () => {
  it('starts where the window starts and stays inside it', () => {
    const t = columnTimes(2, 8, 90)
    expect(t[0]).toBeGreaterThanOrEqual(90)
    expect(t[t.length - 1]!).toBeLessThan(92)
    expect(t.length).toBe(8)
  })

  it('puts the same number of columns in a shorter stretch — the detail is the point', () => {
    const whole = columnTimes(5400, 64)
    const window = columnTimes(2, 64, 1200)
    expect(window.length).toBe(whole.length)
    expect(window[1]! - window[0]!).toBeLessThan(whole[1]! - whole[0]!)
  })

  it('is unchanged when no window is named', () => {
    expect(columnTimes(10, 5)).toEqual(columnTimes(10, 5, 0))
  })
})

describe('waveScale against a given reference', () => {
  // The zoom made this a real question: a window that computed its own level
  // would draw a quiet passage tall the moment you looked closely at it, and
  // the same second of audio would change height as the window slid over it.
  it('a loud stretch and a quiet one of the same channel do not agree on their own', () => {
    const loud = waveScale([0.8, 0.9, 1.0, 0.85])
    const quiet = waveScale([0.02, 0.03, 0.025, 0.02])
    expect(quiet.scale).toBeGreaterThan(loud.scale * 10)
  })

  it('the channel level is what a window must be drawn against', () => {
    // Given the whole channel's reference, a quiet window draws quiet: the
    // column at 0.03 lands at 3% of the lane, not at 100% of it.
    const channel = waveScale([0.02, 0.03, 0.8, 0.9, 1.0])
    const drawnWith = (peak: number, reference: number) => peak * (1 / reference)
    expect(drawnWith(0.03, channel.reference)).toBeLessThan(0.05)
    expect(drawnWith(0.03, waveScale([0.02, 0.03, 0.025]).reference)).toBeGreaterThan(0.9)
  })
})
