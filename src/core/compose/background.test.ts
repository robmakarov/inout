import { describe, expect, it } from 'vitest'
import {
  MAX_PAD_FRAC,
  backgroundCss,
  backgroundIsActive,
  clampBackground,
  containRect,
  gradientLine,
  screenInsetRect,
  shadowFor,
} from './background'
import type { BackgroundStyle } from '@core/types'

const style = (p: Partial<BackgroundStyle> = {}): BackgroundStyle => ({
  preset: 'slate',
  padFrac: 0.06,
  radiusFrac: 0.02,
  shadow: true,
  ...p,
})

describe('backgroundIsActive', () => {
  it('absent, and a style that paints and insets nothing, are both inactive', () => {
    expect(backgroundIsActive(undefined)).toBe(false)
    expect(backgroundIsActive(style({ preset: 'none', padFrac: 0, radiusFrac: 0 }))).toBe(false)
  })

  it('a paint alone, or an inset alone, is active', () => {
    expect(backgroundIsActive(style({ preset: 'ink', padFrac: 0, radiusFrac: 0 }))).toBe(true)
    expect(backgroundIsActive(style({ preset: 'none', padFrac: 0.04 }))).toBe(true)
  })
})

describe('screenInsetRect', () => {
  it('is full bleed when inactive', () => {
    const r = screenInsetRect(undefined, 16 / 9)
    expect(r).toEqual({ leftFrac: 0, topFrac: 0, widthFrac: 1, heightFrac: 1 })
  })

  it('is a uniform scale, so the box keeps the frame aspect', () => {
    const r = screenInsetRect(style({ padFrac: 0.06 }), 16 / 9)
    expect(r.leftFrac).toBeCloseTo(0.06, 10)
    expect(r.topFrac).toBeCloseTo(0.06, 10)
    expect(r.widthFrac).toBeCloseTo(0.88, 10)
    expect(r.heightFrac).toBeCloseTo(0.88, 10)
  })

  it('never insets past the clamp', () => {
    const r = screenInsetRect(style({ padFrac: 5 }), 16 / 9)
    expect(r.topFrac).toBeCloseTo(MAX_PAD_FRAC, 10)
  })
})

describe('containRect', () => {
  it('returns the box itself when the aspects match', () => {
    const box = screenInsetRect(style({ padFrac: 0.06 }), 16 / 9)
    const fit = containRect(box, 16 / 9, 16 / 9)
    expect(fit.widthFrac).toBeCloseTo(box.widthFrac, 10)
    expect(fit.heightFrac).toBeCloseTo(box.heightFrac, 10)
  })

  it('letterboxes a 4:3 source inside a 16:9 box, centred', () => {
    const box = screenInsetRect(undefined, 16 / 9)
    const fit = containRect(box, 16 / 9, 4 / 3)
    // 4:3 inside 16:9 fills the height and 3/4 of the width.
    expect(fit.heightFrac).toBeCloseTo(1, 10)
    expect(fit.widthFrac).toBeCloseTo(0.75, 10)
    expect(fit.leftFrac).toBeCloseTo(0.125, 10)
  })

  it('pillarboxes an ultrawide source, centred', () => {
    const box = screenInsetRect(undefined, 16 / 9)
    const fit = containRect(box, 16 / 9, 32 / 9)
    expect(fit.widthFrac).toBeCloseTo(1, 10)
    expect(fit.heightFrac).toBeCloseTo(0.5, 10)
    expect(fit.topFrac).toBeCloseTo(0.25, 10)
  })
})

describe('gradientLine', () => {
  it('0deg runs bottom to top, like CSS', () => {
    const l = gradientLine(0, 1920, 1080)
    expect(l).toEqual({ x0: 960, y0: 1080, x1: 960, y1: 0 })
  })

  it('90deg runs left to right, like CSS', () => {
    const l = gradientLine(90, 1920, 1080)
    expect(l.x0).toBeCloseTo(0, 6)
    expect(l.x1).toBeCloseTo(1920, 6)
    expect(l.y0).toBeCloseTo(540, 6)
    expect(l.y1).toBeCloseTo(540, 6)
  })
})

describe('css and clamping', () => {
  it('an inactive style paints nothing in CSS either', () => {
    expect(backgroundCss(undefined)).toBeUndefined()
    expect(backgroundCss(style({ preset: 'none', padFrac: 0, radiusFrac: 0 }))).toBeUndefined()
  })

  it('emits a gradient whose angle matches the preset', () => {
    expect(backgroundCss(style({ preset: 'dawn' }))).toMatch(/^linear-gradient\(145deg, /)
  })

  it('clamps to finite, bounded values and keeps absent absent', () => {
    expect(clampBackground(undefined)).toBeUndefined()
    const c = clampBackground({ preset: 'nope', padFrac: NaN, radiusFrac: 9, shadow: 1 as never })!
    expect(c.preset).toBe('none')
    expect(c.padFrac).toBe(0)
    expect(c.radiusFrac).toBeLessThanOrEqual(0.12)
    expect(c.shadow).toBe(true)
  })

  it('no shadow without an active background', () => {
    expect(shadowFor(style({ preset: 'none', padFrac: 0, radiusFrac: 0 }), 1080)).toBeNull()
    expect(shadowFor(style({ shadow: false }), 1080)).toBeNull()
    expect(shadowFor(style(), 1080)?.blur).toBeCloseTo(1080 * 0.035, 10)
  })
})
