import { describe, expect, it } from 'vitest'
import {
  boxOverlap,
  changedBlobs,
  GRID_COLS,
  GRID_ROWS,
  gridDelta,
  makeGrid,
  type LumaGrid,
} from './delta'

/** A grid of flat mid-grey — the "screen" every test paints on. */
function screen(level = 128): LumaGrid {
  const g = makeGrid()
  g.data.fill(level)
  return g
}

/** Paint a box in grid cells (x,y,w,h). */
function paint(g: LumaGrid, x: number, y: number, w: number, h: number, level: number): LumaGrid {
  const out: LumaGrid = { cols: g.cols, rows: g.rows, data: new Uint8Array(g.data) }
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      if (i < 0 || j < 0 || i >= g.cols || j >= g.rows) continue
      out.data[j * g.cols + i] = level
    }
  }
  return out
}

describe('delta metric', () => {
  it('is zero on an identical frame and on codec-level noise', () => {
    const a = screen()
    expect(gridDelta(a, a).changedFrac).toBe(0)
    const noisy = makeGrid()
    for (let i = 0; i < noisy.data.length; i++) noisy.data[i] = 128 + ((i % 5) - 2)
    expect(gridDelta(a, noisy).cells).toBe(0)
  })

  it('reports the changed share, its box and its centre', () => {
    const a = screen()
    const b = paint(a, 40, 20, 16, 9, 240)
    const d = gridDelta(a, b)
    expect(d.cells).toBe(16 * 9)
    expect(d.changedFrac).toBeCloseTo((16 * 9) / (GRID_COLS * GRID_ROWS), 6)
    expect(d.bbox).toEqual({ xFrac: 40 / GRID_COLS, yFrac: 20 / GRID_ROWS, widthFrac: 16 / GRID_COLS, heightFrac: 9 / GRID_ROWS })
    expect(d.centroid!.xFrac).toBeCloseTo(47.5 / GRID_COLS, 3)
  })

  it('separates a moved pointer into the mark it left and the mark it made', () => {
    const a = paint(screen(), 10, 10, 2, 2, 20)
    const b = paint(screen(), 60, 40, 2, 2, 20)
    const blobs = changedBlobs(a, b)
    expect(blobs).toHaveLength(2)
    expect(blobs[0]!.cells).toBe(4)
    // Centroid of a 2×2 blob at x=10 is 10.5 cells — the mark, not its corner.
    const xs = blobs.map((x) => x.centroid.xFrac * GRID_COLS).sort((p, q) => p - q)
    expect(xs).toEqual([10.5, 60.5])
  })

  it('refuses to hunt for a pointer inside a large change — that is content', () => {
    const a = screen()
    const b = paint(a, 0, 0, GRID_COLS, GRID_ROWS / 2, 250)
    expect(changedBlobs(a, b)).toHaveLength(0)
    expect(gridDelta(a, b).changedFrac).toBeCloseTo(0.5, 6)
  })

  it('scores box overlap as intersection over union', () => {
    const r = { xFrac: 0, yFrac: 0, widthFrac: 0.2, heightFrac: 0.2 }
    expect(boxOverlap(r, r)).toBe(1)
    expect(boxOverlap(r, { xFrac: 0.5, yFrac: 0.5, widthFrac: 0.2, heightFrac: 0.2 })).toBe(0)
    expect(boxOverlap(r, { xFrac: 0.1, yFrac: 0, widthFrac: 0.2, heightFrac: 0.2 })).toBeCloseTo(1 / 3, 6)
  })
})
