/**
 * O4 step 2 — main-thread driver for the worker compositor.
 *
 * Same contract as liveComposite.ts (v1) on purpose: session.ts picks one and
 * everything downstream — instant export, salvage, the composite-invalid rules
 * — is untouched. What changes is everything behind it:
 *
 *   v1: source → <video> decode → main-thread drawImage on a 30 Hz tick →
 *       canvas.captureStream → MediaRecorder → blob writes
 *   v2: source → MediaStreamTrackProcessor → transfer to worker → composite +
 *       VideoEncoder + fMP4 → SyncAccessHandle, frame-driven
 *
 * The main thread now does no pixel work at all: it reads frames and posts
 * them (transferable, so nothing is copied).
 *
 * WHAT STAYS ON THIS THREAD, and why:
 *   · The audio MIX. WebAudio has no worker, and this graph's gain staging and
 *     limiter behaviour are shipped and tuned; it is tapped as PCM instead of
 *     being rebuilt.
 *   · The LIVENESS TICK. A frozen source delivers no frames at all, so frame
 *     arrivals alone can never notice it. The AudioWorklet tick keeps firing in
 *     a background tab (rAF does not, and recording means switching away), and
 *     the last frame's own timestamp is the media clock it samples.
 */
import { blobStore } from '@core/store'
import type { CompositorMsg, CompositorReply, CompositorStats } from './compositor.worker'
import type { CompositeRecording } from '../types'
import { SourceLiveness, type LivenessEvent } from './sourceLiveness'
import { watchdogVerdict } from './compositorWatchdog'
import { DELIVERY_FLOOR_RATIO, ladderVerdict } from './resolutionLadder'

const FPS = 30
/**
 * The composite's shape when nothing says otherwise — what this engine wrote
 * before F13, and what every take without a frame to follow still gets.
 */
const W = 1920
const H = 1080
const VIDEO_BITS = 8_000_000
const AUDIO_BITS = 128_000
const FPS_LOG_MS = 10_000
/**
 * How long to wait for the compositor to prove it can paint the preview before
 * giving up and leaving the caller's own preview in place. Everything on this
 * path has a deadline (note 3) — and a preview that never arrives must cost the
 * user a fallback, not a blank rectangle.
 */
const PREVIEW_ATTACH_BUDGET_MS = 3000

/**
 * Watchdog: see compositorWatchdog.ts. The honest signal is the rate that
 * reaches the FILE, measured from the encoder's FIRST OUTPUT — a cold
 * encoder's multi-second initialization is not a slow machine, and killing a
 * take during it was exactly how the whole engine got misdiagnosed as
 * "2-10 fps" (2026-08-24). Keep-alive frames are excluded so a static
 * composition is left alone.
 */

/**
 * One worklet, two jobs: it taps the mixed PCM and it is the liveness tick.
 *
 * Two rules it inherits from the measured-audio worklet, both learned the hard
 * way and both re-learned here when they were left out:
 *  · Quanta that arrive STARVED after audio has started become SILENCE, not
 *    nothing. The timeline is sample-counted, so a skipped quantum splices it —
 *    every sample after it moves early and the splice itself is a step
 *    discontinuity. Leaving them out measured as a −33 dB spur.
 *  · Quanta BEFORE the first live sample are the context's startup catch-up and
 *    must be dropped, or the take begins with fast-forwarded silence.
 *
 * Each batch carries the AudioContext time of its FIRST sample. Wall-clocking
 * a batch when it arrives on the main thread is wrong whenever the port has
 * queued (it queues during worker start), and that error lands entirely on the
 * anchor — it placed the whole audio track ~430 ms late.
 */
