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

import { blobStore, recordingsRepo } from '@core/store'
import { startLiveComposite } from '@core/capture/liveComposite'
import { drainRecorder, type RecorderDrainStats } from '@core/capture/recorderDrain'
import { createCaptureSession } from '@core/capture/session'
import { setSyntheticScreenSize } from '@core/capture/synthetic'
import { makeRig, probeComposite, type FileProbe } from './compositorEngine'

/** O8's shipped tail band, in ms — the gate this task has to land inside. */
export const TAIL_BAND_MS = 400

/**
 * `production` is the one that gates the task: it drives the real
 * createCaptureSession over a 4K synthetic screen and reads the tail off the
 * raw screen channel the session itself wrote. The other four are the
 * comparison table that chose the procedure.
 */
export type StopProcedure = 'shipped' | 'slice250' | 'cut' | 'throttle' | 'production' | 'wedged'

const TIMESLICE: Record<StopProcedure, number> = {
  shipped: 1000,
  slice250: 250,
  cut: 250,
  throttle: 250,
  production: 1000,
  wedged: 1000,
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
  /**
   * laneMs minus the last decodable frame AT OR BEFORE laneMs. Small = the tail
   * survived. Measured against the lane's own declared length, because that is
   * what the timeline uses — a file that runs past it is not "extra tail", it is
   * material nothing will ever read.
   */
  tailGapMs: number | null
  /** How far the file runs PAST the declared length: the drain keeps writing at
   *  1 fps, and those frames carry real timestamps. Bytes, not tail. */
  overrunMs: number | null
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
  /** `production` only: what the take actually contained. A run that reports no
   *  screen channel has to say whether the channel was never armed, arrived
   *  empty, or was dropped — otherwise "no screen channel" is just a shrug. */
  take?: {
    channels: { kind: string; durationMs: number; startOffsetMs: number }[]
    missing: string[]
    stalled: string[]
    hasComposite: boolean
    /** The composite's OWN delivery, read out of its file. The o4step2 rig
     *  drives the two engines directly; this reads what the REAL session
     *  produced, which is the only way to tell an engine apart from a rig. */
    compositeFps: number | null
    compositeFrames: number | null
    compositeBytes: number | null
    captureEvents: string[]
    /** Every `[capture]` line the session printed while stopping. */
    captureLog: string[]
  }
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

/**
 * The gate number, and the number that is NOT the gate. `tailGapMs` asks what is
 * missing before the declared end; `overrunMs` says how far the file kept going
 * after it. Conflating them is how a drain that writes 1 fps past the end scores
 * a triumphant -1227 ms and hides whatever it actually lost.
 */
function scoreTail(run: RawTailRun, probe: FileProbe): void {
  const cutoff = probe.lastFrameBeforeCutoffSec ?? null
  if (cutoff !== null) {
    run.tailGapMs = Math.round(run.laneMs - cutoff * 1000)
    run.tailBandPass = run.tailGapMs <= TAIL_BAND_MS
  } else if (probe.lastFrameSec !== null) {
    // Every frame in the file is past the declared end: nothing to score.
    run.tailGapMs = null
    run.tailBandPass = null
  }
  if (probe.lastFrameSec !== null) {
    run.overrunMs = Math.max(0, Math.round(probe.lastFrameSec * 1000 - run.laneMs))
  }
}

/**
 * The gate run: a whole take through the PRODUCTION session — arm, start, stop —
 * over a 4K synthetic screen, with the live composite running exactly as it
 * does for a user. The tail is read off the raw SCREEN channel's own file,
 * against the length the session itself recorded for it, so a wiring mistake in
 * doStop (wrong order, an inflated duration) shows up here and nowhere else.
 */
async function runProduction(
  width: number,
  height: number,
  takeMs: number,
  wedged = false,
): Promise<RawTailRun> {
  const base: RawTailRun = {
    procedure: wedged ? 'wedged' : 'production',
    sourceWidth: width,
    sourceHeight: height,
    timesliceMs: wedged ? TIMESLICE.wedged : TIMESLICE.production,
    laneMs: 0,
    bytes: 0,
    frameCount: 0,
    deliveredFps: null,
    lastFrameSec: null,
    tailGapMs: null,
    overrunMs: null,
    tailBandPass: null,
    procedureMs: 0,
    drain: null,
    selfStoppedOnTrackEnd: false,
  }
  setSyntheticScreenSize({ width, height })
  let recordingId: string | null = null
  let blobKeys: string[] = []
  // THE FORCED CASE: every recorder in the take is made to swallow stop(), so
  // no onstop ever fires. Before the deadlines went in, that hung the take
  // forever — the finished recording simply never arrived. Now it must come
  // back inside the stop budget with whatever reached disk.
  const realStop = MediaRecorder.prototype.stop
  if (wedged) {
    MediaRecorder.prototype.stop = function noStop(): void {
      /* deliberately deaf */
    }
  }
  try {
    const session = await createCaptureSession({
      screen: true,
      camera: true,
      mic: true,
      systemAudio: false,
    })
    const captureEvents: string[] = []
    session.on((e) => {
      if (e.type === 'tick') return
      captureEvents.push('kind' in e ? `${e.type}:${e.kind}` : e.type)
    })
    session.start()
    await new Promise((r) => setTimeout(r, takeMs))
    // The drain reports itself on the console and nowhere else (it is not part
    // of any contract), so the rig listens to what production says rather than
    // being told the same thing twice through a second channel.
    const captureLog: string[] = []
    const realInfo = console.info
    const realWarn = console.warn
    const tap =
      (real: typeof console.info) =>
      (...a: unknown[]): void => {
        if (typeof a[0] === 'string' && a[0].startsWith('[capture]')) captureLog.push(a[0])
        real.apply(console, a as [])
      }
    console.info = tap(realInfo)
    console.warn = tap(realWarn)
    const stopAt = performance.now()
    let recording
    try {
      recording = await session.stop()
    } finally {
      console.info = realInfo
      console.warn = realWarn
    }
    base.procedureMs = Math.round(performance.now() - stopAt)
    recordingId = recording.id
    blobKeys = recording.channels.map((c) => c.blobKey)
    if (recording.composite) blobKeys.push(recording.composite.blobKey)
    let compositeFps: number | null = null
    let compositeFrames: number | null = null
    let compositeBytes: number | null = null
    if (recording.composite) {
      const cf = await blobStore.read(recording.composite.blobKey)
      const cp = await probeComposite(cf)
      compositeBytes = cf.size
      compositeFrames = cp?.frameCount ?? null
      compositeFps =
        cp && recording.composite.durationMs > 0
          ? Math.round((cp.frameCount / (recording.composite.durationMs / 1000)) * 10) / 10
          : null
    }
    base.take = {
      channels: recording.channels.map((c) => ({
        kind: c.kind,
        durationMs: c.durationMs,
        startOffsetMs: c.startOffsetMs,
      })),
      missing: recording.missing ?? [],
      stalled: recording.stalled ?? [],
      hasComposite: !!recording.composite,
      compositeFps,
      compositeFrames,
      compositeBytes,
      captureEvents: [...new Set(captureEvents)],
      captureLog,
    }
    const screen = recording.channels.find((c) => c.kind === 'screen')
    if (!screen) {
      // Expected when wedged: a recorder that never stops never flushes, so the
      // channel has no bytes and is dropped. The point of that run is the CLOCK.
      base.error = wedged
        ? 'no screen channel (expected: the wedged recorder never flushed) — the number to read is procedureMs'
        : 'the take produced no screen channel'
      return base
    }
    // The session's OWN length for this channel is the reference: the drain must
    // lengthen the file without lengthening the timeline, and if it lengthened
    // both this number would silently stay small while the take got longer.
    base.laneMs = screen.durationMs
    const file = await blobStore.read(screen.blobKey)
    const probe = await probeComposite(file, base.laneMs / 1000)
    if (probe) {
      base.bytes = file.size
      base.frameCount = probe.frameCount
      base.deliveredFps = Math.round((probe.frameCount / (base.laneMs / 1000)) * 10) / 10
      base.lastFrameSec = probe.lastFrameSec
      scoreTail(base, probe)
    }
    return base
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err)
    return base
  } finally {
    MediaRecorder.prototype.stop = realStop
    setSyntheticScreenSize(null)
    if (recordingId) await recordingsRepo.remove(recordingId).catch(() => undefined)
    for (const k of blobKeys) await blobStore.remove(k).catch(() => undefined)
  }
}

