/**
 * B14 — A READING IS ONLY ABOUT THE FRAME IT WAS TAKEN AT.
 *
 * The defect, measured on prod 2026-09-03 before any of this was written: a
 * `max` take on a 3024x1964 screen certified `"fps":30`, twice over and by two
 * different branches of the same function.
 *
 *   cold  (fresh profile, record pressed ~4 s after load, nothing in storage)
 *         "3024×1964 at 60 fps wants 356 Mpx/s and this machine has not been
 *          measured yet — holding at 30 fps on the old size rule"
 *   warm  (record pressed 60 s in, the meter has published)
 *         "…and this machine's encoder measured 342 Mpx/s — holding at 30 fps"
 *
 * The second one is the interesting one, because the machine CAN do it. The
 * meter ran at a hard-coded 1920x1080 with a hard-coded `avc1.4D402A` — level
 * 4.2, which cannot be configured above 1080p at all — and Mpx/s is not the
 * same number at every frame size. Same machine, same 40-frame meter, the
 * take's own codec ladder, three reps each:
 *
 *   1920x1080  330      2560x1662  389      3024x1964  398/406/412      3840x2160  417
 *
 * 3024x1964@60 wants 356. The machine delivers ~405 at that frame and 330 at
 * 1080p, and the whole defect lives in the gap between those two readings.
 *
 * So the rule this file pins is not a margin and not a correction. It is the
 * DIRECTION OF THE ERROR, which is known and monotone: a reading taken at a
 * smaller frame than the surface UNDER-states the surface, and an
 * under-statement may inform an attempt but must never be spent as a refusal.
 */
import { describe, expect, it } from 'vitest'
import { rateDecisionForSurface, rateForSurface } from './rate'

/** Robert's screen, and the reading his own encoder gives AT that frame. */
const SCREEN = { width: 3024, height: 1964 }
const AT_SCREEN = 405e6
/** What the same encoder reads at 1080p — the number the meter used to store. */
const AT_1080P = 330e6

describe('B14 — the rate decision names the branch it took', () => {
  it('allows 60 when the machine was measured at this surface and it fits', () => {
    const d = rateDecisionForSurface(SCREEN.width, SCREEN.height, 60, AT_SCREEN, SCREEN)
    expect(d.fps).toBe(60)
    expect(d.branch).toBe('measured-fits')
    expect(Math.round(d.wantMpxPerS)).toBe(356)
    expect(d.measuredAt).toBe('3024x1964')
  })

  it('THE DEFECT: a 1080p reading no longer refuses a 3024x1964 surface', () => {
    // This is the exact call the shipped build made on prod, and it answered
    // 30. It under-states — 330 was measured on a frame 2.9x smaller — so it
    // may not be the thing that takes 60 fps away.
    const d = rateDecisionForSurface(SCREEN.width, SCREEN.height, 60, AT_1080P, {
      width: 1920,
      height: 1080,
    })
    expect(d.branch).toBe('measured-below-surface')
    // It falls through to the size rule, which is where the OTHER half of the
    // defect lives and which this task deliberately did not move: the cold
    // branch still answers 30 at a 3024 long edge. The fix that closes the gate
    // is the meter running at the display's own size, so this branch is not
    // reached in the first place.
    expect(d.fps).toBe(30)
  })

  it('a reading taken LARGER than the surface is comparable and is used', () => {
    // The meter measures at the display's size and a capture surface cannot be
    // bigger than the display, so this is the ordinary case for every take
    // smaller than the whole screen.
    const d = rateDecisionForSurface(1920, 1200, 60, AT_SCREEN, SCREEN)
    expect(d.branch).toBe('measured-fits')
    expect(d.fps).toBe(60)
  })

  it('still refuses what the machine measurably cannot carry, at its own size', () => {
    // 4K60 is 498 Mpx/s against 417 measured AT 4K. The rate is what gives,
    // never the resolution — Robert's order of sacrifice, unchanged.
    const d = rateDecisionForSurface(3840, 2160, 60, 417e6, { width: 3840, height: 2160 })
    expect(d.branch).toBe('measured-over')
    expect(d.fps).toBe(30)
  })

  it('an unmeasured machine is still not experimented on', () => {
    const d = rateDecisionForSurface(SCREEN.width, SCREEN.height, 60, 0)
    expect(d.branch).toBe('unmeasured')
    expect(d.fps).toBe(30)
  })

  it('below the 60 ceiling there is no decision to take, and it says so', () => {
    const d = rateDecisionForSurface(SCREEN.width, SCREEN.height, 30, 0)
    expect(d.branch).toBe('no-ceiling')
    expect(d.fps).toBe(30)
  })

  it('a surface with no geometry is never refused', () => {
    expect(rateDecisionForSurface(undefined, undefined, 60, AT_1080P).branch).toBe('no-geometry')
    expect(rateForSurface(undefined, undefined, 60, AT_1080P)).toBe(60)
  })

  it('rateForSurface is exactly the decision, so the two can never disagree', () => {
    for (const [w, h, rate, at] of [
      [3024, 1964, AT_SCREEN, SCREEN],
      [3024, 1964, AT_1080P, { width: 1920, height: 1080 }],
      [3840, 2160, 417e6, { width: 3840, height: 2160 }],
      [1920, 1080, 0, { width: 0, height: 0 }],
    ] as const) {
      expect(rateForSurface(w, h, 60, rate, at)).toBe(
        rateDecisionForSurface(w, h, 60, rate, at).fps,
      )
    }
  })
})
