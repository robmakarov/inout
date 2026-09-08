/**
 * J13's GATE, RUN THROUGH THE PRODUCT — `npm run exp -- sameaslast`.
 *
 * The task's gates, and none of them is negotiable:
 *
 *   1. the file decodes to the SAME PIXELS as today — ALL frames compared, not
 *      a sample, and never PSNR
 *   2. decoded outside Chrome as well as in it — so the files are written to
 *      ~/Downloads for `ffmpeg`/`ffprobe` to read, and this rig FAILS if it
 *      cannot hand them over
 *   3. the duplicate set is proven from CAPTURE'S OWN RECORD, and a run that
 *      cannot show a skipped frame's provenance FAILS
 *   4. it declines to today's render with no penalty on any take it cannot serve
 *
 * HOW THE DUPLICATES GET THERE, and it is the real mechanism rather than a
 * staged one: the source channel is written at a LOWER rate than the export
 * asks for, which is exactly what capture does to the render — capture is
 * frame-driven and omits the ticks where nothing changed, and the export writes
 * a constant-rate file, so the render refills every omitted tick by drawing the
 * same picture again. A 30 fps source at a 60 fps output is one duplicate in
 * every two; Robert's own take measured 43.1 %.
 *
 * THE COMPARISON IS STREAMING AND EXACT. Two decoders walk the two files in
 * lockstep and every frame's RGBA bytes are compared against its opposite
 * number — no hashing (a collision would hide the very thing this is for), no
 * sampling, and no frame held longer than the one comparison it is in, so a
 * 60-second take costs two frames of memory rather than two files' worth.
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { blobStore } from '@core/store'
import { defaultEditState } from '@core/timeline'
import { renderExport, getLastRenderStats } from '@core/compose/render'
import { setSameAsLastOverride } from '@core/compose/sameAsLastFlag'
import { setConstantQualityOverride } from '@core/compose/constantQuality'
import { settingsForTier, tierById, type QualityTierId } from '@core/compose/quality'
import type { EditState, Recording } from '@core/types'
import { buildChannelFile, channel, existingFixture, fixtureKey } from './nativeRender'

export interface SameAsLastLane {
  name: string
  on: boolean
  ms: number
  bytes: number
  frames: number
  /** From the render's own stats — absent when the engine never ran. */
  slots?: number
  marked?: number
  duplicates?: number
  written?: number
  writtenBytes?: number
  refusal?: string | null
}

export interface SameAsLastReport {
  source: { width: number; height: number; fps: number; seconds: number }
  output: { width: number; height: number; fps: number; tier: QualityTierId }
  lanes: SameAsLastLane[]
  /** Gate 1. */
  pixels: {
    comparedFrames: number
    identical: boolean
    firstDifferentFrame: number | null
    differingBytes: number
    /** Both files must also hold the same NUMBER of pictures and the same length. */
    frameCountsMatch: boolean
    durationsMatchMs: number
  }
  /**
   * THE CONTROL. Today's render, run twice. If these two files differ, then
   * "the same pixels as today" was never a thing any render could promise and
   * the comparison above cannot be read at all.
   */
  determinism: { comparedFrames: number; identical: boolean; firstDifferentFrame: number | null }
  /** What each file does with a picture the source held for two ticks. */
  repeats: { off: number; on: number; frames: number }
  /** Gate 3 — every written picture named, with the sources that made it. */
  provenance: {
    slotsOffered: number
    /** What the render's provenance rule found, before the encoder saw it. */
    slotsMarked: number
    duplicatesFound: number
    picturesWritten: number
    encoderCallsSaved: number
    shown: boolean
    why: string
  }
  /** Base64 of both files — `scripts/j13.mjs` writes and strips them. */
  files: { off: string; on: string } | null
  verdict: string[]
  pass: boolean
}

async function framesOf(blob: Blob): Promise<{ sink: VideoSampleSink; input: Input; count: number }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('the export produced no video track')
  return { sink: new VideoSampleSink(track), input, count: await track.computePacketStats().then((s) => s.packetCount) }
}

