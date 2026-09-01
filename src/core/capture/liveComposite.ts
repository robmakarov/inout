/**
 * Instant rendering v1: while channels record, a second lightweight recorder
 * captures the DEFAULT composition (screen contain + camera PiP + mixed audio)
 * to its own blob. If the user exports without edits — the common case — the
 * file already exists and export is instant. Any edit falls back to the full
 * compositor. Geometry mirrors src/core/compose/layout.ts (decision #11).
 * v2 (WebCodecs + smart-cut) replaces this without changing the contract.
 */
import { COMPOSITE_BITS } from './captureBitrate'
import { adoptedFrame } from '@core/frame'
import { blobStore } from '@core/store'
import type { CameraPose, CompositeRecording } from '../types'
import { SourceLiveness, type LivenessEvent } from './sourceLiveness'

/**
 * Draw ticks come from an AudioWorklet, NOT requestAnimationFrame: rAF is
 * throttled to a standstill in background tabs, and recording normally means
 * switching AWAY from this tab. Audio render quanta keep firing regardless.
 */
const TICKER_SOURCE = `
class InoutCompositeTick extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0 }
  process() {
    this.n++
    if (this.n >= 6) { this.port.postMessage(0); this.n = 0 }
    return true
  }
}
registerProcessor('inout-composite-tick', InoutCompositeTick)
`
let tickerUrl: string | null = null
function tickerModuleUrl(): string {
  if (!tickerUrl) {
    tickerUrl = URL.createObjectURL(new Blob([TICKER_SOURCE], { type: 'application/javascript' }))
  }
  return tickerUrl
}

/**
 * The composite's rate when the caller names none — what this engine wrote
 * before F15, and what every take whose source does not offer more still gets.
 */
const FPS = 30
/**
 * The composite's shape when the caller names none — what this engine wrote
 * before F13, and what every take without a frame to follow still gets.
 */
const W = 1920
const H = 1080
/** F13: how long the picture has to declare itself before the guess stands. */
const ADOPT_BUDGET_MS = 700
/** How often each source's delivered frame rate is logged (evidence only). */
const FPS_LOG_MS = 10_000
/** rAF cadence watchdog: give up silently rather than tax a weak machine. */
const WATCHDOG_AFTER_MS = 5000
const WATCHDOG_MAX_GAP_P50_MS = 50

/**
 * TAIL DRAIN (task P0-tail). MEASURED 2026-08-23: on a 4K source this recorder
 * put 140 frames into a 10 s file and its last decodable frame sat 2734 ms
 * before the end — nearly three seconds of the take simply absent, which is
 * Robert's "Loom cuts last seconds" happening in our own product.
 *
 * MediaRecorder is a black box at stop: whatever it has not encoded is gone.
 * So stop() now stops PAINTING first, then PROBES the encoder with
 * requestData() until it answers empty, and only then asks it to stop.
 *
 * MEASURED at 4K, 10 s takes, tail = take length minus the last decodable frame:
 *     shipped before                       2734 ms
 *     1 s timeslice → 250 ms, no drain     675, 922 ms
 *     + wait-for-quiet drain               150, 198, 579 ms
 *     + probe drain (this)                 56, 320 ms, ~1 MB recovered per take
 * The wait-for-quiet version is in that table because it looked right and was
 * wrong: under load this recorder emits four chunks in ten seconds, so "no
 * bytes for 200 ms" is true almost immediately and proves nothing.
 * On a healthy 1080p take the drain costs 242 ms at stop and recovers 0 bytes —
 * there is nothing to recover — and the tail stays 71-80 ms, exactly where it
 * was. If the budget runs out with the encoder still producing, that is
 * REPORTED (tailIncomplete) rather than silently shipped.
 */
const CHUNK_MS = 250
/**
 * The drain PROBES with requestData() rather than waiting for the byte flow to
 * go quiet, and that distinction is the whole fix. Measured: under 4K load this
 * recorder emits about four chunks in ten seconds — bursts ~2.6 s apart — so
 * "no bytes for 200 ms" is true almost immediately and means nothing. A
 * requestData() flushes whatever has been encoded so far, so an EMPTY answer is
 * real evidence that there is nothing left in the queue.
 */
const DRAIN_POLL_MS = 120
/** Consecutive empty probes that count as caught up. */
const DRAIN_IDLE_PROBES = 2
/** Never wait longer than this at stop, however far behind the encoder is. */
const DRAIN_BUDGET_MS = 2000

