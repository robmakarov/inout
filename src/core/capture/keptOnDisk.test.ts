import { describe, expect, it } from 'vitest'
import { keepChannel } from './keptOnDisk'

/**
 * H5 — the take stops deleting what it just wrote.
 *
 * The defect these pin, in one line: `bytes` comes from the stop REPLY, the
 * wait for that reply is bounded at 5 s, and a channel that missed the budget
 * was therefore indistinguishable from one that recorded nothing — so its file
 * was removed and the report card said the device never delivered a byte.
 */
describe('what a finished take keeps', () => {
  it('answers from the reply when the reply came — the normal take costs nothing', () => {
    const v = keepChannel({ replyBytes: 12_000_000, diskBytes: 0, probedMs: 0, knownMs: 30_000, wallClockMs: 30_200 })
    expect(v).toEqual({ keep: true, bytes: 12_000_000, durationMs: 30_000, source: 'reply' })
  })

  it('keeps a channel whose stop timed out, at the length the FILE has', () => {
    // H1's rig, 2026-09-02: screen and camera armed at +120 ms, delivering
    // 1920x1080 all take, and both absent from the finished take.
    const v = keepChannel({ replyBytes: 0, diskBytes: 48_000_000, probedMs: 119_800, wallClockMs: 120_400 })
    expect(v.keep).toBe(true)
    expect(v.bytes).toBe(48_000_000)
    expect(v.durationMs).toBe(119_800)
    expect(v.source).toBe('demuxed')
  })

  it('prefers the demuxed length over the wall clock, because the tail may be unflushed', () => {
    // The clock says 120.4 s; the file has 119.8 s. Believing the clock would
    // claim material the file does not have and slide every other channel
    // against this one.
    const v = keepChannel({ replyBytes: 0, diskBytes: 1, probedMs: 119_800, wallClockMs: 120_400 })
    expect(v.durationMs).toBe(119_800)
  })

  it('falls back to the clock only when the file will not say how long it is', () => {
    const v = keepChannel({ replyBytes: 0, diskBytes: 7_000_000, probedMs: 0, wallClockMs: 61_000 })
    expect(v).toEqual({ keep: true, bytes: 7_000_000, durationMs: 61_000, source: 'wall clock' })
  })

  it('prefers a length the channel already knew over the clock', () => {
    // The MediaRecorder path stamps durationMs at the last live frame, before
    // the drain; that is a better answer than "now minus the start".
    const v = keepChannel({ replyBytes: 0, diskBytes: 5, probedMs: 0, knownMs: 9_900, wallClockMs: 11_500 })
    expect(v.durationMs).toBe(9_900)
    expect(v.source).toBe('wall clock')
  })

  it('still removes a channel the disk agrees is empty', () => {
    // A closed-lid camera writes a 28-byte file and delivers nothing; a take
    // that keeps it is lying in the other direction, and the file is the orphan
    // reclaim.ts exists to prevent.
    const v = keepChannel({ replyBytes: 0, diskBytes: 0, probedMs: 0, wallClockMs: 30_000 })
    expect(v).toEqual({ keep: false, bytes: 0, durationMs: 0, source: 'empty' })
  })

  it('never reports a negative length, whatever the clocks did', () => {
    const v = keepChannel({ replyBytes: 0, diskBytes: 10, probedMs: 0, wallClockMs: -5 })
    expect(v.durationMs).toBe(0)
  })
})
