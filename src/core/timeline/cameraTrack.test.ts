import { describe, expect, it } from 'vitest'
import type { CameraTrack } from '../types'
import {
  CAMERA_MOVE_MS,
  PIP_MARGIN_X_FRAC,
  PIP_MARGIN_Y_FRAC,
  PIP_MAX_WIDTH_FRAC,
  PIP_MIN_WIDTH_FRAC,
  PIP_WIDTH_FRAC,
  cameraPoseAt,
  cameraTrackIsActive,
  clampPose,
  defaultCameraPose,
  easeInOut,
  normalizeCameraTrack,
  poseToRect,
  writeCameraKeyframe,
} from './cameraTrack'

/** 16:9 output, 4:3 camera — the synthetic rig's shape (640×480). */
const G = { frameAspect: 16 / 9, cameraAspect: 4 / 3 }
const TAKE_MS = 10_000

/** Poses are lerped, so a boundary sample can land 1 ulp away from its
 * keyframe — compare numerically rather than by identity. */
function expectPose(actual: { xFrac: number; yFrac: number; widthFrac: number }, expected: { xFrac: number; yFrac: number; widthFrac: number }): void {
  expect(actual.xFrac).toBeCloseTo(expected.xFrac, 10)
  expect(actual.yFrac).toBeCloseTo(expected.yFrac, 10)
  expect(actual.widthFrac).toBeCloseTo(expected.widthFrac, 10)
}

describe('the default pose reproduces the pre-F4 layout exactly', () => {
  it('is the bottom-right slot the fixed layout always drew', () => {
    const rect = poseToRect(defaultCameraPose(G), G)
    expect(rect.widthFrac).toBe(PIP_WIDTH_FRAC)
    // Right edge sits one 24px-at-1920 margin in from the frame's right.
    expect(rect.leftFrac + rect.widthFrac).toBeCloseTo(1 - PIP_MARGIN_X_FRAC, 12)
    expect(rect.topFrac + rect.heightFrac).toBeCloseTo(1 - PIP_MARGIN_Y_FRAC, 12)
  })

  it('matches the CSS the editor preview has always used (24% / 1.25% / 2.2%)', () => {
    // These three numbers are literally in app.css. If the pose math and the
    // stylesheet ever disagree the preview stops predicting the export, which
    // is the one thing the stage exists to do.
    const rect = poseToRect(defaultCameraPose(G), G)
    expect(rect.widthFrac * 100).toBeCloseTo(24, 6)
    expect((1 - rect.leftFrac - rect.widthFrac) * 100).toBeCloseTo(1.25, 6)
    expect((1 - rect.topFrac - rect.heightFrac) * 100).toBeCloseTo(2.222, 3)
  })

  it('keeps the camera aspect: a 4:3 source is 4:3 in the frame', () => {
    const rect = poseToRect(defaultCameraPose(G), G)
    const pxW = rect.widthFrac * 1920
    const pxH = rect.heightFrac * 1080
    expect(pxW / pxH).toBeCloseTo(4 / 3, 9)
  })

  it('is what an absent or empty track samples to at any time', () => {
    const d = defaultCameraPose(G)
    expectPose(cameraPoseAt(undefined, 0, G), d)
    expectPose(cameraPoseAt(undefined, 99_999, G), d)
    expectPose(cameraPoseAt({ keyframes: [] }, 5000, G), d)
    expect(cameraTrackIsActive(undefined)).toBe(false)
    expect(cameraTrackIsActive({ keyframes: [] })).toBe(false)
  })
})

describe('clamping keeps the PiP inside the frame', () => {
  it('pins a pose dragged off each edge', () => {
    const w = 0.24
    const halfH = (w * G.frameAspect) / G.cameraAspect / 2
    expect(clampPose({ xFrac: -5, yFrac: 0.5, widthFrac: w }, G).xFrac).toBeCloseTo(w / 2, 12)
    expect(clampPose({ xFrac: 5, yFrac: 0.5, widthFrac: w }, G).xFrac).toBeCloseTo(1 - w / 2, 12)
    expect(clampPose({ xFrac: 0.5, yFrac: -5, widthFrac: w }, G).yFrac).toBeCloseTo(halfH, 12)
    expect(clampPose({ xFrac: 0.5, yFrac: 5, widthFrac: w }, G).yFrac).toBeCloseTo(1 - halfH, 12)
  })

  it('bounds the size', () => {
    expect(clampPose({ xFrac: 0.5, yFrac: 0.5, widthFrac: 0.001 }, G).widthFrac).toBe(
      PIP_MIN_WIDTH_FRAC,
    )
    expect(clampPose({ xFrac: 0.5, yFrac: 0.5, widthFrac: 9 }, G).widthFrac).toBe(
      PIP_MAX_WIDTH_FRAC,
    )
  })

  it('centres a PiP too tall to fit rather than clamping it off-frame', () => {
    // A very wide 1:4 camera at max width is taller than the frame.
    const tall = { frameAspect: 16 / 9, cameraAspect: 0.25 }
    const p = clampPose({ xFrac: 0.5, yFrac: 0.1, widthFrac: PIP_MAX_WIDTH_FRAC }, tall)
    expect(p.yFrac).toBe(0.5)
  })
})

describe('easing', () => {
  it('is a rest-to-rest cubic pinned at both ends', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 12)
    expect(easeInOut(-3)).toBe(0)
    expect(easeInOut(3)).toBe(1)
    // Slower than linear at the start, which is what "eased" has to mean.
    expect(easeInOut(0.1)).toBeLessThan(0.1)
    expect(easeInOut(0.9)).toBeGreaterThan(0.9)
  })
})