/** What the composite actually did — evidence at stop, and the tail verdict. */
export interface LiveCompositeStats {
  /** Frames the compositor painted (what a perfect encoder would have taken). */
  drawnFrames: number
  /** ms since start of the last paint. */
  lastDrawMs: number
  chunks: number
  bytes: number
  /** ms since start of the last chunk that carried bytes. */
  lastChunkMs: number
  /** How long the post-paint drain waited. */
  drainMs: number
  /** Bytes that arrived during the drain — the tail this fix bought back. */
  drainedBytes: number
  /** True when the encoder was STILL emitting when the budget ran out: the
   *  file is missing an unknown amount of its end. */
  drainTimedOut: boolean
}

export interface LiveCompositeInputs {
  screen?: MediaStream
  camera?: MediaStream
  audio: MediaStream[]
}

export interface LiveCompositeOptions {
  /**
   * A video source stopped (or resumed) delivering frames mid-take. The
   * composite keeps running — the session decides what to do — but a stalled
   * source means the composite is painting the same frame over and over, so an
   * unedited export must NOT copy it. Driven by the worklet tick, so it keeps
   * firing while the tab is in the background (which is the normal case).
   */
  onSourceLiveness?: (kind: 'screen' | 'camera', event: LivenessEvent) => void
  /**
   * The session epoch (performance.now()), so the composite can say WHERE ITS
   * OWN CLOCK STARTS on the recording timeline (P0-instant-sync). This engine
   * is the WORSE offender of the two: a MediaRecorder file always begins at 0,
   * and by the time it begins, the <video> elements, the canvas, the audio
   * graph and the durable write stream have all been built — measured 244.8 ms
   * of A/V offset on the instant path against the same take's render at ~60.
   * Omitted by rigs driving this engine directly: then the file declares no
   * offset and consumers keep the old assume-zero behaviour.
   */
  epochMs?: number
  /**
   * THE COMPOSITE'S OWN GEOMETRY (task F13). The session derives it from the
   * take's video channel; omitted, this engine writes the 1920x1080 it always
   * has.
   */
  width?: number
  height?: number
  /**
   * F13, second pass: take the shape from the PICTURE, not from the caller.
   * `track.getSettings()` reports the SENSOR on a phone held portrait —
   * landscape — while the frames are rotated to portrait, and THIS is the
   * engine an iPhone uses (Safari has no MediaStreamTrackProcessor, so v2 is
   * never available there). A `<video>` element's videoWidth/videoHeight are
   * the rotated truth, so the canvas is sized from those.
   */
  followSource?: boolean
  /** The pixel budget the adopted shape is resolved at (long edge). */
  longEdge?: number
  /**
   * THE COMPOSITE'S RATE (task F15). This engine's rate is the rate it asks
   * `canvas.captureStream()` for — MediaRecorder then encodes what that stream
   * delivers. Omitted, it is the 30 this engine always painted at.
   */
  fps?: number
  onGeometry?: (size: { width: number; height: number }) => void
}

export interface LiveCompositeHandle {
  /** Resolves at stop: null when the composite was aborted by the watchdog. */
  stop(): Promise<CompositeRecording | null>
  cancel(): Promise<void>
  /**
   * Paint the live preview into this canvas instead of making the UI decode
   * the sources a second time (O4-polish). OPTIONAL, and v1 does not implement
   * it: this engine composites on the MAIN thread from <video> elements the UI
   * is already showing, so there is nothing here to hand over and nothing to
   * save. Absent = the caller keeps its own preview.
   */
  attachPreview?(canvas: HTMLCanvasElement): Promise<boolean>
  /**
   * UI1 — move the camera PiP while the take runs. OPTIONAL, and v1 does not
   * implement it: v1 composites on the MAIN thread from the <video> elements
   * the UI already shows, and its layout is `compose/layout.ts` called directly
   * — a pose there is the editor's job, not a live message. Absent = the take
   * keeps the default corner, which is what v1 takes have always had.
   */
  setCameraPose?(pose: CameraPose | null): void
}

/** v1 also reports what it did. Kept off the shared handle so the engine
 *  switch in session.ts stays a plain union of two interchangeable things. */
export interface LiveCompositeV1Handle extends LiveCompositeHandle {
  /** Only meaningful after stop() — the drain fields are filled there. */
  stats(): LiveCompositeStats
}

