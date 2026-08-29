/**
 * The delta metric the AI export is built on (task AI1).
 *
 * Everything the file decides — which instants become keyframes, whether a page
 * carries a crop, what is the cursor and what is content — comes from ONE
 * measurement: the share of a downscaled luma grid whose cells changed. No
 * knobs, no settings; the picture decides.
 *
 * WHY A GRID AND NOT PIXELS. A screen recording is compressed, so a pixel diff
 * of two decoded frames is never zero: codec noise sits at a few luma levels
 * everywhere. Averaging into ~12 px cells kills that noise (it is zero-mean
 * inside a cell) while keeping anything a human would call a change, and it
 * makes the metric resolution-independent — the same take at 720p and 1080p
 * produces the same fractions.
 *
 * The grid is deliberately coarse enough that the OS cursor covers a handful of
 * cells and a tooltip covers a hundred: that separation IS the taxonomy in
 * select.ts, and it is why the cursor filter is a threshold rather than a
 * detector.
 */

/** Cells across the frame. 160×90 ⇒ 12 px cells at 1920×1080. */
export const GRID_COLS = 160
export const GRID_ROWS = 90

/**
 * A cell counts as changed when its mean luma moves by more than this (0-255).
 * Measured against vp9/avc decode noise, which lives ~2-4 levels after cell
 * averaging; 10 is comfortably above it and well below any visible change.
 */
export const CELL_DELTA = 10

/** One mean-luma byte per grid cell. */
export interface LumaGrid {
  cols: number
  rows: number
  /** Row-major, length cols*rows. */
  data: Uint8Array
}

export interface Rect {
  /** Fractions of the frame, [0,1]. */
  xFrac: number
  yFrac: number
  widthFrac: number
  heightFrac: number
}

export interface Blob {
  cells: number
  centroid: { xFrac: number; yFrac: number }
  bbox: Rect
}

export interface Delta {
  /** Changed cells as a share of all cells — the metric everything reads. */
  changedFrac: number
  cells: number
  /** Bounding box of every changed cell, or null when nothing changed. */
  bbox: Rect | null
  /** Area of that box as a share of the frame (a MOVING cursor makes this big
   *  while `changedFrac` stays tiny — the two together are the signal). */
  bboxAreaFrac: number
  centroid: { xFrac: number; yFrac: number } | null
}

export function emptyDelta(): Delta {
  return { changedFrac: 0, cells: 0, bbox: null, bboxAreaFrac: 0, centroid: null }
}

export function makeGrid(cols = GRID_COLS, rows = GRID_ROWS): LumaGrid {
  return { cols, rows, data: new Uint8Array(cols * rows) }
}

/**
 * Grid → grid mean-luma difference. Both must be the same shape.
 *
 * `ignore` marks cells the caller knows are the pointer or the caret (see
 * pointerMask). Excluding them is what lets the CONTENT threshold go small
 * enough to catch a button highlight or a typed word without a stopped cursor
 * buying itself a page — the taxonomy's job done by subtraction rather than by
 * a threshold high enough to hide both.
 */
export function gridDelta(
  a: LumaGrid,
  b: LumaGrid,
  threshold = CELL_DELTA,
  ignore?: Uint8Array,
): Delta {
  if (a.cols !== b.cols || a.rows !== b.rows) throw new Error('gridDelta: grid shape mismatch')
  const { cols, rows } = a
  let cells = 0
  let minX = cols
  let minY = rows
  let maxX = -1
  let maxY = -1
  let sumX = 0
  let sumY = 0
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      if (ignore && ignore[i]) continue
      if (Math.abs(a.data[i]! - b.data[i]!) <= threshold) continue
      cells++
      sumX += x
      sumY += y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (cells === 0) return emptyDelta()
  const bbox: Rect = {
    xFrac: minX / cols,
    yFrac: minY / rows,
    widthFrac: (maxX - minX + 1) / cols,
    heightFrac: (maxY - minY + 1) / rows,
  }
  return {
    changedFrac: cells / (cols * rows),
    cells,
    bbox,
    bboxAreaFrac: bbox.widthFrac * bbox.heightFrac,
    centroid: { xFrac: sumX / cells / cols, yFrac: sumY / cells / rows },
  }
}

/**
 * Connected regions of changed cells (4-connectivity), largest first.
 *
 * Only the pointer trail needs this: a cursor that moved leaves TWO blobs — the
 * hole where it was and the mark where it is — and telling them apart is the
 * whole of "where is the pointer". Capped so a full-frame change cannot turn a
 * flood fill into the export's cost centre.
 */
