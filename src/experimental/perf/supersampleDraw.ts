/**
 * O9(a) — THE SUPERSAMPLED DRAW, KEPT ONLY AS A MEASURING INSTRUMENT.
 *
 * This shipped in the export for an afternoon (`?ss=`, compose/supersample.ts)
 * and was removed the same day, because the rig that used it — drawCeiling.ts,
 * `node scripts/o9-colour.mjs` — proved the premise wrong. It lives here so the
 * finding stays REPRODUCIBLE: a claim that a lever does nothing is worth
 * exactly as much as the ability to run it again.
 *
 * THE PREMISE, from .ai/TASKS O9(a): the export draws every source frame into
 * the delivery canvas with one bilinear `drawImage`, and a source bigger than
 * the file (a native-res screen at 3024x1964 delivered at 1080p, the shipped
 * default) is therefore SAMPLED rather than averaged. Draw at an integer
 * multiple and reduce in one aligned step and every output pixel becomes the
 * exact block average of its draw pixels. X15(e)'s ladder — 1x 80.0 · 1.5x 90.1
 * · 2x 94.7 % green — was read as the evidence for it.
 *
 * WHAT THE MEASUREMENT SAID (2026-09-04, docs/qa/o9-colour.json):
 *   the 1:1 draw of a 3024-wide source into 1080p keeps 99.8 % of the green
 *   with NO encoder anywhere. There is nothing there to recover. The finished
 *   4:2:0 file reads 78.2 % at 1x and 78.2-78.7 % at 2x — inside run variance —
 *   while the glyph chroma fringe goes the WRONG way, 3.21 → 3.59, and the
 *   export's wall clock rises 8 %. X15(e)'s ladder is about the ENCODE's
 *   resolution, not the draw's: its rungs encode at 1620p and 2160p and cost
 *   1.68x and 2.29x the bytes. The draw was never the lever.
 *
 * ALIGNED is still load-bearing for the rows this produces: a factor whose
 * product is not a whole even number of pixels puts the reduction back on a
 * resampler with a fractional phase, which is a different experiment.
 */

/** The factors the ladder offers, biggest first. */
export const SUPERSAMPLE_FACTORS = [2, 1.5] as const

/** 8 GB M3: a 2x draw of a source-tier export is 23.8 Mpx = 95 MB of RGBA. */
const MAX_DRAW_PX = 16_000_000
/** Chrome's per-side canvas limit is 16384; stay well inside it. */
const MAX_DRAW_SIDE = 8192

export interface SupersampleDraw {
  /** The factor actually used — asked-for, stepped down until it aligns/fits. */
  factor: number
  width: number
  height: number
}

/**
 * The draw size for an output frame, or null for "draw at the output size",
 * which is what the export does and what a factor of 1 means.
 */
export function supersampleDraw(
  width: number,
  height: number,
  asked: number,
): SupersampleDraw | null {
  if (!(asked > 1) || !Number.isFinite(asked)) return null
  if (width <= 0 || height <= 0) return null
  const rungs = [asked, ...SUPERSAMPLE_FACTORS.filter((f) => f < asked)]
  for (const factor of rungs) {
    const w = width * factor
    const h = height * factor
    if (!Number.isInteger(w) || !Number.isInteger(h) || w % 2 !== 0 || h % 2 !== 0) continue
    if (w > MAX_DRAW_SIDE || h > MAX_DRAW_SIDE) continue
    if (w * h > MAX_DRAW_PX) continue
    return { factor, width: w, height: h }
  }
  return null
}
