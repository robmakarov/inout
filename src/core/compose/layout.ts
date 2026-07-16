import type { VideoSample } from 'mediabunny'

export interface FrameCanvas {
  ctx: OffscreenCanvasRenderingContext2D
  width: number
  height: number
  /** Fixed product layout is authored at 1920w: scale = width / 1920. */
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
 * PiP bottom-right; camera covers the frame only when the composition has no
 * screen at all (cameraFull) — momentary screen gaps keep the camera in the
 * PiP slot over the empty background so the layout never jumps mid-video.
 */
export function drawVideoFrame(
  f: FrameCanvas,
  screen: VideoSample | null,
  camera: VideoSample | null,
  cameraFull: boolean,
): void {
  if (screen) {
    f.ctx.fillStyle = '#000000'
    f.ctx.fillRect(0, 0, f.width, f.height)
    screen.drawWithFit(f.ctx, { fit: 'contain' })
    if (camera) drawCameraPip(f, camera)
  } else if (camera && cameraFull) {
    camera.drawWithFit(f.ctx, { fit: 'cover' })
  } else if (camera) {
    drawEmptyFrame(f)
    drawCameraPip(f, camera)
  } else {
    drawEmptyFrame(f)
  }
}

function drawCameraPip(f: FrameCanvas, camera: VideoSample): void {
  if (camera.displayWidth <= 0 || camera.displayHeight <= 0) return
  const { ctx, width, scale } = f
  const pipW = 0.24 * width
  const pipH = pipW * (camera.displayHeight / camera.displayWidth)
  const margin = 24 * scale
  const radius = 16 * scale
  const x = width - margin - pipW
  const y = f.height - margin - pipH
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
