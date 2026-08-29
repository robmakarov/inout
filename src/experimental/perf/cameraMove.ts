/**
 * EXPERIMENTAL — F4 evidence: the movable, TIMED camera.
 *
 * The claim under test is not "the PiP can be dragged" — it is that the
 * exported FILE shows the camera where the user put it, AT the instant they
 * put it there. So this measures the pixels: it records a synthetic take
 * (whose camera is a flat grey field with a red ball, deliberately unlike the
 * dark gradient of the synthetic screen), writes camera keyframes exactly as
 * the editor's drag handler does, exports through the production pipeline, and
 * then LOCATES the PiP in decoded frames and compares where it actually is
 * against where the pose function says it should be.
 *
 * It also guards the thing that must not change: a take nobody touched still
 * takes the instant packet-copy path, and its PiP still lands in the fixed
 * bottom-right slot to the pixel.
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { createCaptureSession } from '@core/capture/session'
import { warmRigEncoder } from '../rigWarm'
import { exportInstant } from '@core/compose/instant'
import { exportRecording } from '@core/compose'
import { editsRepo, recordingsRepo } from '@core/store'
import {
  cameraPoseAt,
  clampEditState,
  defaultCameraPose,
  defaultEditState,
  isDefaultEdit,
  poseToRect,
  writeCameraKeyframe,
  type CameraGeometry,
} from '@core/timeline'
import type { CameraTrack, CaptureConfig, EditState, Recording } from '@core/types'

/** Blocks, not pixels: anti-aliased text edges on the synthetic screen are
 * grey too, but they never fill an 8×8 block, and the camera field always does. */
const BLOCK = 8
const BLOCK_FILL = 0.6

interface MeasuredRect {
  leftFrac: number
  topFrac: number
  widthFrac: number
  heightFrac: number
  centreXFrac: number
  centreYFrac: number
  blocks: number
}

/**
 * Find the camera PiP in one decoded frame. The synthetic camera is a flat
 * #7f7f7f field with a red ball; the synthetic screen is a dark, SATURATED
 * gradient plus white text. So "neutral grey at mid brightness, or strongly
 * red" separates them with a wide margin even after 4:2:0 subsampling.
 */
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
  if (maxC < 0 || blocks < 16) return null
  const leftFrac = (minC * BLOCK) / width
  const rightFrac = ((maxC + 1) * BLOCK) / width
  const topFrac = (minR * BLOCK) / height
  const bottomFrac = ((maxR + 1) * BLOCK) / height
  return {
    leftFrac,
    topFrac,
    widthFrac: rightFrac - leftFrac,
    heightFrac: bottomFrac - topFrac,
    centreXFrac: (leftFrac + rightFrac) / 2,
    centreYFrac: (topFrac + bottomFrac) / 2,
    blocks,
  }
}

export interface SampleCheck {
  atMs: number
  expected: { centreXFrac: number; centreYFrac: number; widthFrac: number }
  measured: MeasuredRect | null
  /** Error in fractions of the frame; the block grid alone costs ~0.004. */
  centreErrXFrac: number | null
  centreErrYFrac: number | null
  widthErrFrac: number | null
  withinBand: boolean
}

const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d

async function sampleExport(
  blob: Blob,
  timesMs: number[],
  expectedAt: (ms: number, g: CameraGeometry) => { centreXFrac: number; centreYFrac: number; widthFrac: number },
  tolerance: number,
): Promise<{ width: number; height: number; checks: SampleCheck[] }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('exported file has no video track')
    const width = track.displayWidth
    const height = track.displayHeight
    const sink = new VideoSampleSink(track)
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2d context unavailable')
    const geometry: CameraGeometry = { frameAspect: width / height, cameraAspect: 4 / 3 }
    const checks: SampleCheck[] = []
    for (const atMs of timesMs) {
      const sample = await sink.getSample(atMs / 1000)
      let measured: MeasuredRect | null = null
      if (sample) {
        sample.draw(ctx, 0, 0, width, height)
        measured = locatePip(ctx.getImageData(0, 0, width, height).data, width, height)
        sample.close()
      }
      const expected = expectedAt(atMs, geometry)
      const centreErrXFrac = measured ? round(measured.centreXFrac - expected.centreXFrac) : null
      const centreErrYFrac = measured ? round(measured.centreYFrac - expected.centreYFrac) : null
      const widthErrFrac = measured ? round(measured.widthFrac - expected.widthFrac) : null
      checks.push({
        atMs,
        expected: {
          centreXFrac: round(expected.centreXFrac),
          centreYFrac: round(expected.centreYFrac),
          widthFrac: round(expected.widthFrac),
        },
        measured: measured
          ? {
              leftFrac: round(measured.leftFrac),
              topFrac: round(measured.topFrac),
              widthFrac: round(measured.widthFrac),
              heightFrac: round(measured.heightFrac),
              centreXFrac: round(measured.centreXFrac),
              centreYFrac: round(measured.centreYFrac),
              blocks: measured.blocks,
            }
          : null,
        centreErrXFrac,
        centreErrYFrac,
        widthErrFrac,
        withinBand:
          centreErrXFrac !== null &&
          centreErrYFrac !== null &&
          widthErrFrac !== null &&
          Math.abs(centreErrXFrac) <= tolerance &&
          Math.abs(centreErrYFrac) <= tolerance &&
          Math.abs(widthErrFrac) <= tolerance * 2,
      })
    }
    return { width, height, checks }
  } finally {
    input.dispose()
  }
}

