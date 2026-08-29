/**
 * The `?screensize=` / `?camsize=` harness knobs (F13).
 *
 * F13's portrait gate needs a portrait SOURCE on the deployed build, and no rig
 * can conjure a phone. These two parameters are how that take is reproduced
 * from a link — so the parser is worth pinning: a bad one silently gives back
 * the 640x480 default and the gate then measures nothing at all, green.
 */
import { describe, expect, it } from 'vitest'
import { parseFpsParam, parseSizeParam } from './synthetic'

describe('parseSizeParam', () => {
  it('reads WxH', () => {
    expect(parseSizeParam('?synthetic=1&camsize=1080x1920', 'camsize')).toEqual({
      width: 1080,
      height: 1920,
    })
    expect(parseSizeParam('?screensize=3840x2160', 'screensize')).toEqual({
      width: 3840,
      height: 2160,
    })
  })

  it('is null when absent, so the caller keeps its default', () => {
    expect(parseSizeParam('?synthetic=1', 'camsize')).toBeNull()
    expect(parseSizeParam('', 'camsize')).toBeNull()
  })

  it('refuses anything that is not two plain dimensions', () => {
    for (const raw of ['1080', '1080*1920', '1080x', 'x1920', '0x1920', '1080x0', '-4x3', '1e3x900']) {
      expect(parseSizeParam(`?camsize=${encodeURIComponent(raw)}`, 'camsize')).toBeNull()
    }
  })
})

/**
 * `?screenfps=` / `?camfps=` (F15) — the same argument one dimension over: the
 * 60 fps gate needs a source that OFFERS more than 30, and a bad parse hands
 * back the 30 default and the gate then proves nothing, green.
 */
describe('parseFpsParam', () => {
  it('reads a plain rate', () => {
    expect(parseFpsParam('?synthetic=1&screenfps=60', 'screenfps')).toBe(60)
    expect(parseFpsParam('?camfps=50', 'camfps')).toBe(50)
  })

  it('is null when absent, so the caller keeps its default', () => {
    expect(parseFpsParam('?synthetic=1', 'screenfps')).toBeNull()
    expect(parseFpsParam('', 'screenfps')).toBeNull()
  })

  it('refuses anything a canvas cannot be asked for', () => {
    for (const raw of ['0', '-30', '121', '999', '30.5', '6e1', 'sixty', '']) {
      expect(parseFpsParam(`?screenfps=${encodeURIComponent(raw)}`, 'screenfps')).toBeNull()
    }
  })
})
