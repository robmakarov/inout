import type { CameraKeyframe, CameraPose, CameraTrack } from '../types'

/**
 * TIMED CAMERA MOTION (task F4) — the single source of truth for where the
 * camera PiP is at a given instant. The export compositor and the editor
 * preview both sample THIS, which is the only way preview↔export parity can be
 * a property rather than a coincidence.
 *
 * Everything is expressed in FRACTIONS of the output frame, never pixels: the
 * same pose then renders identically at 720p, 1080p and 1440p, and identically
 * in a preview stage of whatever size the window happens to be.
 */

/** The pre-F4 constants, kept exact so an absent track renders byte-identically. */
export const PIP_WIDTH_FRAC = 0.24
/** 24 px of margin in a 1920-wide authored layout. */
export const PIP_MARGIN_X_FRAC = 24 / 1920
/** The same 24 px against a 1080-tall frame. */
export const PIP_MARGIN_Y_FRAC = 24 / 1080

export const PIP_MIN_WIDTH_FRAC = 0.08
/**
 * 50 % of frame width, and the number is not arbitrary: the camera is captured
 * at 720p when a screen is present (O3a), and half of the widest export tier
 * (0.5 × 2560 = 1280) is exactly that. So every size the user can choose stays
 * inside the captured resolution — no upscaled, soft PiP at any tier. A bigger
 * ceiling wants native-resolution camera capture (O6).
 */
export const PIP_MAX_WIDTH_FRAC = 0.5

/**
 * How long the camera takes to travel to a newly dropped position.
 *
 * This is the one real interpretation call in F4 and it is worth naming. PO:
 * "the export moves it exactly WHEN the user moved it". Interpolating straight
 * between two drops would instead have the camera drifting for the whole span
 * between them — moving long before the user did. So a drop writes a PAIR of
 * keyframes and the camera holds perfectly still between moves.
 *
 * The pair LANDS on the playhead: anchor at (T − CAMERA_MOVE_MS) holding the
 * old pose, target at T holding the new one. The alternative — starting the
 * move at T — was built first and is wrong on the stage: the user scrubs to the
 * moment they want the camera somewhere, drags it there, and on release it
 * springs back, because at that exact instant the camera has not travelled yet.
 * Landing on T means the frame under the playhead is the frame they just
 * composed, and the motion eases in over the beat before it.
 */
export const CAMERA_MOVE_MS = 450

