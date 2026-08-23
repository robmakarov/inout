/**
 * EXPERIMENTAL — F2 evidence: timed zoom and pan.
 *
 * The claim is not "the stage can be zoomed" — it is that the exported FILE
 * shows the zoom the user composed, at the instant they composed it, and that
 * the preview showed them the same thing. So this measures pixels the F4 way:
 * the synthetic camera PiP is a flat grey field with a red ball, unmistakable
 * against the dark screen gradient, which makes it a FIDUCIAL. Where the PiP
 * lands in a decoded frame is a direct read of the viewport transform, because
 * the compositor puts the PiP at a known place in frame space and the viewport
 * is the only thing that can move it from there.
 *
 * It also guards the thing that must not change: a take with no viewport track
 * still takes the instant packet-copy path, and its PiP still lands in the
 * fixed bottom-right slot.
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { createCaptureSession } from '@core/capture/session'
import { exportRecording } from '@core/compose'
import { recordingsRepo } from '@core/store'
import {
  clampEditState,
  defaultCameraPose,
  defaultEditState,
  isDefaultEdit,
  poseToRect,
  viewportAt,
  viewportToRect,
  writeViewportKeyframe,
  type CameraGeometry,
} from '@core/timeline'
import type { CaptureConfig, EditState, Recording, Viewport, ViewportTrack } from '@core/types'

/** Blocks, not pixels — the same locator F4 uses, for the same reason. */
const BLOCK = 8
const BLOCK_FILL = 0.6
/** Band for the geometry check, in output pixels at 1080p. The locator reads in
 *  8 px blocks, so anything under one block is at the instrument's resolution. */
const BAND_PX = 10

interface MeasuredRect {
  leftFrac: number
  topFrac: number
  widthFrac: number
  heightFrac: number
  blocks: number
}

function locatePip(data: Uint8ClampedArray, width: number, height: number): MeasuredRect | null {
  const cols = Math.floor(width / BLOCK)
  const rows = Math.floor(height / BLOCK)
  let minC = cols
  let maxC = -1
  let minR = rows
  let maxR = -1
  let blocks = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let hits = 0
      for (let y = 0; y < BLOCK; y++) {
        const row = (r * BLOCK + y) * width
        for (let x = 0; x < BLOCK; x++) {
          const i = (row + c * BLOCK + x) * 4
          const R = data[i]!
          const G = data[i + 1]!
          const B = data[i + 2]!
          const max = Math.max(R, G, B)
          const min = Math.min(R, G, B)
          const mean = (R + G + B) / 3
          const grey = max - min <= 30 && mean >= 95 && mean <= 170
          const red = R - Math.max(G, B) > 60 && R > 140
          if (grey || red) hits++
        }
      }
      if (hits / (BLOCK * BLOCK) >= BLOCK_FILL) {
        blocks++
        if (c < minC) minC = c
        if (c > maxC) maxC = c
        if (r < minR) minR = r
        if (r > maxR) maxR = r
      }
    }
  }
  if (maxC < 0 || maxR < 0 || blocks < 4) return null
  const leftFrac = (minC * BLOCK) / width
  const topFrac = (minR * BLOCK) / height
  const widthFrac = ((maxC + 1) * BLOCK - minC * BLOCK) / width
  const heightFrac = ((maxR + 1) * BLOCK - minR * BLOCK) / height
  return { leftFrac, topFrac, widthFrac, heightFrac, blocks }
}

/**
 * Where the PiP should be on the CANVAS once the viewport has moved it —
 * CLIPPED to the canvas, because that is what a renderer does and what a
 * locator can see. Zooming into a corner deliberately pushes part of the PiP
 * off frame; the first version of this expectation did not clip and reported a
 * 450 px "error" that was the measurement being right and the maths being
 * incomplete.
 */
