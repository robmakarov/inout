import { describe, expect, it } from 'vitest'
import { MAX_THUMBS, THUMB_PITCH_PX, planFilmstrip } from './filmstripPlan'

describe('planFilmstrip', () => {
  it('has no strip to draw when the lane is narrower than one thumbnail', () => {
    expect(planFilmstrip(40, 10, 32)).toBeNull()
  })

  it('refuses a take with no length', () => {
    expect(planFilmstrip(900, 0, 32)).toBeNull()
    expect(planFilmstrip(900, Number.POSITIVE_INFINITY, 32)).toBeNull()
  })

  it('spaces thumbnails by pitch, not by take length', () => {
    const short = planFilmstrip(760, 10, 32)!
    const long = planFilmstrip(760, 1800, 32)!
    expect(short.count).toBe(Math.round(760 / THUMB_PITCH_PX))
    // THE POINT OF THE PITCH RULE: a 30-minute take gets the same number of
    // thumbnails as a 10-second one, each standing for more time.
    expect(long.count).toBe(short.count)
  })

  it('never exceeds the decode budget', () => {
    const wide = planFilmstrip(20000, 60, 32)!
    expect(wide.count).toBe(MAX_THUMBS)
    expect(wide.atSec).toHaveLength(MAX_THUMBS)
  })

  it('samples cell centres, ascending and inside the take', () => {
    const p = planFilmstrip(760, 20, 32)!
    expect(p.atSec[0]).toBeGreaterThan(0)
    expect(p.atSec[p.atSec.length - 1]).toBeLessThan(20)
    for (let i = 1; i < p.atSec.length; i++) {
      expect(p.atSec[i]!).toBeGreaterThan(p.atSec[i - 1]!)
    }
    // First cell centre of an n-cell strip over 20 s.
    expect(p.atSec[0]).toBeCloseTo((0.5 / p.count) * 20, 6)
  })

  it('keeps 16:9 thumbnails', () => {
    expect(planFilmstrip(760, 10, 36)!.thumbWidthPx).toBe(64)
  })

  it('draws one thumbnail rather than none on a narrow-but-usable lane', () => {
    const p = planFilmstrip(60, 10, 32)!
    expect(p.count).toBe(1)
  })
})
