/**
 * EXPERIMENTAL — P0-tail-raw evidence: does a RAW channel keep its ending?
 *
 * P0-tail fixed the composite (2734 ms of a 4K take missing → 43-320 ms) and
 * found, with the same rig, that the raw channels lose 203-753 ms of their own.
 * That matters more than it sounds: an EDITED take is rendered from the raw
 * channels, so this is the tail of every take the instant path cannot serve.
 *
 * The composite's fix does not port over unchanged. It could stop PAINTING; a
 * raw channel's source is a live device, so the equivalent is ending the track —
 * and it is not obvious that a MediaRecorder whose stream just went inactive
 * will still hand over its backlog rather than stopping itself on the spot.
 * That is a question about Chrome, not about us, so this measures it instead of
 * reasoning about it. Four stop procedures on the same 4K load, same rig as
 * P0-tail so the numbers are comparable with the ones already recorded:
 *
 *   shipped   requestData() then stop(), 1000 ms timeslice   (production today)
 *   slice250  the same, at a 250 ms timeslice                (P0-tail's lever 1)
 *   cut       end the TRACK, drain the backlog, then stop    (the candidate)
 *   throttle  drop the source to 1 fps, drain, then stop     (if cut self-stops)
 *
 * The composite runs alongside every variant and is stopped at the same instant,
 * because in production both encoders drain at once and compete for the machine.
 */

import { blobStore } from '@core/store'
import { startLiveComposite } from '@core/capture/liveComposite'
import { drainRecorder, type RecorderDrainStats } from '@core/capture/recorderDrain'
import { makeRig, probeComposite } from './compositorEngine'

/** O8's shipped tail band, in ms — the gate this task has to land inside. */
export const TAIL_BAND_MS = 400

export type StopProcedure = 'shipped' | 'slice250' | 'cut' | 'throttle'

const TIMESLICE: Record<StopProcedure, number> = {
  shipped: 1000,
  slice250: 250,
  cut: 250,
  throttle: 250,
}

export interface RawTailRun {
  procedure: StopProcedure
  sourceWidth: number
  sourceHeight: number
  timesliceMs: number
  /** Wall time the lane actually recorded, from recorder.start to the cut. */
  laneMs: number
  bytes: number
  frameCount: number
  deliveredFps: number | null
  lastFrameSec: number | null
  /** laneMs minus the last decodable frame. Small = the tail survived. */
  tailGapMs: number | null
  tailBandPass: boolean | null
  /** How long the stop procedure took end to end — what the user waits. */
  procedureMs: number
  drain: RecorderDrainStats | null
  /**
   * Did the recorder stop ITSELF when the track ended, before we asked? This is
   * the whole question behind the `cut` procedure: a self-stop means the backlog
   * is gone and cutting the source buys nothing.
   */
  selfStoppedOnTrackEnd: boolean
  /** `throttle` only: the source accepted a frameRate constraint. */
  throttled?: boolean
  error?: string
}

interface Lane {
  startedAt: number
  emitted: () => number
  recorder: MediaRecorder
  selfStopped: () => boolean
  finish: () => Promise<{ bytes: number }>
}

/** A plain MediaRecorder on the given stream — exactly what a raw channel is. */
async function startLane(stream: MediaStream, key: string, timeslice: number): Promise<Lane> {
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) =>
    MediaRecorder.isTypeSupported(m),
  )
  if (!mime) throw new Error('no supported webm mime for a raw lane')
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
  const writable = await blobStore.createWriteStream(key)
  const writer = writable.getWriter()
  let chain = Promise.resolve()
  let bytes = 0
  // Counted SYNCHRONOUSLY: a counter that only moves once the disk acknowledges
  // is too late to steer a drain by (see recorderDrain.ts).
  let emitted = 0
  let selfStopped = false
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return
    emitted += e.data.size
    chain = chain.then(() =>
      writer.write(e.data).then(
        () => {
          bytes += e.data.size
        },
        () => undefined,
      ),
    )
  }
  recorder.onstop = () => {
    selfStopped = true
  }
  recorder.start(timeslice)
  const startedAt = performance.now()
  return {
    startedAt,
    emitted: () => emitted,
    recorder,
    selfStopped: () => selfStopped,
    async finish() {
      await chain
      await writer.close().catch(() => undefined)
      return { bytes }
    },
  }
}

