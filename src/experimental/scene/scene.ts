/**
 * EXPERIMENTAL — Scene Document (Experiment 7b).
 *
 * The frame's appearance at output time t is currently defined twice: once in
 * src/core/compose/layout.ts (canvas) and once in the DOM preview (Player).
 * Decision #11 in .ai/DECISIONS records the obligation to keep both in sync
 * BY HAND. This module extracts the semantics into one pure, serializable
 * data structure — a SceneFrame — that a canvas renderer can compile and a
 * DOM renderer can interpret.
 *
 * The vocabulary is intentionally exactly what the product does today:
 * contain-fit screen, cover-fit camera, PiP slot, waveform fallback. Nothing
 * speculative. The win is representation, not new features.
 *
 * Pure: derives everything from (Recording, EditState, tMs) via the same
 * timeline functions production uses, so the placement RULES (not pixels)
 * are testable without a browser.
 */

import type { ChannelKind, EditState, Recording } from '@core/types'
import { channelHasOutputWindow, channelSourceTimeAt, hasEnabledVideo } from '@core/timeline'

/** Normalized rect: fractions of output width/height, so it is resolution-free. */
export interface NRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ScenePlacement {
  channelId: string
  kind: ChannelKind
  /** Channel-local sample time, ms. */
  sourceMs: number
  /** Where the media goes. null = full frame. */
  rect: NRect | null
  fit: 'contain' | 'cover'
  /** Corner radius as a fraction of output width (0 = square). */
  cornerRadiusFrac: number
  /** Draw order: lower first. */
  z: number
}

export interface SceneFrame {
  tMs: number
  background: string
  /** 'video' scene or full-frame 'waveform' visualization (audio-only). */
  mode: 'video' | 'waveform'
  placements: ScenePlacement[]
}

/** Product layout constants, authored at 1920w — same numbers as layout.ts. */
const PIP_WIDTH_FRAC = 0.24
const PIP_MARGIN_FRAC = 24 / 1920
const PIP_RADIUS_FRAC = 16 / 1920
export const SCENE_BACKGROUND = '#0a0a0c'

export interface SceneContext {
  /**
   * Layout slot rule (decision #11): camera is full-frame ONLY when no screen
   * channel contributes anywhere in the output window. Computed once per
   * composition, passed in so sceneAt stays per-frame pure.
   */
  cameraFull: boolean
  /** Output aspect ratio (width/height) — needed to compute the PiP rect. */
  aspect: number
  /** camera aspect (w/h) if known; PiP height depends on it. */
  cameraAspect?: number
}

/** Decision-#11 rule, exposed so callers derive the context the same way. */
export function isCameraFull(r: Recording, e: EditState): boolean {
  const screens = r.channels.filter((c) => c.kind === 'screen')
  return !screens.some((c) => channelHasOutputWindow(r, e, c.id))
}

export function sceneAt(r: Recording, e: EditState, tMs: number, ctx: SceneContext): SceneFrame {
  if (!hasEnabledVideo(r, e)) {
    return { tMs, background: SCENE_BACKGROUND, mode: 'waveform', placements: [] }
  }

  let screen: ScenePlacement | null = null
  let camera: ScenePlacement | null = null

  for (const ch of r.channels) {
    if (ch.media !== 'video') continue
    const src = channelSourceTimeAt(r, e, ch.id, tMs)
    if (src === null) continue
    if (ch.kind === 'screen') {
      screen = {
        channelId: ch.id,
        kind: 'screen',
        sourceMs: src,
        rect: null,
        fit: 'contain',
        cornerRadiusFrac: 0,
        z: 0,
      }
    } else if (ch.kind === 'camera') {
      camera = {
        channelId: ch.id,
        kind: 'camera',
        sourceMs: src,
        rect: null, // resolved below
        fit: 'cover',
        cornerRadiusFrac: 0,
        z: 1,
      }
    }
  }

  const placements: ScenePlacement[] = []
  if (screen) placements.push(screen)

  if (camera) {
    const full = !screen && ctx.cameraFull
    if (full) {
      camera.rect = null
      camera.cornerRadiusFrac = 0
    } else {
      camera.rect = pipRect(ctx)
      camera.cornerRadiusFrac = PIP_RADIUS_FRAC
    }
    placements.push(camera)
  }

  return { tMs, background: screen ? '#000000' : SCENE_BACKGROUND, mode: 'video', placements }
}

/** PiP rect in normalized coordinates — same geometry as drawCameraPip. */
export function pipRect(ctx: SceneContext): NRect {
  const camAspect = ctx.cameraAspect && ctx.cameraAspect > 0 ? ctx.cameraAspect : 4 / 3
  const w = PIP_WIDTH_FRAC
  // pipH = pipW_px / camAspect; normalize by height: pipW_px = w * W, so
  // hFrac = (w * W / camAspect) / H = w * aspect / camAspect.
  const h = (w * ctx.aspect) / camAspect
  const mx = PIP_MARGIN_FRAC
  const my = PIP_MARGIN_FRAC * ctx.aspect
  return { x: 1 - mx - w, y: 1 - my - h, w, h }
}