/**
 * MP4 first — the instant file must match the rendered export's format
 * (product: no surprise .webm). Without MediaRecorder MP4 support the
 * composite is skipped and export falls back to the full render (mp4).
 */
const MP4_MIMES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
]

function pickCompositeMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const m of MP4_MIMES) if (MediaRecorder.isTypeSupported(m)) return m
  return null
}

export function canLiveComposite(inputs: LiveCompositeInputs): boolean {
  return !!(inputs.screen || inputs.camera) && pickCompositeMime() !== null
}

function drawContain(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, W: number, H: number): void {
  const vw = v.videoWidth || W
  const vh = v.videoHeight || H
  const s = Math.min(W / vw, H / vh)
  const dw = vw * s
  const dh = vh * s
  ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh)
}

function drawCover(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, W: number, H: number): void {
  const vw = v.videoWidth || W
  const vh = v.videoHeight || H
  const s = Math.max(W / vw, H / vh)
  const dw = vw * s
  const dh = vh * s
  ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh)
}

function drawPip(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, W: number, H: number): void {
  // F13: keyed to the LONG edge, so a portrait composite keeps the border and
  // radius the layout was authored with. Identical to W / 1920 in landscape.
  const scale = Math.max(W, H) / 1920
  const pipW = 0.24 * W
  const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 4 / 3
  const pipH = pipW / aspect
  const margin = 24 * scale
  const r = 16 * scale
  const x = W - pipW - margin
  const y = H - pipH - margin
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x, y, pipW, pipH, r)
  ctx.clip()
  ctx.drawImage(v, x, y, pipW, pipH)
  ctx.restore()
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x, y, pipW, pipH, r)
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'
  ctx.lineWidth = 1.5 * scale
  ctx.stroke()
  ctx.restore()
}

/** Frames the source has actually handed this element, or null where the
 * browser doesn't expose the counter. Exact — unlike inferring cadence from
 * the media clock, which only tells us "advanced since last tick". */
function deliveredFrames(el: HTMLVideoElement): number | null {
  if (typeof el.getVideoPlaybackQuality !== 'function') return null
  return el.getVideoPlaybackQuality().totalVideoFrames
}

function videoFor(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement('video')
  v.srcObject = stream
  v.muted = true
  v.playsInline = true
  void v.play().catch(() => undefined)
  return v
}

/**
 * The element's real picture size, once the browser knows it. Bounded: a source
 * that never produces metadata must not hold a take up, and the caller's guess
 * is exactly the geometry this engine used to always write.
 */
async function firstDims(
  el: HTMLVideoElement,
  budgetMs: number,
): Promise<{ width: number; height: number } | null> {
  if (el.videoWidth > 0 && el.videoHeight > 0) {
    return { width: el.videoWidth, height: el.videoHeight }
  }
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      el.removeEventListener('loadedmetadata', finish)
      el.removeEventListener('resize', finish)
      resolve(
        el.videoWidth > 0 && el.videoHeight > 0
          ? { width: el.videoWidth, height: el.videoHeight }
          : null,
      )
    }
    const timer = setTimeout(finish, budgetMs)
    el.addEventListener('loadedmetadata', finish)
    el.addEventListener('resize', finish)
  })
}

