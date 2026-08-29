/**
 * The capture ladder — it moves the RATE and nothing else, in both directions.
 *
 * Every rule here is a way a take gets ruined, and most of them have ruined one:
 * judging inside an encoder's init read as a hardware failure (note 6, three
 * times), a still screen read as collapse (P0-ladder-static), an encoder that
 * produced NOTHING switched the ladder off entirely, and a resolution step made
 * Chrome upscale every frame back for a raw channel that could not follow.
 */
import { describe, expect, it } from 'vitest'
import {
  DEAD_ENCODER_MS,
  DELIVERY_FLOOR_RATIO,
  RATE_RUNGS,
  RECOVERY_MS,
  RECOVERY_RATIO,
  SETTLE_MS,
  SUSTAINED_MS,
  WARMUP_MS,
  ladderVerdict,
  rungsFor,
  type LadderInput,
} from './captureLadder'

/** A 60 fps take whose encoder is warm and is keeping up with nothing to spare. */
const base: LadderInput = {
  nowMs: 60_000,
  startedAtMs: 0,
  firstOutputAtMs: 1_000,
  lastStepAtMs: null,
  underFloorForMs: 0,
  aboveRecoveryForMs: 0,
  deliveredFps: 55,
  arrivedFps: 60,
  requestedFps: 60,
  currentFps: 60,
}

/** …and the same take collapsing: 10 of 60 arriving, sustained. */
const failing: LadderInput = {
  ...base,
  deliveredFps: 10,
  underFloorForMs: SUSTAINED_MS + 1,
}

/** …and the same take recovered, after a step down to 30. */
const recovered: LadderInput = {
  ...base,
  currentFps: 30,
  arrivedFps: 30,
  deliveredFps: 30,
  aboveRecoveryForMs: RECOVERY_MS + 1,
}

describe('the ladder is a RATE ladder and the floor is 30', () => {
  it('has exactly two rungs, because 30 is the product floor and 60 its ceiling', () => {
    // Robert: "but not less than 30 fps i guess".
    expect(RATE_RUNGS).toEqual([60, 30])
    expect(rungsFor(60).map((r) => r.fps)).toEqual([60, 30])
  })

  it('a 30 fps take has nothing to give and is never touched', () => {
    expect(rungsFor(30).map((r) => r.fps)).toEqual([30])
    expect(ladderVerdict({ ...failing, requestedFps: 30, currentFps: 30, arrivedFps: 30 })).toBeNull()
  })

  it('no rung carries a size — not down, not up, not ever', () => {
    for (const r of [...rungsFor(60), ...rungsFor(30)]) {
      expect(r).toEqual({ label: `${r.fps} fps`, fps: r.fps })
    }
  })
})

describe('down', () => {
  it('steps 60 → 30 when delivery stays under the floor', () => {
    const v = ladderVerdict(failing)
    expect(v?.direction).toBe('down')
    expect(v?.rung.fps).toBe(30)
  })

  it('says nothing on a bad instant — it has to be sustained', () => {
    expect(ladderVerdict({ ...failing, underFloorForMs: SUSTAINED_MS - 1 })).toBeNull()
  })

  it('says nothing while the encoder is keeping up', () => {
    expect(ladderVerdict({ ...base, underFloorForMs: SUSTAINED_MS + 1 })).toBeNull()
    // Exactly at the floor is keeping up; below it is not.
    const atFloor = { ...failing, deliveredFps: 60 * DELIVERY_FLOOR_RATIO }
    expect(ladderVerdict(atFloor)).toBeNull()
  })

  it('RULE 4: a source that sent nothing did not fail', () => {
    // P0-ladder-static: a document nobody is scrolling delivers 0 fps and that
    // is health. This cost real takes their resolution before it was fixed.
    expect(ladderVerdict({ ...failing, arrivedFps: 0, deliveredFps: 0 })).toBeNull()
  })

  it('RULE 2: an encoder inside its init is waking up, not failing', () => {
    expect(
      ladderVerdict({ ...failing, firstOutputAtMs: base.nowMs - (WARMUP_MS - 1) }),
    ).toBeNull()
  })

  it('RULE 2 HAS A CEILING: silence past any init IS the case this exists for', () => {
    // The hole that cost a whole composite: firstOutputAtMs stayed null, so the
    // rule above held forever and the watchdog killed the take at 15 s.
    const silent = { ...failing, startedAtMs: 0, firstOutputAtMs: null, deliveredFps: 0 }
    expect(ladderVerdict({ ...silent, nowMs: DEAD_ENCODER_MS - 1 })).toBeNull()
    const v = ladderVerdict({ ...silent, nowMs: DEAD_ENCODER_MS + 1 })
    expect(v?.direction).toBe('down')
    expect(v?.reason).toContain('produced NOTHING')
  })

  it('the bound sits clear of any init and under the watchdog', () => {
    expect(DEAD_ENCODER_MS).toBeGreaterThan(WARMUP_MS * 2)
    expect(DEAD_ENCODER_MS).toBeLessThan(15_000)
  })
})

