import { afterEach, describe, expect, it } from 'vitest'
import {
  COOLDOWN_MS,
  MAX_STEPS_PER_TAKE,
  MIN_DELTA_PX,
  SETTLE_MS,
  differsMeaningfully,
  resolutionStepEnabled,
  setResolutionStep,
  stepVerdict,
} from './resolutionStep'

/**
 * O16 — Robert: "why resolution cannot go safely, make it go up safely too."
 *
 * The file surgery is F6's (close the segment, open segment N+1 on the same
 * track). What has to be got right here is NOT THRASHING: a window being dragged
 * emits a continuous stream of sizes, and a segment per size would shred the
 * take into hundreds of files.
 */
afterEach(() => setResolutionStep(null))

const at = (width: number, height: number) => ({ width, height })
const base = {
  current: at(1920, 1080),
  observed: at(2560, 1440),
  nowMs: 100_000,
  differingSinceMs: 100_000 - SETTLE_MS,
  lastStepAtMs: null,
  stepsTaken: 0,
}

describe('when a step is worth a segment boundary', () => {
  it('follows the source UP once the new size has held still', () => {
    const v = stepVerdict(base)
    expect(v?.to).toEqual({ width: 2560, height: 1440 })
    expect(v?.why).toContain('following it UP')
  })

  it('follows it down the same way — the mechanism has no preferred direction', () => {
    const v = stepVerdict({ ...base, current: at(2560, 1440), observed: at(1920, 1080) })
    expect(v?.to).toEqual({ width: 1920, height: 1080 })
    expect(v?.why).toContain('following it down')
  })

  it('a source that is not changing size never steps', () => {
    expect(stepVerdict({ ...base, observed: at(1920, 1080) })).toBeNull()
  })
})

describe('the ways this could shred a take, each refused', () => {
  it('THE DRAG: a size that has not settled yet is not stepped on', () => {
    expect(stepVerdict({ ...base, differingSinceMs: base.nowMs - (SETTLE_MS - 1) })).toBeNull()
    // …and the same size one tick later, having now held, is.
    expect(stepVerdict({ ...base, differingSinceMs: base.nowMs - SETTLE_MS })).not.toBeNull()
  })

  it('a size that never differed has no settle clock at all', () => {
    expect(stepVerdict({ ...base, differingSinceMs: null })).toBeNull()
  })

  it('JITTER: a pixel or two is not a resolution change', () => {
    // Capturers report jitter, and evenDown in the capture path can move a side
    // by one on its own. A segment boundary is far too expensive for that.
    expect(differsMeaningfully(at(1920, 1080), at(1921, 1081))).toBe(false)
    expect(stepVerdict({ ...base, observed: at(1920 + MIN_DELTA_PX - 1, 1080) })).toBeNull()
    expect(stepVerdict({ ...base, observed: at(1920 + MIN_DELTA_PX, 1080) })).not.toBeNull()
  })

  it('THE COOLDOWN: a step cannot immediately cause another', () => {
    expect(stepVerdict({ ...base, lastStepAtMs: base.nowMs - (COOLDOWN_MS - 1) })).toBeNull()
    expect(stepVerdict({ ...base, lastStepAtMs: base.nowMs - COOLDOWN_MS })).not.toBeNull()
  })

  it('AN OSCILLATING SOURCE costs a BOUNDED number of files, then stops', () => {
    expect(stepVerdict({ ...base, stepsTaken: MAX_STEPS_PER_TAKE - 1 })).not.toBeNull()
    expect(stepVerdict({ ...base, stepsTaken: MAX_STEPS_PER_TAKE })).toBeNull()
    // After the cap the channel keeps the size it has and the composite carries
    // the change — exactly what happened before this task existed.
    expect(stepVerdict({ ...base, stepsTaken: MAX_STEPS_PER_TAKE + 40 })).toBeNull()
  })

  it('a track reporting nothing is not a change', () => {
    expect(stepVerdict({ ...base, observed: null })).toBeNull()
    expect(stepVerdict({ ...base, observed: at(0, 0) })).toBeNull()
  })
})

describe('the flag', () => {
  it('is OFF by default — a take is exactly the take it was', () => {
    expect(resolutionStepEnabled()).toBe(false)
  })

  it('turns on and off', () => {
    setResolutionStep(true)
    expect(resolutionStepEnabled()).toBe(true)
    setResolutionStep(false)
    expect(resolutionStepEnabled()).toBe(false)
  })
})
