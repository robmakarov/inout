import { describe, expect, it } from 'vitest'
import { changedBlobs, emptyDelta, gridDelta, makeGrid, pointerMask, type LumaGrid } from './delta'
import { initSelector, paceMs, stepSelection, type Decision } from './select'

/** Production looks at the picture 8 times a second; so does this. */
const FPS = 8
const INTERVAL = 1000 / FPS

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
 * keyframe and against the previous sample), blobs from the second, the pointer
 * masked out of the content metric, and the reference advancing only when a
 * page is actually emitted.
 */
function run(frames: LumaGrid[], budget?: number): Decision[] {
  const durationMs = (frames.length * 1000) / FPS
  let state = initSelector(durationMs, INTERVAL, budget === undefined ? undefined : { budget })
  let ref: LumaGrid | null = null
  let prev: LumaGrid | null = null
  let refPointer: { xFrac: number; yFrac: number } | null = null
  const out: Decision[] = []
  frames.forEach((f, i) => {
    const mask = pointerMask(f.cols, f.rows, [refPointer, state.pointer])
    const step = stepSelection(state, {
      index: i,
      atOutMs: i * INTERVAL,
      atRecMs: i * INTERVAL,
      vsRef: ref ? gridDelta(ref, f, undefined, mask) : emptyDelta(),
      vsPrev: prev ? gridDelta(prev, f) : emptyDelta(),
      blobsVsPrev: prev ? changedBlobs(prev, f) : [],
    })
    state = step.state
    if (step.decision.keyframe) {
      ref = f
      refPointer = state.pointer
    }
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

  it('spends its pages where the picture moves, not over the still stretches', () => {
    // 30 s: still, a 3 s burst of full-frame motion in the middle, still again.
    const frames = Array.from({ length: 30 * FPS }, (_, i) => {
      if (i < 12 * FPS || i >= 15 * FPS) return screen()
      return paint(screen(), 0, 0, 160, 90, 60 + ((i * 37) % 160))
    })
    const ks = keyframes(run(frames))
    const still = ks.filter((i) => i < 12 * FPS).length
    const moving = ks.filter((i) => i >= 12 * FPS && i <= 15 * FPS + 4).length
    expect(still).toBe(1) // the opening page, and nothing else
    // The motion is SAMPLED, not summarized: Robert uses this file to reproduce
    // animation, and one page for three seconds of motion cannot do that. It is
    // also not sampled forever — after the burst cap the ordinary pace resumes,
    // because three seconds of continuous change is a scroll, not a transition.
    expect(moving).toBeGreaterThanOrEqual(12)
    expect(moving).toBeLessThan(24)
  })

  it('an animation comes back as a sequence of frames, all marked as one burst', () => {
    // A box slides across the frame over one second — a UI transition.
    const frames = Array.from({ length: 4 * FPS }, (_, i) => {
      if (i < FPS || i >= 2 * FPS) return paint(screen(), i < FPS ? 4 : 120, 30, 24, 20, 240)
      const x = 4 + Math.round(((i - FPS) / FPS) * 116)
      return paint(screen(), x, 30, 24, 20, 240)
    })
    const d = run(frames)
    const moving = keyframes(d).filter((i) => i >= FPS && i < 2 * FPS)
    expect(moving.length).toBeGreaterThanOrEqual(6)
    // The first sample of the movement is an ordinary content page — one change
    // is an event. From the second on it is motion, and the burst carries it.
    expect(moving.filter((i) => d[i]!.inBurst).length).toBeGreaterThanOrEqual(5)
  })

  it('paces from what is LEFT of the budget, so a long take cannot bankrupt it', () => {
    // Plenty of budget for the time remaining ⇒ the floor is the sample rate.
    expect(paceMs(10_000, 200, INTERVAL)).toBe(INTERVAL)
    // Comfortable, but not unlimited: 200 pages over 30 s is one per 150 ms.
    expect(paceMs(30_000, 200, INTERVAL)).toBe(150)
    // Budget nearly spent ⇒ the rest is spread over what remains.
    expect(paceMs(60_000, 10, INTERVAL)).toBe(6000)
    expect(paceMs(600_000, 10, INTERVAL)).toBe(8000) // and never stretches past the ceiling
    expect(paceMs(10_000, 0, INTERVAL)).toBe(8000)
  })

  it('a change held back by the pace is not lost — it fires at the next allowed instant', () => {
    // A tight budget forces the pace to stretch over a changing picture.
    const frames = Array.from({ length: 8 * FPS }, (_, i) =>
      i === 0 ? screen() : paint(screen(), 0, 0, 160, 45, 20 + i),
    )
    const ks = keyframes(run(frames, 6))
    expect(ks[0]).toBe(0)
    expect(ks.length).toBeLessThanOrEqual(6)
    // Nothing is silently dropped: the page still lands, just later.
    expect(ks.length).toBeGreaterThan(1)
  })
})

describe('keyframe selection — the cursor taxonomy (Robert’s hard gate)', () => {
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
      // ~300×80 px at 1080p ≈ 25×7 cells, appearing at sample 12 and staying.
      if (i >= 12) f = paint(f, x + 2, y + 2, 25, 7, 235)
      return f
    })
    const d = run(frames)
    const ks = keyframes(d)
    expect(ks).toHaveLength(2)
    expect(ks[0]).toBe(0)
    const tooltip = d[ks[1]!]!
    expect(tooltip.crop).not.toBeNull()
    expect(tooltip.atCursor).toBe(true)
  })

  it('a small UI change — a typed word, a button turning active — is NOT lost', () => {
    // ~250×30 px at 1080p ≈ 20×2 cells: under the old content threshold, which
    // is exactly what swallowed the typing in Robert's first real take.
    const frames = Array.from({ length: 40 }, (_, i) =>
      i < 10 ? screen() : paint(screen(), 30, 50, 20, 2, 230),
    )
    const ks = keyframes(run(frames))
    expect(ks).toHaveLength(2)
    expect(ks[1]).toBeLessThanOrEqual(12) // seen within ~250 ms of happening
  })

  it('a flicker that does not survive is not content', () => {
    const frames = Array.from({ length: 40 }, (_, i) =>
      i === 10 ? paint(screen(), 60, 40, 6, 4, 235) : screen(),
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