function expectedPip(view: Viewport, geometry: CameraGeometry): MeasuredRect {
  const pip = poseToRect(defaultCameraPose(geometry), geometry)
  const v = viewportToRect(view)
  const left = (pip.leftFrac - v.leftFrac) / v.widthFrac
  const top = (pip.topFrac - v.topFrac) / v.heightFrac
  const right = left + pip.widthFrac / v.widthFrac
  const bottom = top + pip.heightFrac / v.heightFrac
  const clippedLeft = Math.max(0, left)
  const clippedTop = Math.max(0, top)
  return {
    leftFrac: clippedLeft,
    topFrac: clippedTop,
    widthFrac: Math.max(0, Math.min(1, right) - clippedLeft),
    heightFrac: Math.max(0, Math.min(1, bottom) - clippedTop),
    blocks: 0,
  }
}

async function frameAt(blob: Blob, timeSec: number, w: number, h: number): Promise<ImageData | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return null
    const sink = new VideoSampleSink(track)
    const sample = await sink.getSample(timeSec)
    if (!sample) return null
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    sample.draw(ctx, 0, 0, w, h)
    sample.close()
    return ctx.getImageData(0, 0, w, h)
  } finally {
    input.dispose()
  }
}

export interface ZoomCheck {
  atMs: number
  expected: { leftFrac: number; topFrac: number; widthFrac: number }
  measured: { leftFrac: number; topFrac: number; widthFrac: number } | null
  /** Worst edge error at 1080p, in pixels. */
  errorPx: number | null
  within: boolean
  zoomFactor: number
}

export interface F2Report {
  takeMs: number
  keyframes: ViewportTrack['keyframes']
  checks: ZoomCheck[]
  bandPx: number
  /** A zoomed take must NOT take the packet-copy path. */
  zoomedIsDefaultEdit: boolean
  /** An untouched take must still be instant, with the PiP in its old slot. */
  untouched: { isDefaultEdit: boolean; pipErrorPx: number | null }
  /** Render cost of the zoom, against the same take with no track. */
  exportTimeDeltaPct: number | null
  passed: boolean
  notes: string[]
}

