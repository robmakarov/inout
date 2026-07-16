import { describe, expect, it } from 'vitest'
import type { EditState, Recording } from '@core/types'
import { channelSourceTimeAt, clampEditState, defaultEditState } from '@core/timeline'
import {
  channelTimeMap,
  compose,
  cutRanges,
  invert,
  makeTimeMap,
  outputEndMs,
  outputSpanMs,
  ripple,
  sourceAt,
} from './timemap'

const seg = (outStartMs: number, outEndMs: number, srcStartMs: number, rate = 1) => ({
  outStartMs,
  outEndMs,
  srcStartMs,
  rate,
})

describe('timemap algebra', () => {
  it('sourceAt maps linearly inside segments and null in gaps', () => {
    const m = makeTimeMap([seg(0, 1000, 500), seg(2000, 3000, 5000, 2)])
    expect(sourceAt(m, 0)).toBe(500)
    expect(sourceAt(m, 999)).toBe(1499)
    expect(sourceAt(m, 1500)).toBeNull()
    expect(sourceAt(m, 2000)).toBe(5000)
    expect(sourceAt(m, 2500)).toBe(6000) // rate 2
    expect(sourceAt(m, 3000)).toBeNull() // half-open
  })

  it('rejects overlapping or degenerate segments', () => {
    expect(() => makeTimeMap([seg(0, 1000, 0), seg(500, 1500, 0)])).toThrow()
    expect(() => makeTimeMap([seg(0, 0, 0)])).toThrow()
    expect(() => makeTimeMap([{ ...seg(0, 10, 0), rate: 0 }])).toThrow()
  })

  it('span and end account for gaps', () => {
    const m = makeTimeMap([seg(0, 1000, 0), seg(2000, 2500, 0)])
    expect(outputSpanMs(m)).toBe(1500)
    expect(outputEndMs(m)).toBe(2500)
  })

  it('invert(invert(m)) == m and invert flips domains', () => {
    const m = makeTimeMap([seg(0, 1000, 500, 2), seg(1000, 2000, 4000, 0.5)])
    const inv = invert(m)
    expect(sourceAt(inv, 500)).toBe(0) // src 500 -> out 0
    expect(sourceAt(inv, 2499)).toBeCloseTo(999.5, 6)
    const round = invert(inv)
    expect(round.segments).toEqual(m.segments)
  })

  it('compose with identity is neutral', () => {
    const m = makeTimeMap([seg(0, 1000, 3000), seg(1000, 1500, 9000, 2)])
    const identity = makeTimeMap([seg(0, 1500, 0)])
    const c = compose(m, identity)
    for (const t of [0, 250, 999, 1000, 1200, 1499]) {
      expect(sourceAt(c, t)).toBe(sourceAt(m, t))
    }
  })

  it('compose multiplies rates and intersects windows', () => {
    // inner: mid [0,1000) -> src starting 100 at rate 2
    const inner = makeTimeMap([seg(0, 1000, 100, 2)])
    // outer: out [0,250) -> mid starting 500 at rate 2 (covers mid [500,1000))
    const outer = makeTimeMap([seg(0, 250, 500, 2)])
    const c = compose(inner, outer)
    expect(c.segments).toHaveLength(1)
    expect(c.segments[0].rate).toBe(4)
    // out 0 -> mid 500 -> src 100 + 500*2 = 1100
    expect(sourceAt(c, 0)).toBe(1100)
    // out 100 -> mid 700 -> src 100 + 700*2 = 1500
    expect(sourceAt(c, 100)).toBe(1500)
  })

  it('cutRanges removes output ranges and ripples the rest together', () => {
    const m = makeTimeMap([seg(0, 10_000, 0)])
    const cut = cutRanges(m, [
      { startMs: 2000, endMs: 3000 },
      { startMs: 8000, endMs: 9000 },
    ])
    expect(outputSpanMs(cut)).toBe(8000)
    expect(outputEndMs(cut)).toBe(8000)
    // Before first cut: unchanged.
    expect(sourceAt(cut, 1999)).toBe(1999)
    // After first cut: shifted by 1000.
    expect(sourceAt(cut, 2000)).toBe(3000)
    // After both cuts: shifted by 2000.
    expect(sourceAt(cut, 7500)).toBe(9500)
  })

  it('ripple packs gaps and preserves per-segment mapping', () => {
    const m = makeTimeMap([seg(1000, 2000, 0), seg(5000, 6000, 100, 3)])
    const r = ripple(m)
    expect(outputEndMs(r)).toBe(2000)
    expect(sourceAt(r, 0)).toBe(0)
    expect(sourceAt(r, 1500)).toBe(100 + 500 * 3)
  })
})

// ---------------------------------------------------------------------------
// Equivalence with the production timeline implementation
// ---------------------------------------------------------------------------

function fixtureRecording(): Recording {
  return {
    id: 'rec_fixture',
    createdAt: 0,
    durationMs: 10_000,
    channels: [
      {
        id: 'ch_screen',
        kind: 'screen',
        media: 'video',
        mimeType: 'video/webm',
        blobKey: 'k1',
        startOffsetMs: 0,
        durationMs: 10_000,
      },
      {
        id: 'ch_cam',
        kind: 'camera',
        media: 'video',
        mimeType: 'video/webm',
        blobKey: 'k2',
        startOffsetMs: 1500,
        durationMs: 7000,
      },
      {
        id: 'ch_mic',
        kind: 'mic',
        media: 'audio',
        mimeType: 'audio/webm',
        blobKey: 'k3',
        startOffsetMs: 300,
        durationMs: 9500,
      },
    ],
  }
}

function edits(r: Recording): EditState[] {
  const base = defaultEditState(r)
  const trimmed: EditState = clampEditState(r, {
    ...base,
    globalTrimStartMs: 1200,
    globalTrimEndMs: 8800,
    channels: base.channels.map((c) =>
      c.channelId === 'ch_cam'
        ? { ...c, trimStartMs: 1000, trimEndMs: 5000 }
        : c.channelId === 'ch_mic'
          ? { ...c, enabled: false }
          : c,
    ),
  })
  const weird: EditState = clampEditState(r, {
    ...base,
    globalTrimStartMs: 4000,
    globalTrimEndMs: 4100,
    channels: base.channels.map((c) => ({ ...c, trimStartMs: 50, trimEndMs: 60_000 })),
  })
  return [base, trimmed, weird]
}

describe('channelTimeMap ≡ channelSourceTimeAt (EditState is the single-segment case)', () => {
  it('agrees with the production implementation at 1ms granularity', () => {
    const r = fixtureRecording()
    for (const e of edits(r)) {
      const dur = e.globalTrimEndMs - e.globalTrimStartMs
      for (const ch of r.channels) {
        const map = channelTimeMap(r, e, ch.id)
        expect(map.segments.length).toBeLessThanOrEqual(1)
        for (let t = -5; t <= dur + 5; t += 1) {
          const expected = channelSourceTimeAt(r, e, ch.id, t)
          const actual = sourceAt(map, t)
          if (expected === null) {
            expect(actual, `ch=${ch.id} t=${t}`).toBeNull()
          } else {
            expect(actual, `ch=${ch.id} t=${t}`).toBeCloseTo(expected, 6)
          }
        }
      }
    }
  })

  it('agrees for unknown channels and disabled channels (empty maps)', () => {
    const r = fixtureRecording()
    const e = edits(r)[1]
    expect(channelTimeMap(r, e, 'nope').segments).toHaveLength(0)
    expect(channelTimeMap(r, e, 'ch_mic').segments).toHaveLength(0)
  })
})
