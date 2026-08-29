import { describe, expect, it } from 'vitest'
import {
  DEGRADE_RUNGS,
  SETTLE_MS,
  SUSTAINED_MS,
  WARMUP_MS,
  ladderVerdict,
  type LadderInput,
  DEAD_ENCODER_MS,
  rungsFor,
} from './resolutionLadder'

/** A machine that is failing badly, with every timing precondition satisfied:
 *  frames ARRIVE at the full rate and two thirds of them never get encoded. */
const failing: LadderInput = {
  nowMs: 30_000,
  startedAtMs: 0,
  firstOutputAtMs: 1_000,
  lastStepAtMs: null,
  underFloorForMs: SUSTAINED_MS + 500,
  deliveredFps: 9,
  arrivedFps: 30,
  requestedFps: 30,
  stepsTaken: 0,
}

describe('ladderVerdict', () => {
  it('steps down when delivery has been failing for long enough', () => {
    const v = ladderVerdict(failing)
    expect(v?.rung.label).toBe('1440p')
    expect(v?.reason).toContain('30 %')
  })

  it('takes ONE rung at a time, in order', () => {
    expect(ladderVerdict({ ...failing, stepsTaken: 1 })?.rung.label).toBe('1080p')
  })

  it('NEVER steps below the last rung, however bad it gets', () => {
    // Rule 1. Past the floor the answer is the watchdog's, not the ladder's:
    // the composite gets refused and the take renders from raw channels.
    expect(ladderVerdict({ ...failing, stepsTaken: DEGRADE_RUNGS.length, deliveredFps: 1 })).toBeNull()
  })

  it('the dead-encoder bound sits UNDER the watchdog and well clear of any init', () => {
    // Both halves are load-bearing and the first attempt got the second wrong:
    // at 6 s this fired on 2560x1440@60, a configuration measured to keep 81 %
    // of its frames, and stepped a healthy take down to 132 frames from 508.
    expect(DEAD_ENCODER_MS).toBeGreaterThan(WARMUP_MS * 2)
    expect(DEAD_ENCODER_MS).toBeLessThan(15_000)
  })

  it('says nothing while the encoder has not produced output YET', () => {
    // Note 6, the fault that cost this project three sessions: a fresh
    // process's first VideoEncoder pays a multi-second init, and judging inside
    // it reads as a hardware failure.
    expect(
      ladderVerdict({
        ...failing,
        startedAtMs: 0,
        nowMs: DEAD_ENCODER_MS - 1,
        firstOutputAtMs: null,
        deliveredFps: 0,
      }),
    ).toBeNull()
  })

  it('a take ABOVE 30 gives the RATE back first, and a 30 fps take is unchanged', () => {
    // Measured on prod 2026-08-29: 3456x2234@60 encoded NOTHING while the same
    // source at 30 was healthy, and two resolution steps did not rescue it —
    // the composite draws into its own 1920x1080 canvas sixty times a second
    // whatever the source's size, so shrinking the source misses the cost.
    expect(rungsFor(30)).toEqual(DEGRADE_RUNGS)
    expect(rungsFor(30)[0]?.fps).toBeUndefined()
    const fast = rungsFor(60)
    expect(fast[0]).toEqual({ label: '30 fps', fps: 30 })
    expect(fast.slice(1)).toEqual(DEGRADE_RUNGS)
    // The first verdict on a 60 fps take is the rate; the next two are the
    // rungs it always had.
    const at60 = { ...failing, requestedFps: 60, arrivedFps: 60, deliveredFps: 1 }
    expect(ladderVerdict(at60)?.rung.label).toBe('30 fps')
    expect(ladderVerdict({ ...at60, stepsTaken: 1 })?.rung.label).toBe('1440p')
    expect(ladderVerdict({ ...at60, stepsTaken: 2 })?.rung.label).toBe('1080p')
    // …and the floor moves with the list rather than being hardcoded.
    expect(ladderVerdict({ ...at60, stepsTaken: 3 })).toBeNull()
    expect(ladderVerdict({ ...failing, stepsTaken: DEGRADE_RUNGS.length })).toBeNull()
  })

  it('but an encoder silent for longer than any init IS the case this ladder is for', () => {
    // THE HOLE THAT COST A TAKE ITS COMPOSITE, measured on prod 2026-08-29 at
    // 3456x2234@60: the encoder produced nothing at all, so firstOutputAtMs
    // stayed null, so the rule above held FOREVER and the ladder never ran —
    // and the watchdog then killed the composite at 15 s. "Initialising" and
    // "never going to produce anything" cannot be the same state forever.
    const dead = {
      ...failing,
      startedAtMs: 0,
      nowMs: DEAD_ENCODER_MS + 1,
      firstOutputAtMs: null,
      deliveredFps: 0,
    }
    const verdict = ladderVerdict(dead)
    expect(verdict?.rung.label).toBe('1440p')
    expect(verdict?.reason).toContain('produced NOTHING')
    // …and it still obeys every other rule. A source that sent nothing has not
    // failed (rule 4), so a dead encoder over a still screen is left alone.
    expect(ladderVerdict({ ...dead, arrivedFps: 0 })).toBeNull()
    // The floor is still the floor (rule 1).
    expect(ladderVerdict({ ...dead, stepsTaken: DEGRADE_RUNGS.length })).toBeNull()
    // A step still has to settle before the next one (rule 3).
    expect(ladderVerdict({ ...dead, lastStepAtMs: dead.nowMs - 1 })).toBeNull()
  })

  it('gives the encoder a warm-up window even after its first output', () => {
    expect(
      ladderVerdict({ ...failing, nowMs: 3_000, firstOutputAtMs: 1_000, deliveredFps: 2 }),
    ).toBeNull()
    expect(
      ladderVerdict({ ...failing, nowMs: 1_000 + WARMUP_MS + 1, firstOutputAtMs: 1_000 }),
    ).not.toBeNull()
  })

  it('lets a step settle before judging the rung it moved to', () => {
    // Rule 3. Without this the step's own transient scores as a failure and the
    // ladder cascades to the floor in a fraction of a second.
    expect(
      ladderVerdict({ ...failing, stepsTaken: 1, lastStepAtMs: failing.nowMs - 500 }),
    ).toBeNull()
    expect(
      ladderVerdict({ ...failing, stepsTaken: 1, lastStepAtMs: failing.nowMs - SETTLE_MS - 1 }),
    ).not.toBeNull()
  })

  it('ignores a brief dip — delivery has to stay down', () => {
    expect(ladderVerdict({ ...failing, underFloorForMs: SUSTAINED_MS - 1 })).toBeNull()
  })

  it('does not step for delivery that is merely imperfect', () => {
    // 28 of 30 is the number a HEALTHY 1080p lane reads (O4's flip gate was
    // ≥28), so a ladder that fired here would degrade every good take.
    expect(ladderVerdict({ ...failing, deliveredFps: 28 })).toBeNull()
    expect(ladderVerdict({ ...failing, deliveredFps: 20 })).toBeNull()
  })

  it('is silent when the requested rate is unknown rather than guessing', () => {
    expect(ladderVerdict({ ...failing, requestedFps: 0 })).toBeNull()
  })

  // ---- Rule 4 (P0-ladder-static): the ruler is what ARRIVED, not the wall clock

  it('NEVER steps for a static source — 0 fps arriving is health, not collapse', () => {
    // The live defect: getDisplayMedia emits on change, a still document
    // delivers nothing, and the old requested-rate ruler read that as 0 % and
    // walked a 4K screen down to 1080p for the rest of the take.
    expect(
      ladderVerdict({ ...failing, arrivedFps: 0, deliveredFps: 0, underFloorForMs: 10_000 }),
    ).toBeNull()
  })

  it('still steps for a starved pipeline — frames arriving and none reaching the file', () => {
    const v = ladderVerdict({ ...failing, arrivedFps: 30, deliveredFps: 0 })
    expect(v?.rung.label).toBe('1440p')
    expect(v?.reason).toContain('0 % kept')
  })

  it('does not step for a sparse source the encoder fully keeps up with', () => {
    // Someone typing on an otherwise-still screen: 2 fps arrive, 2 fps encode.
    // Under the old ruler this was 7 % of requested and stepped.
    expect(ladderVerdict({ ...failing, arrivedFps: 2, deliveredFps: 2 })).toBeNull()
  })

  it('does not punish a 60 fps source for the cadence gate dropping its excess', () => {
    // Demand is capped at the requested rate: 30 encoded of 60 arriving is the
    // cadence gate working, not backpressure.
    expect(ladderVerdict({ ...failing, arrivedFps: 60, deliveredFps: 30 })).toBeNull()
  })
})