export async function startLiveComposite(
  inputs: LiveCompositeInputs,
  blobKey: string,
  options: LiveCompositeOptions = {},
): Promise<LiveCompositeV1Handle> {
  // The elements come FIRST now: their videoWidth/videoHeight is the only
  // honest statement of what this take looks like (F13), and the canvas has to
  // be that shape before a single frame is drawn into it.
  const screenEl = inputs.screen ? videoFor(inputs.screen) : null
  const cameraEl = inputs.camera ? videoFor(inputs.camera) : null
  let torndown = false

  // F13: the caller's frame is the guess; the picture is the answer.
  let outW = options.width && options.width > 0 ? options.width : W
  let outH = options.height && options.height > 0 ? options.height : H
  // F15: the caller's rate, same contract as the frame above.
  const outFps = options.fps && options.fps > 0 ? Math.round(options.fps) : FPS
  if (options.followSource) {
    const primary = screenEl ?? cameraEl
    const dims = primary ? await firstDims(primary, ADOPT_BUDGET_MS) : null
    const want = dims
      ? adoptedFrame(
          { width: outW, height: outH },
          dims,
          options.longEdge && options.longEdge > 0 ? options.longEdge : Math.max(outW, outH),
        )
      : null
    if (want && dims) {
      console.info(
        `[capture] composite v1: the picture is ${dims.width}x${dims.height} — composing ` +
          `${want.width}x${want.height}, not ${outW}x${outH} (F13)`,
      )
      outW = want.width
      outH = want.height
    }
  }
  options.onGeometry?.({ width: outW, height: outH })

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('live composite: 2d context unavailable')

  // Mixed audio with gain staging + limiter: naive unity summing clips as
  // soon as mic and system audio overlap — that IS audible noise/distortion.
  const audioCtx = new AudioContext({ sampleRate: 48000 })
  await audioCtx.audioWorklet.addModule(tickerModuleUrl())
  let audioTrack: MediaStreamTrack | null = null
  if (inputs.audio.length > 0) {
    const dest = audioCtx.createMediaStreamDestination()
    if (inputs.audio.length === 1) {
      // Single source can't exceed ±1 — any dynamics stage here only damages
      // it (the −6dB/20:1 limiter audibly pumped tab music: music program
      // sits near full scale, so it lived permanently above threshold).
      audioCtx.createMediaStreamSource(inputs.audio[0]!).connect(dest)
    } else {
      const limiter = audioCtx.createDynamicsCompressor()
      // Safety net for overlapping sources, not a mastering stage: after 0.7
      // gain staging, typical program peaks land under −3dB and pass clean;
      // only genuine mic+music pileups get caught.
      limiter.threshold.value = -3
      limiter.knee.value = 3
      limiter.ratio.value = 12
      limiter.attack.value = 0.003
      limiter.release.value = 0.25
      limiter.connect(dest)
      const perSource = audioCtx.createGain()
      perSource.gain.value = 0.7
      perSource.connect(limiter)
      for (const s of inputs.audio) audioCtx.createMediaStreamSource(s).connect(perSource)
    }
    audioTrack = dest.stream.getAudioTracks()[0] ?? null
  }
  await audioCtx.resume()

  const canvasStream = canvas.captureStream(outFps)
  if (audioTrack) canvasStream.addTrack(audioTrack)

  const writable = await blobStore.createWriteStream(blobKey)
  const writer = writable.getWriter()
  let writeChain = Promise.resolve()
  let bytes = 0
  let writeFailed = false

  const mime = pickCompositeMime()
  if (!mime) throw new Error('live composite: no supported mp4 mime')
  const recorder = new MediaRecorder(canvasStream, {
    mimeType: mime,
    videoBitsPerSecond: COMPOSITE_BITS,
    audioBitsPerSecond: 128_000,
  })
  let chunks = 0
  let lastChunkAt = 0
  /** Bytes the recorder has HANDED US, counted synchronously. `bytes` only
   *  moves once the durable write resolves, which is too late to steer the
   *  drain by. */
  let emittedBytes = 0
  recorder.ondataavailable = (e) => {
    if (!e.data.size || writeFailed) return
    chunks++
    emittedBytes += e.data.size
    lastChunkAt = performance.now()
    writeChain = writeChain.then(() =>
      writer.write(e.data).then(
        () => {
          bytes += e.data.size
        },
        () => {
          writeFailed = true
        },
      ),
    )
  }

  const startedAt = performance.now()
  /** performance.now() right after recorder.start() — the fallback origin. */
  let recorderStartedWall: number | null = null
  /** The first paint the recorder could have captured: the file's real t=0. */
  let fileOriginWall: number | null = null
  let lastFrame = startedAt
  let lastDraw = 0
  const gaps: number[] = []
  let aborted = false

  // Frozen-source watch: a dead track keeps readyState >= 2 forever, so
  // drawImage happily repaints its last frame for the rest of the take and the
  // file ends up a still image. The media clock is the only honest signal.
  const liveness: {
    kind: 'screen' | 'camera'
    el: HTMLVideoElement
    /** The source's own video track — its muted flag is the browser's verdict
     * on whether frame silence means frozen or merely static. */
    track: MediaStreamTrack | undefined
    det: SourceLiveness
    /** Frame counter at the last cadence log — see the FPS_LOG_MS block. */
    framesAtLog: number | null
  }[] = []
  const videoTrackOf = (el: HTMLVideoElement): MediaStreamTrack | undefined =>
    el.srcObject instanceof MediaStream ? el.srcObject.getVideoTracks()[0] : undefined
  if (screenEl)
    liveness.push({
      kind: 'screen',
      el: screenEl,
      track: videoTrackOf(screenEl),
      det: new SourceLiveness(),
      framesAtLog: null,
    })
  if (cameraEl)
    liveness.push({
      kind: 'camera',
      el: cameraEl,
      track: videoTrackOf(cameraEl),
      det: new SourceLiveness(),
      framesAtLog: null,
    })
  let lastFpsLog = startedAt

  let drawnFrames = 0
  const draw = (): void => {
    const now = performance.now()
    if (now - lastDraw < 1000 / outFps - 3) return
    // THE FILE'S ZERO IS THE FIRST PAINT THE RECORDER SEES, not the instant it
    // was told to start (P0-instant-sync, refined 2026-08-25). A canvas capture
    // stream produces a frame when the canvas is painted, so between start()
    // and that paint there is up to a frame of nothing — and stamping the file
    // a frame early places every copied packet a frame early, which measured as
    // ~30 ms of extra A/V offset on the instant path and put a v1 oracle run
    // over the band.
    if (recorderStartedWall !== null && fileOriginWall === null) fileOriginWall = now
    lastDraw = now
    drawnFrames++
    gaps.push(now - lastFrame)
    lastFrame = now
    for (const s of liveness) {
      if (s.el.readyState < 2) continue
      // A stalled media clock is only "frozen" when the browser itself says the
      // source is sick (muted/ended) — a static screen is silent and healthy.
      const ev = s.det.sample(
        now,
        s.el.currentTime,
        s.track ? s.track.readyState === 'live' && !s.track.muted : true,
      )
      if (ev) {
        console.warn(`[capture] ${s.kind} source ${ev}`)
        options.onSourceLiveness?.(s.kind, ev)
      }
    }
    // Cadence evidence, console only — deliberately NOT a warning: a static
    // screen legitimately delivers ~1 keep-alive fps, so low cadence alone
    // can't be judged here. Full freezes are the detector's job above; this
    // is what turns the next "it stutters" report into a number.
    if (now - lastFpsLog >= FPS_LOG_MS) {
      const windowSec = (now - lastFpsLog) / 1000
      lastFpsLog = now
      for (const s of liveness) {
        const frames = deliveredFrames(s.el)
        if (frames === null) continue
        const prev = s.framesAtLog
        s.framesAtLog = frames
        if (prev === null) continue
        console.info(
          `[capture] ${s.kind} ${s.el.videoWidth}×${s.el.videoHeight} ` +
            `delivering ${((frames - prev) / windowSec).toFixed(1)} fps`,
        )
      }
    }
    // Watchdog: median frame gap over the warmup window decides viability.
    if (!aborted && now - startedAt > WATCHDOG_AFTER_MS && gaps.length > 30) {
      const sorted = [...gaps].sort((a, b) => a - b)
      if (sorted[Math.floor(sorted.length / 2)] > WATCHDOG_MAX_GAP_P50_MS) {
        aborted = true
        console.warn('[capture] live composite aborted: compositor cannot keep pace')
        void teardown(true)
        return
      }
      gaps.length = 0
    }
    ctx.fillStyle = '#0a0a0c'
    ctx.fillRect(0, 0, outW, outH)
    if (screenEl && screenEl.readyState >= 2) {
      drawContain(ctx, screenEl, outW, outH)
      if (cameraEl && cameraEl.readyState >= 2) drawPip(ctx, cameraEl, outW, outH)
    } else if (cameraEl && cameraEl.readyState >= 2) {
      drawCover(ctx, cameraEl, outW, outH)
    }
  }
  const ticker = new AudioWorkletNode(audioCtx, 'inout-composite-tick', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  })
  ticker.connect(audioCtx.destination)
  ticker.port.onmessage = () => {
    if (!torndown && !aborted) draw()
  }
  recorder.start(CHUNK_MS)
  /**
   * THE FILE'S OWN ZERO (P0-instant-sync). Everything above this line —
   * elements, canvas, audio graph, durable write stream — is time the take had
   * already been running, so `startedAt` is not the file's zero and using it as
   * one made the composite's declared duration include the setup.
   *
   * The recorder's first SAMPLE, though, is the first frame the canvas stream
   * hands it, which is the first PAINT at or after this point: `draw()` fills
   * fileOriginWall in, and this stamp is only the fallback for a take that
   * somehow stops before painting once.
   */
  recorderStartedWall = performance.now()

  const stats: LiveCompositeStats = {
    drawnFrames: 0,
    lastDrawMs: 0,
    chunks: 0,
    bytes: 0,
    lastChunkMs: 0,
    drainMs: 0,
    drainedBytes: 0,
    drainTimedOut: false,
  }

  /**
   * Painting has stopped; let the encoder catch up before asking it to stop.
   * Resolves as soon as the chunk flow goes quiet, and never later than the
   * budget. `drainTimedOut` is the honest signal that the file is short.
   */
  const drainEncoder = async (): Promise<void> => {
    if (recorder.state !== 'recording') return
    const t0 = performance.now()
    const bytesAtStart = emittedBytes
    let idle = 0
    while (performance.now() - t0 < DRAIN_BUDGET_MS) {
      const before = emittedBytes
      try {
        recorder.requestData()
      } catch {
        break
      }
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS))
      if (emittedBytes === before) {
        if (++idle >= DRAIN_IDLE_PROBES) break
      } else {
        idle = 0
      }
    }
    // Still producing when the budget ran out ⇒ the encoder never caught up and
    // the end of this take is not in the file. Say so; do not ship it silently.
    stats.drainTimedOut = idle < DRAIN_IDLE_PROBES
    stats.drainMs = Math.round(performance.now() - t0)
    stats.drainedBytes = emittedBytes - bytesAtStart
  }

  const teardown = async (discard: boolean): Promise<void> => {
    if (torndown) return
    torndown = true
    try {
      ticker.port.onmessage = null
      ticker.disconnect()
    } catch {
      /* already gone */
    }
    // Stop painting FIRST, then drain: every frame painted after this point is
    // a frame the encoder has to get through before it can reach the ones the
    // user actually wants at the end of their take. Discarding takes never
    // wait — there is nothing to save.
    if (!discard) await drainEncoder()
    if (recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
        try {
          recorder.requestData()
          recorder.stop()
        } catch {
          resolve()
        }
      })
    }
    await writeChain
    try {
      await writer.close()
    } catch {
      /* already failed */
    }
    for (const el of [screenEl, cameraEl]) if (el) el.srcObject = null
    if (audioCtx.state !== 'closed') await audioCtx.close().catch(() => undefined)
    if (discard) await blobStore.remove(blobKey).catch(() => undefined)
  }

  const snapshotStats = (): LiveCompositeStats => {
    stats.drawnFrames = drawnFrames
    stats.lastDrawMs = Math.round(lastDraw ? lastDraw - startedAt : 0)
    stats.chunks = chunks
    stats.bytes = bytes
    stats.lastChunkMs = Math.round(lastChunkAt ? lastChunkAt - startedAt : 0)
    return stats
  }

  return {
    async stop() {
      // Measured from the file's own zero, not from before the recorder
      // existed: the difference is setup time that was never in the file.
      const origin = fileOriginWall ?? recorderStartedWall ?? startedAt
      const durationMs = performance.now() - origin
      if (aborted) return null
      await teardown(false)
      snapshotStats()
      // One line, always: this is how a short tail becomes loud instead of
      // silent. drainTimedOut means the encoder was still behind when we ran
      // out of patience, i.e. the end of this take did not make it into the file.
      const level = stats.drainTimedOut ? console.warn : console.info
      level(
        `[capture] composite drained in ${stats.drainMs}ms (+${stats.drainedBytes} B)` +
          `${stats.drainTimedOut ? ' — TIMED OUT, the end of this take is missing' : ''} · ` +
          `${stats.drawnFrames} frames painted, ${stats.chunks} chunks, ${stats.bytes} B`,
      )
      if (writeFailed || bytes === 0) {
        await blobStore.remove(blobKey).catch(() => undefined)
        return null
      }
      const composite: CompositeRecording = {
        blobKey,
        engine: 'v1',
        mimeType: recorder.mimeType || mime,
        durationMs: Math.round(durationMs),
        width: outW,
        height: outH,
        // F15: what `captureStream` was asked for, which is the ceiling this
        // file's frames were produced under.
        fps: outFps,
        bytes,
        tailIncomplete: stats.drainTimedOut || undefined,
      }
      if (options.epochMs !== undefined) {
        const offset = Math.round(origin - options.epochMs)
        composite.startOffsetMs = offset
        console.info(`[capture] composite v1 clock starts +${offset}ms into the take`)
      }
      return composite
    },
    async cancel() {
      aborted = true
      await teardown(true)
      snapshotStats()
    },
    stats: snapshotStats,
  }
}