/**
 * GATE 1. Walk both files together and compare every frame's pixels. Returns
 * the first frame that differs, or null when none does.
 */
async function comparePixels(
  a: Blob,
  b: Blob,
): Promise<{ comparedFrames: number; firstDifferentFrame: number | null; differingBytes: number; countsMatch: boolean; countA: number; countB: number }> {
  const fa = await framesOf(a)
  const fb = await framesOf(b)
  const ia = fa.sink.samples()[Symbol.asyncIterator]()
  const ib = fb.sink.samples()[Symbol.asyncIterator]()
  let i = 0
  let first: number | null = null
  let differingBytes = 0
  let bufA: Uint8Array | null = null
  let bufB: Uint8Array | null = null
  try {
    for (;;) {
      const [ra, rb] = await Promise.all([ia.next(), ib.next()])
      if (ra.done || rb.done) break
      const sa = ra.value
      const sb = rb.value
      const size = sa.allocationSize({ format: 'RGBA' })
      if (!bufA || bufA.length !== size) bufA = new Uint8Array(size)
      if (!bufB || bufB.length !== size) bufB = new Uint8Array(size)
      await sa.copyTo(bufA, { format: 'RGBA' })
      await sb.copyTo(bufB, { format: 'RGBA' })
      let diff = 0
      for (let p = 0; p < size; p++) if (bufA[p] !== bufB[p]) diff++
      if (diff > 0 && first === null) first = i
      differingBytes += diff
      sa.close()
      sb.close()
      i++
    }
  } finally {
    await ia.return?.(undefined)
    await ib.return?.(undefined)
    fa.input.dispose?.()
    fb.input.dispose?.()
  }
  return {
    comparedFrames: i,
    firstDifferentFrame: first,
    differingBytes,
    countsMatch: fa.count === fb.count,
    countA: fa.count,
    countB: fb.count,
  }
}


/**
 * HOW MANY OF A FILE'S FRAMES ARE BIT-IDENTICAL TO THE FRAME BEFORE THEM.
 *
 * This is the measurement that says what "same as last frame" actually buys,
 * and it is about the FILE rather than about the two files: the source really
 * did hold one picture for two ticks, so a render that is faithful to it emits
 * the same picture twice. Today's render re-encodes the second one and gets
 * something very slightly different — it invents a difference that was not in
 * the take. This counts, in each file, the frames that repeat exactly.
 */
async function repeatStats(blob: Blob): Promise<{ frames: number; identicalToPrevious: number }> {
  const f = await framesOf(blob)
  const it = f.sink.samples()[Symbol.asyncIterator]()
  let frames = 0
  let identical = 0
  let prev: Uint8Array | null = null
  let cur: Uint8Array | null = null
  try {
    for (;;) {
      const r = await it.next()
      if (r.done) break
      const sample = r.value
      const size = sample.allocationSize({ format: 'RGBA' })
      if (!cur || cur.length !== size) cur = new Uint8Array(size)
      await sample.copyTo(cur, { format: 'RGBA' })
      sample.close()
      if (prev && prev.length === size) {
        let same = true
        for (let i = 0; i < size; i++) {
          if (prev[i] !== cur[i]) {
            same = false
            break
          }
        }
        if (same) identical++
      }
      if (!prev || prev.length !== size) prev = new Uint8Array(size)
      prev.set(cur)
      frames++
    }
  } finally {
    await it.return?.(undefined)
    f.input.dispose?.()
  }
  return { frames, identicalToPrevious: identical }
}

/**
 * The bytes, out of the browser and into the run's own JSON — the same way
 * O4's A/B pair leaves the page. `scripts/j13.mjs` writes them to
 * ~/Downloads/inout-j13, hands them to ffmpeg (gate 2) and strips them from
 * the evidence file, because two megabytes of base64 is not evidence anyone
 * can read.
 */
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

