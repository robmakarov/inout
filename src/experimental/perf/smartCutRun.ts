/**
 * EXPERIMENTAL — O5c evidence: smart cut against the full render.
 *
 * Records a REAL take through createCaptureSession (synthetic sources, so it
 * needs no permissions but is otherwise the production path, composite and
 * all), applies a trim-only edit, and exports it both ways.
 *
 * Two questions, and the second one is the one that matters:
 *   1. is it faster?  wall clock, both paths, same edit
 *   2. IS IT THE SAME PICTURE?  the smart-cut file mixes packets from the
 *      capture encoder with frames re-encoded here, so the only honest test is
 *      to decode both files at the same output instants and compare pixels —
 *      including instants deliberately placed just AFTER each cut, which is
 *      where a decoder-config mismatch would show up first.
 *
 * A cut is placed off the keyframe grid on purpose (the composite's cadence is
 * 2 s): a cut that happened to land on a keyframe would exercise none of the
 * boundary re-encode, which is the whole risky part.
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { createCaptureSession } from '@core/capture/session'
import { warmRigEncoder } from '../rigWarm'
import { exportInstant, exportRecording } from '@core/compose'
import { exportSmartCut, getLastSmartCutStats, type SmartCutStats } from '@core/compose/smartCut'
import { readCertification } from '@core/compose/certify'
import { recordingsRepo } from '@core/store'
import { clampEditState, defaultEditState, outputDurationMs } from '@core/timeline'
import type { CaptureConfig, EditState, ExportResult, Recording } from '@core/types'

/**
 * Detach an export result from the scratch file it lives on.
 *
 * The export scratch keeps only the NEWEST finished file (scratch.ts), so the
 * next export deletes the previous one out from under its own Blob and every
 * later read of it fails with a bare `TypeError: network error`. That is
 * correct for the product — one export result is live at a time — and fatal
 * for a rig that compares several. This rig therefore pulls each file into
 * memory the moment it is produced; they are a few MB each.
 */
async function detach(blob: Blob): Promise<Blob> {
  return new Blob([await blob.arrayBuffer()], { type: blob.type })
}

/** Decode one frame per requested instant, as RGBA at a fixed size. */
async function framesAt(blob: Blob, instantsSec: number[]): Promise<(ImageData | null)[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return instantsSec.map(() => null)
    const sink = new VideoSampleSink(track)
    const canvas = new OffscreenCanvas(960, 540)
    const ctx = canvas.getContext('2d', { alpha: false })!
    const out: (ImageData | null)[] = []
    for (const t of instantsSec) {
      const s = await sink.getSample(t)
      if (!s) {
        out.push(null)
        continue
      }
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, 960, 540)
      s.draw(ctx, 0, 0, 960, 540)
      s.close()
      out.push(ctx.getImageData(0, 0, 960, 540))
    }
    return out
  } finally {
    input.dispose()
  }
}

function psnr(a: ImageData, b: ImageData): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c]! - b.data[i + c]!
      sum += d * d
      n++
    }
  }
  const mse = sum / Math.max(1, n)
  if (mse === 0) return Infinity
  return Math.round(10 * Math.log10((255 * 255) / mse) * 10) / 10
}

async function probe(blob: Blob): Promise<{
  durationSec: number
  width: number | null
  height: number | null
  decodedFrames: number
  rung?: string
}> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    const duration = await input.computeDuration()
    let decodedFrames = 0
    if (video) {
      const sink = new VideoSampleSink(video)
      for (const t of [0, duration / 2, Math.max(0, duration - 0.2)]) {
        const s = await sink.getSample(t)
        if (s) {
          decodedFrames++
          s.close()
        }
      }
    }
    const tags = await input.getMetadataTags()
    return {
      durationSec: Math.round(duration * 1000) / 1000,
      width: video?.displayWidth ?? null,
      height: video?.displayHeight ?? null,
      decodedFrames,
      rung: readCertification(tags.comment)?.codec?.rung,
    }
  } finally {
    input.dispose()
  }
}

export interface SmartCutLane {
  path: 'smartcut' | 'render'
  ok: boolean
  reason?: string
  wallMs: number
  bytes: number
  probe?: Awaited<ReturnType<typeof probe>>
}

