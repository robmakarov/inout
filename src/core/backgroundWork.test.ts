import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPressure, type PressureSignals } from './pressure'
import {
  EDITING_QUIET_MS,
  EDITOR_OPENING_MAX_MS,
  RAMP_UP_AFTER_MS,
  backgroundWorkState,
  currentPace,
  noteEditingActivity,
  noteEditorOpen,
  noteEditorOpening,
  noteTakeActive,
  noteTakePressure,
  onBackgroundWorkChange,
  resetBackgroundWorkForTests,
  setBackgroundPace,
} from './backgroundWork'

/**
 * F16b's policy, which is the whole of Robert's ruling in one table: the
 * background render is PARALLEL to a take and it is the FIRST thing shed.
 * These pin the two ways it could be wrong — spending the machine while a take
 * is in trouble, and refusing to spend it when nothing is wrong.
 */

/** Signals that read at a chosen strain, with everything else unmeasured. */
function signalsAt(queueMean: number | null): PressureSignals {
  return {
    intervalMs: 250,
    frameBudgetMs: 1000 / 60,
    queueMean,
    queueCliff: 8,
    encodeLatencyMs: null,
    workerLateMeanMs: null,
    workerLateMaxMs: null,
    perFrameCostMs: null,
    gpuPerFrameMs: null,
    stale: null,
    arrivals: null,
    dropped: 0,
    burst: 0,
    platform: null,
  }
}

const nominal = (): void => noteTakePressure(readPressure(signalsAt(0.4))) // strain 0.05
const fair = (): void => noteTakePressure(readPressure(signalsAt(4.4))) // strain 0.55
const serious = (): void => noteTakePressure(readPressure(signalsAt(6.4))) // strain 0.80
const blind = (): void => noteTakePressure(readPressure(signalsAt(null)))

afterEach(() => {
  vi.useRealTimers()
  resetBackgroundWorkForTests()
})

describe('what a background job may spend', () => {
  it('runs flat out when no take is recording — there is nothing to be polite to', () => {
    expect(currentPace()).toBe('full')
    expect(backgroundWorkState().why).toContain('no take')
  })

  it('a take starting sheds the job at once, before any reading has arrived', () => {
    noteTakeActive(true)
    expect(currentPace()).toBe('paused')
    expect(backgroundWorkState().why).toContain('nothing readable')
  })

  /**
   * THE INVERSION OF E1's RULE, on purpose. A blind reading must not fire a
   * capture step (a detector that fires because it cannot see steps a healthy
   * take down). Here the thing that gets shed is the JOB, and the asymmetry
   * runs the other way: a late pre-render costs nothing that cannot be
   * re-earned, a damaged take cannot be re-recorded.
   */
  it('a blind reading sheds rather than passes', () => {
    noteTakeActive(true)
    blind()
    expect(currentPace()).toBe('paused')
  })

  it('serious pressure pauses the job — shed before anything of the take is', () => {
    noteTakeActive(true)
    nominal()
    serious()
    expect(currentPace()).toBe('paused')
    expect(backgroundWorkState().why).toContain('serious')
  })

  it('fair pressure trickles rather than stopping: parallel, not paused', () => {
    noteTakeActive(true)
    fair()
    expect(currentPace()).toBe('trickle')
  })

  it('ramps back a rung at a time once the reading has been clear long enough', () => {
    vi.useFakeTimers()
    noteTakeActive(true)
    serious()
    expect(currentPace()).toBe('paused')
    nominal()
    // Clear, but not yet for long enough: the climb is deliberate where the
    // step down is immediate.
    expect(currentPace()).toBe('trickle')
    vi.advanceTimersByTime(RAMP_UP_AFTER_MS + 50)
    nominal()
    expect(currentPace()).toBe('half')
  })

  it('a reading that stops arriving expires — silence during a take is blind, not healthy', () => {
    vi.useFakeTimers()
    noteTakeActive(true)
    nominal()
    vi.advanceTimersByTime(RAMP_UP_AFTER_MS + 50)
    nominal()
    expect(currentPace()).toBe('half')
    vi.advanceTimersByTime(2000)
    expect(currentPace()).toBe('paused')
  })

  it('the take ending gives the machine back immediately', () => {
    noteTakeActive(true)
    serious()
    expect(currentPace()).toBe('paused')
    noteTakeActive(false)
    expect(currentPace()).toBe('full')
  })

  /**
   * CAPTURE > EDITING > BACKGROUND RENDER, and the middle term is not a
   * comment: a hand on the editor outranks a render nobody asked for yet.
   */
  it('a hand on the editor steps the job down, and lets go when the hand does', () => {
    vi.useFakeTimers()
    noteEditingActivity()
    expect(currentPace()).toBe('trickle')
    expect(backgroundWorkState().why).toContain('hand')
    vi.advanceTimersByTime(EDITING_QUIET_MS + 50)
    expect(currentPace()).toBe('full')
  })

  /**
   * The other half of the same rule, and the one Robert's black screen came
   * from: at the end of a long take the at-stop pre-render is already running
   * FULL, because the take is over and nobody has touched anything yet.
   */
  it('the editor OPENING steps the job down before any hand touches it', () => {
    vi.useFakeTimers()
    expect(currentPace()).toBe('full')
    noteEditorOpening()
    expect(currentPace()).toBe('trickle')
    expect(backgroundWorkState().why).toContain('editor is opening')
    noteEditorOpen()
    expect(currentPace()).toBe('full')
  })

  it('a re-render cannot extend the opening window, and the window expires by itself', () => {
    vi.useFakeTimers()
    noteEditorOpening()
    vi.advanceTimersByTime(EDITOR_OPENING_MAX_MS - 100)
    // Idempotent: this must NOT restart the clock.
    noteEditorOpening()
    vi.advanceTimersByTime(200)
    expect(currentPace()).toBe('full')
  })

  it('a take outranks the editor — an opening editor cannot lift the shed', () => {
    noteTakeActive(true)
    serious()
    noteEditorOpening()
    expect(currentPace()).toBe('paused')
  })

  it('a take outranks the editor — a hand on it cannot lift the shed', () => {
    noteEditingActivity()
    noteTakeActive(true)
    serious()
    noteEditingActivity()
    expect(currentPace()).toBe('paused')
  })

  /** The frozen rule's runtime fallback, and the gate's own positive control. */
  it('?bgpace=0 gives back the unthrottled behaviour, whatever the pressure says', () => {
    setBackgroundPace(false)
    noteTakeActive(true)
    serious()
    expect(currentPace()).toBe('full')
    expect(backgroundWorkState().why).toContain('brake is off')
    setBackgroundPace(true)
    expect(currentPace()).toBe('paused')
  })

  it('a subscriber is told the current state at once and on every change', () => {
    const seen: string[] = []
    const off = onBackgroundWorkChange((s) => seen.push(s.pace))
    noteTakeActive(true)
    serious()
    noteTakeActive(false)
    off()
    noteTakeActive(true)
    expect(seen[0]).toBe('full')
    expect(seen).toContain('paused')
    expect(seen[seen.length - 1]).toBe('full')
  })
})