async function runOne(
  procedure: StopProcedure,
  width: number,
  height: number,
  takeMs: number,
): Promise<RawTailRun> {
  if (procedure === 'production' || procedure === 'wedged') {
    return runProduction(width, height, takeMs, procedure === 'wedged')
  }
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
    overrunMs: null,
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

    const probe = await probeComposite(await blobStore.read(laneKey), base.laneMs / 1000)
    if (probe) {
      base.frameCount = probe.frameCount
      base.deliveredFps = Math.round((probe.frameCount / (base.laneMs / 1000)) * 10) / 10
      base.lastFrameSec = probe.lastFrameSec
      scoreTail(base, probe)
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

/**
 * O4-polish's remaining "4K row in production shape" — and the first thing it
 * needs is to know whether the shape can be built here at all.
 *
 * Production caps a display track with applyConstraints (capDisplayTrack), so
 * the composite receives 1080p frames from a 4K screen and never pays for the
 * extra pixels. This rig's 4K source is a CANVAS captureStream, and a canvas
 * track's resolution is the canvas's — the question is whether it accepts the
 * constraint anyway. Asked directly rather than assumed, because the answer
 * decides how tight O8b's delivered-fps band can be.
 */
export async function runCapCheck(): Promise<{
  before: { width?: number; height?: number; frameRate?: number }
  after: { width?: number; height?: number; frameRate?: number }
  accepted: boolean
  error: string | null
  verdict: string
}> {
  const canvas = document.createElement('canvas')
  canvas.width = 3840
  canvas.height = 2160
  const g = canvas.getContext('2d')!
  let raf = 0
  const draw = (): void => {
    g.fillStyle = `hsl(${(performance.now() / 20) % 360},50%,30%)`
    g.fillRect(0, 0, canvas.width, canvas.height)
    raf = requestAnimationFrame(draw)
  }
  draw()
  const stream = canvas.captureStream(30)
  const track = stream.getVideoTracks()[0]!
  const before = { ...track.getSettings() }
  let error: string | null = null
  try {
    await track.applyConstraints({
      width: { max: 1920 },
      height: { max: 1080 },
      frameRate: { max: 30 },
    })
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  }
  const after = { ...track.getSettings() }
  cancelAnimationFrame(raf)
  track.stop()
  const accepted = (after.width ?? 0) <= 1920 && (after.height ?? 0) <= 1080
  return {
    before: { width: before.width, height: before.height, frameRate: before.frameRate },
    after: { width: after.width, height: after.height, frameRate: after.frameRate },
    accepted,
    error,
    verdict: accepted
      ? 'a canvas track DOES honour the cap, so a production-shaped 4K row can be built from synthetic sources and O8b’s band can be tightened against it'
      : `a canvas track does NOT honour the cap (${before.width}×${before.height} → ${after.width}×${after.height}${error ? `, ${error}` : ''}). The rig therefore measures the UNCAPPED regime — the one CAPTURE_MAX_* exists to prevent — and a production-shaped 4K row needs a real display, i.e. PO's hardware.`,
  }
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
  const procedures = opts.procedures ?? ['shipped', 'slice250', 'cut', 'throttle', 'production']
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
      'production drives the real createCaptureSession end to end, so the tail is scored against the length the session itself recorded for the channel',
    ],
  }
}
