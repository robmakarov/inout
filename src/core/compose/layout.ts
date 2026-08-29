import type { VideoSample } from 'mediabunny'
import type { BackgroundStyle, CameraPose, Viewport } from '../types'
import { sourceFrameEnabled } from '../frame'
import { defaultCameraPose, poseToRect } from '../timeline/cameraTrack'
import { viewportIsActive, viewportToRect } from '../timeline/viewportTrack'
import {
  backgroundIsActive,
  containRect,
  paintBackground,
  screenInsetRect,
  shadowFor,
} from './background'

export interface FrameCanvas {
  ctx: OffscreenCanvasRenderingContext2D
  width: number
  height: number
  /**
   * Fixed product layout is authored at 1920 wide, so every hardcoded pixel in
   * this file is multiplied by this. Build it with `frameScale(width, height)`
   * (core/frame.ts) — on a landscape frame that IS `width / 1920`, and on a
   * portrait one it keeps the PiP's border and radius the thickness they were
   * drawn at instead of shrinking them with the narrower side.
   */
  scale: number
}

export const EMPTY_BACKGROUND = '#0a0a0c'

export function roundedRectPath(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r)
    return
  }
  const radius = Math.min(r, w / 2, h / 2)
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

export function drawEmptyFrame(f: FrameCanvas): void {
  f.ctx.fillStyle = EMPTY_BACKGROUND
  f.ctx.fillRect(0, 0, f.width, f.height)
}

/**
 * Fixed layout: screen letterboxed full-frame on black with optional camera
 * PiP; camera covers the frame only when the composition has no screen at all
 * (cameraFull) — momentary screen gaps keep the camera in the PiP slot over the
 * empty background so the layout never jumps mid-video.
 *
 * `pose` (task F4) is where the PiP sits at THIS instant. Omitted = the fixed
 * bottom-right slot, byte-identical to every take made before F4.
 *
 * `background` (task F3) frames the screen surface. Omitted or inactive takes
 * the exact code path this function had before F3 — the frozen rule is that
 * nothing changes without the user asking for it.
 *
 * `viewport` (task F2) is what part of the finished frame is visible. It is a
 * TRANSFORM around everything below rather than a step in the composition:
 * a zoom magnifies the picture the user already composed — background, screen
 * and PiP together — instead of re-laying it out. Costs one save/restore when
 * present and nothing at all when absent.
 */
export function drawVideoFrame(
  f: FrameCanvas,
  screen: VideoSample | null,
  camera: VideoSample | null,
  cameraFull: boolean,
  pose?: CameraPose,
  background?: BackgroundStyle,
  viewport?: Viewport,
): void {
  if (viewportIsActive(viewport)) {
    const rect = viewportToRect(viewport!)
    const scale = 1 / rect.widthFrac
    f.ctx.save()
    // Frame space -> canvas space. Everything drawn below is authored against
    // the full frame and lands inside the visible rect.
    f.ctx.setTransform(
      scale,
      0,
      0,
      scale,
      -rect.leftFrac * f.width * scale,
      -rect.topFrac * f.height * scale,
    )
    try {
      drawComposition(f, screen, camera, cameraFull, pose, background)
    } finally {
      f.ctx.restore()
    }
    return
  }
  drawComposition(f, screen, camera, cameraFull, pose, background)
}

