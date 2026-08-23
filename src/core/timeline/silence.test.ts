import { describe, expect, it } from 'vitest'
import {
  SILENCE_DEFAULTS,
  analyzeEnvelope,
  outputSpanToRecordingSpans,
  proposeTightening,
  removeRecordingSpans,
} from './silence'
import type { EditState } from '../types'

/** 100 ms windows: `speech` and `quiet` in seconds, alternating. */
function envelope(pattern: { quiet: boolean; sec: number }[]): Float32Array {
  const out: number[] = []
  for (const p of pattern) {
    for (let i = 0; i < Math.round(p.sec * 10); i++) out.push(p.quiet ? 0.0008 : 0.12)
  }
  return Float32Array.from(out)
}

const edit = (over: Partial<EditState> = {}): EditState => ({
  recordingId: 'r',
  globalTrimStartMs: 0,
  globalTrimEndMs: 20_000,
  channels: [],
  ...over,
})

describe('analyzeEnvelope', () => {
  it('finds a long silence and pads it in from both ends', () => {
    const a = analyzeEnvelope(
      envelope([
        { quiet: false, sec: 2 },
        { quiet: true, sec: 1.5 },
        { quiet: false, sec: 2 },
      ]),
      100,
      0.12,
      0.0008,
    )
    expect(a.usable).toBe(true)
    expect(a.raw).toHaveLength(1)
    expect(a.raw[0]).toEqual({ startMs: 2000, endMs: 3500 })
    expect(a.cuts).toHaveLength(1)
    expect(a.cuts[0]).toEqual({
      startMs: 2000 + SILENCE_DEFAULTS.paddingMs,
      endMs: 3500 - SILENCE_DEFAULTS.paddingMs,
    })
  })

  it('leaves short pauses alone', () => {
    const a = analyzeEnvelope(
      envelope([
        { quiet: false, sec: 1 },
        { quiet: true, sec: 0.4 },
        { quiet: false, sec: 1 },
      ]),
      100,
      0.12,
      0.0008,
    )
    expect(a.raw).toHaveLength(1)
    expect(a.cuts).toHaveLength(0)
  })

  it('refuses a take whose loud and quiet parts are too close', () => {
    const a = analyzeEnvelope(envelope([{ quiet: false, sec: 4 }]), 100, 0.01, 0.008)
    expect(a.usable).toBe(false)
    expect(a.cuts).toHaveLength(0)
    expect(a.reason).toMatch(/no clear quiet/)
  })

  it('keeps the threshold above the take own noise floor', () => {
    // A hissy take: floor is 0.01, speech 0.12. relToLoud alone would put the
    // threshold at 0.012, barely over the hiss — relToFloor lifts it to 0.02.
    const a = analyzeEnvelope(envelope([{ quiet: false, sec: 4 }]), 100, 0.12, 0.01)
    expect(a.thresholdRms).toBeCloseTo(0.02, 6)
  })

  it('never lets the threshold reach speech level', () => {
    const a = analyzeEnvelope(envelope([{ quiet: false, sec: 4 }]), 100, 0.1, 0.03)
    expect(a.thresholdRms).toBeCloseTo(0.1 * SILENCE_DEFAULTS.maxRelToLoud, 6)
  })
})

describe('output → recording mapping', () => {
  it('is a shift when there are no cuts', () => {
    const e = edit({ globalTrimStartMs: 1000, globalTrimEndMs: 9000 })
    expect(outputSpanToRecordingSpans(e, { startMs: 500, endMs: 1500 })).toEqual([
      { startMs: 1500, endMs: 2500 },
    ])
  })

  it('splits a span that crosses an existing cut', () => {
    const e = edit({
      segments: [
        { startMs: 0, endMs: 2000 },
        { startMs: 5000, endMs: 8000 },
      ],
    })
    // Output 1500-2500 is 1500-2000 in the first span and 5000-5500 in the second.
    expect(outputSpanToRecordingSpans(e, { startMs: 1500, endMs: 2500 })).toEqual([
      { startMs: 1500, endMs: 2000 },
      { startMs: 5000, endMs: 5500 },
    ])
  })
})

describe('removeRecordingSpans', () => {
  it('cuts a hole in the middle', () => {
    const e = edit({ globalTrimEndMs: 10_000 })
    expect(removeRecordingSpans(e, [{ startMs: 4000, endMs: 6000 }])).toEqual([
      { startMs: 0, endMs: 4000 },
      { startMs: 6000, endMs: 10_000 },
    ])
  })

  it('drops slivers instead of leaving segments nobody can grab', () => {
    const e = edit({ globalTrimEndMs: 10_000 })
    const out = removeRecordingSpans(e, [{ startMs: 100, endMs: 6000 }])
    expect(out).toEqual([{ startMs: 6000, endMs: 10_000 }])
  })

  it('handles several cuts in one pass', () => {
    const e = edit({ globalTrimEndMs: 12_000 })
    const out = removeRecordingSpans(e, [
      { startMs: 2000, endMs: 3000 },
      { startMs: 7000, endMs: 9000 },
    ])
    expect(out).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 3000, endMs: 7000 },
      { startMs: 9000, endMs: 12_000 },
    ])
  })
})

describe('proposeTightening', () => {
  it('is null when nothing is worth cutting', () => {
    const a = analyzeEnvelope(envelope([{ quiet: false, sec: 4 }]), 100, 0.12, 0.0008)
    expect(proposeTightening(edit(), a)).toBeNull()
  })

  it('reports what it would remove without touching the edit', () => {
    const e = edit({ globalTrimEndMs: 10_000 })
    const a = analyzeEnvelope(
      envelope([
        { quiet: false, sec: 2 },
        { quiet: true, sec: 2 },
        { quiet: false, sec: 6 },
      ]),
      100,
      0.12,
      0.0008,
    )
    const p = proposeTightening(e, a)!
    expect(p.segments).toEqual([
      { startMs: 0, endMs: 2000 + SILENCE_DEFAULTS.paddingMs },
      { startMs: 4000 - SILENCE_DEFAULTS.paddingMs, endMs: 10_000 },
    ])
    expect(p.removedMs).toBe(2000 - 2 * SILENCE_DEFAULTS.paddingMs)
    // The proposal is data; the caller's edit is untouched.
    expect(e.segments).toBeUndefined()
  })
})
