import { describe, expect, it } from 'vitest'
import { changedBlobs, emptyDelta, gridDelta, makeGrid, type LumaGrid } from './delta'
import { initSelector, keyframeMinGapMs, stepSelection, type Decision } from './select'

const FPS = 4

function screen(level = 128): LumaGrid {
  const g = makeGrid()
  g.data.fill(level)
  return g
}

function paint(g: LumaGrid, x: number, y: number, w: number, h: number, level: number): LumaGrid {
  const out: LumaGrid = { cols: g.cols, rows: g.rows, data: new Uint8Array(g.data) }
  for (let j = Math.max(0, y); j < Math.min(g.rows, y + h); j++) {
    for (let i = Math.max(0, x); i < Math.min(g.cols, x + w); i++) out.data[j * g.cols + i] = level
  }
  return out
}

/**
 * The production loop, exactly: two diffs per sample (against the last emitted
 * keyframe and against the previous sample), blobs from the second, and the
 * reference advancing only when a page is actually emitted.
 */
function run(frames: LumaGrid[]): Decision[] {
  const durationMs = (frames.length * 1000) / FPS
  let state = initSelector(durationMs)
  let ref: LumaGrid | null = null
  let prev: LumaGrid | null = null
  const out: Decision[] = []
  frames.forEach((f, i) => {
    const step = stepSelection(state, {
      index: i,
      atOutMs: (i * 1000) / FPS,
      atRecMs: (i * 1000) / FPS,
      vsRef: ref ? gridDelta(ref, f) : emptyDelta(),
      vsPrev: prev ? gridDelta(prev, f) : emptyDelta(),
      blobsVsPrev: prev ? changedBlobs(prev, f) : [],
    })
    state = step.state
    if (step.decision.keyframe) ref = f
    prev = f
    out.push(step.decision)
  })
  return out
}

const keyframes = (d: Decision[]): number[] =>
  d.map((x, i) => (x.keyframe ? i : -1)).filter((i) => i >= 0)

/** 24 px cursor at 1080p ≈ 2×2 cells of a 160×90 grid. */
const CURSOR = 2

describe('keyframe selection — the economy claims', () => {
  it('always emits the first sample and nothing else while the picture is still', () => {
    const d = run(Array.from({ length: 40 }, () => screen()))
    expect(keyframes(d)).toEqual([0])
  })

  it('a 60 s mostly-static take stays under the page budget', () => {
    // Static, with one 5 s burst of full-frame motion in the middle.
    const frames = Array.from({ length: 60 * FPS }, (_, i) => {
      if (i < 20 * FPS || i >= 25 * FPS) return screen()
      return paint(screen(), 0, 0, 160, 90, 60 + ((i * 37) % 160))
    })
    const d = run(frames)
    const ks = keyframes(d)
    expect(ks.length).toBeLessThanOrEqual(8)
    // And they are concentrated INSIDE the burst, not spread over the still part.
    const inside = ks.filter((i) => i >= 20 * FPS && i <= 26 * FPS).length
    expect(inside).toBeGreaterThanOrEqual(ks.length - 1)
  })

  it('paces itself by the take’s own length, never by a setting', () => {
    expect(keyframeMinGapMs(30_000)).toBe(500)
    expect(keyframeMinGapMs(60_000)).toBe(1000)
    expect(keyframeMinGapMs(600_000)).toBe(10_000)
    // A very long take is capped, so pages never stop entirely.
    expect(keyframeMinGapMs(60 * 60_000)).toBe(15_000)
  })

  it('a change held back by the pace is not lost — it fires at the next allowed instant', () => {
    // 30 s take ⇒ 500 ms floor ⇒ every other sample may be a page.
    const frames = Array.from({ length: 30 * FPS }, (_, i) =>
      i === 0 ? screen() : paint(screen(), 0, 0, 160, 45, 20 + i),
    )
    const d = run(frames)
    const ks = keyframes(d)
    expect(ks[0]).toBe(0)
    expect(ks[1]).toBe(2)
    for (let i = 1; i < ks.length; i++) expect(ks[i]! - ks[i - 1]!).toBeGreaterThanOrEqual(2)
  })
})

describe('keyframe selection — the cursor taxonomy (PO’s hard gate)', () => {
  it('a cursor wandering over a static screen costs ONE page, the first', () => {
    const path = [
      [10, 10], [24, 18], [40, 30], [55, 44], [70, 55], [88, 61], [100, 50], [110, 35],
      [120, 20], [130, 12], [120, 30], [100, 44], [80, 58], [60, 70], [40, 76], [20, 80],
    ]
    const frames = path.flatMap(([x, y]) =>
      // Each position held for two samples: a real cursor is not a strobe.
      [0, 1].map(() => paint(screen(), x!, y!, CURSOR, CURSOR, 20)),
    )
    const d = run(frames)
    expect(keyframes(d)).toEqual([0])
    expect(d.filter((x) => x.classification === 'cursor').length).toBeGreaterThan(4)
    expect(d.some((x) => x.pointer !== null)).toBe(true)
  })

  it('a caret blinking in place costs nothing after the first page', () => {
    const frames = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? screen() : paint(screen(), 80, 45, 1, 2, 20),
    )
    const d = run(frames)
    expect(keyframes(d)).toEqual([0])
    expect(d.filter((x) => x.classification === 'caret').length).toBeGreaterThan(10)
  })

  it('a tooltip appearing under the cursor is exactly one page, cropped on it', () => {
    const cursorAt = (i: number): [number, number] => (i < 8 ? [20 + i * 4, 40] : [52, 40])
    const frames = Array.from({ length: 60 }, (_, i) => {
      const [x, y] = cursorAt(i)
      let f = paint(screen(), x, y, CURSOR, CURSOR, 20)
      // Tooltip: ~300×80 px at 1080p ≈ 25×7 cells, appearing at sample 12 and staying.
      if (i >= 12) f = paint(f, x + 2, y + 2, 25, 7, 235)
      return f
    })
    const d = run(frames)
    const ks = keyframes(d)
    expect(ks).toHaveLength(2)
    expect(ks[0]).toBe(0)
    const tooltip = d[ks[1]!]!
    expect(tooltip.reason).toBe('persistent')
    expect(tooltip.crop).not.toBeNull()
    expect(tooltip.atCursor).toBe(true)
  })

  it('a flicker that does not survive is not content', () => {
    const frames = Array.from({ length: 40 }, (_, i) =>
      i === 10 ? paint(screen(), 60, 40, 25, 7, 235) : screen(),
    )
    expect(keyframes(run(frames))).toEqual([0])
  })

  it('a large change is a page on sight, with no persistence to prove', () => {
    const frames = Array.from({ length: 20 }, (_, i) =>
      i < 8 ? screen() : paint(screen(), 0, 0, 120, 70, 240),
    )
    const ks = keyframes(run(frames))
    expect(ks[0]).toBe(0)
    expect(ks[1]).toBe(8)
  })
})
