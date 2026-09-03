/**
 * THE DOOR — task M1. What it records, when, and what it refuses to pretend.
 *
 * The behaviours under test are the ones the audit of 2026-09-02 was written
 * about: a decision that was REFUSED is not a shed, a decision taken while the
 * take was being armed belongs to that take, and the elastic ledger has exactly
 * one writer.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  adoptDoorDecision,
  armDoor,
  openDoor,
  passDoor,
  readDoorLog,
  resetDoorForTests,
  takeDoorLog,
} from './door'
import {
  auditElastic,
  readElasticLog,
  resetElasticLogForTests,
  startElasticLog,
  takeElasticLog,
} from './elasticLog'

beforeEach(() => {
  resetDoorForTests()
  resetElasticLogForTests()
})

/** A rate step, as the ladder makes it. */
function rateStep(nowMs: number, from: number, to: number, apply: () => void = () => undefined) {
  return passDoor(
    {
      dial: 'rate',
      decidedBy: 'ladder',
      layer: 'picture',
      action: to < from ? 'shed' : 'restore',
      what: `${from} → ${to} fps`,
      why: 'pressure critical with the unseen work already shed',
      block: 'encoder',
      level: 'critical',
      nowMs,
    },
    apply,
  )
}

describe('passing through the door', () => {
  it('records the decision as the act of making it', () => {
    armDoor()
    openDoor(1000)
    let applied = false
    rateStep(2000, 60, 30, () => {
      applied = true
    })
    expect(applied).toBe(true)
    const { decisions } = readDoorLog()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      atMs: 1000,
      dial: 'rate',
      decidedBy: 'ladder',
      action: 'shed',
      outcome: 'applied',
      block: 'encoder',
      level: 'critical',
    })
  })

  it('records a REFUSAL as a refusal, not as a step', () => {
    // The defect this removes, in one test: liveCompositeV2 wrote the ledger
    // line at the VERDICT, and session.ts then refused to step in max mode. A
    // max take under load carried `60 → 30 fps` having never moved a frame.
    armDoor()
    openDoor(0)
    startElasticLog(0)
    rateStep(500, 60, 30, () => {
      /* max says no */
    })
    passDoor(
      {
        dial: 'rate',
        decidedBy: 'ladder',
        layer: 'picture',
        action: 'shed',
        what: '60 → 30 fps',
        why: 'pressure critical',
        nowMs: 600,
      },
      (t) => t.refuse('max mode: nothing steps down in max'),
    )
    const { decisions } = readDoorLog()
    expect(decisions.map((d) => d.outcome)).toEqual(['applied', 'refused'])
    expect(decisions[1]?.outcomeWhy).toContain('max mode')
    // AND THE ELASTIC LEDGER ONLY CARRIES THE ONE THAT HAPPENED.
    expect(readElasticLog().events).toHaveLength(1)
  })

  it('records a failure when the platform refuses the constraint', async () => {
    armDoor()
    openDoor(0)
    await expect(
      passDoor(
        {
          dial: 'resolution',
          decidedBy: 'budget',
          action: 'shed',
          what: 'screen → 1920 long edge',
          why: 'over this machine’s earned budget',
          nowMs: 10,
        },
        () => Promise.reject(new Error('OverconstrainedError')),
      ),
    ).rejects.toThrow('OverconstrainedError')
    const { decisions } = readDoorLog()
    expect(decisions[0]?.outcome).toBe('failed')
    expect(decisions[0]?.outcomeWhy).toContain('OverconstrainedError')
  })

  it('passes the caller’s value and error through untouched', async () => {
    armDoor()
    openDoor(0)
    const sync = passDoor(
      { dial: 'quality', decidedBy: 'codec', action: 'set', what: 'avc', why: 'floor', nowMs: 1 },
      () => 42,
    )
    expect(sync).toBe(42)
    const async = await passDoor(
      { dial: 'quality', decidedBy: 'codec', action: 'set', what: 'avc', why: 'floor', nowMs: 2 },
      () => Promise.resolve('ok'),
    )
    expect(async).toBe('ok')
  })

  it('keeps what the platform actually gave, not what was asked for', async () => {
    armDoor()
    openDoor(0)
    await passDoor(
      {
        dial: 'rate',
        decidedBy: 'ladder',
        action: 'shed',
        what: '60 → 30 fps',
        why: 'pressure',
        measured: { fps: 60 },
        nowMs: 5,
      },
      async (t) => {
        await Promise.resolve()
        t.note({ fpsAfter: 24 })
      },
    )
    expect(readDoorLog().decisions[0]?.measured).toEqual({ fps: 60, fpsAfter: 24 })
  })
})

