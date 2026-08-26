import { describe, expect, it } from 'vitest'
import {
  DEGRADE_RUNGS,
  SETTLE_MS,
  SUSTAINED_MS,
  WARMUP_MS,
  ladderVerdict,
  type LadderInput,
} from './resolutionLadder'

/** A machine that is failing badly, with every timing precondition satisfied. */
const failing: LadderInput = {
  nowMs: 30_000,
  startedAtMs: 0,
  firstOutputAtMs: 1_000,
  lastStepAtMs: null,
  underFloorForMs: SUSTAINED_MS + 500,
  deliveredFps: 9,
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

  it('says nothing while the encoder has not produced output yet', () => {
    // Note 6, the fault that cost this project three sessions: a fresh
    // process's first VideoEncoder pays a multi-second init, and judging inside
    // it reads as a hardware failure.
    expect(ladderVerdict({ ...failing, firstOutputAtMs: null, deliveredFps: 0 })).toBeNull()
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
})