export function changedBlobs(
  a: LumaGrid,
  b: LumaGrid,
  threshold = CELL_DELTA,
  maxBlobs = 8,
  maxCells = 600,
): Blob[] {
  const { cols, rows } = a
  const changed = new Uint8Array(cols * rows)
  let total = 0
  for (let i = 0; i < changed.length; i++) {
    if (Math.abs(a.data[i]! - b.data[i]!) > threshold) {
      changed[i] = 1
      total++
    }
  }
  // A big change is content, and content has no pointer to find.
  if (total === 0 || total > maxCells) return []
  const seen = new Uint8Array(cols * rows)
  const blobs: Blob[] = []
  const stack: number[] = []
  for (let start = 0; start < changed.length; start++) {
    if (!changed[start] || seen[start]) continue
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    let cells = 0
    let sumX = 0
    let sumY = 0
    let minX = cols
    let minY = rows
    let maxX = -1
    let maxY = -1
    while (stack.length) {
      const i = stack.pop()!
      const x = i % cols
      const y = (i - x) / cols
      cells++
      sumX += x
      sumY += y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x > 0 && changed[i - 1] && !seen[i - 1]) {
        seen[i - 1] = 1
        stack.push(i - 1)
      }
      if (x < cols - 1 && changed[i + 1] && !seen[i + 1]) {
        seen[i + 1] = 1
        stack.push(i + 1)
      }
      if (y > 0 && changed[i - cols] && !seen[i - cols]) {
        seen[i - cols] = 1
        stack.push(i - cols)
      }
      if (y < rows - 1 && changed[i + cols] && !seen[i + cols]) {
        seen[i + cols] = 1
        stack.push(i + cols)
      }
    }
    blobs.push({
      cells,
      centroid: { xFrac: sumX / cells / cols, yFrac: sumY / cells / rows },
      bbox: {
        xFrac: minX / cols,
        yFrac: minY / rows,
        widthFrac: (maxX - minX + 1) / cols,
        heightFrac: (maxY - minY + 1) / rows,
      },
    })
  }
  blobs.sort((p, q) => q.cells - p.cells)
  return blobs.slice(0, maxBlobs)
}

/**
 * Cells the pointer and the caret occupy, so the CONTENT metric can ignore
 * them (task AI1, after Robert's first real take).
 *
 * The alternative — a content threshold set high enough that a moving cursor
 * cannot reach it — is what made the first version blind to a typed word and a
 * button turning active. Masking the pointer instead lets the threshold go
 * where real UI changes live. The mask covers where the pointer IS and where it
 * WAS at the reference frame, because both differ between the two pictures.
 */
export function pointerMask(
  cols: number,
  rows: number,
  spots: ({ xFrac: number; yFrac: number } | null | undefined)[],
  radiusCells = 3,
): Uint8Array {
  const mask = new Uint8Array(cols * rows)
  for (const spot of spots) {
    if (!spot) continue
    const cx = Math.round(spot.xFrac * cols)
    const cy = Math.round(spot.yFrac * rows)
    for (let y = Math.max(0, cy - radiusCells); y <= Math.min(rows - 1, cy + radiusCells); y++) {
      for (let x = Math.max(0, cx - radiusCells); x <= Math.min(cols - 1, cx + radiusCells); x++) {
        mask[y * cols + x] = 1
      }
    }
  }
  return mask
}

/** Overlap of two boxes as a share of their union — how "same place" they are. */
export function boxOverlap(a: Rect, b: Rect): number {
  const x0 = Math.max(a.xFrac, b.xFrac)
  const y0 = Math.max(a.yFrac, b.yFrac)
  const x1 = Math.min(a.xFrac + a.widthFrac, b.xFrac + b.widthFrac)
  const y1 = Math.min(a.yFrac + a.heightFrac, b.yFrac + b.heightFrac)
  if (x1 <= x0 || y1 <= y0) return 0
  const inter = (x1 - x0) * (y1 - y0)
  const union = a.widthFrac * a.heightFrac + b.widthFrac * b.heightFrac - inter
  return union > 0 ? inter / union : 0
}

export function distanceFrac(
  a: { xFrac: number; yFrac: number },
  b: { xFrac: number; yFrac: number },
): number {
  return Math.hypot(a.xFrac - b.xFrac, a.yFrac - b.yFrac)
}
