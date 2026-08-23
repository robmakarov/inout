/**
 * BACKGROUND FRAME (task F3) — one description of the frame, painted twice.
 *
 * The export paints it into a canvas and the editor paints it with CSS, so
 * every preset is stored as DATA (a solid, or a gradient angle plus stops)
 * rather than as a CSS string or a canvas call. Both renderers derive from the
 * same numbers, which is the only way preview↔export parity is a property and
 * not a coincidence — the same rule F4's camera track follows.
 *
 * The inset is a UNIFORM SCALE: `padFrac` is a fraction of each axis, so the
 * surface keeps the frame's aspect and a same-aspect screen fills it exactly.
 * Equal-in-pixels margins are impossible here anyway — a uniform scale of a
 * 16:9 picture inside a 16:9 frame always leaves margins in the ratio 16:9 —
 * and every tool that insets a recording does it this way. The corner radius is
 * a fraction of HEIGHT, because a radius is one number and has to stay round.
 *
 * Deliberately no image wallpapers: they would cost first-paint bytes (the O7
 * gate is 300 KB) and a second parity problem (decode timing, cover cropping)
 * for something gradients already do well. Gradients are also resolution-free,
 * so a 540p export and a 1440p export are the same picture.
 */
import type { BackgroundStyle } from '@core/types'

export interface GradientStop {
  /** 0..1 along the gradient line. */
  at: number
  color: string
}

export type BackgroundPaint =
  | { kind: 'solid'; color: string }
  /** CSS convention: 0deg points up, 90deg points right. */
  | { kind: 'linear'; angleDeg: number; stops: GradientStop[] }

export interface BackgroundPreset {
  id: string
  label: string
  /** null = paint nothing (full-bleed black, exactly as before F3). */
  paint: BackgroundPaint | null
  /** A single colour for a UI swatch. */
  swatch: string
}

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  { id: 'none', label: 'None', paint: null, swatch: '#000000' },
  { id: 'ink', label: 'Ink', paint: { kind: 'solid', color: '#0a0a0c' }, swatch: '#0a0a0c' },
  {
    id: 'slate',
    label: 'Slate',
    paint: {
      kind: 'linear',
      angleDeg: 160,
      stops: [
        { at: 0, color: '#1b2430' },
        { at: 1, color: '#0b0f14' },
      ],
    },
    swatch: '#1b2430',
  },
  {
    id: 'dawn',
    label: 'Dawn',
    paint: {
      kind: 'linear',
      angleDeg: 145,
      stops: [
        { at: 0, color: '#ff9a76' },
        { at: 0.55, color: '#c86ba0' },
        { at: 1, color: '#5b4b8a' },
      ],
    },
    swatch: '#c86ba0',
  },
  {
    id: 'mint',
    label: 'Mint',
    paint: {
      kind: 'linear',
      angleDeg: 200,
      stops: [
        { at: 0, color: '#a8e6cf' },
        { at: 1, color: '#3d8b7d' },
      ],
    },
    swatch: '#63c1a8',
  },
]

export function backgroundPreset(id: string | undefined): BackgroundPreset {
  return BACKGROUND_PRESETS.find((p) => p.id === id) ?? BACKGROUND_PRESETS[0]!
}

/** Inset steps offered in the editor, as fractions of frame height. */
export const PAD_STEPS: { id: string; label: string; padFrac: number; radiusFrac: number }[] = [
  { id: 'flush', label: 'Flush', padFrac: 0, radiusFrac: 0 },
  { id: 's', label: 'S', padFrac: 0.03, radiusFrac: 0.014 },
  { id: 'm', label: 'M', padFrac: 0.06, radiusFrac: 0.022 },
  { id: 'l', label: 'L', padFrac: 0.1, radiusFrac: 0.03 },
]

export const MAX_PAD_FRAC = 0.24
export const MAX_RADIUS_FRAC = 0.12

export const DEFAULT_BACKGROUND: BackgroundStyle = {
  preset: 'slate',
  padFrac: 0.06,
  radiusFrac: 0.022,
  shadow: true,
}

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo

/** Bounded, finite, and with an id that exists. Absent stays absent. */
export function clampBackground(bg: BackgroundStyle | undefined): BackgroundStyle | undefined {
  if (!bg) return undefined
  return {
    preset: backgroundPreset(bg.preset).id,
    padFrac: clamp(bg.padFrac, 0, MAX_PAD_FRAC),
    radiusFrac: clamp(bg.radiusFrac, 0, MAX_RADIUS_FRAC),
    shadow: !!bg.shadow,
  }
}

/**
 * Does this style ask for anything at all? A style that paints nothing and
 * insets nothing is the old full-bleed frame, and must be treated as absent
 * everywhere — including by isDefaultEdit, which decides whether the export can
 * packet-copy the composite.
 */
