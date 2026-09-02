import { describe, expect, it } from 'vitest'
import {
  COOLDOWN_MS,
  MAX_PER_CHANNEL,
  containVerdict,
  exhaustedWhy,
  type ContainCause,
} from './segmentContain'
import { faultDelayMs, parseFaults } from './faultInject'

const base = {
  kind: 'screen' as const,
  cause: 'encoder-error' as ContainCause,
  nowMs: 10_000,
  lastContainAtMs: null,
  containsTaken: 0,
}

describe('containVerdict — H1 thrash rules', () => {
  it('contains the first death of a channel', () => {
    expect(containVerdict(base)?.why).toContain('screen encoder-error')
  })

  it('names the segments it is closing and opening', () => {
    const v = containVerdict({ ...base, containsTaken: 2 })
    // Three deaths in, the take is on segment 3 and about to open segment 4.
    expect(v?.why).toContain('segment 3 closed')
    expect(v?.why).toContain('opening segment 4')
  })

  it('REFUSES INSIDE THE COOLDOWN — an encoder that dies on open would spin', () => {
    expect(
      containVerdict({ ...base, containsTaken: 1, lastContainAtMs: 10_000 - (COOLDOWN_MS - 1) }),
    ).toBeNull()
  })

  it('contains again once the cooldown has passed', () => {
    expect(
      containVerdict({ ...base, containsTaken: 1, lastContainAtMs: 10_000 - COOLDOWN_MS }),
    ).not.toBeNull()
  })

  it('REFUSES PAST THE BUDGET — a permanently sick encoder is not resurrected forever', () => {
    expect(
      containVerdict({ ...base, containsTaken: MAX_PER_CHANNEL, lastContainAtMs: 0 }),
    ).toBeNull()
  })

  it('spends the budget one below the ceiling', () => {
    expect(
      containVerdict({ ...base, containsTaken: MAX_PER_CHANNEL - 1, lastContainAtMs: 0 }),
    ).not.toBeNull()
  })

  it('the budget is PER CHANNEL — a sick camera does not spend the screen’s', () => {
    // The caller keeps one counter per kind; this pins that the verdict reads
    // only the counter it is handed, so nothing here is take-global.
    const camera = containVerdict({
      ...base,
      kind: 'camera',
      containsTaken: MAX_PER_CHANNEL,
      lastContainAtMs: 0,
    })
    const screen = containVerdict({ ...base, containsTaken: 0 })
    expect(camera).toBeNull()
    expect(screen).not.toBeNull()
  })

  it('says why it gave up, naming the budget', () => {
    expect(exhaustedWhy('mic', 'worker-death')).toContain(`${MAX_PER_CHANNEL} contained segments`)
    expect(exhaustedWhy('mic', 'worker-death')).toContain('the take continues')
  })
})

describe('faultInject — the induced-death knobs', () => {
  it('parses one kind and its instant', () => {
    expect([...parseFaults('?killenc=screen:6000', 'killenc')]).toEqual([['screen', 6000]])
  })

  it('parses several, comma-separated, like ?die=', () => {
    expect([...parseFaults('?killenc=screen:6000,mic:9000', 'killenc')]).toEqual([
      ['screen', 6000],
      ['mic', 9000],
    ])
  })

  it('?killworker is VIDEO ONLY — no audio channel has a worker', () => {
    expect([...parseFaults('?killworker=mic:6000,screen:1000', 'killworker')]).toEqual([
      ['screen', 1000],
    ])
  })

  it('ignores junk rather than arming something unintended', () => {
    expect(parseFaults('?killenc=notachannel:100', 'killenc').size).toBe(0)
    expect(parseFaults('?killenc=screen:abc', 'killenc').size).toBe(0)
    expect(parseFaults('?killenc=screen:-5', 'killenc').size).toBe(0)
    expect(parseFaults('', 'killenc').size).toBe(0)
  })

  it('is inert with no location — the module holds no clock and no DOM', () => {
    // Node has no `location`; faultDelayMs must be a no-op rather than a throw,
    // which is what lets session.ts call it unconditionally.
    expect(faultDelayMs('screen', 'killenc', 0)).toBeNull()
  })
})