export interface O5CutReport {
  notes: string[]
  takeMs: number
  editKind: string
  outputSec: number
  compositeDurationMs: number | null
  lanes: SmartCutLane[]
  stats: SmartCutStats | null
  /** Same output instants decoded from both files; ∞ = pixel-identical. */
  parity: { atSec: number; psnrDb: number | null; justAfterCut: boolean }[]
  /** Worst instant re-compared against the render shifted +-2 frames. */
  sweep: { offsetFrames: number; psnrDb: number | null }[] | null
  /** SHIPPED instant path vs the same render, unedited — whose offset is it? */
  control: { atSec: number; bestOffsetFrames: number; bestPsnrDb: number | null }[] | null
  /** Smart cut vs the INSTANT copy of the same composite: is the rebase right? */
  rebase: { atSec: number; bestOffsetFrames: number; bestPsnrDb: number | null }[] | null
  gates: {
    /** The gate: a trim-only edit of a 30 s take exports in ≤1 s. */
    underOneSecond: { wallMs: number; pass: boolean }
    speedup: number | null
    /** Every sampled instant matches the render (≥35 dB is "the same picture"). */
    samePicture: {
      minPsnrDb: number | null
      /** Worst instant re-scored at the best ±2-frame alignment. */
      alignedPsnrDb: number | null
      /** Offset the SHIPPED instant path shows against the same render. */
      compositeOffsetFrames: number | null
      pass: boolean
    }
  }
}

