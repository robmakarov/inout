import { describe, expect, it } from 'vitest'
import type { CompositeRecording } from '@core/types'
import {
  compositeOffsetMs,
  compositeToRecordingSec,
  compositeWindowMs,
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
