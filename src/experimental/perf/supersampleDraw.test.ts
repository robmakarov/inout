import { describe, expect, it } from 'vitest'
import { supersampleDraw } from './supersampleDraw'

/**
 * The rows drawCeiling.ts produces are only comparable if the reduction is an
 * EXACT block average. A draw size that is not a whole even number of pixels
 * puts a resampler with a fractional phase back in the path, which would be a
 * different experiment wearing the same label.
 */
describe('the aligned draw size', () => {
  it('is nothing at 1x — the export’s own draw, and the control every row is read against', () => {
    expect(supersampleDraw(1920, 1080, 1)).toBeNull()
    expect(supersampleDraw(1920, 1080, 0)).toBeNull()
  })

  it('doubles a 1080p frame exactly', () => {
    expect(supersampleDraw(1920, 1080, 2)).toEqual({ factor: 2, width: 3840, height: 2160 })
  })

  it('takes 1.5x when both sides land on whole even pixels', () => {
    expect(supersampleDraw(1920, 1080, 1.5)).toEqual({ factor: 1.5, width: 2880, height: 1620 })
  })

  it('refuses a factor that does not land on whole even pixels', () => {
    expect(supersampleDraw(1442, 810, 1.5)).toBeNull()
    expect(supersampleDraw(1442, 810, 2)).toEqual({ factor: 2, width: 2884, height: 1620 })
  })

  it('steps 2x down to 1.5x rather than allocating past the memory cap', () => {
    expect(supersampleDraw(3024, 1964, 2)).toEqual({ factor: 1.5, width: 4536, height: 2946 })
  })

  it('gives up rather than allocating a canvas past the side limit', () => {
    expect(supersampleDraw(6000, 4000, 2)).toBeNull()
  })

  it('never draws for a zero-sized frame', () => {
    expect(supersampleDraw(0, 1080, 2)).toBeNull()
  })
})