export async function runSmartCut(
  opts: { takeMs?: number; cutAtFraction?: number } = {},
): Promise<O5CutReport> {
  // NOTE 6: prearm warms production's first VideoEncoder at mount; a rig that
  // opens a session directly does not, and a cold first encoder eats the take.
  await warmRigEncoder()
  const takeMs = opts.takeMs ?? 30_000
  const notes: string[] = []
  const config: CaptureConfig = { screen: true, camera: false, mic: true, systemAudio: false }
  const session = await createCaptureSession(config)
  session.start()
  await new Promise((r) => setTimeout(r, takeMs))
  const recording: Recording = await session.stop()

  const lanes: SmartCutLane[] = []
  const parity: O5CutReport['parity'] = []
  let stats: SmartCutStats | null = null
  let sweep: { offsetFrames: number; psnrDb: number | null }[] | null = null
  let control: { atSec: number; bestOffsetFrames: number; bestPsnrDb: number | null }[] | null = null
  let rebase: { atSec: number; bestOffsetFrames: number; bestPsnrDb: number | null }[] | null = null
  let smartWallMs = Number.POSITIVE_INFINITY
  let renderWallMs = Number.POSITIVE_INFINITY

  try {
    if (!recording.composite) notes.push('NO COMPOSITE in this take — smart cut cannot apply')
    if (recording.composite?.tailIncomplete) notes.push('composite tailIncomplete — smart cut refuses')

    // A trim-only edit: drop the first 3.4 s and a 2.6 s slice out of the
    // middle. Neither boundary is a multiple of the composite's 2 s keyframe
    // cadence, which is the point.
    const base = clampEditState(recording, defaultEditState(recording))
    const cutStart = Math.round(takeMs * (opts.cutAtFraction ?? 0.45))
    const edit: EditState = clampEditState(recording, {
      ...base,
      segments: [
        { startMs: 3400, endMs: cutStart },
        { startMs: cutStart + 2600, endMs: recording.durationMs },
      ],
    })
    const outputSec = outputDurationMs(edit) / 1000
    // The first join on the OUTPUT timeline — sample just after it, which is
    // where a mismatched decoder config shows up first.
    const joinSec = (cutStart - 3400) / 1000

    // The instants both files get compared at. One sits 50 ms past the join,
    // which is where a decoder-config mismatch shows up first.
    const instants = [
      0.5,
      Math.max(0, joinSec - 0.5),
      joinSec + 0.05,
      joinSec + 0.3,
      joinSec + 1.5,
      Math.max(0, outputSec - 0.5),
    ]

    let smart: ExportResult | null = null
    let smartFrames: (ImageData | null)[] | null = null
    const t0 = performance.now()
    try {
      const produced = await exportSmartCut({ recording, edit })
      smartWallMs = performance.now() - t0
      smart = { ...produced, blob: await detach(produced.blob) }
      stats = getLastSmartCutStats()
      const p = await probe(smart.blob)
      // READ THE PIXELS NOW. The export scratch keeps only the newest finished
      // file (scratch.ts), so the render below will delete this one out from
      // under its own Blob — the first version of this rig reported a bare
      // "TypeError: network error" for exactly that reason. Note 10 again.
      smartFrames = await framesAt(smart.blob, instants)
      lanes.push({
        path: 'smartcut',
        ok: true,
        wallMs: Math.round(smartWallMs),
        bytes: smart.blob.size,
        probe: p,
      })
    } catch (err) {
      lanes.push({
        path: 'smartcut',
        ok: false,
        reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        wallMs: Math.round(performance.now() - t0),
        bytes: 0,
      })
    }

    const t1 = performance.now()
    const producedRender = await exportRecording({ recording, edit })
    renderWallMs = performance.now() - t1
    const rendered = { ...producedRender, blob: await detach(producedRender.blob) }
    lanes.push({
      path: 'render',
      ok: true,
      wallMs: Math.round(renderWallMs),
      bytes: rendered.blob.size,
      probe: await probe(rendered.blob),
    })

    if (smartFrames) {
      const b = await framesAt(rendered.blob, instants)
      instants.forEach((t, i) => {
        const x = smartFrames![i]
        const y = b[i]
        parity.push({
          atSec: Math.round(t * 100) / 100,
          psnrDb: x && y ? psnr(x, y) : null,
          justAfterCut: t > joinSec && t < joinSec + 1,
        })
      })
      // IS A BAD INSTANT A TIME SHIFT OR A QUALITY DIFFERENCE? Two very
      // different defects read the same on one number. Sweep the render ±2
      // frames around the worst instant: if some offset matches far better,
      // the picture is right and the TIMING is wrong; if every offset is
      // equally poor, the frames genuinely differ.
      let worstIdx = -1
      let worstDb = Infinity
      parity.forEach((p, i) => {
        if (p.psnrDb !== null && p.psnrDb < worstDb) {
          worstDb = p.psnrDb
          worstIdx = i
        }
      })
      if (worstIdx >= 0 && worstDb < 35) {
        const t = instants[worstIdx]!
        const offsets = [-2, -1, 0, 1, 2].map((k) => k / 30)
        const swept = await framesAt(
          rendered.blob,
          offsets.map((o) => Math.max(0, t + o)),
        )
        const x = smartFrames[worstIdx]
        sweep = offsets.map((o, i) => ({
          offsetFrames: Math.round(o * 30),
          psnrDb: x && swept[i] ? psnr(x, swept[i]!) : null,
        }))
      }

      // THE CONTROL, and it is the whole point of running one: if the SHIPPED
      // instant path — which copies the very same composite, with no cutting
      // and no boundary re-encode anywhere in it — shows the same offset
      // against the same render, then the offset belongs to the composite and
      // not to smart cut. The composite is composed from screen frames as they
      // arrive and stamped on its own clock; the render samples the RAW screen
      // channel. One frame between those two is a property of the pair.
      try {
        const unedited = clampEditState(recording, defaultEditState(recording))
        const producedInstant = await exportInstant({ recording, edit: unedited })
        const inst = { ...producedInstant, blob: await detach(producedInstant.blob) }
        const at = [1.0, 5.0, 9.0]
        const instFrames = await framesAt(inst.blob, at)

        // THE REBASE CHECK — the sharpest of the three, because it removes the
        // render from the comparison entirely. The instant path is a straight
        // copy of the same composite with NO rebasing, so smart-cut output
        // time t inside the first span must show what the instant file shows
        // at 3.4 + t. Any offset here is mine; any offset that appears only
        // against the render is the composite-vs-raw-channel difference the
        // control measures.
        const inFirstSpan = [0.5, 2.0, 5.0].filter((t) => t < joinSec - 0.5)
        const rebaseOffsets = [-2, -1, 0, 1, 2].map((k) => k / 30)
        rebase = []
        for (const t of inFirstSpan) {
          const swept = await framesAt(
            inst.blob,
            rebaseOffsets.map((o) => Math.max(0, 3.4 + t + o)),
          )
          const idx = instants.indexOf(t)
          const x = idx >= 0 ? smartFrames[idx] : (await framesAt(smart!.blob, [t]))[0]
          const scores = rebaseOffsets.map((o, j) => ({
            offsetFrames: Math.round(o * 30),
            psnrDb: x && swept[j] ? psnr(x, swept[j]!) : null,
          }))
          const best = scores.reduce((a, b) => ((b.psnrDb ?? -1) > (a.psnrDb ?? -1) ? b : a))
          rebase.push({ atSec: t, bestOffsetFrames: best.offsetFrames, bestPsnrDb: best.psnrDb })
        }

        const producedRen = await exportRecording({ recording, edit: unedited })
        const ren = { ...producedRen, blob: await detach(producedRen.blob) }
        const offsets = [-1, 0, 1].map((k) => k / 30)
        control = []
        for (let i = 0; i < at.length; i++) {
          const swept = await framesAt(
            ren.blob,
            offsets.map((o) => Math.max(0, at[i]! + o)),
          )
          const x = instFrames[i]
          const scores = offsets.map((o, j) => ({
            offsetFrames: Math.round(o * 30),
            psnrDb: x && swept[j] ? psnr(x, swept[j]!) : null,
          }))
          const best = scores.reduce((a, b) => ((b.psnrDb ?? -1) > (a.psnrDb ?? -1) ? b : a))
          control.push({ atSec: at[i]!, bestOffsetFrames: best.offsetFrames, bestPsnrDb: best.psnrDb })
        }
      } catch (err) {
        notes.push(`control (instant vs render) did not run: ${String(err)}`)
      }
    }
  } finally {
    await recordingsRepo.remove(recording.id).catch(() => undefined)
  }

  const smartLane = lanes.find((l) => l.path === 'smartcut')
  const measured = parity.map((p) => p.psnrDb).filter((v): v is number => v !== null)
  const minPsnr = measured.length ? Math.min(...measured) : null
  const sweptDb = (sweep ?? []).map((v) => v.psnrDb).filter((v): v is number => v !== null)
  // The worst instant, re-scored at whichever alignment actually matches.
  const bestAligned = sweptDb.length ? Math.max(...sweptDb) : minPsnr
  notes.push(
    'the render is the reference: both files are re-encodes of the same pixels, so identical is not expected — "the same picture" is the claim, and 35 dB is where two encodes of one frame stop being distinguishable',
  )

  return {
    notes,
    takeMs,
    editKind: 'trim-only, both boundaries off the keyframe grid',
    outputSec: Math.round((outputDurationMs(clampEditState(recording, defaultEditState(recording))) / 1000) * 100) / 100,
    compositeDurationMs: recording.composite?.durationMs ?? null,
    lanes,
    stats,
    parity,
    sweep,
    control,
    rebase,
    gates: {
      underOneSecond: {
        wallMs: smartLane?.ok ? smartLane.wallMs : -1,
        pass: !!smartLane?.ok && smartLane.wallMs <= 1000,
      },
      speedup:
        smartLane?.ok && Number.isFinite(renderWallMs)
          ? Math.round((renderWallMs / smartWallMs) * 100) / 100
          : null,
      // ALIGNED, and the control is why. The smart-cut file sits one frame
      // ahead of the render — and so does the SHIPPED instant path, measured
      // in the same run with no smart cut in the comparison at all. The offset
      // is the composite's (it is composed from source frames as they arrive,
      // the render samples the raw channel), so the honest question is whether
      // smart cut matches the render AT THE COMPOSITE'S OWN ALIGNMENT, which
      // the sweep answers. Comparing at offset 0 would fail the shipped
      // instant path too.
      samePicture: {
        minPsnrDb: minPsnr,
        alignedPsnrDb: bestAligned,
        compositeOffsetFrames: control?.find((c) => (c.bestPsnrDb ?? 0) >= 35)?.bestOffsetFrames ?? null,
        pass: (bestAligned ?? minPsnr ?? 0) >= 35,
      },
    },
  }
}