describe('the take’s window', () => {
  it('keeps arming decisions, and they read negative', () => {
    armDoor()
    // The encoder budget, taken before the take has a clock.
    passDoor(
      {
        dial: 'resolution',
        decidedBy: 'budget',
        action: 'shed',
        what: 'screen 3024x1964 → 1920 long edge',
        why: 'over the earned budget',
        nowMs: 800,
      },
      () => undefined,
    )
    openDoor(1000)
    rateStep(3000, 60, 30)
    const log = takeDoorLog()
    expect(log.decisions.map((d) => d.atMs)).toEqual([-200, 2000])
  })

  it('does not hand a take the decisions of an export that ran between takes', () => {
    // A codec rung skipped while no take is open belongs to nobody.
    passDoor(
      { dial: 'quality', decidedBy: 'codec', action: 'shed', what: 'av1 rung skipped', why: 'no hw', nowMs: 0 },
      () => undefined,
    )
    armDoor()
    openDoor(100)
    rateStep(200, 60, 30)
    const log = takeDoorLog()
    expect(log.decisions).toHaveLength(1)
    expect(log.decisions[0]?.dial).toBe('rate')
    // …and it is still readable in the ring, which is the session's own view.
    expect(readDoorLog().decisions).toHaveLength(2)
  })

  it('is bounded, and says how many it dropped', () => {
    armDoor()
    openDoor(0)
    for (let i = 0; i < 450; i++) rateStep(i, 60, 30)
    const log = takeDoorLog()
    expect(log.decisions).toHaveLength(400)
    expect(log.droppedDecisions).toBe(50)
  })
})

describe('one write, two views', () => {
  it('mirrors the order of defence into E2’s ledger and nothing else', () => {
    startElasticLog(0)
    armDoor()
    openDoor(0)
    passDoor(
      {
        dial: 'work',
        decidedBy: 'broker',
        layer: 'unseen',
        action: 'shed',
        what: 'background work full → paused',
        why: 'serious',
        nowMs: 100,
      },
      () => undefined,
    )
    rateStep(200, 60, 30)
    // A decision with NO layer is not part of the order of defence and must not
    // reach the ledger the ordering is graded from.
    passDoor(
      {
        dial: 'channels',
        decidedBy: 'watchdog',
        action: 'shed',
        what: 'the live composite stopped being recorded',
        why: 'encoder produced nothing in 15 s',
        nowMs: 300,
      },
      () => undefined,
    )
    const elastic = takeElasticLog()
    expect(elastic.events.map((e) => e.layer)).toEqual(['unseen', 'picture'])
    // and the order the ruling is about still reads as held
    expect(auditElastic(elastic).ok).toBe(true)
    expect(takeDoorLog().decisions).toHaveLength(3)
  })

  it('mirrors nothing when no take is open', () => {
    // An editor-time pace change is not a shed (elasticLog's own rule), and the
    // door must not smuggle one in.
    passDoor(
      {
        dial: 'work',
        decidedBy: 'broker',
        layer: 'unseen',
        action: 'shed',
        what: 'background work full → half',
        why: 'the editor is busy',
        nowMs: 0,
      },
      () => undefined,
    )
    expect(readElasticLog().events).toHaveLength(0)
    expect(readDoorLog().decisions).toHaveLength(1)
  })
})

describe('a decision taken inside a worker', () => {
  it('is adopted into the take’s ledger and says so', () => {
    startElasticLog(0)
    armDoor()
    openDoor(0)
    adoptDoorDecision(
      {
        dial: 'quality',
        decidedBy: 'absorber',
        layer: 'burst',
        action: 'shed',
        what: 'encoder burst absorber engaged (3 frames held)',
        why: 'queue past its steady bound',
        outcome: 'applied',
      },
      500,
    )
    const { decisions } = readDoorLog()
    expect(decisions[0]).toMatchObject({ fromWorker: true, atMs: 500, outcome: 'applied' })
    expect(readElasticLog().events.map((e) => e.layer)).toEqual(['burst'])
  })
})

describe('the witness never kills what it watches', () => {
  it('survives a measured value that cannot be serialised', () => {
    armDoor()
    openDoor(0)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() =>
      passDoor(
        {
          dial: 'rate',
          decidedBy: 'ladder',
          action: 'shed',
          what: 'x',
          why: 'y',
          measured: circular as never,
          nowMs: 0,
        },
        () => undefined,
      ),
    ).not.toThrow()
  })
})
