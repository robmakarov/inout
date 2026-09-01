import { describe, expect, it } from 'vitest'
import { REVIVE_CEILING_SEC, ReviveSchedule } from './reviveSchedule'

const RATE = 48_000
const BATCH = 1024

/** Run `seconds` of unbroken silence through the schedule one worklet batch at
 *  a time and report the silence-age, in seconds, of every attempt it grants. */
function attemptsOverSilence(sched: ReviveSchedule, seconds: number, fromFrame = 0): number[] {
  const out: number[] = []
  const end = fromFrame + Math.round(seconds * RATE)
  for (let f = fromFrame; f < end; f += BATCH) {
    if (sched.silentBatch(f, BATCH)) out.push(Math.round((f + BATCH - fromFrame) / RATE))
  }
  return out
}

describe('dead-tap revive schedule', () => {
  it('climbs the shipped ladder, then holds the ceiling as its cadence', () => {
    const sched = new ReviveSchedule({ sampleRate: RATE })
    // 5/10/20/40/80 is exactly what shipped. From there the gap would have been
    // 80 s and then nothing at all; it is one minute, and it never stops.
    expect(attemptsOverSilence(sched, 330)).toEqual([5, 10, 20, 40, 80, 140, 200, 260, 320])
  })

  it('NEVER RETIRES — the defect that cost 25 minutes of a 50-minute take', () => {
    const sched = new ReviveSchedule({ sampleRate: RATE })
    // Robert's run: silence from 22.9 min to the end of a 50.4-min take. The
    // shipped ladder stopped at the sixth attempt (160 s) and made no other in
    // the 1,490 s that followed.
    const attempts = attemptsOverSilence(sched, 1650)
    expect(attempts.slice(0, 5)).toEqual([5, 10, 20, 40, 80])
    // Where the shipped ladder stopped — six attempts, the last at 160 s.
    expect(attempts.filter((at) => at <= 160)).toHaveLength(6)
    // Past it, one attempt per ceiling, forever.
    const tail = attempts.filter((at) => at >= 80)
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i]! - tail[i - 1]!).toBe(REVIVE_CEILING_SEC)
    }
    // The 1,490 s he lost after the cap would have been looked at ~25 times.
    expect(attempts.filter((at) => at > 160).length).toBeGreaterThanOrEqual(24)
  })

  it('once the ladder is climbed, no silence goes unattended longer than the ceiling', () => {
    const sched = new ReviveSchedule({ sampleRate: RATE })
    const attempts = attemptsOverSilence(sched, 3600)
    const settled = attempts.filter((at) => at >= 80)
    for (let i = 1; i < settled.length; i++) {
      expect(settled[i]! - settled[i - 1]!).toBeLessThanOrEqual(REVIVE_CEILING_SEC)
    }
    // An hour of unbroken silence ends with an attempt within the last minute,
    // not with a channel written off 55 minutes ago.
    expect(3600 - attempts[attempts.length - 1]!).toBeLessThanOrEqual(REVIVE_CEILING_SEC)
  })

  it('a channel that recovers carries no spent backoff into its next death', () => {
    const sched = new ReviveSchedule({ sampleRate: RATE })
    attemptsOverSilence(sched, 200)
    expect(sched.attempts).toBe(7)
    sched.reset() // signal returned (or the track unmuted)
    expect(sched.runStartFrame).toBeNull()
    expect(sched.attempts).toBe(0)
    expect(attemptsOverSilence(sched, 12, 200 * RATE)).toEqual([5, 10])
  })

  it('grants nothing before the base delay — a quiet passage is not a dead tap', () => {
    const sched = new ReviveSchedule({ sampleRate: RATE })
    expect(attemptsOverSilence(sched, 4.9)).toEqual([])
    expect(sched.attempts).toBe(0)
  })

  it('reports the open run so the take can testify to its silent tail', () => {
    const sched = new ReviveSchedule({ sampleRate: RATE })
    expect(sched.silentFramesAt(1000)).toBe(0)
    sched.silentBatch(10 * RATE, BATCH)
    expect(sched.runStartFrame).toBe(10 * RATE)
    expect(sched.silentFramesAt(30 * RATE)).toBe(20 * RATE)
    sched.reset()
    expect(sched.silentFramesAt(30 * RATE)).toBe(0)
  })

  it('honours a custom base and ceiling', () => {
    const sched = new ReviveSchedule({ sampleRate: RATE, baseSec: 1, ceilingSec: 4 })
    expect(attemptsOverSilence(sched, 30)).toEqual([1, 2, 4, 8, 12, 16, 20, 24, 28])
  })
})