describe('up — "go back to max smoothly as suffering eases"', () => {
  it('climbs 30 → 60 once delivery has been comfortable for long enough', () => {
    const v = ladderVerdict(recovered)
    expect(v?.direction).toBe('up')
    expect(v?.rung.fps).toBe(60)
  })

  it('never climbs past what the take was started at', () => {
    // 60 was never recorded on a 30 fps take and the encoder was not configured
    // for it, so there is nothing above to climb to.
    expect(ladderVerdict({ ...recovered, requestedFps: 30 })).toBeNull()
    expect(ladderVerdict({ ...recovered, currentFps: 60, arrivedFps: 60, deliveredFps: 60 })).toBeNull()
  })

  it('RULE 5: recovery is stricter and slower than collapse, so it cannot hunt', () => {
    // Merely above the floor is not recovered — the gap between the two ratios
    // is the whole anti-oscillation mechanism.
    const halfWay = { ...recovered, deliveredFps: 30 * ((DELIVERY_FLOOR_RATIO + RECOVERY_RATIO) / 2) }
    expect(ladderVerdict(halfWay)).toBeNull()
    expect(RECOVERY_RATIO).toBeGreaterThan(DELIVERY_FLOOR_RATIO)
    expect(RECOVERY_MS).toBeGreaterThan(SUSTAINED_MS)
  })

  it('a good instant is not a recovery', () => {
    expect(ladderVerdict({ ...recovered, aboveRecoveryForMs: RECOVERY_MS - 1 })).toBeNull()
  })

  it('never climbs on silence — an encoder that produced nothing has proved nothing', () => {
    expect(
      ladderVerdict({ ...recovered, firstOutputAtMs: null, nowMs: DEAD_ENCODER_MS + 1 }),
    ).toBeNull()
  })

  it('a still screen does not read as recovery either', () => {
    expect(ladderVerdict({ ...recovered, arrivedFps: 0, deliveredFps: 0 })).toBeNull()
  })
})

describe('RULE 3: one step at a time, in both directions', () => {
  it('lets a step settle before judging its result', () => {
    expect(ladderVerdict({ ...failing, lastStepAtMs: base.nowMs - (SETTLE_MS - 1) })).toBeNull()
    expect(ladderVerdict({ ...recovered, lastStepAtMs: base.nowMs - (SETTLE_MS - 1) })).toBeNull()
    expect(ladderVerdict({ ...failing, lastStepAtMs: base.nowMs - (SETTLE_MS + 1) })).not.toBeNull()
  })

  it('a take that has fallen and recovered can fall again', () => {
    const again = { ...failing, currentFps: 30, arrivedFps: 30, deliveredFps: 2 }
    // …but there is nowhere below 30 to go, which is the floor doing its job.
    expect(ladderVerdict(again)).toBeNull()
  })
})