/** Wait for the recorder to actually stop, bounded — never hang the rig on it. */
function awaitStop(recorder: MediaRecorder, budgetMs = 4000): Promise<void> {
  if (recorder.state === 'inactive') return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, budgetMs)
    recorder.onstop = () => {
      clearTimeout(timer)
      resolve()
    }
    try {
      recorder.requestData()
      recorder.stop()
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

async function runProcedure(
  procedure: StopProcedure,
  lane: Lane,
  stream: MediaStream,
): Promise<{ drain: RecorderDrainStats | null; selfStopped: boolean; throttled?: boolean }> {
  if (procedure === 'shipped' || procedure === 'slice250') {
    await awaitStop(lane.recorder)
    return { drain: null, selfStopped: false }
  }
  let throttled: boolean | undefined
  if (procedure === 'cut') {
    // The raw equivalent of "stop painting": no new frames can enter the
    // encoder, so whatever is queued is now a FINITE backlog.
    for (const t of stream.getTracks()) t.stop()
  } else {
    // Same intent without ending the track: starve the inflow so the encoder
    // can get ahead of it. The fallback if a cut makes the recorder self-stop.
    throttled = false
    for (const t of stream.getVideoTracks()) {
      try {
        await t.applyConstraints({ frameRate: 1 })
        throttled = true
      } catch {
        /* source refuses the constraint — reported, not fatal */
      }
    }
  }
  const drain = await drainRecorder(lane.recorder, lane.emitted)
  // Read AFTER the drain: a self-stop arrives as an event, so asking on the
  // same task as track.stop() would always answer "no".
  const selfStopped = lane.selfStopped()
  await awaitStop(lane.recorder)
  return { drain, selfStopped, throttled }
}

async function runOne(
  procedure: StopProcedure,
  width: number,
  height: number,
  takeMs: number,
): Promise<RawTailRun> {
  const audioCtx = new AudioContext({ sampleRate: 48000 })
  await audioCtx.resume()
  const rig = makeRig(width, height, audioCtx)
  const compositeKey = `exp-rawtail-comp-${procedure}-${Date.now()}.mp4`
  const laneKey = `exp-rawtail-${procedure}-${Date.now()}.webm`
  const base: RawTailRun = {
    procedure,
    sourceWidth: width,
    sourceHeight: height,
    timesliceMs: TIMESLICE[procedure],
    laneMs: 0,
    bytes: 0,
    frameCount: 0,
    deliveredFps: null,
    lastFrameSec: null,
    tailGapMs: null,
    tailBandPass: null,
    procedureMs: 0,
    drain: null,
    selfStoppedOnTrackEnd: false,
  }
  try {
    // The composite is the LOAD, and it is not optional: in production both
    // encoders are alive on the same GPU and both drain at stop.
    const composite = await startLiveComposite(
      { screen: rig.screen, camera: rig.camera, audio: rig.audio },
      compositeKey,
    )
    const lane = await startLane(rig.screen, laneKey, TIMESLICE[procedure])
    await new Promise((r) => setTimeout(r, takeMs))

    const cutAt = performance.now()
    base.laneMs = Math.round(cutAt - lane.startedAt)
    // Both stops at once, exactly as doStop will run them.
    const compositeStopped = composite.stop().catch(() => null)
    const result = await runProcedure(procedure, lane, rig.screen)
    base.procedureMs = Math.round(performance.now() - cutAt)
    base.drain = result.drain
    base.selfStoppedOnTrackEnd = result.selfStopped
    if (result.throttled !== undefined) base.throttled = result.throttled
    await compositeStopped
    const { bytes } = await lane.finish()
    base.bytes = bytes

    const probe = await probeComposite(await blobStore.read(laneKey))
    if (probe) {
      base.frameCount = probe.frameCount
      base.deliveredFps = Math.round((probe.frameCount / (base.laneMs / 1000)) * 10) / 10
      base.lastFrameSec = probe.lastFrameSec
      if (probe.lastFrameSec !== null) {
        base.tailGapMs = Math.round(base.laneMs - probe.lastFrameSec * 1000)
        base.tailBandPass = base.tailGapMs <= TAIL_BAND_MS
      }
    }
    return base
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err)
    return base
  } finally {
    rig.stop()
    for (const s of [rig.screen, rig.camera, ...rig.audio]) for (const t of s.getTracks()) t.stop()
    if (audioCtx.state !== 'closed') await audioCtx.close().catch(() => undefined)
    await blobStore.remove(compositeKey).catch(() => undefined)
    await blobStore.remove(laneKey).catch(() => undefined)
  }
}

export interface RawTailReport {
  takeMs: number
  runs: RawTailRun[]
  tailBandMs: number
  /** Every run that produced a file landed inside the band. */
  tailBandPass: boolean
  notes: string[]
}

export async function runRawTail(
  opts: {
    takeMs?: number
    size?: [number, number]
    procedures?: StopProcedure[]
    /** Repeat the whole set — the gate asks for the winner twice. */
    repeats?: number
  } = {},
): Promise<RawTailReport> {
  const takeMs = opts.takeMs ?? 10_000
  const [width, height] = opts.size ?? [3840, 2160]
  const procedures = opts.procedures ?? ['shipped', 'slice250', 'cut', 'throttle']
  const repeats = opts.repeats ?? 1
  const runs: RawTailRun[] = []
  for (let i = 0; i < repeats; i++) {
    for (const p of procedures) {
      runs.push(await runOne(p, width, height, takeMs))
      // Let the machine settle: a run that inherits the previous encoder's
      // backlog measures the previous run (see TASKS note 10).
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  const measured = runs.filter((r) => r.tailBandPass !== null)
  return {
    takeMs,
    runs,
    tailBandMs: TAIL_BAND_MS,
    tailBandPass: measured.length > 0 && measured.every((r) => r.tailBandPass === true),
    notes: [
      'tailGapMs is the lane’s own recorded length minus the last decodable frame in its file — conservative, because the file’s t=0 is the first frame delivered, which is slightly after recorder.start()',
      'the composite runs alongside every variant and is stopped at the same instant: in production both encoders drain at once',
      'selfStoppedOnTrackEnd answers the question the `cut` procedure rests on — a recorder that stops itself when its stream ends has already discarded the backlog',
      'shipped is the procedure in main today; slice250 isolates P0-tail’s first lever from its drain',
    ],
  }
}
