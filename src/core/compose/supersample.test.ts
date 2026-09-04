import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setSupersampleOverride,
  supersampleActive,
  supersampleDraw,
  supersampleFactor,
} from './supersample'

afterEach(() => {
  setSupersampleOverride(null)
  vi.unstubAllGlobals()
})

/**
 * The whole point of O9(a) is that the reduction is an EXACT block average. A
 * draw size that is not a whole even number of pixels puts a resampler with a
 * fractional phase back in the path — the artefact the task is removing — so
 * the rule is pinned here rather than judged by eye.
 */
describe('the aligned draw size', () => {
  it('is off by default: no draw canvas, today’s path exactly', () => {
    expect(supersampleDraw(1920, 1080, 1)).toBeNull()
    expect(supersampleDraw(1920, 1080, 0)).toBeNull()
  })

  it('doubles a 1080p frame exactly', () => {
    expect(supersampleDraw(1920, 1080, 2)).toEqual({ factor: 2, width: 3840, height: 2160 })
  })

  it('takes 1.5x when both sides land on whole even pixels', () => {
    expect(supersampleDraw(1920, 1080, 1.5)).toEqual({ factor: 1.5, width: 2880, height: 1620 })
  })

  it('steps DOWN to a rung that aligns rather than drawing a fractional frame', () => {
    // 1.5x of 1080p-ish odd geometry: 1442*1.5 = 2163 — odd, so 1.5 is refused.
    const got = supersampleDraw(1442, 810, 1.5)
    expect(got).toBeNull()
    // …and 2x of the same frame is whole and even, so the ladder still runs.
    expect(supersampleDraw(1442, 810, 2)).toEqual({ factor: 2, width: 2884, height: 1620 })
  })

  it('falls from 2x to 1.5x when 2x would not fit the memory cap', () => {
    // A source-tier 3024x1964 export: 2x is 6048x3928 = 23.8 Mpx, past the cap.
    // 1.5x is 4536x2946 = 13.4 Mpx and fits, so the lever degrades instead of
    // failing the export.
    expect(supersampleDraw(3024, 1964, 2)).toEqual({ factor: 1.5, width: 4536, height: 2946 })
  })

  it('gives up rather than allocating a canvas past the side limit', () => {
    expect(supersampleDraw(6000, 4000, 2)).toBeNull()
  })

  it('never draws for a zero-sized frame', () => {
    expect(supersampleDraw(0, 1080, 2)).toBeNull()
  })
})

/**
 * The seam workerFlags.test.ts pins for `?cq=`, `?loudness=` and `?sourceframe=`.
 * The render runs in a dedicated worker with no storage and a location of its
 * own script URL, so a getter read INSIDE the render answers its default no
 * matter what the page was opened with. The page reads, the worker is told.
 */
describe('the flag the export worker cannot read for itself', () => {
  it('falls through to 1 inside a worker — the defect this seam exists for', () => {
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('location', { search: '' })
    expect(supersampleFactor()).toBe(1)
    expect(supersampleActive()).toBe(1)
  })

  it('obeys what the page forwarded', () => {
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('location', { search: '' })
    setSupersampleOverride(2)
    expect(supersampleActive()).toBe(2)
  })

  it('reads ?ss= on the page, and off means 1 rather than null', () => {
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('location', { search: '?ss=2' })
    expect(supersampleFactor()).toBe(2)
    vi.stubGlobal('location', { search: '?ss=off' })
    expect(supersampleFactor()).toBe(1)
  })
})