export async function runZoomPan(opts: { takeMs?: number } = {}): Promise<F2Report> {
  const takeMs = opts.takeMs ?? 8000
  const W = 1920
  const H = 1080
  const config: CaptureConfig = { screen: true, camera: true, mic: true, systemAudio: false }
  const session = await createCaptureSession(config)
  session.start()
  await new Promise((r) => setTimeout(r, takeMs))
  const recording: Recording = await session.stop()

  const checks: ZoomCheck[] = []
  let exportTimeDeltaPct: number | null = null
  let untouched: F2Report['untouched'] = { isDefaultEdit: false, pipErrorPx: null }
  let keyframes: ViewportTrack['keyframes'] = []
  let zoomedIsDefaultEdit = true
  try {
    const base = defaultEditState(recording)
    const camera = recording.channels.find((c) => c.kind === 'camera')
    const geometry: CameraGeometry = {
      frameAspect: W / H,
      cameraAspect:
        camera?.width && camera?.height ? camera.width / camera.height : 4 / 3,
    }

    // Warm-up render, thrown away: the first export of a session pays for
    // encoder setup, and charging it to whichever case runs first is how a
    // cost comparison becomes meaningless (F3 learned this the hard way).
    await exportRecording({ recording, edit: base, settings: { width: W, height: H, fps: 30 } })

    const t0 = performance.now()
    const plain = await exportRecording({
      recording,
      edit: base,
      settings: { width: W, height: H, fps: 30 },
    })
    const plainMs = performance.now() - t0

    // The untouched take: still instant, PiP still in its historical slot.
    untouched = { isDefaultEdit: isDefaultEdit(recording, base), pipErrorPx: null }
    const plainFrame = await frameAt(plain.blob, Math.min(2, takeMs / 2000), W, H)
    const plainPip = plainFrame ? locatePip(plainFrame.data, W, H) : null
    if (plainPip) {
      const want = expectedPip({ xFrac: 0.5, yFrac: 0.5, widthFrac: 1 }, geometry)
      untouched.pipErrorPx =
        Math.round(
          Math.max(
            Math.abs(plainPip.leftFrac - want.leftFrac) * W,
            Math.abs(plainPip.topFrac - want.topFrac) * H,
            Math.abs(plainPip.widthFrac - want.widthFrac) * W,
          ) * 10,
        ) / 10
    }

    // Two moves, exactly as the stage commits them: a zoom into the
    // bottom-right (where the PiP lives, so the fiducial stays in frame) at
    // 2 s, and a pan at 5 s.
    let track = writeViewportKeyframe(
      undefined,
      2000,
      { xFrac: 0.72, yFrac: 0.72, widthFrac: 0.55 },
      recording.durationMs,
    )
    track = writeViewportKeyframe(
      track,
      5000,
      { xFrac: 0.62, yFrac: 0.66, widthFrac: 0.5 },
      recording.durationMs,
    )
    keyframes = track.keyframes
    const zoomed: EditState = clampEditState(recording, { ...base, viewport: track })
    zoomedIsDefaultEdit = isDefaultEdit(recording, zoomed)

    const t1 = performance.now()
    const result = await exportRecording({
      recording,
      edit: zoomed,
      settings: { width: W, height: H, fps: 30 },
    })
    const zoomMs = performance.now() - t1
    exportTimeDeltaPct = plainMs > 0 ? Math.round(((zoomMs - plainMs) / plainMs) * 1000) / 10 : null

    // Sample AFTER each move has landed, and once between them — the between
    // sample is what proves the view holds instead of drifting.
    for (const atMs of [2000, 3500, 5000]) {
      const img = await frameAt(result.blob, atMs / 1000, W, H)
      const measured = img ? locatePip(img.data, W, H) : null
      const view = viewportAt(zoomed.viewport, atMs + base.globalTrimStartMs)
      const want = expectedPip(view, geometry)
      const errorPx = measured
        ? Math.round(
            Math.max(
              Math.abs(measured.leftFrac - want.leftFrac) * W,
              Math.abs(measured.topFrac - want.topFrac) * H,
              Math.abs(measured.widthFrac - want.widthFrac) * W,
            ) * 10,
          ) / 10
        : null
      const round = (n: number): number => Math.round(n * 1e4) / 1e4
      checks.push({
        atMs,
        expected: {
          leftFrac: round(want.leftFrac),
          topFrac: round(want.topFrac),
          widthFrac: round(want.widthFrac),
        },
        measured: measured
          ? {
              leftFrac: round(measured.leftFrac),
              topFrac: round(measured.topFrac),
              widthFrac: round(measured.widthFrac),
            }
          : null,
        errorPx,
        within: errorPx !== null && errorPx <= BAND_PX,
        zoomFactor: Math.round((1 / view.widthFrac) * 100) / 100,
      })
    }
  } finally {
    await recordingsRepo.remove(recording.id).catch(() => undefined)
  }

  return {
    takeMs: recording.durationMs,
    keyframes,
    checks,
    bandPx: BAND_PX,
    zoomedIsDefaultEdit,
    untouched,
    exportTimeDeltaPct,
    passed:
      checks.length === 3 &&
      checks.every((c) => c.within) &&
      !zoomedIsDefaultEdit &&
      untouched.isDefaultEdit &&
      untouched.pipErrorPx !== null &&
      untouched.pipErrorPx <= BAND_PX,
    notes: [
      'the PiP is the fiducial: the compositor puts it at a known place in FRAME space, so where it lands on the CANVAS is a direct read of the viewport transform',
      'the middle sample (3.5 s) sits between the two moves and proves the view HOLDS there rather than drifting toward the next keyframe',
      'a zoomed take must report isDefaultEdit false — the composite is the whole frame, so packet-copying it would ship a video that ignores the zoom',
      'the band is 10 px at 1080p because the locator reads in 8 px blocks; below one block there is nothing to measure',
    ],
  }
}
