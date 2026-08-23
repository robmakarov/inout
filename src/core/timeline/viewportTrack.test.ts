import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIEWPORT,
  MIN_VIEWPORT_WIDTH_FRAC,
  ZOOM_MOVE_MS,
  clampViewport,
  moveViewportKeyframe,
  normalizeViewportTrack,
  viewportAt,
  viewportIsActive,
  viewportToRect,
  viewportTrackIsActive,
  writeViewportKeyframe,
  zoomAround,
} from './viewportTrack'
import type { ViewportTrack } from '../types'

describe('clampViewport', () => {
  it('never lets the visible region leave the frame', () => {
    const v = clampViewport({ xFrac: 0, yFrac: 1, widthFrac: 0.5 })
    expect(v.xFrac).toBeCloseTo(0.25, 10)
    expect(v.yFrac).toBeCloseTo(0.75, 10)
  })

  it('bounds the zoom at both ends', () => {
    expect(clampViewport({ xFrac: 0.5, yFrac: 0.5, widthFrac: 0.01 }).widthFrac).toBe(
      MIN_VIEWPORT_WIDTH_FRAC,
    )
    expect(clampViewport({ xFrac: 0.5, yFrac: 0.5, widthFrac: 4 }).widthFrac).toBe(1)
  })

  it('survives garbage', () => {
    const v = clampViewport({ xFrac: NaN, yFrac: NaN, widthFrac: NaN })
    expect(v).toEqual({ xFrac: 0.5, yFrac: 0.5, widthFrac: 1 })
  })
})

describe('viewportAt', () => {
  it('an absent track is the whole frame', () => {
    expect(viewportAt(undefined, 1234)).toEqual(DEFAULT_VIEWPORT)
    expect(viewportTrackIsActive(undefined)).toBe(false)
    expect(viewportIsActive(DEFAULT_VIEWPORT)).toBe(false)
  })

  it('holds still before the first keyframe and after the last', () => {
    const track: ViewportTrack = {
      keyframes: [
        { atMs: 1000, xFrac: 0.5, yFrac: 0.5, widthFrac: 1 },
        { atMs: 2000, xFrac: 0.3, yFrac: 0.3, widthFrac: 0.5 },
      ],
    }
    expect(viewportAt(track, 0).widthFrac).toBe(1)
    expect(viewportAt(track, 9999).widthFrac).toBeCloseTo(0.5, 10)
    expect(viewportAt(track, 9999).xFrac).toBeCloseTo(0.3, 10)
  })

  it('eases between keyframes and is exactly halfway at the midpoint', () => {
    const track: ViewportTrack = {
      keyframes: [
        { atMs: 0, xFrac: 0.5, yFrac: 0.5, widthFrac: 1 },
        { atMs: 1000, xFrac: 0.5, yFrac: 0.5, widthFrac: 0.6 },
      ],
    }
    expect(viewportAt(track, 500).widthFrac).toBeCloseTo(0.8, 6)
    // Eased, so a quarter of the way through is less than a quarter of the way there.
    expect(viewportAt(track, 250).widthFrac).toBeGreaterThan(0.9)
  })
})

describe('writeViewportKeyframe', () => {
  it('lands the move ON the playhead, with an anchor a beat before', () => {
    const track = writeViewportKeyframe(
      undefined,
      5000,
      { xFrac: 0.3, yFrac: 0.4, widthFrac: 0.5 },
      10_000,
    )
    expect(track.keyframes).toHaveLength(2)
    expect(track.keyframes[0]!.atMs).toBe(5000 - ZOOM_MOVE_MS)
    expect(track.keyframes[0]!.widthFrac).toBe(1)
    expect(track.keyframes[1]!.atMs).toBe(5000)
    expect(track.keyframes[1]!.widthFrac).toBeCloseTo(0.5, 10)
    // The frame under the playhead is the frame the user composed.
    expect(viewportAt(track, 5000).widthFrac).toBeCloseTo(0.5, 10)
  })

  it('replaces a move at the same moment instead of stacking one on it', () => {
    let track = writeViewportKeyframe(undefined, 5000, { xFrac: 0.3, yFrac: 0.4, widthFrac: 0.5 }, 10_000)
    track = writeViewportKeyframe(track, 5000, { xFrac: 0.6, yFrac: 0.6, widthFrac: 0.7 }, 10_000)
    expect(track.keyframes).toHaveLength(2)
    expect(viewportAt(track, 5000).widthFrac).toBeCloseTo(0.7, 10)
  })

  it('at the very start there is no room to ease in', () => {
    const track = writeViewportKeyframe(undefined, 0, { xFrac: 0.5, yFrac: 0.5, widthFrac: 0.5 }, 10_000)
    expect(track.keyframes).toHaveLength(1)
    expect(viewportAt(track, 0).widthFrac).toBeCloseTo(0.5, 10)
  })

  it('keeps earlier and later moves', () => {
    let track = writeViewportKeyframe(undefined, 2000, { xFrac: 0.4, yFrac: 0.4, widthFrac: 0.6 }, 10_000)
    track = writeViewportKeyframe(track, 8000, { xFrac: 0.7, yFrac: 0.7, widthFrac: 0.5 }, 10_000)
    expect(track.keyframes).toHaveLength(4)
    expect(viewportAt(track, 2000).widthFrac).toBeCloseTo(0.6, 10)
    expect(viewportAt(track, 8000).widthFrac).toBeCloseTo(0.5, 10)
    // It holds between the two moves rather than drifting.
    expect(viewportAt(track, 5000).widthFrac).toBeCloseTo(0.6, 10)
  })
})

