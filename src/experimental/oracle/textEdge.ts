/**
 * TEXT EDGE + CHROMA FRINGE — the instrument O9 needs before O9 can be judged.
 *
 * O9's goal is "screen text without smear", and its four parts (4:4:4 where the
 * hardware allows, AV1 screen-content tools, a near-lossless mode for static
 * spans, a text rig) all reduce to one question this project could not answer:
 * IS THE TEXT BETTER? PSNR cannot say. A frame of coloured text on a dark
 * ground is ~96 % flat background, so a codec can destroy every glyph edge and
 * still score well — the errors live on a few percent of the pixels, which is
 * exactly what X5 measured when two painters disagreed by up to 156 levels on
 * 3.8 % of pixels while the whole-frame PSNR moved barely at all.
 *
 * So the metric looks only where text is, and separates the two ways it dies:
 *
 *   chromaFringeMean   4:2:0 stores colour at half resolution in each axis, so
 *                      a red glyph on grey bleeds colour across its boundary.
 *                      Mean |ΔCb|+|ΔCr| over EDGE pixels only.
 *   lumaSmearMean      the glyph's own shape, blurred. Mean |ΔY| over the same
 *                      pixels.
 *   edgeContrastKept   the ratio of the decoded luma gradient to the source's,
 *                      over the same pixels. 1.0 = the edge is as sharp as it
 *                      was; 0.6 = it has lost 40 % of its step. This is the one
 *                      that tracks "can I read it", and it is bounded, so a
 *                      codec cannot win by sharpening into ringing.
 *
 * EDGE PIXELS ARE CHOSEN FROM THE SOURCE, never from the decode. Choosing them
 * from the decode would let a codec that erases an edge also erase the evidence
 * that it was there — the metric would improve as the picture got worse.
 *
 * Rec.601 is used for the RGB→YCbCr transform because that is what the metric
 * is comparing, not what any file declares: both sides go through the SAME
 * transform, so a matrix disagreement cancels and only the codec's damage
 * remains.
 */

export interface TextEdgeMetric {
  /** How many pixels the source said were text edges. */
  edgePixels: number
  /** Share of the frame those were — the reason a whole-frame PSNR is blind. */
  edgeSharePct: number
  /** Mean |ΔCb| + |ΔCr| on edge pixels, 0-255 scale. Lower is better. */
  chromaFringeMean: number
  /** Mean |ΔY| on edge pixels. Lower is better. */
  lumaSmearMean: number
  /** decoded gradient / source gradient on edge pixels. 1 = sharpness kept. */
  edgeContrastKept: number
  /** The same |ΔY| over NON-edge pixels — the flat areas codecs find easy. */
  flatLumaMean: number
}

/** Rec.601 luma, integer-free so the tests can be exact about small numbers. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}
function cb(r: number, g: number, b: number): number {
  return 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
}
function cr(r: number, g: number, b: number): number {
  return 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
}

/**
 * Sobel-free gradient: the maximum absolute luma step to the four neighbours.
 * A glyph edge is a STEP, not a ramp, and the max-step form is what makes the
 * threshold mean something a person could name ("this pixel sits on a jump of
 * at least N levels") rather than a filter response nobody can picture.
 */
function maxStep(y: Float32Array, w: number, h: number, x: number, py: number): number {
  const i = py * w + x
  const c = y[i]!
  let m = 0
  if (x > 0) m = Math.max(m, Math.abs(c - y[i - 1]!))
  if (x < w - 1) m = Math.max(m, Math.abs(c - y[i + 1]!))
  if (py > 0) m = Math.max(m, Math.abs(c - y[i - w]!))
  if (py < h - 1) m = Math.max(m, Math.abs(c - y[i + w]!))
  return m
}

/**
 * A luma step this big is a glyph boundary rather than a gradient or noise.
 * 40 of 255 is well above dithering and well below the ~200 a white-on-black
 * caret produces, so it catches ordinary syntax-highlighted text too.
 */
export const EDGE_STEP_THRESHOLD = 40

export function textEdgeMetric(
  source: { data: Uint8ClampedArray; width: number; height: number },
  decoded: { data: Uint8ClampedArray; width: number; height: number },
  threshold = EDGE_STEP_THRESHOLD,
): TextEdgeMetric {
  const w = Math.min(source.width, decoded.width)
  const h = Math.min(source.height, decoded.height)
  const n = w * h
  const ys = new Float32Array(n)
  const yd = new Float32Array(n)
  for (let py = 0; py < h; py++) {
    for (let x = 0; x < w; x++) {
      const i = py * w + x
      const si = (py * source.width + x) * 4
      const di = (py * decoded.width + x) * 4
      ys[i] = luma(source.data[si]!, source.data[si + 1]!, source.data[si + 2]!)
      yd[i] = luma(decoded.data[di]!, decoded.data[di + 1]!, decoded.data[di + 2]!)
    }
  }

  let edgePixels = 0
  let chromaSum = 0
  let lumaSum = 0
  let srcGradSum = 0
  let decGradSum = 0
  let flatSum = 0
  let flatPixels = 0
  for (let py = 0; py < h; py++) {
    for (let x = 0; x < w; x++) {
      const i = py * w + x
      const si = (py * source.width + x) * 4
      const di = (py * decoded.width + x) * 4
      const dy = Math.abs(ys[i]! - yd[i]!)
      // The SOURCE decides what is an edge — see the header.
      if (maxStep(ys, w, h, x, py) >= threshold) {
        edgePixels++
        lumaSum += dy
        const sr = source.data[si]!
        const sg = source.data[si + 1]!
        const sb = source.data[si + 2]!
        const dr = decoded.data[di]!
        const dg = decoded.data[di + 1]!
        const db = decoded.data[di + 2]!
        chromaSum += Math.abs(cb(sr, sg, sb) - cb(dr, dg, db))
        chromaSum += Math.abs(cr(sr, sg, sb) - cr(dr, dg, db))
        srcGradSum += maxStep(ys, w, h, x, py)
        decGradSum += maxStep(yd, w, h, x, py)
      } else {
        flatPixels++
        flatSum += dy
      }
    }
  }

  const r2 = (v: number): number => Math.round(v * 100) / 100
  return {
    edgePixels,
    edgeSharePct: Math.round((edgePixels / Math.max(1, n)) * 1000) / 10,
    chromaFringeMean: edgePixels ? r2(chromaSum / edgePixels) : 0,
    lumaSmearMean: edgePixels ? r2(lumaSum / edgePixels) : 0,
    // Clamped at 1: a codec that rings past the original step is not sharper,
    // and letting it score above 1 would reward exactly that artefact.
    edgeContrastKept: srcGradSum > 0 ? r2(Math.min(1, decGradSum / srcGradSum)) : 0,
    flatLumaMean: flatPixels ? r2(flatSum / flatPixels) : 0,
  }
}
