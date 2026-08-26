import { describe, expect, it } from 'vitest'
import { EDGE_STEP_THRESHOLD, textEdgeMetric } from './textEdge'

const W = 32
const H = 16

interface Img {
  data: Uint8ClampedArray
  width: number
  height: number
}

function blank(r = 20, g = 22, b = 26): Img {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  }
  return { data, width: W, height: H }
}

/** A vertical bar of `colour` — one glyph stroke, with two hard edges. */
function withBar(img: Img, x0: number, x1: number, [r, g, b]: [number, number, number]): Img {
  const out: Img = { data: new Uint8ClampedArray(img.data), width: W, height: H }
  for (let y = 0; y < H; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4
      out.data[i] = r
      out.data[i + 1] = g
      out.data[i + 2] = b
      out.data[i + 3] = 255
    }
  }
  return out
}

describe('textEdgeMetric', () => {
  it('scores a perfect copy as no damage at all', () => {
    const src = withBar(blank(), 10, 14, [230, 240, 255])
    const m = textEdgeMetric(src, src)
    expect(m.edgePixels).toBeGreaterThan(0)
    expect(m.chromaFringeMean).toBe(0)
    expect(m.lumaSmearMean).toBe(0)
    expect(m.edgeContrastKept).toBe(1)
  })

  it('finds only the glyph edges, not the flat background', () => {
    const src = withBar(blank(), 10, 14, [230, 240, 255])
    const m = textEdgeMetric(src, src)
    // Two boundaries, both sides of each, over H rows — a small share of frame.
    expect(m.edgeSharePct).toBeLessThan(30)
    expect(m.edgeSharePct).toBeGreaterThan(0)
  })

  it('reports chroma fringe when only the COLOUR of the glyph is wrong', () => {
    // Same luma, different hue: this is precisely what 4:2:0 does to coloured
    // text, and it is invisible to a luma-only measure.
    const src = withBar(blank(), 10, 14, [200, 100, 100])
    const dec = withBar(blank(), 10, 14, [150, 130, 120])
    const m = textEdgeMetric(src, dec)
    expect(m.chromaFringeMean).toBeGreaterThan(10)
  })

  it('reports lost sharpness when the edge is blurred away', () => {
    const src = withBar(blank(), 10, 14, [240, 240, 240])
    // The bar washed out towards the background: the step is much smaller.
    const dec = withBar(blank(), 10, 14, [90, 92, 96])
    const m = textEdgeMetric(src, dec)
    expect(m.edgeContrastKept).toBeLessThan(0.7)
    expect(m.lumaSmearMean).toBeGreaterThan(20)
  })

  it('never scores sharper than the source — ringing is not an improvement', () => {
    const src = withBar(blank(), 10, 14, [140, 140, 140])
    // Over-sharpened: a bigger step than the original had.
    const dec = withBar(blank(), 10, 14, [255, 255, 255])
    const m = textEdgeMetric(src, dec)
    expect(m.edgeContrastKept).toBeLessThanOrEqual(1)
  })

  it('takes its edge set from the SOURCE, so erasing the text cannot hide it', () => {
    const src = withBar(blank(), 10, 14, [240, 240, 240])
    // The decode lost the glyph entirely. If edges came from the decode there
    // would be none, and the metric would report a flawless frame.
    const dec = blank()
    const m = textEdgeMetric(src, dec)
    expect(m.edgePixels).toBeGreaterThan(0)
    expect(m.edgeContrastKept).toBeLessThan(0.2)
    expect(m.lumaSmearMean).toBeGreaterThan(50)
  })

  it('ignores a gentle gradient — that is not a glyph boundary', () => {
    const src = blank()
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const v = 20 + Math.round((x / W) * (EDGE_STEP_THRESHOLD - 10))
        src.data[i] = v
        src.data[i + 1] = v
        src.data[i + 2] = v
      }
    }
    const m = textEdgeMetric(src, src)
    expect(m.edgePixels).toBe(0)
  })
})
