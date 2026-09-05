import { describe, expect, it } from 'vitest'
import { MAX_THUMBS, THUMB_PITCH_PX, planFilmstrip, thumbPitchPx } from './filmstripPlan'

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
    expect(short.count).toBe(Math.round(760 / thumbPitchPx(32)))
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

  // UI1: the pitch may never fall below a thumbnail's own width, or the strip
  // is drawn wider than its lane and every frame is squashed to fit — the
  // stretch is `background-size: 100% 100%`, so the overrun is invisible in the
  // count and plainly visible in the picture.
  it('never packs thumbnails closer together than they are wide', () => {
    for (const h of [16, 24, 30, 32, 48]) {
      expect(thumbPitchPx(h)).toBeGreaterThanOrEqual(Math.round(h * (16 / 9)))
      expect(thumbPitchPx(h)).toBeGreaterThanOrEqual(THUMB_PITCH_PX)
      const p = planFilmstrip(900, 30, h)!
      expect(p.count * p.thumbWidthPx).toBeLessThanOrEqual(900 + p.thumbWidthPx)
    }
  })
})

describe('planFilmstrip over a window', () => {
  it('samples inside the window it was given, not the whole channel', () => {
    // 90 seconds into a channel, two seconds wide.
    const plan = planFilmstrip(760, 2, 32, 90)!
    expect(plan.atSec[0]).toBeGreaterThanOrEqual(90)
    expect(plan.atSec[plan.atSec.length - 1]!).toBeLessThan(92)
  })

  it('gives a two-second window the same frame COUNT as the whole take', () => {
    // This is the fix Robert asked for: the pitch is the rule, so zooming buys
    // more frames of less time rather than the same frames stretched.
    const whole = planFilmstrip(760, 5400, 32)!
    const window = planFilmstrip(760, 2, 32, 1200)!
    expect(window.count).toBe(whole.count)
    // ...and they cover two seconds instead of an hour and a half. Centre to
    // centre, so a count of n spans (n-1)/n of the stretch.
    const spread = (p: { atSec: number[] }) => p.atSec[p.atSec.length - 1]! - p.atSec[0]!
    expect(spread(whole)).toBeGreaterThan(4000)
    expect(spread(window)).toBeLessThan(2)
  })

  it('is unchanged when no window is named', () => {
    const plan = planFilmstrip(760, 10, 32)!
    expect(plan.atSec[0]).toBeGreaterThan(0)
    expect(plan.atSec[plan.atSec.length - 1]!).toBeLessThan(10)
  })
})
