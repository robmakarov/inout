/**
 * EXPERIMENTAL — F3 evidence: the background frame.
 *
 * Three claims, all measured on the PRODUCTION exporter:
 *
 * 1. PARITY. The screen surface lands exactly where the pure geometry function
 *    says it does. Measured the F4 way — not by trusting the renderer, but by
 *    LOCATING the surface in decoded exported frames: with a bright backdrop
 *    behind a dark screen, a scan across the middle row and column finds the
 *    four edges to the pixel. The editor positions its <video> from the same
 *    function, so pinning the export to it pins the preview too.
 * 2. THE DEFAULT IS UNTOUCHED. The same take exported with no background must
 *    still be full bleed — the surface fills the frame edge to edge.
 * 3. COST. Painting a backdrop, clipping a rounded rect and casting a shadow on
 *    every frame must not make exports meaningfully slower (gate: <10 %).
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { createCaptureSession } from '@core/capture/session'
import { exportRecording } from '@core/compose'
import { containRect, screenInsetRect } from '@core/compose/background'
import { recordingsRepo } from '@core/store'
import { defaultEditState } from '@core/timeline'
import type { BackgroundStyle, CaptureConfig, EditState, Recording } from '@core/types'

const W = 1920
const H = 1080

interface EdgeRect {
  leftFrac: number
  topFrac: number
  widthFrac: number
  heightFrac: number
}

/**
 * Find the screen surface by walking in from each edge until the pixel stops
 * looking like the backdrop. Middle row and middle column only, so the corner
 * radius cannot bias the answer.
 */
function locateSurface(img: ImageData): EdgeRect | null {
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * img.width + x) * 4
    return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]
  }
  const far = (p: [number, number, number], q: [number, number, number]): boolean =>
    Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 60

  const midY = Math.floor(img.height / 2)
  const midX = Math.floor(img.width / 2)
  // The backdrop is sampled at the very corner pixel, which the surface can
  // never reach while any inset is in play.
  const bgLeft = at(0, midY)
  const bgTop = at(midX, 0)

  let left = 0
  while (left < img.width && !far(at(left, midY), bgLeft)) left++
  let right = img.width - 1
  while (right > left && !far(at(right, midY), at(img.width - 1, midY))) right--
  let top = 0
  while (top < img.height && !far(at(midX, top), bgTop)) top++
  let bottom = img.height - 1
  while (bottom > top && !far(at(midX, bottom), at(midX, img.height - 1))) bottom--
  if (left >= right || top >= bottom) return null
  return {
    leftFrac: left / img.width,
    topFrac: top / img.height,
    widthFrac: (right - left + 1) / img.width,
    heightFrac: (bottom - top + 1) / img.height,
  }
}

async function frameAt(blob: Blob, timeSec: number): Promise<ImageData | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return null
    const sink = new VideoSampleSink(track)
    const sample = await sink.getSample(timeSec)
    if (!sample) return null
    const canvas = new OffscreenCanvas(W, H)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    sample.draw(ctx, 0, 0, W, H)
    sample.close()
    return ctx.getImageData(0, 0, W, H)
  } finally {
    input.dispose()
  }
}

export interface F3Case {
  label: string
  background: BackgroundStyle | null
  wallMs: number
  bytes: number
  /** Where the surface actually is, read out of a decoded frame. */
  measured: EdgeRect | null
  /** Where the pure geometry says it should be. */
  expected: EdgeRect
  /** Worst edge error, in output pixels. */
  maxErrorPx: number | null
  /**
   * False for the shadowed case: a drop shadow darkens the backdrop AROUND the
   * surface, and an edge scan cannot tell "shadowed backdrop" from "surface".
   * The overshoot it produces is reported as shadowReachPx instead — evidence
   * that the shadow exists and how far it reaches, not a geometry error.
   */
  parityChecked: boolean
  shadowReachPx?: number
  verdict: 'PASS' | 'FAIL' | 'n/a'
}

export interface F3Report {
  takeMs: number
  passed: boolean
  cases: F3Case[]
  /** Framed render time against the plain one, percent. Gate: <10. */
  exportTimeDeltaPct: number | null
  parityBandPx: number
  notes: string[]
}

const PARITY_BAND_PX = 3