export function backgroundIsActive(bg: BackgroundStyle | undefined): boolean {
  if (!bg) return false
  return bg.preset !== 'none' || bg.padFrac > 0 || bg.radiusFrac > 0
}

export interface InsetRect {
  leftFrac: number
  topFrac: number
  widthFrac: number
  heightFrac: number
}

/**
 * Where the screen surface sits: the frame scaled uniformly by (1 − 2·pad), so
 * the box keeps the frame's aspect and a same-aspect source fills it with no
 * letterbox of its own.
 */
export function screenInsetRect(bg: BackgroundStyle | undefined, _frameAspect: number): InsetRect {
  const pad = backgroundIsActive(bg) ? clamp(bg!.padFrac, 0, MAX_PAD_FRAC) : 0
  return {
    leftFrac: pad,
    topFrac: pad,
    widthFrac: Math.max(0.05, 1 - 2 * pad),
    heightFrac: Math.max(0.05, 1 - 2 * pad),
  }
}

/**
 * The 'contain' box for a source of the given aspect inside `rect`. Both
 * renderers need it: the canvas draws the image there, and the editor positions
 * the <video> element there so its rounded corners hug the picture rather than
 * the letterbox.
 */
export function containRect(rect: InsetRect, frameAspect: number, sourceAspect: number): InsetRect {
  if (!(sourceAspect > 0) || !(frameAspect > 0)) return rect
  // Aspects are width/height; inside the frame, a rect's aspect in absolute
  // terms is (widthFrac·W)/(heightFrac·H) = frameAspect·widthFrac/heightFrac.
  const boxAspect = (frameAspect * rect.widthFrac) / rect.heightFrac
  if (sourceAspect > boxAspect) {
    const heightFrac = rect.heightFrac * (boxAspect / sourceAspect)
    return {
      leftFrac: rect.leftFrac,
      topFrac: rect.topFrac + (rect.heightFrac - heightFrac) / 2,
      widthFrac: rect.widthFrac,
      heightFrac,
    }
  }
  const widthFrac = rect.widthFrac * (sourceAspect / boxAspect)
  return {
    leftFrac: rect.leftFrac + (rect.widthFrac - widthFrac) / 2,
    topFrac: rect.topFrac,
    widthFrac,
    heightFrac: rect.heightFrac,
  }
}

/**
 * Endpoints of a CSS-style gradient line for a w×h box, so the canvas gradient
 * is the same gradient the browser would paint from `linear-gradient(Ndeg,…)`.
 */
export function gradientLine(
  angleDeg: number,
  w: number,
  h: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const rad = (angleDeg * Math.PI) / 180
  // CSS: the line's length is |W·sin(a)| + |H·cos(a)|, centred on the box, with
  // 0deg pointing up (negative y).
  const length = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))
  const dx = (Math.sin(rad) * length) / 2
  const dy = (-Math.cos(rad) * length) / 2
  return { x0: w / 2 - dx, y0: h / 2 - dy, x1: w / 2 + dx, y1: h / 2 + dy }
}

/** Paint the backdrop across the whole frame. No-op for an inactive style. */
export function paintBackground(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  bg: BackgroundStyle | undefined,
): void {
  const paint = backgroundIsActive(bg) ? backgroundPreset(bg!.preset).paint : null
  if (!paint) {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, width, height)
    return
  }
  if (paint.kind === 'solid') {
    ctx.fillStyle = paint.color
  } else {
    const { x0, y0, x1, y1 } = gradientLine(paint.angleDeg, width, height)
    const g = ctx.createLinearGradient(x0, y0, x1, y1)
    for (const s of paint.stops) g.addColorStop(s.at, s.color)
    ctx.fillStyle = g
  }
  ctx.fillRect(0, 0, width, height)
}

/** The same paint as a CSS `background` value, for the editor stage. */
export function backgroundCss(bg: BackgroundStyle | undefined): string | undefined {
  const paint = backgroundIsActive(bg) ? backgroundPreset(bg!.preset).paint : null
  if (!paint) return undefined
  if (paint.kind === 'solid') return paint.color
  const stops = paint.stops.map((s) => `${s.color} ${Math.round(s.at * 1000) / 10}%`).join(', ')
  return `linear-gradient(${paint.angleDeg}deg, ${stops})`
}

/** Shadow, in pixels for a frame of this height. Same numbers on both sides. */
export function shadowFor(bg: BackgroundStyle | undefined, height: number): {
  blur: number
  offsetY: number
  color: string
} | null {
  if (!bg?.shadow || !backgroundIsActive(bg)) return null
  return { blur: height * 0.035, offsetY: height * 0.012, color: 'rgba(0, 0, 0, 0.45)' }
}