function drawComposition(
  f: FrameCanvas,
  screen: VideoSample | null,
  camera: VideoSample | null,
  cameraFull: boolean,
  pose?: CameraPose,
  background?: BackgroundStyle,
): void {
  if (screen && backgroundIsActive(background)) {
    drawFramedScreen(f, screen, background!)
    // The PiP stays keyed to the FRAME, not to the inset surface: F4's poses are
    // frame fractions the user placed by eye, and re-anchoring them to a
    // background they add later would move the camera behind their back.
    if (camera) drawCameraPip(f, camera, pose)
  } else if (screen) {
    f.ctx.fillStyle = '#000000'
    f.ctx.fillRect(0, 0, f.width, f.height)
    screen.drawWithFit(f.ctx, { fit: 'contain' })
    if (camera) drawCameraPip(f, camera, pose)
  } else if (camera && cameraFull) {
    // EVERYTHING THE CAMERA SEES (PO 2026-08-29, judging F13 on a phone: "make
    // it like it supposed on phone, everything camera sees").
    //
    // When the frame follows the take these two are the SAME operation — a
    // camera-only take's frame IS the camera's aspect, so there is nothing to
    // crop either way, and a 16:9 take is byte-identical. They differ only
    // where the frame and the picture disagree, and that is exactly where
    // 'cover' silently threw away the user's head and chin. Letterboxing there
    // is not a nicer default, it is the difference between a bounded cosmetic
    // cost and losing the recording, so it wins whenever the geometry chain has
    // been wrong about something — which on a phone it has been twice.
    //
    // Without the flag this is the old crop, untouched.
    camera.drawWithFit(f.ctx, { fit: sourceFrameEnabled() ? 'contain' : 'cover' })
  } else if (camera) {
    drawEmptyFrame(f)
    drawCameraPip(f, camera, pose)
  } else {
    drawEmptyFrame(f)
  }
}

/**
 * The screen surface inside a background frame: paint the backdrop, then draw
 * the picture inset, rounded and shadowed. The rounded rect follows the PICTURE
 * (the contain box), not the padding box — rounding empty letterbox space would
 * look like a bug, and it is also what the editor's <video> element does.
 */
function drawFramedScreen(f: FrameCanvas, screen: VideoSample, bg: BackgroundStyle): void {
  const { ctx, width, height } = f
  paintBackground(ctx, width, height, bg)
  const frameAspect = width / height
  const sourceAspect =
    screen.displayWidth > 0 && screen.displayHeight > 0
      ? screen.displayWidth / screen.displayHeight
      : frameAspect
  const picture = containRect(screenInsetRect(bg, frameAspect), frameAspect, sourceAspect)
  const x = picture.leftFrac * width
  const y = picture.topFrac * height
  const w = picture.widthFrac * width
  const h = picture.heightFrac * height
  const radius = Math.min(bg.radiusFrac * height, w / 2, h / 2)

  const shadow = shadowFor(bg, height)
  if (shadow) {
    ctx.save()
    ctx.shadowColor = shadow.color
    ctx.shadowBlur = shadow.blur
    ctx.shadowOffsetY = shadow.offsetY
    // Fill the plate the shadow is cast by; the picture covers it immediately.
    ctx.fillStyle = '#000000'
    roundedRectPath(ctx, x, y, w, h, radius)
    ctx.fill()
    ctx.restore()
  }

  ctx.save()
  roundedRectPath(ctx, x, y, w, h, radius)
  ctx.clip()
  screen.draw(ctx, x, y, w, h)
  ctx.restore()
}

function drawCameraPip(f: FrameCanvas, camera: VideoSample, pose?: CameraPose): void {
  if (camera.displayWidth <= 0 || camera.displayHeight <= 0) return
  const { ctx, width, height, scale } = f
  const geometry = {
    frameAspect: width / height,
    cameraAspect: camera.displayWidth / camera.displayHeight,
  }
  const rect = poseToRect(pose ?? defaultCameraPose(geometry), geometry)
  const pipW = rect.widthFrac * width
  const pipH = rect.heightFrac * height
  const x = rect.leftFrac * width
  const y = rect.topFrac * height
  // The corner radius belongs to the PiP, not to the frame — it must not grow
  // when the user makes the PiP bigger, so it stays keyed to the layout scale.
  const radius = 16 * scale
  ctx.save()
  roundedRectPath(ctx, x, y, pipW, pipH, radius)
  ctx.clip()
  camera.draw(ctx, x, y, pipW, pipH)
  ctx.restore()
  roundedRectPath(ctx, x, y, pipW, pipH, radius)
  ctx.lineWidth = 1.5 * scale
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
  ctx.stroke()
}