describe('a drag lands the camera exactly ON the instant it was dragged at', () => {
  const target = { xFrac: 0.2, yFrac: 0.25, widthFrac: 0.3 }

  it('writes an anchor one move BEFORE the playhead and the new pose at it', () => {
    const t = writeCameraKeyframe(undefined, 2000, target, G, TAKE_MS)
    expect(t.keyframes.map((k) => k.atMs)).toEqual([2000 - CAMERA_MOVE_MS, 2000])
    // The anchor holds the pose the camera already had.
    expect(t.keyframes[0]).toMatchObject(defaultCameraPose(G))
    expect(t.keyframes[1]).toMatchObject(clampPose(target, G))
  })

  it('is AT the dropped pose at the playhead — the stage must not spring back', () => {
    // This is the property the first implementation got wrong: it started the
    // move at the playhead, so releasing a drag snapped the box back to where
    // it had been and the edit looked like it had failed.
    const t = writeCameraKeyframe(undefined, 2000, target, G, TAKE_MS)
    expectPose(cameraPoseAt(t, 2000, G), clampPose(target, G))
  })

  it('holds the old pose until the move begins, then eases in', () => {
    const t = writeCameraKeyframe(undefined, 2000, target, G, TAKE_MS)
    const d = defaultCameraPose(G)
    expectPose(cameraPoseAt(t, 0, G), d)
    expectPose(cameraPoseAt(t, 2000 - CAMERA_MOVE_MS, G), d)
    const mid = cameraPoseAt(t, 2000 - CAMERA_MOVE_MS / 2, G)
    expect(mid.xFrac).toBeLessThan(d.xFrac)
    expect(mid.xFrac).toBeGreaterThan(target.xFrac)
    expectPose(cameraPoseAt(t, 9000, G), clampPose(target, G))
  })

  it('replays two drags as two separate moves, each at its own instant', () => {
    const a = { xFrac: 0.2, yFrac: 0.25, widthFrac: 0.24 }
    const b = { xFrac: 0.8, yFrac: 0.75, widthFrac: 0.24 }
    let t = writeCameraKeyframe(undefined, 2000, a, G, TAKE_MS)
    t = writeCameraKeyframe(t, 5000, b, G, TAKE_MS)
    expectPose(cameraPoseAt(t, 2000, G), clampPose(a, G))
    // Still at A for the whole span between the drags — no slow drift.
    expectPose(cameraPoseAt(t, 3000, G), clampPose(a, G))
    expectPose(cameraPoseAt(t, 5000 - CAMERA_MOVE_MS, G), clampPose(a, G))
    expectPose(cameraPoseAt(t, 5000, G), clampPose(b, G))
  })

  it('replaces a move when the same instant is dragged twice', () => {
    const a = { xFrac: 0.2, yFrac: 0.25, widthFrac: 0.24 }
    const b = { xFrac: 0.7, yFrac: 0.6, widthFrac: 0.24 }
    let t = writeCameraKeyframe(undefined, 2000, a, G, TAKE_MS)
    t = writeCameraKeyframe(t, 2000, b, G, TAKE_MS)
    expect(t.keyframes).toHaveLength(2)
    expectPose(cameraPoseAt(t, 2000, G), clampPose(b, G))
  })

  it('clamps a drag that lands off-frame instead of refusing it', () => {
    const t = writeCameraKeyframe(undefined, 1000, { xFrac: 2, yFrac: 2, widthFrac: 0.24 }, G, TAKE_MS)
    const landed = cameraPoseAt(t, 1000, G)
    expect(landed.xFrac).toBeCloseTo(1 - 0.12, 12)
    expect(landed.yFrac).toBeLessThan(1)
  })

  it('a drag at t=0 sets the camera for the whole take, with no run-up', () => {
    const t = writeCameraKeyframe(undefined, 0, target, G, TAKE_MS)
    expect(t.keyframes).toHaveLength(1)
    expectPose(cameraPoseAt(t, 0, G), clampPose(target, G))
    expectPose(cameraPoseAt(t, TAKE_MS, G), clampPose(target, G))
  })

  it('a drag at the very end still lands there', () => {
    const t = writeCameraKeyframe(undefined, TAKE_MS, target, G, TAKE_MS)
    expect(t.keyframes.map((k) => k.atMs)).toEqual([TAKE_MS - CAMERA_MOVE_MS, TAKE_MS])
    expectPose(cameraPoseAt(t, TAKE_MS, G), clampPose(target, G))
  })
})

describe('normalization', () => {
  it('sorts, bounds to the take, and keeps the last of a tie', () => {
    const messy: CameraTrack = {
      keyframes: [
        { atMs: 5000, xFrac: 0.5, yFrac: 0.5, widthFrac: 0.24 },
        { atMs: -100, xFrac: 0.1, yFrac: 0.1, widthFrac: 0.24 },
        { atMs: 99_999, xFrac: 0.9, yFrac: 0.9, widthFrac: 0.24 },
        { atMs: 5000, xFrac: 0.6, yFrac: 0.6, widthFrac: 0.24 },
      ],
    }
    const t = normalizeCameraTrack(messy, TAKE_MS)
    expect(t.keyframes.map((k) => k.atMs)).toEqual([0, 5000, TAKE_MS])
    expect(t.keyframes[1]!.xFrac).toBe(0.6)
  })

  it('drops garbage rather than rendering NaN', () => {
    const t = normalizeCameraTrack(
      { keyframes: [{ atMs: Number.NaN, xFrac: 0.5, yFrac: 0.5, widthFrac: 0.24 }] },
      TAKE_MS,
    )
    expect(t.keyframes).toHaveLength(0)
  })
})
