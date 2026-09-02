import { describe, expect, it } from 'vitest'
import type { CompositeRecording } from '@core/types'
import {
  compositeOffsetMs,
  compositeToRecordingSec,
  compositeWindowMs,
  copyPlacement,
  rebasedCompositeOffsetMs,
  recordingToCompositeSec,
} from './compositeTime'

const comp = (over: Partial<CompositeRecording> = {}): CompositeRecording => ({
  blobKey: 'k',
  mimeType: 'video/mp4',
  durationMs: 10_000,
  width: 1920,
  height: 1080,
  ...over,
})

describe('composite time base', () => {
  it('absent offset means the old assumption: composite time IS recording time', () => {
    expect(compositeOffsetMs(comp())).toBe(0)
    expect(compositeToRecordingSec(1.5, compositeOffsetMs(comp()))).toBe(1.5)
  })

  it('a declared offset moves composite time onto the recording timeline', () => {
    const off = compositeOffsetMs(comp({ startOffsetMs: 180 }))
    expect(off).toBe(180)
    // The composite's first frame (t=0) happened 180 ms into the take.
    expect(compositeToRecordingSec(0, off)).toBeCloseTo(0.18, 9)
    expect(compositeToRecordingSec(1, off)).toBeCloseTo(1.18, 9)
  })

  it('round trips', () => {
    const off = 133
    expect(recordingToCompositeSec(compositeToRecordingSec(2.5, off), off)).toBeCloseTo(2.5, 9)
  })

  it('an instant before the composite existed maps to negative composite time', () => {
    // The take starts at 0; the composite's first frame is at 180 ms. Asking
    // the composite for output t=0 must not quietly hand back its frame 0.
    expect(recordingToCompositeSec(0, 180)).toBeCloseTo(-0.18, 9)
  })

  it('the window is where the composite sits on the recording timeline', () => {
    expect(compositeWindowMs(comp({ startOffsetMs: 180 }))).toEqual({ startMs: 180, endMs: 10_180 })
    expect(compositeWindowMs(comp())).toEqual({ startMs: 0, endMs: 10_000 })
  })

  it('ignores a garbage offset rather than propagating NaN into every timestamp', () => {
    expect(compositeOffsetMs(comp({ startOffsetMs: NaN }))).toBe(0)
    expect(compositeOffsetMs(comp({ startOffsetMs: undefined }))).toBe(0)
  })
})

/**
 * B9 — THE STOP PATH'S ARITHMETIC AND THE COPY PATH'S, PINNED.
 *
 * The numbers are B8's census (.ai/TASKS): seven takes through the shipped
 * capture session, the composite leading the earliest channel by 64-198 ms on
 * five of them, and its own video track starting 133-300 ms into the file.
 */
describe('B9 — the composite origin is carried with its sign', () => {
  it('a composite that starts AFTER the earliest channel rebases as it always did', () => {
    // The ordinary take: nothing about this case changes.
    expect(rebasedCompositeOffsetMs(520, 400)).toBe(120)
    expect(rebasedCompositeOffsetMs(400, 400)).toBe(0)
  })

  it('a composite that LEADS keeps the lead instead of losing it to a clamp', () => {
    // Census row 5: composite origin 157.2 ms before the earliest channel. The
    // clamp made this 0 and the copied picture landed 157 ms late.
    expect(rebasedCompositeOffsetMs(262.8, 420)).toBeCloseTo(-157.2, 9)
    expect(rebasedCompositeOffsetMs(222.1, 420)).toBeCloseTo(-197.9, 9)
  })

  it('a take with no channel to rebase against shifts by nothing', () => {
    expect(rebasedCompositeOffsetMs(120, Infinity)).toBe(120)
    expect(rebasedCompositeOffsetMs(120, NaN)).toBe(120)
  })

  it('placement: an old take that declares nothing does not move a packet', () => {
    // Absent offset reads 0, and a zero shift is what keeps the copy
    // byte-identical to what those takes were always exported with.
    expect(copyPlacement(0, null)).toEqual({ shiftSec: 0, unrepresentableMs: 0 })
  })

  it('placement: a positive offset shifts forward, as it always has', () => {
    expect(copyPlacement(180, null)).toEqual({ shiftSec: 0.18, unrepresentableMs: 0 })
  })

  it('placement: a lead shorter than the file’s first key packet is recovered whole', () => {
    // Census row 3: leads by 64.5 ms, video track starts 133.3 ms in. The
    // first packet lands at 133.3 − 64.5 = 68.8 ms — still after zero.
    const p = copyPlacement(-64.5, 0.1333)
    expect(p.shiftSec).toBeCloseTo(-0.0645, 9)
    expect(p.unrepresentableMs).toBe(0)
    expect(0.1333 + p.shiftSec).toBeGreaterThan(0)
  })

  it('placement: the deepest measured lead is still recovered whole', () => {
    // Census row 7: 197.9 ms of lead against a video track starting 300 ms in.
    const p = copyPlacement(-197.9, 0.3)
    expect(p.shiftSec).toBeCloseTo(-0.1979, 9)
    expect(p.unrepresentableMs).toBe(0)
  })

  it('placement: a lead deeper than the first key packet is floored there, and says so', () => {
    // Not seen on a real take — but if it happened, the first key packet lands
    // exactly at zero rather than before it, and the remainder is counted.
    const p = copyPlacement(-198, 0.1333)
    expect(p.shiftSec).toBeCloseTo(-0.1333, 9)
    expect(p.unrepresentableMs).toBeCloseTo(64.7, 1)
    // The floor is the whole point: nothing lands before output zero.
    expect(0.1333 + p.shiftSec).toBeCloseTo(0, 9)
  })

  it('placement: a file with no key packet to floor against does not move at all', () => {
    expect(copyPlacement(-198, null)).toEqual({ shiftSec: 0, unrepresentableMs: 198 })
  })

  it('EVERY take recorded before this fix places exactly as it did', () => {
    // The gate: an old take cannot recover an origin nobody stored. It cannot
    // be harmed either, and this is why — the clamp guaranteed that every
    // stored offset is >= 0 (or absent, which reads 0), and over that whole
    // domain the new placement predicate (`shift !== 0`) and the old one
    // (`shift > 0`) are the same predicate, at the same shift.
    for (const declared of [0, 0.4, 1, 12, 52, 99, 121, 180, 244.8, 5_000]) {
      const { shiftSec, unrepresentableMs } = copyPlacement(declared, 0.1333)
      expect(shiftSec).toBeCloseTo(declared / 1000, 12)
      expect(unrepresentableMs).toBe(0)
      // old: `compOffsetSec > 0` · new: `compOffsetSec !== 0`
      expect(shiftSec !== 0).toBe(declared / 1000 > 0)
    }
  })

  it('the copy path and the read path agree about a negative origin', () => {
    // smart cut converts instead of shifting: recording t=0 sits 157 ms INTO a
    // composite that leads by 157 ms, which is the same statement.
    expect(recordingToCompositeSec(0, -157)).toBeCloseTo(0.157, 9)
    expect(compositeToRecordingSec(0.157, -157)).toBeCloseTo(0, 9)
  })
})