describe('normalizeViewportTrack', () => {
  it('sorts, bounds and de-duplicates', () => {
    const track = normalizeViewportTrack(
      {
        keyframes: [
          { atMs: 9000, xFrac: 0.5, yFrac: 0.5, widthFrac: 0.5 },
          { atMs: 1000, xFrac: 0.5, yFrac: 0.5, widthFrac: 0.7 },
          { atMs: 1000, xFrac: 0.5, yFrac: 0.5, widthFrac: 0.6 },
          { atMs: NaN, xFrac: 0.5, yFrac: 0.5, widthFrac: 0.6 },
        ],
      },
      5000,
    )
    expect(track.keyframes.map((k) => k.atMs)).toEqual([1000, 5000])
    expect(track.keyframes[0]!.widthFrac).toBeCloseTo(0.6, 10)
  })
})

describe('zoomAround', () => {
  it('keeps the anchored point under the cursor', () => {
    const from = { xFrac: 0.5, yFrac: 0.5, widthFrac: 1 }
    const to = zoomAround(from, 0.5, 0.25, 0.25)
    // The anchor sat a quarter across the visible rect; after zooming it must
    // still sit a quarter across the new one.
    const rect = viewportToRect(to)
    expect((0.25 - rect.leftFrac) / rect.widthFrac).toBeCloseTo(0.25, 6)
    expect((0.25 - rect.topFrac) / rect.heightFrac).toBeCloseTo(0.25, 6)
  })

  it('clamps at the frame edge rather than showing nothing', () => {
    const to = zoomAround({ xFrac: 0.5, yFrac: 0.5, widthFrac: 1 }, 0.5, 0, 0)
    expect(to.xFrac).toBeCloseTo(0.25, 10)
    expect(to.yFrac).toBeCloseTo(0.25, 10)
  })
})

describe('viewportToRect', () => {
  it('is the whole frame at rest', () => {
    expect(viewportToRect(DEFAULT_VIEWPORT)).toEqual({
      leftFrac: 0,
      topFrac: 0,
      widthFrac: 1,
      heightFrac: 1,
    })
  })

  it('keeps the output aspect, so height tracks width in fractions', () => {
    const r = viewportToRect({ xFrac: 0.5, yFrac: 0.5, widthFrac: 0.5 })
    expect(r.heightFrac).toBeCloseTo(r.widthFrac, 10)
    expect(r.leftFrac).toBeCloseTo(0.25, 10)
    expect(r.topFrac).toBeCloseTo(0.25, 10)
  })
})

describe('moveViewportKeyframe (F2b)', () => {
  const track = (): ViewportTrack => ({
    keyframes: [
      { atMs: 1000, xFrac: 0.5, yFrac: 0.5, widthFrac: 1 },
      { atMs: 1600, xFrac: 0.3, yFrac: 0.4, widthFrac: 0.5 },
      { atMs: 4000, xFrac: 0.3, yFrac: 0.4, widthFrac: 0.5 },
      { atMs: 4600, xFrac: 0.5, yFrac: 0.5, widthFrac: 1 },
    ],
  })

  it('drags a move by its target, and the anchor comes with it', () => {
    const next = moveViewportKeyframe(track(), 1, 2500, 10_000)
    expect(next.keyframes.map((k) => k.atMs)).toEqual([1900, 2500, 4000, 4600])
    // The move keeps its duration: an ease that stretched would be a different edit.
    expect(next.keyframes[1]!.atMs - next.keyframes[0]!.atMs).toBe(600)
  })

  it('drags by the anchor too, moving the same group', () => {
    const next = moveViewportKeyframe(track(), 0, 2000, 10_000)
    expect(next.keyframes.map((k) => k.atMs)).toEqual([2000, 2600, 4000, 4600])
  })

  it('cannot be dragged past the next move', () => {
    const next = moveViewportKeyframe(track(), 1, 9000, 10_000)
    // The group stops one ms short of the next keyframe.
    expect(next.keyframes[1]!.atMs).toBe(3999)
    expect(next.keyframes[0]!.atMs).toBe(3399)
    expect(next.keyframes.map((k) => k.atMs)).toEqual([3399, 3999, 4000, 4600])
  })

  it('cannot be dragged before the take, or past its end', () => {
    const early = moveViewportKeyframe(track(), 1, -5000, 10_000)
    expect(early.keyframes[0]!.atMs).toBe(0)
    expect(early.keyframes[1]!.atMs).toBe(600)
    const late = moveViewportKeyframe(track(), 3, 999_999, 10_000)
    expect(late.keyframes[3]!.atMs).toBe(10_000)
    expect(late.keyframes[2]!.atMs).toBe(9400)
  })

  it('leaves the view itself alone — only the time moves', () => {
    const next = moveViewportKeyframe(track(), 1, 2500, 10_000)
    expect(next.keyframes[1]!.widthFrac).toBe(0.5)
    expect(next.keyframes[1]!.xFrac).toBe(0.3)
    expect(viewportAt(next, 2500)).toEqual({ xFrac: 0.3, yFrac: 0.4, widthFrac: 0.5 })
  })

  it('an out-of-range index changes nothing', () => {
    expect(moveViewportKeyframe(track(), 9, 100, 10_000).keyframes.map((k) => k.atMs)).toEqual([
      1000, 1600, 4000, 4600,
    ])
    expect(moveViewportKeyframe(undefined, 0, 100, 10_000).keyframes).toEqual([])
  })
})