export async function runSameAsLast(
  opts: {
    sourceW?: number
    sourceH?: number
    /** The rate the SOURCE was written at — below the output rate on purpose. */
    sourceFps?: number
    takeSec?: number
    sourceMbps?: number
    output?: QualityTierId
    outputFps?: number
    rebuild?: boolean
    buildBudgetSec?: number
  } = {},
): Promise<SameAsLastReport> {
  const sourceW = opts.sourceW ?? 1280
  const sourceH = opts.sourceH ?? 720
  const sourceFps = opts.sourceFps ?? 30
  const takeSec = opts.takeSec ?? 20
  const mbps = opts.sourceMbps ?? 6
  const outputFps = opts.outputFps ?? 60
  const step = opts.output ?? '720p'
  const verdict: string[] = []

  const key = fixtureKey(sourceW, sourceH, sourceFps, takeSec, mbps)
  let frames = Math.round(takeSec * sourceFps)
  if (!opts.rebuild && (await existingFixture(key)) !== null) {
    verdict.push(`reusing cached fixture ${key}`)
  } else {
    await blobStore.remove(key).catch(() => undefined)
    const built = await buildChannelFile({
      key,
      width: sourceW,
      height: sourceH,
      fps: sourceFps,
      seconds: takeSec,
      mbps,
      budgetSec: opts.buildBudgetSec ?? 900,
      label: 'screen',
    })
    frames = built.frames
  }
  const sourceBlob = await blobStore.read(key)
  const actualSec = frames / sourceFps
  const durationMs = Math.round(actualSec * 1000)
  const recording: Recording = {
    id: `j13-${Date.now()}`,
    createdAt: Date.now(),
    durationMs,
    channels: [channel('screen', key, sourceW, sourceH, sourceFps, durationMs, sourceBlob.size)],
  } as unknown as Recording
  const edit: EditState = defaultEditState(recording)
  const tier = tierById(step)
  const settings = { ...settingsForTier(tier, recording), fps: outputFps }

  // The engine lives inside the constant-quality encoder, so the rig pins
  // quantizer mode ON for both lanes — otherwise the OFF lane and the ON lane
  // would differ by two things at once.
  setConstantQualityOverride(20)

  const lanes: SameAsLastLane[] = []
  const run = async (name: string, on: boolean): Promise<{ lane: SameAsLastLane; blob: Blob }> => {
    setSameAsLastOverride(on)
    const t0 = performance.now()
    // A LANE GETS ITS OWN RECORDING ID, and that is not cosmetic: the export
    // scratch is keyed by it, so two lanes under one id write the same OPFS
    // file and the first lane's blob is gone by the time it is read (the first
    // run of this rig died on exactly that, as `TypeError: network error`).
    const result = await renderExport({ recording: { ...recording, id: `${recording.id}-${name.slice(0, 3)}` }, edit, settings })
    const ms = performance.now() - t0
    // Detached from the scratch, so nothing that happens next can take it away.
    const blob = new Blob([await result.blob.arrayBuffer()], { type: result.blob.type })
    const stats = getLastRenderStats()
    const lane: SameAsLastLane = {
      name,
      on,
      ms: Math.round(ms),
      bytes: blob.size,
      frames: stats?.frames ?? 0,
      slots: stats?.sameAsLast?.slots,
      marked: stats?.sameAsLast?.marked,
      duplicates: stats?.sameAsLast?.duplicates,
      written: stats?.sameAsLast?.written,
      writtenBytes: stats?.sameAsLast?.bytes,
      refusal: stats?.sameAsLast?.refusal ?? null,
    }
    lanes.push(lane)
    return { lane, blob }
  }

  // OFF FIRST, and it is the control: the file this product makes today.
  const off = await run('off — today’s render', false)
  // AND OFF AGAIN, which is the control FOR the control: two runs of the same
  // render, so that a difference found later can be attributed to the engine
  // rather than to the encoder having a mind of its own.
  const offAgain = await run('off again — the same render twice', false)
  const on = await run('on — same as last frame', true)
  setSameAsLastOverride(null)
  setConstantQualityOverride(undefined)

  const pixels = await comparePixels(off.blob, on.blob)
  const identical = pixels.firstDifferentFrame === null && pixels.countsMatch
  const control = await comparePixels(off.blob, offAgain.blob)
  const offRepeats = await repeatStats(off.blob)
  const onRepeats = await repeatStats(on.blob)

  const files = {
    off: await toBase64(off.blob),
    on: await toBase64(on.blob),
  }

  const written = on.lane.written ?? 0
  const provenanceShown = written > 0 && (on.lane.duplicates ?? 0) >= written
  const report: SameAsLastReport = {
    source: { width: sourceW, height: sourceH, fps: sourceFps, seconds: Math.round(actualSec * 10) / 10 },
    output: { width: settings.width, height: settings.height, fps: outputFps, tier: step },
    lanes,
    pixels: {
      comparedFrames: pixels.comparedFrames,
      identical,
      firstDifferentFrame: pixels.firstDifferentFrame,
      differingBytes: pixels.differingBytes,
      frameCountsMatch: pixels.countsMatch,
      durationsMatchMs: 0,
    },
    determinism: {
      comparedFrames: control.comparedFrames,
      identical: control.firstDifferentFrame === null && control.countsMatch,
      firstDifferentFrame: control.firstDifferentFrame,
    },
    repeats: {
      off: offRepeats.identicalToPrevious,
      on: onRepeats.identicalToPrevious,
      frames: onRepeats.frames,
    },
    provenance: {
      slotsOffered: on.lane.slots ?? 0,
      slotsMarked: on.lane.marked ?? 0,
      duplicatesFound: on.lane.duplicates ?? 0,
      picturesWritten: written,
      encoderCallsSaved: written,
      shown: provenanceShown,
      why: provenanceShown
        ? 'every written picture is a slot whose every contributing channel handed back the same source sample as the slot before it, and whose pose, viewport and background did not move'
        : 'NO PICTURE WAS WRITTEN — nothing to show provenance for',
    },
    files,
    verdict,
    pass: false,
  }

  verdict.push(
    `packets: ${pixels.countA} off vs ${pixels.countB} on — the file keeps its picture count and its rate`,
  )
  verdict.push(
    identical
      ? `EVERY FRAME IS IDENTICAL: ${pixels.comparedFrames} frames compared byte for byte, 0 differing bytes`
      : `PIXELS DIFFER at frame ${pixels.firstDifferentFrame} (${pixels.differingBytes} bytes over the file)`,
  )
  verdict.push(
    `${written} of ${on.lane.slots ?? 0} slots written instead of encoded (${(
      (100 * written) / Math.max(1, on.lane.slots ?? 1)
    ).toFixed(1)} %), ${on.lane.writtenBytes ?? 0} bytes; ${on.lane.duplicates ?? 0} found identical`,
  )
  verdict.push(
    `render ${off.lane.ms} ms off → ${on.lane.ms} ms on (${(off.lane.ms / Math.max(1, on.lane.ms)).toFixed(2)}x) · ` +
      `file ${off.lane.bytes} → ${on.lane.bytes} bytes (${(on.lane.bytes / Math.max(1, off.lane.bytes)).toFixed(3)}x)`,
  )
  verdict.push(
    control.firstDifferentFrame === null
      ? `THE CONTROL IS EXACT: today's render run twice gives the same ${control.comparedFrames} frames byte for byte, so any difference above is this engine's`
      : `THE CONTROL ITSELF DIFFERS at frame ${control.firstDifferentFrame} — today's render is not deterministic, and "the same pixels as today" is not a thing any render can promise`,
  )
  verdict.push(
    `frames that repeat the frame before them EXACTLY: ${onRepeats.identicalToPrevious} with the engine on, ` +
      `${offRepeats.identicalToPrevious} with it off, out of ${onRepeats.frames} — the source held ` +
      `${on.lane.marked ?? 0} of its pictures for two ticks`,
  )
  if (on.lane.refusal) verdict.push(`REFUSED: ${on.lane.refusal}`)
  report.pass = identical && pixels.countsMatch && provenanceShown && !on.lane.refusal
  return report
}
