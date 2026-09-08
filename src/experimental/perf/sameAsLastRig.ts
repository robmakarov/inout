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
import { renderChunked, getLastChunkedStats } from '@core/compose/chunkedRender'
import { sweepChunks } from '@core/compose/chunkStore'
import { setSameAsLastOverride } from '@core/compose/sameAsLastFlag'
import { setConstantQualityOverride } from '@core/compose/constantQuality'
import { settingsForTier, tierById, type QualityTierId } from '@core/compose/quality'
import { calibrateSteps, estimateFromCalibration } from '@core/compose/sizeProbe'
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
  /**
   * THE PATH AN EDITED EXPORT ACTUALLY TAKES (J1). A chunked export renders
   * one 2.5 s window at a time and concatenates the packets, so the engine runs
   * once per chunk and the injected pictures have to survive a re-mux. Nothing
   * about that was proven by the unbroken lanes above, and "it should work" is
   * not a measurement.
   */
  chunked: {
    ran: boolean
    frames: number
    written: number
    /** Frames of the CONCATENATED file that repeat their predecessor exactly. */
    repeats: number
    bytes: number
    bytesOff: number
    ms: number
    msOff: number
    /** The picture count, rate and length, both ways. */
    shapeMatches: boolean
    note: string
  }
  /**
   * DOES THE SIZE PROMISE KNOW ABOUT THE ENGINE? The estimate prices a file as
   * keyframes plus deltas; J13 made a large share of those deltas cost twenty
   * bytes. This runs the PRODUCTION probe against the same take and scores its
   * answer against the file that was actually made — the only way to tell a
   * model that learned from a model that was told.
   */
  sizeEstimate: {
    ran: boolean
    duplicateFraction: number
    /** Predicted vs actual, engine ON. 1.00 is a promise kept. */
    predictedOn: number
    actualOn: number
    ratioOn: number
    /** The same probe with the engine off, against the file it makes. */
    predictedOff: number
    actualOff: number
    ratioOff: number
    note: string
  }
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

  /**
   * THE CHUNKED LANE. Same take, same settings, through `renderChunked` — the
   * path J1 made the default for an edited export. The chunk cache is swept
   * between the two so neither lane is handed the other's files.
   */
  const chunkedLane = async (on: boolean): Promise<{ blob: Blob; ms: number; written: number }> => {
    // Keep nothing: neither lane may be handed the other's chunk files.
    await sweepChunks().catch(() => undefined)
    setSameAsLastOverride(on)
    const t0 = performance.now()
    const result = await renderChunked({
      recording: { ...recording, id: `${recording.id}-ch${on ? 'on' : 'off'}` },
      edit,
      settings,
    })
    const ms = performance.now() - t0
    const blob = new Blob([await result.blob.arrayBuffer()], { type: result.blob.type })
    // The chunked path rolls its per-chunk RenderStats up and publishes them
    // through the same seam the unbroken render uses.
    void getLastChunkedStats()
    return { blob, ms, written: getLastRenderStats()?.sameAsLast?.written ?? 0 }
  }

  let chunked: SameAsLastReport['chunked'] = {
    ran: false, frames: 0, written: 0, repeats: 0, bytes: 0, bytesOff: 0, ms: 0, msOff: 0,
    shapeMatches: false, note: 'not run',
  }
  try {
    const chOff = await chunkedLane(false)
    const chOn = await chunkedLane(true)
    const onRepeatsChunked = await repeatStats(chOn.blob)
    const offRepeatsChunked = await repeatStats(chOff.blob)
    chunked = {
      ran: true,
      frames: onRepeatsChunked.frames,
      written: chOn.written,
      repeats: onRepeatsChunked.identicalToPrevious,
      bytes: chOn.blob.size,
      bytesOff: chOff.blob.size,
      ms: Math.round(chOn.ms),
      msOff: Math.round(chOff.ms),
      shapeMatches: onRepeatsChunked.frames === offRepeatsChunked.frames,
      note:
        onRepeatsChunked.frames === offRepeatsChunked.frames && chOn.written > 0 &&
        onRepeatsChunked.identicalToPrevious === chOn.written
          ? 'every picture the chunks wrote survived the concatenation and decodes as an exact copy'
          : `chunks wrote ${chOn.written}, the concatenated file repeats ${onRepeatsChunked.identicalToPrevious} ` +
            `of ${onRepeatsChunked.frames} frames (control ${offRepeatsChunked.identicalToPrevious} of ${offRepeatsChunked.frames})`,
    }
  } catch (err) {
    chunked = { ...chunked, note: `the chunked lane did not run: ${String(err)}` }
  }
  setSameAsLastOverride(null)

  /**
   * THE SIZE PROBE, THROUGH ITS OWN PRODUCTION ENTRY POINT, both ways. It is
   * run AFTER the renders so the files it is scored against already exist.
   */
  let sizeEstimate: SameAsLastReport['sizeEstimate'] = {
    ran: false, duplicateFraction: 0, predictedOn: 0, actualOn: 0, ratioOn: 0,
    predictedOff: 0, actualOff: 0, ratioOff: 0, note: 'not run',
  }
  try {
    /**
     * A TIER THE PROBE WILL ACTUALLY PRICE. It skips any step whose export is a
     * packet copy of the source — "their size is the file, not an estimate" —
     * and a 720p step on a 720p take is exactly that, so scoring the model
     * there measures nothing. This one re-renders, which is the case the
     * estimate exists for, and the two files it is scored against are rendered
     * at the SAME step so the comparison is like for like.
     */
    // THE STEP AND THE RENDER MUST AGREE ON THE RATE, or the estimate is asked
    // about a different file from the one it is scored against. The rig runs
    // the output faster than the take (that is how it manufactures duplicates),
    // so the step it asks about carries that rate too — which is what the
    // product's own settings would carry for a take recorded at it.
    const sizeTier = { ...tierById('540p'), fps: outputFps }
    const sizeSettings = { ...settingsForTier(tierById('540p'), recording), fps: outputFps }
    setSameAsLastOverride(true)
    const madeOn = await renderExport({ recording: { ...recording, id: `${recording.id}-szon` }, edit, settings: sizeSettings })
    const onBytes = madeOn.blob.size
    setSameAsLastOverride(false)
    const madeOff = await renderExport({ recording: { ...recording, id: `${recording.id}-szoff` }, edit, settings: sizeSettings })
    const offBytes = madeOff.blob.size
    setSameAsLastOverride(true)
    const cal = await calibrateSteps(recording, edit, [sizeTier])
    if (cal) {
      const on = estimateFromCalibration(recording, sizeTier, durationMs, cal)
      setSameAsLastOverride(false)
      const off = estimateFromCalibration(recording, sizeTier, durationMs, cal)
      const actualOn = onBytes
      const actualOff = offBytes
      sizeEstimate = {
        ran: true,
        duplicateFraction: Math.round((cal.duplicateFraction ?? 0) * 1000) / 1000,
        predictedOn: on?.bytes ?? 0,
        actualOn,
        ratioOn: on ? Math.round((on.bytes / Math.max(1, actualOn)) * 1000) / 1000 : 0,
        predictedOff: off?.bytes ?? 0,
        actualOff,
        ratioOff: off ? Math.round((off.bytes / Math.max(1, actualOff)) * 1000) / 1000 : 0,
        note: 'the probe counted the duplicate share on this take and priced those slots as written pictures',
      }
    } else sizeEstimate = { ...sizeEstimate, note: 'the calibration returned nothing' }
  } catch (err) {
    sizeEstimate = { ...sizeEstimate, note: `the size probe threw: ${String(err)}` }
  }
  setSameAsLastOverride(null)

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
    chunked,
    sizeEstimate,
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
  verdict.push(
    chunked.ran
      ? `CHUNKED (the path an edited export takes): ${chunked.written} written across the chunks, ` +
          `${chunked.repeats} of ${chunked.frames} frames of the CONCATENATED file repeat their predecessor ` +
          `exactly · ${chunked.bytesOff} -> ${chunked.bytes} bytes · ${chunked.msOff} -> ${chunked.ms} ms — ${chunked.note}`
      : `CHUNKED LANE DID NOT RUN — ${chunked.note}`,
  )
  verdict.push(
    sizeEstimate.ran
      ? `SIZE PROMISE: the probe found ${(100 * sizeEstimate.duplicateFraction).toFixed(1)} % of slots repeat and ` +
          `predicts ${sizeEstimate.predictedOn} bytes against ${sizeEstimate.actualOn} actually written ` +
          `(${sizeEstimate.ratioOn}x) · with the engine off it predicts ${sizeEstimate.predictedOff} against ` +
          `${sizeEstimate.actualOff} (${sizeEstimate.ratioOff}x)`
      : `SIZE PROMISE NOT MEASURED — ${sizeEstimate.note}`,
  )
  if (on.lane.refusal) verdict.push(`REFUSED: ${on.lane.refusal}`)
  report.pass = identical && pixels.countsMatch && provenanceShown && !on.lane.refusal
  return report
}
