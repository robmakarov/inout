import { afterEach, describe, expect, it } from 'vitest'
import {
  COLLAPSE_MARGIN,
  REDUCTION_FLOOR_LONG_EDGE,
  budgetVerdict,
  describePlan,
  encoderCeiling,
  encoderPixelRate,
  planOf,
  recordEncoderCollapse,
  recordEncoderSustained,
  resetEncoderBudgetForTests,
  type PlannedEncoder,
} from './encoderBudget'

/**
 * O15. Robert's own console, 2026-08-29 — the take that froze the whole
 * machine, not just the tab:
 *
 *   raw screen    3024x1964  (AVC level 5.1)
 *   raw camera    1280x720
 *   composite     1920x1080
 *   …and a game rendering on the same GPU.
 *
 * Three hardware encoders, nothing budgeting them against each other, and no
 * line anywhere that added them up.
 */
const ROBERTS_TAKE: PlannedEncoder[] = [
  { what: 'screen', width: 3024, height: 1964, fps: 30 },
  { what: 'camera', width: 1280, height: 720, fps: 30 },
  { what: 'composite', width: 1920, height: 1080, fps: 30 },
]

afterEach(() => resetEncoderBudgetForTests())

describe('the plan nobody could read before', () => {
  it('adds up the take that froze the machine', () => {
    const plan = planOf(ROBERTS_TAKE)
    expect(plan.encoders).toHaveLength(3)
    // (5,939,136 + 921,600 + 2,073,600) x 30
    expect(plan.pixelRate).toBe(268_030_080)
    expect(describePlan(plan)).toContain('3 encoder(s)')
    expect(describePlan(plan)).toContain('268.0 Mpx/s')
  })

  it('the screen alone is two thirds of it — which is why it is the lever', () => {
    const plan = planOf(ROBERTS_TAKE)
    const screen = encoderPixelRate(ROBERTS_TAKE[0]!)
    expect(screen / plan.pixelRate).toBeGreaterThan(0.66)
  })
})

describe('a budget is earned, never assumed', () => {
  it('THE SAFETY PROPERTY: a machine that never collapsed has no ceiling at all', () => {
    // Nobody's first take is bounded by someone else's hardware. This is what
    // makes the whole file safe to leave running: no history, no opinion.
    expect(encoderCeiling()).toBe(0)
    expect(
      budgetVerdict({
        plan: planOf(ROBERTS_TAKE),
        ceiling: encoderCeiling(),
        screen: ROBERTS_TAKE[0]!,
        compositeLongEdge: 1920,
      }),
    ).toBeNull()
  })

  it('a sustained take alone still buys no ceiling — only a collapse does', () => {
    recordEncoderSustained(100e6)
    expect(encoderCeiling()).toBe(0)
  })

  it('remembers the SMALLEST load it was ever seen to fail at', () => {
    recordEncoderCollapse(268e6, 'the composite degraded')
    recordEncoderCollapse(400e6, 'a worse one later')
    expect(encoderCeiling()).toBeCloseTo(268e6 * COLLAPSE_MARGIN, -3)
  })

  it('raises the sustained mark only — a small quiet take cannot talk it down', () => {
    recordEncoderCollapse(200e6, 'collapse')
    recordEncoderSustained(240e6)
    const earned = encoderCeiling()
    expect(earned).toBe(240e6)
    recordEncoderSustained(20e6) // a two-second take of a still window
    expect(encoderCeiling()).toBe(earned)
  })

  it('a take that WORKED outranks an older one that did not', () => {
    // The same rule W1 put in the wedge ladder the same night. A machine whose
    // collapse was a passing game is never held below its own proven best.
    recordEncoderCollapse(200e6, 'a game was running')
    expect(encoderCeiling()).toBeCloseTo(200e6 * COLLAPSE_MARGIN, -3)
    recordEncoderSustained(240e6)
    expect(encoderCeiling()).toBe(240e6)
  })
})

describe('what the screen is allowed to be', () => {
  const screen = ROBERTS_TAKE[0]!
  const plan = planOf(ROBERTS_TAKE)

  it('a plan that fits is not touched', () => {
    expect(
      budgetVerdict({ plan, ceiling: 300e6, screen, compositeLongEdge: 1920 }),
    ).toBeNull()
  })

  it("snaps to the composite's own geometry, which is worth more than the pixels", () => {
    // Equality with the composite is what makes a take single-generation
    // eligible (session.singleGenerationTake) — one whole encoder gone rather
    // than merely a smaller one. Preferred even when a larger size would fit.
    const v = budgetVerdict({
      plan,
      ceiling: 268_030_080 * COLLAPSE_MARGIN,
      screen,
      compositeLongEdge: 1920,
    })
    expect(v?.screenLongEdge).toBe(1920)
    expect(v?.why).toContain("composite's own")
  })

  it('scales to fit when even the composite size is too big', () => {
    const v = budgetVerdict({ plan, ceiling: 140e6, screen, compositeLongEdge: 1920 })
    expect(v).not.toBeNull()
    expect(v!.screenLongEdge).toBeLessThan(1920)
    expect(v!.screenLongEdge % 2).toBe(0) // AVC cannot encode an odd side
    // …and it actually fits: the reduced screen plus the others is under.
    const scale = v!.screenLongEdge / 3024
    const reduced = encoderPixelRate(screen) * scale * scale
    const others = plan.pixelRate - encoderPixelRate(screen)
    expect(reduced + others).toBeLessThanOrEqual(140e6)
  })

  it('never cuts below the floor, and says the other encoders are the problem', () => {
    const v = budgetVerdict({ plan, ceiling: 30e6, screen, compositeLongEdge: 1920 })
    expect(v?.screenLongEdge).toBe(REDUCTION_FLOOR_LONG_EDGE)
    expect(v?.why).toContain('still over')
  })

  it('NEVER RAISES a long edge — going up is F18, not this', () => {
    const small: PlannedEncoder = { what: 'screen', width: 1280, height: 720, fps: 30 }
    const v = budgetVerdict({
      plan: planOf([small]),
      ceiling: 1e6, // absurdly tight
      screen: small,
      compositeLongEdge: 1920, // bigger than the screen
    })
    // Already at the floor: nothing to cut, and the composite's 1920 must not
    // be read as a target.
    expect(v).toBeNull()
  })

  it('a take with no screen channel is left alone', () => {
    const cam: PlannedEncoder = { what: 'camera', width: 1280, height: 720, fps: 30 }
    expect(
      budgetVerdict({ plan: planOf([cam]), ceiling: 1e6, screen: null, compositeLongEdge: 1920 }),
    ).toBeNull()
  })
})
