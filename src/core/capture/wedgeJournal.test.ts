import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetWedgeJournal,
  appendWedgeJournal,
  noteBootPhase,
  readWedgeJournal,
  watchBootLiveness,
} from './wedgeJournal'

/**
 * The case file's blocker, 2026-08-30: everything a wedge knows was printed to
 * a console Robert has ruled out and shipped to an analytics sink that is a
 * noop in production, so two field reports of "it goes unresponsive after the
 * refresh" are still unconvicted. These cases pin the properties that make the
 * journal readable off a machine afterwards, with nothing asked of the user.
 */

afterEach(() => {
  __resetWedgeJournal()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the wedge journal', () => {
  it('dates every entry, oldest first', () => {
    appendWedgeJournal({ kind: 'wedge', stall: 'wedge', level: 3, count: 7, t: 1_000 })
    appendWedgeJournal({ kind: 'reload', t: 2_000 })
    expect(readWedgeJournal().map((e) => [e.t, e.kind])).toEqual([
      [1_000, 'wedge'],
      [2_000, 'reload'],
    ])
  })

  it('is a ring — a bad night cannot grow storage without limit', () => {
    for (let i = 0; i < 40; i++) appendWedgeJournal({ kind: 'reload', t: i })
    const all = readWedgeJournal()
    expect(all).toHaveLength(24)
    // The NEWEST survive: the story that matters is the one being reported now.
    expect(all[all.length - 1]?.t).toBe(39)
  })

  it('a refused localStorage costs the session nothing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => undefined,
    })
    __resetWedgeJournal()
    expect(() => appendWedgeJournal({ kind: 'boot', phase: 'script' })).not.toThrow()
    expect(readWedgeJournal()).toHaveLength(1)
  })
})

describe('boot liveness', () => {
  /** A visible tab whose timer comes back late by N seconds was gone for N
   *  seconds — which is the whole of "the app goes unresponsive". */
  it('records a main-thread block the user would call unresponsive', () => {
    vi.useFakeTimers()
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })
    let clock = 0
    watchBootLiveness(1_200, { now: () => clock })
    // The warm-up names its step before each await; the block is filed under
    // the last name, so the entry says WHERE the boot froze, not only how long.
    noteBootPhase('warm:worklet')
    clock = 3_000 // the tick due at 500 ms ran at 3 s: 2.5 s of nothing
    vi.advanceTimersByTime(500)
    const blocks = readWedgeJournal().filter((e) => e.kind === 'block')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.blockedMs).toBe(2_500)
    expect(blocks[0]?.phase).toBe('warm:worklet')
    // Dated from the reload, not from the watch, so the entry says how long
    // after the refresh the app went away.
    expect(blocks[0]?.sinceReloadMs).toBe(4_200)
  })

  /**
   * THE RETRACTED "FOUND IT" MUST NOT COME BACK. A hidden tab's timers are
   * throttled by Chrome — the case file already spent one session convicting
   * that artifact as main-thread jank. A tick is believed only when the tab
   * was visible for the whole interval.
   */
  it('never mistakes a background tab for a frozen one', () => {
    vi.useFakeTimers()
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })
    let clock = 0
    watchBootLiveness(0, { now: () => clock })
    clock = 60_000
    vi.advanceTimersByTime(500)
    expect(readWedgeJournal().filter((e) => e.kind === 'block')).toHaveLength(0)
  })

  it('stops itself — a healthy boot pays one timer and then nothing', () => {
    vi.useFakeTimers()
    let clock = 0
    const stop = watchBootLiveness(0, { now: () => clock, windowMs: 2_000 })
    for (let i = 1; i <= 6; i++) {
      clock = i * 500
      vi.advanceTimersByTime(500)
    }
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })
})
