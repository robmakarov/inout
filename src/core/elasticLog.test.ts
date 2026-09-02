/**
 * E2 — THE ORDER OF DEFENCE IS A CLAIM, AND THIS IS WHERE IT IS CHECKED.
 *
 * Robert's ruling of 2026-09-02 is an ORDER: the unseen work goes first, the
 * burst absorber second, the picture last. Everything else in E2 is machinery
 * for obeying it; this file is the machinery for PROVING it obeyed, and the
 * report card and the E2 rig both read the same audit rather than each writing
 * their own (a rig that re-implements a gate cannot prove the product).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  auditElastic,
  elasticLogOpen,
  noteElastic,
  readElasticLog,
  resetElasticLogForTests,
  startElasticLog,
  takeElasticLog,
} from './elasticLog'
import type { ElasticEvent } from './types'

const shed = (atMs: number, layer: ElasticEvent['layer']): ElasticEvent => ({
  atMs,
  layer,
  action: 'shed',
  what: `${layer} shed`,
  why: 'test',
})
const restore = (atMs: number, layer: ElasticEvent['layer']): ElasticEvent => ({
  atMs,
  layer,
  action: 'restore',
  what: `${layer} restored`,
  why: 'test',
})

beforeEach(() => resetElasticLogForTests())

describe('the ledger only exists inside a take', () => {
  it('drops notes when no take is open — an editor drag is not a shed', () => {
    expect(elasticLogOpen()).toBe(false)
    noteElastic({ layer: 'unseen', action: 'shed', what: 'x', why: 'y' }, 1_000)
    expect(readElasticLog().events).toEqual([])
  })

  it('stamps every line on the TAKE clock, not the page clock', () => {
    startElasticLog(10_000)
    noteElastic({ layer: 'unseen', action: 'shed', what: 'x', why: 'y' }, 12_500)
    expect(readElasticLog().events[0]?.atMs).toBe(2_500)
  })

  it('closes at stop, so the next press starts empty', () => {
    startElasticLog(0)
    noteElastic({ layer: 'picture', action: 'shed', what: 'x', why: 'y' }, 1)
    expect(takeElasticLog().events).toHaveLength(1)
    expect(elasticLogOpen()).toBe(false)
    expect(readElasticLog().events).toEqual([])
  })

  it('is bounded, and says how much it dropped rather than pretending', () => {
    startElasticLog(0)
    for (let i = 0; i < 450; i++) {
      noteElastic({ layer: 'unseen', action: 'shed', what: `${i}`, why: 'y' }, i)
    }
    const log = takeElasticLog()
    expect(log.events).toHaveLength(400)
    expect(log.droppedEvents).toBe(50)
    // The OLDEST go: what a take did most recently is what a complaint is about.
    expect(log.events[0]?.what).toBe('50')
  })
})

describe('the audit grades the ORDER, not the stepping', () => {
  it('passes a take that shed the unseen work first and recovered', () => {
    const a = auditElastic({
      droppedEvents: 0,
      events: [
        shed(1_000, 'unseen'),
        shed(1_200, 'burst'),
        shed(1_400, 'picture'),
        restore(6_000, 'picture'),
        restore(6_200, 'burst'),
        restore(6_400, 'unseen'),
      ],
    })
    expect(a.ok).toBe(true)
    expect(a.pictureSheds).toBe(1)
    expect(a.pictureRecoveryMs).toEqual([4_600])
    expect(a.unrecovered).toEqual([])
    expect(a.line).toContain('order held')
  })

  it('FAILS a picture step taken while the free work was still running', () => {
    const bad = shed(1_400, 'picture')
    const a = auditElastic({ droppedEvents: 0, events: [bad, shed(2_000, 'unseen')] })
    expect(a.ok).toBe(false)
    expect(a.outOfOrder).toEqual([bad])
  })

  it('…and a picture step after the unseen work came BACK is out of order again', () => {
    // The ordering is not "was ever shed once": it is about the state of the
    // machine at the moment the picture moved.
    const late = shed(9_000, 'picture')
    const a = auditElastic({
      droppedEvents: 0,
      events: [shed(1_000, 'unseen'), restore(4_000, 'unseen'), late],
    })
    expect(a.ok).toBe(false)
    expect(a.outOfOrder).toEqual([late])
  })

  it('reports a take that ended still shed WITHOUT failing it', () => {
    // A take that stops under load legitimately ends mid-shed. Failing that is
    // the G6(g) defect — grading the attempt instead of the loss.
    const a = auditElastic({
      droppedEvents: 0,
      events: [shed(1_000, 'unseen'), shed(1_400, 'picture')],
    })
    expect(a.ok).toBe(true)
    expect(a.unrecovered).toHaveLength(2)
    expect(a.line).toContain('still shed at stop')
  })

  it('grades an empty ledger as nothing having happened', () => {
    const a = auditElastic({ droppedEvents: 0, events: [] })
    expect(a.ok).toBe(true)
    expect(a.line).toBe('nothing was shed')
  })

  it('sorts before judging — the ledger is appended from two threads worth of clocks', () => {
    const a = auditElastic({
      droppedEvents: 0,
      events: [shed(1_400, 'picture'), shed(1_000, 'unseen')],
    })
    expect(a.ok).toBe(true)
  })
})
