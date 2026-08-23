/**
 * TIMED ZOOM AND PAN (task F2) — the single source of truth for what part of
 * the composed frame is visible at a given instant.
 *
 * This is F4's camera track with a different subject, and deliberately so: the
 * roadmap's instruction was "copy it, don't invent a second one". Same rules,
 * for the same reasons:
 *   · fractions of the frame, never pixels, so one zoom renders identically at
 *     540p and 1440p and identically in a preview stage of any size;
 *   · keyframes sit on the RECORDING timeline, so a cut made afterwards cannot
 *     drag a zoom away from the moment it belongs to;
 *   · a gesture writes a PAIR of keyframes that LANDS on the playhead — anchor
 *     at (T − ZOOM_MOVE_MS) holding the old view, target at T holding the new
 *     one — so the view holds still between moves and the frame under the
 *     playhead is the frame the user just composed. F4 built the other version
 *     first (start moving AT T) and it springs back on release.
 *
 * The viewport keeps the output's aspect, which is why one number describes its
 * size: for a rect of the same aspect, heightFrac === widthFrac.
 */
import type { Viewport, ViewportKeyframe, ViewportTrack } from '../types'
import { easeInOut } from './cameraTrack'

/** The whole frame — what an absent track means, and what reset returns to. */
export const DEFAULT_VIEWPORT: Viewport = { xFrac: 0.5, yFrac: 0.5, widthFrac: 1 }

/**
 * Closest zoom, as a fraction of the frame. 0.4 is 2.5×, and the number is a
 * consequence rather than a taste: capture is capped at 1080p (O3a/acquire) and
 * the default export is 1080p, so EVERY zoom is an upscale of the source. At
 * 2.5× a screen recording is soft but still readable; past that it is mush, and
 * the honest fix is native-resolution capture (O6), not a bigger multiplier.
 */
export const MIN_VIEWPORT_WIDTH_FRAC = 0.4

/**
 * How long the view takes to travel to a new position. Slower than the camera's
 * 450 ms: a zoom moves the whole picture, and the same speed that reads as
 * deliberate on a small PiP reads as a lurch on the frame.
 */
export const ZOOM_MOVE_MS = 600

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Edge-clamped: the visible region is never allowed off the frame. */
export function clampViewport(v: Viewport): Viewport {
  const widthFrac = clamp(
    Number.isFinite(v.widthFrac) ? v.widthFrac : 1,
    MIN_VIEWPORT_WIDTH_FRAC,
    1,
  )
  const half = widthFrac / 2
  return {
    widthFrac,
    xFrac: clamp(Number.isFinite(v.xFrac) ? v.xFrac : 0.5, half, 1 - half),
    yFrac: clamp(Number.isFinite(v.yFrac) ? v.yFrac : 0.5, half, 1 - half),
  }
}

/** True when the track asks for anything other than the whole frame. */
export function viewportTrackIsActive(track: ViewportTrack | undefined): boolean {
  return !!track && track.keyframes.length > 0
}

