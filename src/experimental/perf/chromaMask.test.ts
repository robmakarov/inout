/**
 * R1 — THE INSTRUMENT'S OWN TESTS.
 *
 * Every case here is a way `chromaRows` used to report a number for a
 * measurement it had not taken. That is the failure mode this rig exists to
 * not have: it is the evidence for O3b and for the 4:4:4 decision, and a rig
 * that is wrong before the product is (note 10) costs a session every time.
 *
 * The end-to-end drills — a dead blobKey, a drifted palette — live in the rig
 * itself (`npm run exp -- x15c '{"drill":…}'`), because what they prove is
 * that the REPORT survives and says so. These are the unit half.
 */
import { describe, expect, it } from 'vitest'
import { chromaMask, chromaRows, PAGE_COLOURS, saturationPct } from './textSource'

/** A bare ImageData-shaped object; the node test env has no canvas. */
function img(width: number, height: number, fill: [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0]
    data[i * 4 + 1] = fill[1]
    data[i * 4 + 2] = fill[2]
    data[i * 4 + 3] = 255
  }
  return { width, height, data, colorSpace: 'srgb' } as unknown as ImageData
}

const GREY = PAGE_COLOURS.find((c) => c.key === 'grey')!
const GREEN = PAGE_COLOURS.find((c) => c.key === 'green')!
const FULL = { x: 0, y: 0, w: 8, h: 8 }

describe('chroma mask geometry (R1 fix 2)', () => {
  it('refuses a rect that runs off the source instead of counting the overrun as mask hits', () => {
    const source = img(8, 8, GREEN.rgb)
    // The old scan read source.data past the end, where every sample is
    // `undefined` — and `Math.abs(undefined - c) > tol` is FALSE, so every
    // out-of-bounds pixel counted as a HIT and summed to NaN.
    expect(() => chromaMask(source, { x: 0, y: 0, w: 16, h: 8 })).toThrow(/not inside the source/)
    expect(() => chromaMask(source, { x: -1, y: 0, w: 4, h: 4 })).toThrow(/not inside the source/)
    expect(() => chromaMask(source, { x: 0, y: 0, w: 0, h: 4 })).toThrow(/not inside the source/)
  })

  it('refuses a decoded frame that is not 1:1 with the source', () => {
    const mask = chromaMask(img(8, 8, GREEN.rgb), FULL)
    // Read with the source's stride, a frame of another width is sheared —
    // and the answer looks like a colour measurement either way.
    expect(() => chromaRows(mask, img(16, 8, GREEN.rgb))).toThrow(/not 1:1 with the source/)
    expect(() => chromaRows(mask, img(8, 4, GREEN.rgb))).toThrow(/not 1:1 with the source/)
  })
})

describe('an empty mask is a failed measurement, not a score (R1 fix 10)', () => {
  it('reports MASK EMPTY and a null keptPct when the palette misses the source', () => {
    // A palette-drift drill in miniature: the source is painted in one colour
    // and the mask is asked for another. Nothing matches.
    const mask = chromaMask(img(8, 8, [0, 0, 0]), FULL)
    const rows = chromaRows(mask, img(8, 8, GREEN.rgb))
    for (const row of rows) {
      expect(row.status).toBe('MASK EMPTY')
      expect(row.pixels).toBe(0)
      // The old code returned 0 here, i.e. "the colour was completely
      // destroyed" — a fabricated P1 out of a mask that matched nothing.
      expect(row.keptPct).toBeNull()
      expect(row.saturationDeltaPts).toBeNull()
    }
  })

  it('an untouched frame keeps 100 % and moves zero points', () => {
    const source = img(8, 8, GREEN.rgb)
    const mask = chromaMask(source, FULL)
    const green = chromaRows(mask, source).find((r) => r.key === 'green')!
    expect(green.status).toBe('ok')
    expect(green.pixels).toBe(64)
    expect(green.keptPct).toBe(100)
    expect(green.saturationDeltaPts).toBe(0)
  })
})

describe('rows carry a key, not a display label (R1 fix 1)', () => {
  it('every palette colour has a stable key the gates can look up', () => {
    const mask = chromaMask(img(8, 8, GREY.rgb), FULL)
    expect(chromaRows(mask, img(8, 8, GREY.rgb)).map((r) => r.key)).toEqual([
      'grey',
      'green',
      'blue',
    ])
  })
})

describe('grey needs an absolute delta (R1 fix 9)', () => {
  it('one LSB of decode noise on grey reads as ~6 points of ratio and ~0.4 of truth', () => {
    const source = img(8, 8, GREY.rgb)
    const mask = chromaMask(source, FULL)
    // Grey's source saturation is 7.4 %, so the ratio's denominator is tiny.
    expect(saturationPct(GREY.rgb)).toBeLessThan(8)
    const nudged: [number, number, number] = [GREY.rgb[0], GREY.rgb[1], GREY.rgb[2] - 1]
    const row = chromaRows(mask, img(8, 8, nudged)).find((r) => r.key === 'grey')!
    expect(row.status).toBe('ok')
    // The amplifier: a single least-significant bit becomes several points.
    expect(100 - row.keptPct!).toBeGreaterThan(4)
    // The truth: it barely moved.
    expect(Math.abs(row.saturationDeltaPts!)).toBeLessThan(1)
  })
})