const TAP_SOURCE = `
class InoutCompositeTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = []
    this.frames = 0
    this.channels = 2
    this.sawLive = false
    this.silentTicks = 0
    this.batchFrames = 1024
    this.batchStartTime = 0
  }
  process(inputs) {
    const chans = inputs[0]
    const live = chans && chans.length && chans[0] && chans[0].length
    if (!live && !this.sawLive) {
      // Nothing yet (or no audio in this take at all): still tick so the
      // liveness detector keeps watching the video sources.
      this.silentTicks++
      if (this.silentTicks >= 6) {
        this.silentTicks = 0
        this.port.postMessage({ tick: true })
      }
      return true
    }
    if (this.frames === 0) this.batchStartTime = currentTime
    const n = live ? chans[0].length : 128
    if (live) {
      this.sawLive = true
      this.channels = chans.length
      const copy = []
      for (let c = 0; c < chans.length; c++) copy.push(chans[c].slice(0))
      this.buf.push({ n, data: copy })
    } else {
      this.buf.push({ n, data: null })
    }
    this.frames += n
    if (this.frames >= this.batchFrames) this.flush()
    return true
  }
  flush() {
    if (!this.frames) return
    const total = this.frames
    const ch = this.channels
    const planar = new Float32Array(ch * total)
    let off = 0
    for (const q of this.buf) {
      if (q.data) {
        for (let c = 0; c < ch && c < q.data.length; c++) planar.set(q.data[c], c * total + off)
      }
      off += q.n
    }
    this.port.postMessage(
      { frames: total, channels: ch, planar, contextTime: this.batchStartTime },
      [planar.buffer],
    )
    this.buf = []
    this.frames = 0
  }
}
registerProcessor('inout-composite-tap', InoutCompositeTap)
`

let tapUrl: string | null = null
function tapModuleUrl(): string {
  tapUrl ??= URL.createObjectURL(new Blob([TAP_SOURCE], { type: 'application/javascript' }))
  return tapUrl
}

/** MediaStreamTrackProcessor (Chromium) — still absent from the TS DOM lib. */
interface TrackProcessorLike {
  readable: ReadableStream<VideoFrame>
}
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => TrackProcessorLike

/** The rate every take asks for; the ladder scores delivery against it. */
const FPS_REQUESTED = 30
const LADDER_FLOOR = DELIVERY_FLOOR_RATIO

function trackProcessorCtor(): TrackProcessorCtor | null {
  const g = globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }
  return typeof g.MediaStreamTrackProcessor === 'function' ? g.MediaStreamTrackProcessor : null
}

export interface LiveCompositeV2Inputs {
  screen?: MediaStream
  camera?: MediaStream
  audio: MediaStream[]
}

export interface LiveCompositeV2Options {
  onSourceLiveness?: (kind: 'screen' | 'camera', event: LivenessEvent) => void
  /** Fired when the watchdog gives up, so the caller can fall back to v1. */
  onDegrade?: (reason: string) => void
  /**
   * O6 — step the SOURCE down a rung before giving up on it. The compositor
   * sees delivery, the session owns the tracks, so the verdict travels and the
   * constraint is applied there. Absent = the ladder never runs, which is the
   * default.
   */
  onDegradeStep?: (rung: { label: string; width: number; height: number }, reason: string) => void
  /**
   * The session epoch (performance.now()), so the composite can say WHERE ITS
   * OWN CLOCK STARTS on the recording timeline (P0-instant-sync). Omitted by
   * rigs that drive this engine directly: then the file declares no offset and
   * consumers keep the old assume-zero behaviour rather than a guess.
   */
  epochMs?: number
  /**
   * THE COMPOSITE'S OWN GEOMETRY (task F13). The session derives it from the
   * take's video channel so a portrait source is composited portrait instead of
   * being cropped into a landscape constant. Omitted — by every rig that drives
   * this engine directly, and by the session whenever the frame does not follow
   * the source — leaves it at the 1920x1080 this engine has always written.
   */
  width?: number
  height?: number
  /**
   * F13, second pass: let the compositor take the shape from the first frame it
   * actually receives rather than from `width`/`height`, which on a phone are
   * `track.getSettings()` — the SENSOR's landscape dimensions, not the rotated
   * portrait frames the camera delivers. `width`/`height` stay the guess the
   * take starts with and the answer when nothing ever arrives.
   */
  followSource?: boolean
  /** The pixel budget the adopted shape is resolved at (long edge). */
  longEdge?: number
  /** Fired once the composite's shape is settled, so the UI can stop showing
   *  the guess. Called with the geometry the FILE is being written at. */
  onGeometry?: (size: { width: number; height: number }) => void
}