/** True when THIS view is not simply the whole frame. */
export function viewportIsActive(v: Viewport | undefined): boolean {
  return !!v && v.widthFrac < 0.999
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * The view at a RECORDING-timeline instant. Constant before the first keyframe
 * and after the last, eased in between. An absent track is the whole frame, so
 * nothing that predates F2 changes.
 */
export function viewportAt(track: ViewportTrack | undefined, recordingMs: number): Viewport {
  const kfs = track?.keyframes
  if (!kfs || kfs.length === 0) return DEFAULT_VIEWPORT
  const first = kfs[0]!
  if (recordingMs <= first.atMs) return clampViewport(first)
  const last = kfs[kfs.length - 1]!
  if (recordingMs >= last.atMs) return clampViewport(last)
  for (let i = 1; i < kfs.length; i++) {
    const b = kfs[i]!
    if (recordingMs > b.atMs) continue
    const a = kfs[i - 1]!
    const span = b.atMs - a.atMs
    const t = span <= 0 ? 1 : easeInOut((recordingMs - a.atMs) / span)
    return clampViewport({
      xFrac: lerp(a.xFrac, b.xFrac, t),
      yFrac: lerp(a.yFrac, b.yFrac, t),
      widthFrac: lerp(a.widthFrac, b.widthFrac, t),
    })
  }
  return clampViewport(last)
}

/** Sort by time, drop non-finite entries, keep the last of a tie. */
export function normalizeViewportTrack(track: ViewportTrack, maxMs: number): ViewportTrack {
  const sorted = track.keyframes
    .filter(
      (k) =>
        Number.isFinite(k.atMs) &&
        Number.isFinite(k.xFrac) &&
        Number.isFinite(k.yFrac) &&
        Number.isFinite(k.widthFrac),
    )
    .map((k) => ({ ...k, atMs: clamp(k.atMs, 0, Math.max(0, maxMs)) }))
    .sort((a, b) => a.atMs - b.atMs)
  const out: ViewportKeyframe[] = []
  for (const k of sorted) {
    if (out.length && out[out.length - 1]!.atMs === k.atMs) out[out.length - 1] = k
    else out.push(k)
  }
  return { keyframes: out }
}

/**
 * Commit a zoom or pan the user finished at playhead time `atMs`. Writes the
 * anchor/target pair, and drops any keyframes the new move would travel
 * through — zooming the same moment twice replaces that move rather than
 * stacking a second one on top of it.
 */
export function writeViewportKeyframe(
  track: ViewportTrack | undefined,
  atMs: number,
  viewport: Viewport,
  maxMs: number,
): ViewportTrack {
  const at = clamp(atMs, 0, Math.max(0, maxMs))
  const startAt = Math.max(0, at - ZOOM_MOVE_MS)
  const anchor: ViewportKeyframe = { atMs: startAt, ...viewportAt(track, startAt) }
  const target: ViewportKeyframe = { atMs: at, ...clampViewport(viewport) }
  const kept = (track?.keyframes ?? []).filter((k) => k.atMs < startAt || k.atMs > at)
  const next = startAt >= at ? [...kept, target] : [...kept, anchor, target]
  return normalizeViewportTrack({ keyframes: next }, maxMs)
}

export interface ViewportRect {
  leftFrac: number
  topFrac: number
  widthFrac: number
  heightFrac: number
}

/** Centre-anchored view → the top-left rect a renderer actually crops to. */
export function viewportToRect(v: Viewport): ViewportRect {
  const c = clampViewport(v)
  return {
    leftFrac: c.xFrac - c.widthFrac / 2,
    topFrac: c.yFrac - c.widthFrac / 2,
    widthFrac: c.widthFrac,
    heightFrac: c.widthFrac,
  }
}

/**
 * Zoom around a point instead of around the centre: the fraction of the frame
 * under the cursor stays under the cursor, which is the only zoom that does not
 * feel like the picture is running away.
 *
 * @param anchorXFrac where the cursor is, in FRAME fractions (not stage pixels)
 */
export function zoomAround(
  current: Viewport,
  nextWidthFrac: number,
  anchorXFrac: number,
  anchorYFrac: number,
): Viewport {
  const from = clampViewport(current)
  const to = clamp(nextWidthFrac, MIN_VIEWPORT_WIDTH_FRAC, 1)
  if (to === from.widthFrac) return from
  // Keep the anchor at the same relative position inside the visible rect.
  const rel = (a: number, centre: number, size: number): number =>
    size > 0 ? (a - (centre - size / 2)) / size : 0.5
  const relX = rel(anchorXFrac, from.xFrac, from.widthFrac)
  const relY = rel(anchorYFrac, from.yFrac, from.widthFrac)
  return clampViewport({
    widthFrac: to,
    xFrac: anchorXFrac - (relX - 0.5) * to,
    yFrac: anchorYFrac - (relY - 0.5) * to,
  })
}