export interface CameraGeometry {
  /** Output frame width / height (16/9 today, in both preview and export). */
  frameAspect: number
  /** Camera source width / height. */
  cameraAspect: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** PiP height as a fraction of frame HEIGHT, from its width and the two aspects. */
export function pipHeightFrac(widthFrac: number, g: CameraGeometry): number {
  if (!(g.cameraAspect > 0) || !(g.frameAspect > 0)) return widthFrac
  return (widthFrac * g.frameAspect) / g.cameraAspect
}

/** Exactly the bottom-right slot the fixed layout has always drawn. */
export function defaultCameraPose(g: CameraGeometry): CameraPose {
  const widthFrac = PIP_WIDTH_FRAC
  const h = pipHeightFrac(widthFrac, g)
  return {
    xFrac: 1 - PIP_MARGIN_X_FRAC - widthFrac / 2,
    yFrac: 1 - PIP_MARGIN_Y_FRAC - h / 2,
    widthFrac,
  }
}

/** Edge-clamped: the PiP is never allowed to hang off the frame. */
export function clampPose(p: CameraPose, g: CameraGeometry): CameraPose {
  const widthFrac = clamp(p.widthFrac, PIP_MIN_WIDTH_FRAC, PIP_MAX_WIDTH_FRAC)
  const halfW = widthFrac / 2
  const halfH = pipHeightFrac(widthFrac, g) / 2
  return {
    widthFrac,
    // A PiP wider or taller than the frame can only be centred.
    xFrac: halfW >= 0.5 ? 0.5 : clamp(p.xFrac, halfW, 1 - halfW),
    yFrac: halfH >= 0.5 ? 0.5 : clamp(p.yFrac, halfH, 1 - halfH),
  }
}

/** Cubic ease-in-out — starts and ends at rest, which is what reads as
 * deliberate rather than as a slide. */
export function easeInOut(t: number): number {
  const x = clamp(t, 0, 1)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * The pose at a RECORDING-timeline instant. Constant before the first keyframe
 * and after the last, eased in between. An absent or empty track is the fixed
 * default, so nothing that predates F4 changes.
 */
export function cameraPoseAt(
  track: CameraTrack | undefined,
  recordingMs: number,
  g: CameraGeometry,
): CameraPose {
  const kfs = track?.keyframes
  if (!kfs || kfs.length === 0) return defaultCameraPose(g)
  const first = kfs[0]!
  if (recordingMs <= first.atMs) return clampPose(first, g)
  const last = kfs[kfs.length - 1]!
  if (recordingMs >= last.atMs) return clampPose(last, g)
  for (let i = 1; i < kfs.length; i++) {
    const b = kfs[i]!
    if (recordingMs > b.atMs) continue
    const a = kfs[i - 1]!
    const span = b.atMs - a.atMs
    // Two keyframes at the same instant = a hard change; take the later one.
    const t = span <= 0 ? 1 : easeInOut((recordingMs - a.atMs) / span)
    return clampPose(
      {
        xFrac: lerp(a.xFrac, b.xFrac, t),
        yFrac: lerp(a.yFrac, b.yFrac, t),
        widthFrac: lerp(a.widthFrac, b.widthFrac, t),
      },
      g,
    )
  }
  return clampPose(last, g)
}

/** Sort by time, drop non-finite entries, keep the last of a tie. */
export function normalizeCameraTrack(track: CameraTrack, maxMs: number): CameraTrack {
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
  const out: CameraKeyframe[] = []
  for (const k of sorted) {
    if (out.length && out[out.length - 1]!.atMs === k.atMs) out[out.length - 1] = k
    else out.push(k)
  }
  return { keyframes: out }
}

/**
 * Commit a drag or a resize that the user finished at playhead time `atMs`.
 *
 * Writes the anchor/target PAIR described on CAMERA_MOVE_MS, and drops any
 * keyframes the new move would travel through — dragging the same moment twice
 * must replace that move, not stack a second one on top of it.
 */
export function writeCameraKeyframe(
  track: CameraTrack | undefined,
  atMs: number,
  pose: CameraPose,
  g: CameraGeometry,
  maxMs: number,
): CameraTrack {
  const at = clamp(atMs, 0, Math.max(0, maxMs))
  const startAt = Math.max(0, at - CAMERA_MOVE_MS)
  const anchor: CameraKeyframe = { atMs: startAt, ...cameraPoseAt(track, startAt, g) }
  const target: CameraKeyframe = { atMs: at, ...clampPose(pose, g) }
  const kept = (track?.keyframes ?? []).filter((k) => k.atMs < startAt || k.atMs > at)
  // Dropped at the very start there is no room to ease in — the camera simply
  // begins there, which is also how "set the camera for the whole take" works.
  const next = startAt >= at ? [...kept, target] : [...kept, anchor, target]
  return normalizeCameraTrack({ keyframes: next }, maxMs)
}

/** True when the track actually asks for something other than the fixed slot. */
export function cameraTrackIsActive(track: CameraTrack | undefined): boolean {
  return !!track && track.keyframes.length > 0
}

export interface PipRect {
  /** Top-left corner and size, all fractions of the frame. */
  leftFrac: number
  topFrac: number
  widthFrac: number
  heightFrac: number
}

/** Centre-anchored pose → the top-left rect a renderer actually draws. */
export function poseToRect(p: CameraPose, g: CameraGeometry): PipRect {
  const heightFrac = pipHeightFrac(p.widthFrac, g)
  return {
    leftFrac: p.xFrac - p.widthFrac / 2,
    topFrac: p.yFrac - heightFrac / 2,
    widthFrac: p.widthFrac,
    heightFrac,
  }
}