export interface LiveCompositeV2Handle {
  stop(): Promise<CompositeRecording | null>
  cancel(): Promise<void>
  /** Engine evidence — read by the session for the console line and by tests. */
  stats(): CompositorStats | null
  /**
   * Hand the compositor a canvas to paint the live preview into (O4-polish).
   * Resolves TRUE only once a frame has actually landed on it, so the caller
   * can drop its own preview without a blank flash; false means keep it.
   */
  attachPreview(canvas: HTMLCanvasElement): Promise<boolean>
}

/**
 * FAULT INJECTION, EVIDENCE ONLY (O4-polish's e2e wedge case). Nothing in the
 * product sets this; the o4wedge rig does, to drive the two fallback rungs that
 * unit tests cannot reach — a start failure and a mid-take degrade — through the
 * REAL session, so what is proven is that the take survives them and that the
 * export lands on the right path, not that a pure function returns the right
 * verdict. The oracle's `injectTailLossMs` is the same pattern.
 */
export interface CompositeFault {
  /** Throw before the worker exists → the session's v1 fallback takes the take. */
  startFails?: boolean
  /** Fire the real degrade path this long after start → composite refused. */
  degradeAfterMs?: number
}
let fault: CompositeFault | null = null
export function setCompositeFault(f: CompositeFault | null): void {
  fault = f
}
export function getCompositeFault(): CompositeFault | null {
  return fault
}

export function canLiveCompositeV2(inputs: LiveCompositeV2Inputs): boolean {
  if (!inputs.screen && !inputs.camera) return false
  return (
    trackProcessorCtor() !== null &&
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    !!navigator.storage?.getDirectory
  )
}