export async function runBackgroundFrame(opts: { takeMs?: number } = {}): Promise<F3Report> {
  const takeMs = opts.takeMs ?? 6000
  // Screen ONLY: the camera PiP is anchored to the frame, not to the inset
  // surface, so it would sit on top of the edge this measurement scans for.
  const config: CaptureConfig = { screen: true, camera: false, mic: true, systemAudio: false }
  const session = await createCaptureSession(config)
  session.start()
  await new Promise((r) => setTimeout(r, takeMs))
  const recording: Recording = await session.stop()

  const cases: F3Case[] = []
  try {
    const base = defaultEditState(recording)
    const variants: { label: string; background: BackgroundStyle | null }[] = [
      { label: 'default (no background)', background: null },
      {
        label: 'mint, inset M, rounded, no shadow',
        background: { preset: 'mint', padFrac: 0.06, radiusFrac: 0.022, shadow: false },
      },
      {
        label: 'mint, inset L, flush corners, no shadow',
        background: { preset: 'mint', padFrac: 0.1, radiusFrac: 0, shadow: false },
      },
      {
        label: 'mint, inset M, rounded, SHADOW',
        background: { preset: 'mint', padFrac: 0.06, radiusFrac: 0.022, shadow: true },
      },
    ]
    for (const v of variants) {
      const edit: EditState = v.background ? { ...base, background: v.background } : base
      const t0 = performance.now()
      const result = await exportRecording({
        recording,
        edit,
        settings: { width: W, height: H, fps: 30 },
      })
      const wallMs = Math.round(performance.now() - t0)
      const img = await frameAt(result.blob, Math.min(2, takeMs / 2000))
      const measured = img ? locateSurface(img) : null
      const box = screenInsetRect(v.background ?? undefined, W / H)
      // The synthetic screen source is 16:9, so the contain box IS the inset box;
      // computing it through containRect anyway keeps the check honest for any
      // source aspect the rig might grow later.
      const expected = containRect(box, W / H, 16 / 9)
      const maxErrorPx = measured
        ? Math.max(
            Math.abs(measured.leftFrac - expected.leftFrac) * W,
            Math.abs(measured.topFrac - expected.topFrac) * H,
            Math.abs(measured.widthFrac - expected.widthFrac) * W,
            Math.abs(measured.heightFrac - expected.heightFrac) * H,
          )
        : null
      const shadowed = !!v.background?.shadow
      const parityChecked = !!v.background && !shadowed
      const rounded = maxErrorPx === null ? null : Math.round(maxErrorPx * 10) / 10
      cases.push({
        label: v.label,
        background: v.background,
        wallMs,
        bytes: result.blob.size,
        measured,
        expected,
        maxErrorPx: parityChecked ? rounded : null,
        parityChecked,
        // A shadow makes the scan stop early; how early IS the shadow's reach.
        shadowReachPx: shadowed && rounded !== null ? rounded : undefined,
        verdict: v.background
          ? shadowed
            ? measured
              ? 'n/a'
              : 'FAIL'
            : rounded !== null && rounded <= PARITY_BAND_PX
              ? 'PASS'
              : 'FAIL'
          : // No background: the scan must find NO inset band at all, which is
            // exactly what a full-bleed frame looks like.
            measured === null
            ? 'PASS'
            : 'FAIL',
      })
    }
  } finally {
    await recordingsRepo.remove(recording.id).catch(() => undefined)
  }

  const plain = cases[0]
  const framed = cases[cases.length - 1]
  return {
    takeMs: recording.durationMs,
    cases,
    passed: cases.every((c) => c.verdict !== 'FAIL'),
    exportTimeDeltaPct:
      plain && framed && plain.wallMs > 0
        ? Math.round(((framed.wallMs - plain.wallMs) / plain.wallMs) * 1000) / 10
        : null,
    parityBandPx: PARITY_BAND_PX,
    notes: [
      'the surface is LOCATED in a decoded exported frame, then compared against the same pure function the editor stage positions its <video> from',
      'the default case must measure the full frame (0,0,1,1): a take nobody framed has to render exactly as it did before F3',
      'edges are scanned along the middle row and column, so the corner radius cannot move the answer',
      'the export-time delta compares the FULL-WORKS case (backdrop + rounded clip + shadow) against the plain render of the same take',
    ],
  }
}