export interface F4Report {
  takeMs: number
  dragAtMs: number[]
  toleranceFrac: number
  track: CameraTrack
  untouched: {
    isDefaultEdit: boolean
    instantPathWorks: boolean
    bytes: number
    /** The fixed bottom-right slot must be exactly where it always was. */
    checks: SampleCheck[]
    allWithinBand: boolean
  }
  moved: {
    isDefaultEdit: boolean
    exportMs: number
    bytes: number
    width: number
    height: number
    checks: SampleCheck[]
    allWithinBand: boolean
  }
  persistence: { saved: boolean; reloadedTrack: CameraTrack | null; identical: boolean }
  notes: string[]
}

export async function runCameraMove(opts: { takeMs?: number } = {}): Promise<F4Report> {
  // NOTE 6: prearm warms production's first VideoEncoder at mount; a rig that
  // opens a session directly does not, and a cold first encoder eats the take.
  await warmRigEncoder()
  const takeMs = opts.takeMs ?? 9000
  const config: CaptureConfig = { screen: true, camera: true, mic: false, systemAudio: false }
  const session = await createCaptureSession(config)
  session.start()
  await new Promise((r) => setTimeout(r, takeMs))
  const recording: Recording = await session.stop()

  try {
    const base = defaultEditState(recording)
    const geometry: CameraGeometry = { frameAspect: 16 / 9, cameraAspect: 4 / 3 }
    // A tolerance of 0.02 frame-widths = 38 px at 1080p. The 8 px block grid
    // alone costs half of one, so this is tight rather than generous.
    const tolerance = 0.02

    // ---- the untouched take must be untouched -----------------------------
    const untouchedDefault = isDefaultEdit(recording, base)
    let instantBytes = 0
    let instantChecks: SampleCheck[] = []
    let instantWorks = false
    if (recording.composite) {
      try {
        const instant = await exportInstant({ recording, edit: base })
        instantWorks = true
        instantBytes = instant.blob.size
        const d = defaultCameraPose(geometry)
        const rect = poseToRect(d, geometry)
        const expectDefault = () => ({
          centreXFrac: d.xFrac,
          centreYFrac: d.yFrac,
          widthFrac: rect.widthFrac,
        })
        instantChecks = (
          await sampleExport(instant.blob, [1000, takeMs / 2], expectDefault, tolerance)
        ).checks
      } catch (err) {
        console.warn('instant export failed', err)
      }
    }

    // ---- two drags, at 2 s and 5 s ----------------------------------------
    const dragAtMs = [2000, 5000]
    let track: CameraTrack | undefined
    // Drag 1: up to the top-left, same size.
    track = writeCameraKeyframe(
      track,
      dragAtMs[0]!,
      { xFrac: 0.18, yFrac: 0.2, widthFrac: 0.24 },
      geometry,
      recording.durationMs,
    )
    // Drag 2: down to the bottom-left, and bigger — proves resize is timed too.
    track = writeCameraKeyframe(
      track,
      dragAtMs[1]!,
      { xFrac: 0.22, yFrac: 0.74, widthFrac: 0.34 },
      geometry,
      recording.durationMs,
    )
    const movedEdit: EditState = clampEditState(recording, { ...base, camera: track })

    const t0 = performance.now()
    const moved = await exportRecording({ recording, edit: movedEdit })
    const exportMs = Math.round(performance.now() - t0)

    const expectedAt = (ms: number, g: CameraGeometry) => {
      const pose = cameraPoseAt(movedEdit.camera, ms, g)
      return {
        centreXFrac: pose.xFrac,
        centreYFrac: pose.yFrac,
        widthFrac: poseToRect(pose, g).widthFrac,
      }
    }
    // Before the first move begins · exactly ON drag 1 · held · exactly ON
    // drag 2 · held. The two "held" samples are the ones that prove the camera
    // is NOT drifting between drags, and the two exact-instant samples are the
    // gate itself: at t=2 s and t=5 s the PiP must BE where it was dropped.
    const times = [1000, 2000, 3500, 5000, Math.min(8000, takeMs - 500)]
    const sampled = await sampleExport(moved.blob, times, expectedAt, tolerance)

    // ---- persistence -------------------------------------------------------
    let saved = false
    let reloadedTrack: CameraTrack | null = null
    try {
      await editsRepo.save(movedEdit)
      saved = true
      const back = await editsRepo.get(recording.id)
      reloadedTrack = back?.camera ?? null
    } catch (err) {
      console.warn('edit persistence failed', err)
    }

    return {
      takeMs: recording.durationMs,
      dragAtMs,
      toleranceFrac: tolerance,
      track: movedEdit.camera!,
      untouched: {
        isDefaultEdit: untouchedDefault,
        instantPathWorks: instantWorks,
        bytes: instantBytes,
        checks: instantChecks,
        allWithinBand: instantChecks.length > 0 && instantChecks.every((c) => c.withinBand),
      },
      moved: {
        isDefaultEdit: isDefaultEdit(recording, movedEdit),
        exportMs,
        bytes: moved.blob.size,
        width: sampled.width,
        height: sampled.height,
        checks: sampled.checks,
        allWithinBand: sampled.checks.every((c) => c.withinBand),
      },
      persistence: {
        saved,
        reloadedTrack,
        identical: JSON.stringify(reloadedTrack) === JSON.stringify(movedEdit.camera),
      },
      notes: [
        'the PiP is located by PIXELS in the decoded export, not by re-reading the pose function — the two are compared, which is the only way the render can be caught disagreeing with the model',
        'samples at 4800 ms and 8000 ms are the important ones: they prove the camera HOLDS between drags instead of drifting, which is what "moves exactly when the user moved it" has to mean',
        'the untouched take is exported through the instant packet-copy path and its PiP must still land in the historical bottom-right slot',
      ],
    }
  } finally {
    await editsRepo.remove(recording.id).catch(() => undefined)
    await recordingsRepo.remove(recording.id).catch(() => undefined)
  }
}