export async function startLiveCompositeV2(
  inputs: LiveCompositeV2Inputs,
  blobKey: string,
  options: LiveCompositeV2Options = {},
): Promise<LiveCompositeV2Handle> {
  const TP = trackProcessorCtor()
  if (!TP) throw new Error('live composite v2: MediaStreamTrackProcessor unavailable')
  // F13: the caller's frame, or the constant this engine shipped with.
  const outW = options.width && options.width > 0 ? options.width : W
  const outH = options.height && options.height > 0 ? options.height : H
  if (fault?.startFails) {
    // Before the worker, before OPFS: the shape of a real capability failure.
    throw new Error('live composite v2: injected start failure (o4wedge)')
  }

  const worker = new Worker(new URL('./compositor.worker.ts', import.meta.url), { type: 'module' })
  let latestStats: CompositorStats | null = null
  let workerError: string | null = null
  let degraded = false
  let torndown = false
  /** F13: the shape has been reported to the caller once, and only once. */
  let geometryReported = false
  const reportGeometry = (st: CompositorStats): void => {
    if (geometryReported || !st.outWidth || !st.outHeight) return
    geometryReported = true
    options.onGeometry?.({ width: st.outWidth, height: st.outHeight })
  }

  const pending = new Map<string, { resolve: (r: CompositorReply) => void; reject: (e: Error) => void }>()
  worker.onmessage = (ev: MessageEvent<CompositorReply>) => {
    const reply = ev.data
    if ('event' in reply) {
      if (reply.event === 'stats') {
        latestStats = reply.stats
        reportGeometry(reply.stats)
        checkWatchdog(reply.stats)
      } else {
        workerError = reply.error
        console.warn('[capture] compositor worker error', reply.error)
        degrade(`encoder error: ${reply.error}`)
      }
      return
    }
    const waiter = pending.get(reply.cmd)
    if (waiter) {
      pending.delete(reply.cmd)
      waiter.resolve(reply)
    }
  }
  worker.onerror = (ev) => {
    workerError = ev.message || 'compositor worker failed'
    for (const p of pending.values()) p.reject(new Error(workerError))
    pending.clear()
    degrade('worker crashed')
  }

  const call = (msg: CompositorMsg, transfer?: Transferable[]): Promise<CompositorReply> =>
    new Promise((resolve, reject) => {
      pending.set(msg.cmd, { resolve, reject })
      worker.postMessage(msg, transfer ?? [])
    })

  const startedAt = performance.now()
  const degrade = (reason: string): void => {
    if (degraded) return
    degraded = true
    console.warn(`[capture] composite v2 degraded: ${reason} — falling back`)
    options.onDegrade?.(reason)
  }
  if (fault?.degradeAfterMs !== undefined) {
    // The REAL degrade path, not a stand-in for it: the rig proves the take
    // survives what the watchdog does, so it has to be what the watchdog calls.
    setTimeout(() => degrade('injected wedge (o4wedge)'), fault.degradeAfterMs)
  }

  /** First non-keep-alive output, seen through the 1 Hz stats events — the
   *  watchdog's clock starts here, so encoder initialization is not "slow". */
  let firstOutputAt: number | null = null
  // O6's ladder state. Lives beside the watchdog because it reads the same
  // stats and answers the gentler half of the same question: the watchdog says
  // "give up on the composite", the ladder says "ask the source for less first".
  let stepsTaken = 0
  let lastStepAt: number | null = null
  let underFloorSince: number | null = null
  let lastRealFrames = 0
  let lastInFrames = 0
  let lastStatsAt: number | null = null

  function checkLadder(now: number, real: number, framesIn: number): void {
    if (!options.onDegradeStep || degraded) return
    // Delivered fps over the interval between stats events, not since the
    // start: a take that recovers should stop being judged on how it began.
    if (lastStatsAt !== null && now > lastStatsAt) {
      const fps = ((real - lastRealFrames) * 1000) / (now - lastStatsAt)
      const inFps = ((framesIn - lastInFrames) * 1000) / (now - lastStatsAt)
      const requested = FPS_REQUESTED
      // P0-ladder-static: demand is what ARRIVED, capped at the requested rate
      // (the cadence gate drops a 60 fps source's excess on purpose). A static
      // screen delivers 0 fps by design and must never read as backpressure.
      const demand = Math.min(inFps, requested)
      const under = demand > 0 && fps / demand < LADDER_FLOOR
      if (under) underFloorSince ??= now
      else underFloorSince = null
      const verdict = ladderVerdict({
        nowMs: now,
        startedAtMs: startedAt,
        firstOutputAtMs: firstOutputAt,
        lastStepAtMs: lastStepAt,
        underFloorForMs: underFloorSince === null ? 0 : now - underFloorSince,
        deliveredFps: fps,
        arrivedFps: inFps,
        requestedFps: requested,
        stepsTaken,
      })
      if (verdict) {
        stepsTaken++
        lastStepAt = now
        underFloorSince = null
        console.warn(`[capture] native-res backpressure — stepping down: ${verdict.reason}`)
        options.onDegradeStep(verdict.rung, verdict.reason)
      }
    }
    lastStatsAt = now
    lastRealFrames = real
    lastInFrames = framesIn
  }

  function checkWatchdog(s: CompositorStats): void {
    if (degraded) return
    const now = performance.now()
    const real = s.framesEncoded - s.keepAliveFrames
    if (real > 0 && firstOutputAt === null) firstOutputAt = now
    checkLadder(now, real, s.framesIn)
    const verdict = watchdogVerdict({
      nowMs: now,
      startedAtMs: startedAt,
      firstOutputAtMs: firstOutputAt,
      realFramesEncoded: real,
      framesDropped: s.framesDropped,
    })
    if (verdict) degrade(verdict)
  }

  // ---- liveness: last frame timestamp per source, sampled on the tick ------
  const liveness = new Map<
    'screen' | 'camera',
    { det: SourceLiveness; track: MediaStreamTrack; lastMediaSec: number; frames: number; framesAtLog: number }
  >()
  let lastFpsLog = startedAt

  const sampleLiveness = (): void => {
    const now = performance.now()
    for (const [kind, s] of liveness) {
      // Frame silence is ambiguous on this frame-driven path (a static screen
      // delivers nothing); the track's own health decides — see sourceLiveness.
      const ev = s.det.sample(now, s.lastMediaSec, s.track.readyState === 'live' && !s.track.muted)
      if (ev) {
        console.warn(`[capture] ${kind} source ${ev}`)
        options.onSourceLiveness?.(kind, ev)
      }
    }
    if (now - lastFpsLog >= FPS_LOG_MS) {
      const windowSec = (now - lastFpsLog) / 1000
      lastFpsLog = now
      for (const [kind, s] of liveness) {
        console.info(
          `[capture] ${kind} delivering ${((s.frames - s.framesAtLog) / windowSec).toFixed(1)} fps ` +
            `(v2 worker compositor)`,
        )
        s.framesAtLog = s.frames
      }
    }
  }

  // ---- audio mix, unchanged from v1 in behaviour --------------------------
  const audioCtx = new AudioContext({ sampleRate: 48000 })
  await audioCtx.audioWorklet.addModule(tapModuleUrl())
  const tap = new AudioWorkletNode(audioCtx, 'inout-composite-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    // EXPLICIT STEREO IN, because the encoder is configured for stereo and the
    // batches were not guaranteed to be. The input count defaulted to the MAX
    // of whatever was connected, so an all-mono take (a mono mic, alone or with
    // mono tab audio) delivered 1-channel batches to a 2-channel AAC encoder —
    // a mismatch nothing downstream could have reconciled. v1 never had this
    // hazard: it mixes through a MediaStreamDestination, which is stereo
    // whatever it is fed, and matching that is the point. A genuinely mono
    // source is simply duplicated across both channels, exactly as the measured
    // mic path already does on an unreported channelCount.
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  })
  const hasAudio = inputs.audio.length > 0
  if (hasAudio) {
    if (inputs.audio.length === 1) {
      audioCtx.createMediaStreamSource(inputs.audio[0]!).connect(tap)
    } else {
      const limiter = audioCtx.createDynamicsCompressor()
      limiter.threshold.value = -3
      limiter.knee.value = 3
      limiter.ratio.value = 12
      limiter.attack.value = 0.003
      limiter.release.value = 0.25
      limiter.connect(tap)
      const perSource = audioCtx.createGain()
      perSource.gain.value = 0.7
      perSource.connect(limiter)
      for (const s of inputs.audio) audioCtx.createMediaStreamSource(s).connect(perSource)
    }
  }
  // The tap must be pulled for process() to run at all.
  tap.connect(audioCtx.destination)
  await audioCtx.resume()

  /**
   * One correspondence between the audio clock and the wall clock, taken here
   * and never re-taken. Every batch's wall time is then derived from its own
   * context timestamp, so however long the worker takes to start — and however
   * long the port queues — the audio anchor cannot move.
   */
  const ctxRefTime = audioCtx.currentTime
  const ctxRefWall = performance.now()
  const wallForContextTime = (t: number): number => ctxRefWall + (t - ctxRefTime) * 1000

  // Assigned BEFORE the worker start round-trip: a port only begins delivering
  // when a handler exists, and batches captured in the meantime must keep the
  // capture times they were stamped with, not the time they were handed over.
  const queuedAudio: {
    planar: Float32Array
    frames: number
    channels: number
    atMs: number
    recvMs: number
  }[] = []
  let workerReady = false
  let audioBatches = 0

  const sendAudio = (batch: {
    planar: Float32Array
    frames: number
    channels: number
    atMs: number
    recvMs: number
  }): void => {
    audioBatches++
    worker.postMessage({ cmd: 'audio', ...batch } satisfies CompositorMsg, [batch.planar.buffer])
  }

  tap.port.onmessage = (
    ev: MessageEvent<{ tick?: boolean; frames?: number; channels?: number; planar?: Float32Array; contextTime?: number }>,
  ) => {
    if (torndown) return
    // Taken FIRST: this stamp is the take's only witness that is independent of
    // the audio clock, and the handler below does real work.
    const recvMs = performance.now()
    sampleLiveness()
    const { frames, channels, planar, contextTime } = ev.data
    if (!frames || !channels || !planar || contextTime === undefined) return
    const batch = { planar, frames, channels, atMs: wallForContextTime(contextTime), recvMs }
    if (workerReady) sendAudio(batch)
    else queuedAudio.push(batch)
  }

  const startReply = await call({
    cmd: 'start',
    key: blobKey,
    width: outW,
    height: outH,
    fps: FPS,
    followSource: options.followSource === true,
    longEdge: options.longEdge,
    videoBitrate: VIDEO_BITS,
    audioBitrate: AUDIO_BITS,
    sampleRate: hasAudio ? audioCtx.sampleRate : null,
    channelCount: 2,
  })
  if (!('ok' in startReply) || !startReply.ok) {
    worker.terminate()
    await audioCtx.close().catch(() => undefined)
    throw new Error('error' in startReply ? startReply.error : 'compositor start failed')
  }
  workerReady = true
  for (const batch of queuedAudio) sendAudio(batch)
  queuedAudio.length = 0

  // ---- frame pumps ---------------------------------------------------------
  const readers: { cancel: () => void }[] = []
  const pump = (stream: MediaStream, kind: 'screen' | 'camera'): void => {
    const track = stream.getVideoTracks()[0]
    if (!track) return
    liveness.set(kind, { det: new SourceLiveness(), track, lastMediaSec: -1, frames: 0, framesAtLog: 0 })
    const reader = new TP({ track }).readable.getReader()
    readers.push({ cancel: () => void reader.cancel().catch(() => undefined) })
    void (async () => {
      for (;;) {
        let result: ReadableStreamReadResult<VideoFrame>
        try {
          result = await reader.read()
        } catch {
          break
        }
        const { value, done } = result
        if (done || torndown || degraded) {
          value?.close()
          break
        }
        const state = liveness.get(kind)
        if (state) {
          state.frames++
          state.lastMediaSec = value.timestamp / 1e6
        }
        // Transferred, not copied — the worker owns and closes it.
        worker.postMessage({ cmd: 'frame', kind, atMs: performance.now(), frame: value } satisfies CompositorMsg, [
          value,
        ])
      }
    })()
  }
  if (inputs.screen) pump(inputs.screen, 'screen')
  if (inputs.camera) pump(inputs.camera, 'camera')

  const teardown = async (): Promise<void> => {
    if (torndown) return
    torndown = true
    tap.port.onmessage = null
    for (const r of readers) r.cancel()
    try {
      tap.disconnect()
    } catch {
      /* already gone */
    }
    if (audioCtx.state !== 'closed') await audioCtx.close().catch(() => undefined)
  }

  return {
    stats: () => latestStats,

    async attachPreview(el: HTMLCanvasElement): Promise<boolean> {
      if (torndown || degraded || workerError) return false
      let off: OffscreenCanvas
      try {
        off = el.transferControlToOffscreen()
      } catch {
        // Already transferred (a re-render handing over the same element), or
        // the browser has no OffscreenCanvas: the <video> preview stays.
        return false
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const reply = await Promise.race([
          call({ cmd: 'preview', canvas: off } satisfies CompositorMsg, [off]),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), PREVIEW_ATTACH_BUDGET_MS)
          }),
        ])
        if (!reply) {
          pending.delete('preview')
          console.info('[capture] composite preview did not paint in time — keeping the source preview')
          return false
        }
        return 'ok' in reply && reply.ok
      } catch {
        return false
      } finally {
        if (timer) clearTimeout(timer)
      }
    },

    async stop() {
      const wallMs = performance.now() - startedAt
      await teardown()
      if (degraded) {
        await call({ cmd: 'cancel' }).catch(() => undefined)
        worker.terminate()
        await blobStore.remove(blobKey).catch(() => undefined)
        return null
      }
      let stats: CompositorStats | null = null
      try {
        const reply = await call({ cmd: 'stop' })
        if ('ok' in reply && reply.ok && reply.cmd === 'stop') stats = reply.stats
      } catch (err) {
        console.warn('[capture] composite v2 stop failed', err)
      } finally {
        worker.terminate()
      }
      if (!stats || stats.bytes === 0 || stats.framesEncoded === 0 || workerError) {
        await blobStore.remove(blobKey).catch(() => undefined)
        return null
      }
      latestStats = stats
      const seconds = Math.max(0.001, stats.durationMs / 1000)
      // O11a: where the bits went, counted rather than guessed.
      console.info(
        `[capture] composite v2 ${stats.codec} ${stats.hardware} — ` +
          `${stats.framesEncoded} frames (${stats.framesDropped} dropped, ${stats.keepAliveFrames} keep-alive, ` +
          `peak queue ${stats.peakQueue}), ${audioBatches} audio batches; ` +
          `video ${(stats.videoBytes / 1024).toFixed(0)} KB at ` +
          `${((stats.videoBytes * 8) / seconds / 1e6).toFixed(2)} Mbps of ` +
          `${(stats.requestedVideoBitrate / 1e6).toFixed(1)} Mbps requested, ` +
          `keyframes ${stats.keyframeCount} = ${((stats.keyframeBytes / Math.max(1, stats.videoBytes)) * 100).toFixed(0)}% of video bytes, ` +
          `audio ${(stats.audioBytes / 1024).toFixed(0)} KB` +
          // O4-polish: what the preview blit costs, per frame, measured rather
          // than asserted. Absent from the line when nothing asked for one.
          (stats.previewMs > 0
            ? `; preview ${(stats.previewMs / Math.max(1, stats.framesEncoded)).toFixed(2)} ms/frame ` +
              `(${stats.previewMs.toFixed(0)} ms total)`
            : ''),
      )
      const composite: CompositeRecording = {
        blobKey,
        engine: 'v2',
        mimeType: 'video/mp4',
        // The encoder's own last timestamp is the truth; wall time includes
        // teardown and would overstate the file by the drain.
        durationMs: Math.round(stats.durationMs || wallMs),
        // F13: what the worker actually WROTE, which is not always what it was
        // asked for — the first frame may have turned it.
        width: stats.outWidth || outW,
        height: stats.outHeight || outH,
        bytes: stats.bytes,
      }
      // WHERE THIS FILE'S ZERO SITS IN THE TAKE (P0-instant-sync). The worker
      // stamps its origin with the MAIN-THREAD clock that stamped the arrival,
      // so the subtraction is between two readings of one clock.
      if (options.epochMs !== undefined && stats.originAtMs !== null) {
        const offset = Math.round(stats.originAtMs - options.epochMs)
        composite.startOffsetMs = offset
        console.info(`[capture] composite v2 clock starts +${offset}ms into the take`)
      }
      return composite
    },

    async cancel() {
      await teardown()
      try {
        await call({ cmd: 'cancel' })
      } catch {
        /* worker may already be gone */
      }
      worker.terminate()
      await blobStore.remove(blobKey).catch(() => undefined)
    },
  }
}
