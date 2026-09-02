/**
 * One RAW video channel, encoded off the main thread (task X6).
 *
 * WHAT THIS REPLACES, and why the replacement is not the one the branch tried.
 * A raw screen or camera channel is recorded today by MediaRecorder into
 * VP8/VP9, which Chromium encodes IN SOFTWARE — the largest single CPU cost of
 * a take (O3a), paid twice, while the live composite beside it encodes AVC in
 * hardware. O3a refused to fix this with MediaRecorder's MP4 because Chrome
 * does not STREAM MP4: a tab killed halfway through an 8 s take left 753 bytes
 * on disk against 1.09 MB of decodable webm, which trades crash salvage for
 * CPU. That objection is answered by the pattern v2 already ships and this file
 * copies: WebCodecs → fragmented MP4 → the worker's OWN SyncAccessHandle, every
 * chunk written and flushed where the muxer says it goes, so the bytes on disk
 * are complete up to the last write at every instant.
 *
 * THE ABANDONED BRANCH (ee/webcodecs-capture-2) IS NOT THE STARTING POINT, and
 * its own header says why it should not be: it sampled a paced <video> element
 * on the MAIN THREAD into an OffscreenCanvas because "waiting on VideoEncoder
 * stalls the [track] processor". That stall was the same instrument fault note 6
 * records — a fresh process's first VideoEncoder pays a multi-second init, per
 * launch — and O4 solved it by warming the encoder at mount. So this takes v2's
 * shape instead: frames arrive already decoded, and nothing touches the DOM.
 *
 * FRAMES ARRIVE FROM THE MAIN THREAD, one postMessage each, exactly as the
 * compositor's do. Transferring the whole MediaStreamTrackProcessor readable
 * into the worker was the obvious alternative and is rejected on purpose: the
 * arrival stamp a channel's startOffsetMs is built from would then be taken on
 * the WORKER's clock, and a worker's performance.timeOrigin is not guaranteed to
 * be the document's. Every sync number this project owns was expensive; none of
 * them is worth a clock calibration nobody asked for.
 */
import { evenDown } from '@core/frame'
import {
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny'

const ROOT_DIR = 'blobs'
/**
 * Keyframe cadence. NOT the render's 5 s (O11b): a raw channel is what recovery
 * salvages from a killed tab and what the render seeks into, and a 5 s GOP makes
 * both coarser. 2 s is what the composite uses for the same reason.
 */
const KEYFRAME_INTERVAL_S = 2
/** Frames allowed in flight before this channel drops rather than queues. */
const MAX_ENCODER_QUEUE = 6
/**
 * A STATIC SOURCE DELIVERS NOTHING, AND THAT IS THE WHOLE REASON THIS EXISTS.
 * MediaStreamTrackProcessor is frame-driven: a screen that is not changing
 * produces no frames at all, so a pipeline that only encodes what arrives
 * records a file with two frames in it. MediaRecorder never had this problem —
 * it encodes at its own cadence whatever the source does — and the live
 * composite already carries the same fix for the same reason.
 * FOUND ON THE DEPLOYED BUILD, not in the rig: the rig's synthetic source is
 * ANIMATED and never went quiet, so it encoded 447 frames of 447 and looked
 * perfect. A real static screen — a slide, a document, a paused UI — is the
 * common case and it recorded 2 frames in 9 seconds.
 */
const KEEPALIVE_MS = 1000

/** FileSystemSyncAccessHandle is missing from the project's TS lib set. */
interface SyncAccessHandle {
  write(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number
  flush(): void
  close(): void
  truncate?(size: number): void
}

export interface RawVideoStartMsg {
  cmd: 'start'
  key: string
  width: number
  height: number
  fps: number
  videoBitrate: number
  /**
   * H1 HARNESS (`?killenc=`). Milliseconds from now until this encoder is made
   * to report failure through the very callback a real one uses. Absent on
   * every take nobody typed the flag into, which is every take.
   */
  killEncoderInMs?: number
  /**
   * H1 HARNESS (`?killworker=`). Milliseconds until this worker dies: it stops
   * encoding and then throws where nothing can catch it, which is the one thing
   * that reaches `worker.onerror` on the main thread. A DIFFERENT entry point
   * from killEncoderInMs, and H1's two gates are exactly those two entry points.
   */
  killWorkerInMs?: number
}

export interface RawVideoFrameMsg {
  cmd: 'frame'
  /** performance.now() on the MAIN thread when this frame was read. */
  atMs: number
  frame: VideoFrame
}

export type RawVideoMsg =
  | RawVideoStartMsg
  | RawVideoFrameMsg
  /** `atMs` is the MAIN thread's instant of the stop, which ends the channel. */
  | { cmd: 'stop'; atMs: number }
  | { cmd: 'cancel' }

export interface RawVideoStats {
  framesIn: number
  framesEncoded: number
  framesDropped: number
  /** Frames re-encoded because the source went quiet (a static screen). */
  keepAliveFrames: number
  keyframeCount: number
  bytes: number
  videoBytes: number
  codec: string
  hardware: string
  writeCalls: number
  flushes: number
  /**
   * THE GEOMETRY THIS CHANNEL WAS ACTUALLY ENCODED AT (F13). The start message
   * carries `track.getSettings()`, which reports the SENSOR on a phone held
   * portrait — landscape — while the frames delivered are rotated to portrait.
   * The first frame corrects it here, and the session writes THIS into
   * ChannelRecording so the single-generation copy and the editor are matching
   * the file rather than the settings.
   */
  outWidth: number
  outHeight: number
}

export type RawVideoReply =
  | { ok: true; cmd: 'start'; codec: string; hardware: string }
  | {
      ok: true
      cmd: 'stop'
      bytes: number
      durationMs: number
      /** Main-thread performance.now() of the first frame that was encoded. */
      firstFrameAtMs: number | null
      stats: RawVideoStats
    }
  | { ok: true; cmd: 'cancel' }
  | { ok: false; cmd: string; error: string }
  | { event: 'fatal'; error: string }

/**
 * AVC PROFILE/LEVEL CANDIDATES, IN ASCENDING CAPACITY.
 *
 * A LEVEL IS A FRAME-SIZE LIMIT, and Chrome enforces it: `isConfigSupported`
 * REFUSES a frame the level cannot hold rather than clamping it. The old list
 * stopped at 4.2 (8704 macroblocks, i.e. about 1920x1088), which was invisible
 * for as long as capture was pinned to 1080p — and became a lost channel the
 * morning native-res capture went default, because the raw channel is now
 * configured at the MONITOR's own size. Reproduced on prod:
 * `?synthetic=1&screensize=2560x1441` returns `no supported AVC VideoEncoder
 * config` and the take comes back "Missing from this take: Screen", with the
 * preview having shown the screen throughout. Every display bigger than 1080p
 * was in that hole: 1440p is 14400 macroblocks and 4K is 32400.
 *
 * 5.0 (22080 MB) covers 1440p, 5.1/5.2 (36864 MB) cover 4K, 6.0 covers what
 * comes after. APPENDED, never reordered: the loop returns the first supported
 * config, so every frame that already had one keeps exactly the encoder it had
 * — a 1080p take is untouched, which is the whole safety net.
 */
const CODEC_CANDIDATES = [
  'avc1.42E01E',
  'avc1.4D402A',
  'avc1.640028',
  'avc1.640032',
  'avc1.640033',
  'avc1.640034',
  'avc1.640040',
] as const

async function pickVideoConfig(
  requestedWidth: number,
  requestedHeight: number,
  bitrate: number,
  framerate: number,
): Promise<{ config: VideoEncoderConfig; hardware: string }> {
  // AN ODD SIDE IS NOT A SIZE AVC CAN ENCODE, AND THIS IS THE LAST PLACE THAT
  // CAN KNOW IT. The 2026-08-29 odd-side fix evened the TRACK in
  // capDisplayTrack, on the reasoning that every consumer then sees an
  // encodable frame. Chrome does not always agree to be constrained: asked for
  // 2560x1662 it returned 2559x1662 — it re-derived the width from the aspect
  // and handed back an ODD one. Every AVC candidate is then unsupported, this
  // function threw, and the whole raw channel fell back to MediaRecorder's
  // SOFTWARE VP8/VP9 at 2559x1662@60. That is what froze Robert's machine on
  // 2026-08-30, and the console said only "measured video unavailable".
  //
  // Measured in Chrome 151 before this line was written: 2559x1662 AVC is
  // unsupported and 2558x1662 is supported, and an encoder configured at 2558
  // ACCEPTS a 2559-wide VideoFrame and emits a chunk with no error. So evening
  // DOWN here costs one pixel column and keeps the hardware path; not evening
  // costs the hardware path entirely. `stopRecorders` already corrects
  // ChannelRecording.width from the file's own geometry, so the take still
  // reports what was actually written.
  const width = evenDown(requestedWidth)
  const height = evenDown(requestedHeight)
  if (width !== requestedWidth || height !== requestedHeight) {
    console.info(
      `[capture] raw video: ${requestedWidth}x${requestedHeight} has an odd side, which AVC cannot ` +
        `encode — configuring ${width}x${height} and letting the encoder crop, rather than falling ` +
        `back to a software encoder`,
    )
  }
  // Hardware first — replacing a SOFTWARE encode is the whole point of the
  // task. Software is still an honest fallback rather than a failure: even
  // then this path buys streamed MP4 and keyframe control.
  for (const hardwareAcceleration of [
    'prefer-hardware',
    'no-preference',
    'prefer-software',
  ] as const) {
    for (const codec of CODEC_CANDIDATES) {
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate,
        framerate,
        // 'quality', NOT 'realtime', AND IT IS FASTER — which is the opposite
        // of what the names suggest and is why this was never tried.
        //
        // A RAW CHANNEL FEEDS NOTHING LIVE. It is a file writer: no preview
        // renders from it, no peer waits on it, and nothing downstream cares
        // how many milliseconds an individual frame spends inside the encoder.
        // `realtime` buys low latency by constraining the encoder, and here it
        // was buying nothing and charging throughput for it.
        //
        // Measured on Robert's machine at 3024x1964, interleaved so load drift
        // hits both equally (2026-08-30):
        //     avc  quality   446, 456 Mpx/s   319 KB
        //     avc  realtime  404      Mpx/s   319 KB
        //     hevc quality   412, 416 Mpx/s   294 KB
        // Same bytes, same picture, ~13 % more throughput — and 3024x1964@60
        // needs 356 Mpx/s, so this is a real part of the margin that decides
        // whether max works. Frame order was checked, not assumed: zero
        // out-of-order chunks across every run, so the packet-copy paths and
        // the smart cut see exactly what they saw before.
        latencyMode: 'quality',
        hardwareAcceleration,
        avc: { format: 'avc' },
      }
      let support: VideoEncoderSupport
      try {
        support = await VideoEncoder.isConfigSupported(config)
      } catch {
        continue
      }
      if (support.supported) {
        return {
          config: { ...config, ...(support.config ?? {}), width, height, codec },
          hardware: hardwareAcceleration,
        }
      }
    }
  }
  throw new Error('rawVideo: no supported AVC VideoEncoder config')
}

let handle: SyncAccessHandle | null = null
let output: Output | null = null
let videoSource: EncodedVideoPacketSource | null = null
let encoder: VideoEncoder | null = null
let muxChain: Promise<void> = Promise.resolve()
let fatal: string | null = null
let stopped = false
let W = 1920
let H = 1080
let videoBitrate = 8_000_000
let fps = 30
/** F13: has the first frame been allowed to correct W/H yet? */
let shapeSettled = false
/**
 * F13: the encoder is being reconfigured to the shape the first frame asked
 * for, and NOTHING may be encoded until it is. Getting this wrong is not a
 * subtle cost — the reconfigure is async (it probes the config), so frames
 * encoded meanwhile go in at the OLD geometry and the file ends up carrying two
 * of them. Reproduced on prod with `?camlies=1`: the channel came back
 * `EncodingError: Decoding error` and the editor stage was black.
 */
let encoderPending = false

/** Main-thread stamp of the first frame that reached the encoder. */
let firstFrameAtMs: number | null = null
let lastKeySec = -Infinity
/** Last timestamp handed to the encoder (µs) — the timeline never goes back. */
let lastEncodedTsUs = -1
/** Main-thread reading when a frame last actually reached the encoder. */
let lastEncodeOkMs = -Infinity
/** The most recent picture, kept alive so a quiet source can be re-encoded. */
let lastFrame: VideoFrame | null = null
let keepAliveTimer: ReturnType<typeof setInterval> | null = null

/**
 * The main thread owns the clock (every frame message carries its reading), but
 * the keep-alive fires HERE, so the worker has to express its own now() on the
 * main thread's timeline. Min-filtered because message delivery can only make
 * this worker's reading late, never early — the same construction the
 * compositor uses.
 */
let originOffset = 0
let originSamples = 0

function noteOrigin(mainMs: number): void {
  const delta = performance.now() - mainMs
  if (originSamples === 0 || delta < originOffset) originOffset = delta
  originSamples++
}

function nowOnMainClock(): number {
  return performance.now() - originOffset
}

const stats: RawVideoStats = {
  framesIn: 0,
  framesEncoded: 0,
  framesDropped: 0,
  keepAliveFrames: 0,
  keyframeCount: 0,
  bytes: 0,
  videoBytes: 0,
  codec: '',
  hardware: '',
  outWidth: 0,
  outHeight: 0,
  writeCalls: 0,
  flushes: 0,
}

function fail(err: unknown): void {
  if (fatal) return
  fatal = err instanceof Error ? err.message : String(err)
  post({ event: 'fatal', error: fatal })
}

function post(reply: RawVideoReply): void {
  ;(self as unknown as { postMessage: (m: unknown) => void }).postMessage(reply)
}

self.onmessage = (ev: MessageEvent<RawVideoMsg>): void => {
  const msg = ev.data
  switch (msg.cmd) {
    case 'start':
      void start(msg).then(
        () => post({ ok: true, cmd: 'start', codec: stats.codec, hardware: stats.hardware }),
        (err) => post({ ok: false, cmd: 'start', error: String(err) }),
      )
      return
    case 'frame':
      onFrame(msg)
      return
    case 'stop':
      void stop(msg.atMs).then(
        (r) => post(r),
        (err) => post({ ok: false, cmd: 'stop', error: String(err) }),
      )
      return
    case 'cancel':
      void cancel().then(
        () => post({ ok: true, cmd: 'cancel' }),
        (err) => post({ ok: false, cmd: 'cancel', error: String(err) }),
      )
      return
  }
}

async function start(msg: RawVideoStartMsg): Promise<void> {
  W = msg.width
  H = msg.height
  videoBitrate = msg.videoBitrate
  fps = msg.fps
  stats.outWidth = W
  stats.outHeight = H

  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(ROOT_DIR, { create: true })
  const file = await dir.getFileHandle(msg.key, { create: true })
  handle = await (
    file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> }
  ).createSyncAccessHandle()
  handle.truncate?.(0)

  const { config, hardware } = await pickVideoConfig(W, H, msg.videoBitrate, msg.fps)
  stats.codec = config.codec
  stats.hardware = hardware

  // Per-chunk write AND flush, exactly as the compositor does and for the same
  // reason: it is what makes a tab kill leave a decodable prefix rather than a
  // header. O3a rejected MP4 capture because MediaRecorder cannot do this.
  const sink = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      const h = handle
      if (!h) return
      const written = h.write(chunk.data, { at: chunk.position })
      h.flush()
      stats.writeCalls++
      stats.flushes++
      stats.bytes = Math.max(stats.bytes, chunk.position + written)
    },
  })

  output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
    target: new StreamTarget(sink),
  })
  videoSource = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(videoSource, { frameRate: msg.fps })
  await output.start()

  encoder = new VideoEncoder({
    output: (chunk, meta) => {
      stats.framesEncoded++
      stats.videoBytes += chunk.byteLength
      if (chunk.type === 'key') stats.keyframeCount++
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      muxChain = muxChain
        .then(async () => {
          await videoSource?.add(packet, meta)
        })
        .catch(fail)
    },
    error: fail,
  })
  encoder.configure(config)

  armInducedFaults(msg)

  keepAliveTimer = setInterval(() => {
    if (stopped || fatal || encoderPending || !lastFrame || firstFrameAtMs === null) return
    const nowMain = nowOnMainClock()
    // Against the last frame that actually REACHED the encoder, not the last
    // that arrived: a busy encoder would otherwise suppress the keep-alive it
    // exists to trigger (the compositor learned this one first).
    if (nowMain - lastEncodeOkMs >= KEEPALIVE_MS) encodeAt(lastFrame, nowMain, true)
  }, KEEPALIVE_MS / 2)
}

/**
 * Encode one picture at a main-thread instant. The channel's timeline is built
 * from ARRIVAL stamps rather than source timestamps, for two reasons that are
 * really one: startOffsetMs is already an arrival quantity, so the file's t=0
 * and its placement on the session timeline come from the same clock; and a
 * keep-alive frame has no source timestamp of its own to use.
 */
/** Encode calls made, counted HERE and not in the output callback — see the
 *  keyframe test below for what reading the async counter cost. */
let encodeCalls = 0

function encodeAt(picture: VideoFrame, atMs: number, keepAlive: boolean): void {
  if (fatal || stopped || !encoder) return
  if (firstFrameAtMs === null) firstFrameAtMs = atMs
  const tUs = Math.max(0, Math.round((atMs - firstFrameAtMs) * 1000))
  // Never backwards: a late-delivered frame or a keep-alive racing a real one
  // would otherwise hand the muxer a non-monotonic timeline.
  if (tUs <= lastEncodedTsUs) return
  const tSec = tUs / 1e6
  // THE FIRST-FRAME TEST COUNTS ENCODE CALLS, NOT OUTPUTS, and reading the
  // wrong one was a vicious cycle at the worst possible moment.
  //
  // `stats.framesEncoded` is incremented in the encoder's OUTPUT callback —
  // asynchronously, after a chunk comes back. A cold encoder produces nothing
  // for seconds (note 6: a Chrome process's first VideoEncoder pays a
  // multi-second init), so for that entire window every frame read
  // `framesEncoded === 0` and was requested as a KEYFRAME. A keyframe costs
  // many times a delta frame, so the encoder fell further behind, which kept
  // the output at zero, which kept forcing keyframes.
  //
  // Robert's 3024x1964 take, 2026-08-30, has it in one line: the raw channel
  // encoded "13 frames of 133 in … 13 keyframes" — every frame that got out was
  // a keyframe — while the COMPOSITE in the very same take, whose cadence has
  // never had this term, encoded 6 frames with 1 keyframe. Same machine, same
  // second, one correct and one not.
  const keyFrame = encodeCalls === 0 || tSec - lastKeySec >= KEYFRAME_INTERVAL_S
  let stamped: VideoFrame | null = null
  try {
    stamped = new VideoFrame(picture, { timestamp: tUs })
    encoder.encode(stamped, { keyFrame })
    encodeCalls++
    if (keyFrame) lastKeySec = tSec
    lastEncodedTsUs = tUs
    lastEncodeOkMs = atMs
    if (keepAlive) stats.keepAliveFrames++
  } catch (err) {
    fail(err)
  } finally {
    stamped?.close()
  }
}

/**
 * F13 — ENCODE THE PICTURE THAT ARRIVED, AT ITS OWN SIZE.
 *
 * `track.getSettings()` is what the encoder was configured from, and on a phone
 * held portrait it reports the sensor's landscape dimensions while the frames
 * are rotated to portrait. An encoder configured 1920x1080 fed 1080x1920 frames
 * does not refuse — it rescales — so the raw channel came out squashed, and
 * every consumer that trusts `ChannelRecording.width/height` (the
 * single-generation copy, the editor's PiP) inherited the same lie.
 *
 * Runs once, before anything is encoded (the keep-alive cannot fire before the
 * first frame either), so the file never changes dimensions part-way. A no-op
 * wherever the settings and the frames agree, which is every desktop take this
 * product has ever made.
 */
function adoptFrameSize(frame: VideoFrame): void {
  shapeSettled = true
  const w = frame.displayWidth
  const h = frame.displayHeight
  if (!w || !h || (w === W && h === H)) return
  if (stats.framesEncoded > 0) return
  console.info(
    `[capture] raw channel: the frames are ${w}x${h}, not the ${W}x${H} the track reported — encoding ${w}x${h} (F13)`,
  )
  W = w
  H = h
  stats.outWidth = W
  stats.outHeight = H
  encoderPending = true
  void (async () => {
    const enc = encoder
    try {
      if (!enc || stopped || fatal) return
      const { config, hardware } = await pickVideoConfig(W, H, videoBitrate, fps)
      if (!encoder || stopped || fatal || enc.state === 'closed') return
      enc.configure(config)
      stats.codec = config.codec
      stats.hardware = hardware
    } catch (err) {
      fail(err)
    } finally {
      encoderPending = false
    }
  })()
}

/**
 * H1 harness. Nothing here runs unless a URL flag put a number in the start
 * message, and the session only ever puts one there for the kind that was
 * named. Both timers are one-shot and neither is cleared on stop: a take that
 * ends before its kill instant is a take whose worker is already terminated.
 */
function armInducedFaults(msg: RawVideoStartMsg): void {
  if (msg.killEncoderInMs !== undefined && msg.killEncoderInMs > 0) {
    setTimeout(() => {
      if (stopped || fatal) return
      // The exact path `new VideoEncoder({ error: fail })` takes, and the one a
      // muxer write that throws lands on: `fail` posts {event:'fatal'} and every
      // later frame is dropped at the top of onFrame.
      fail(new Error('induced encoder error (?killenc)'))
    }, msg.killEncoderInMs)
  }
  if (msg.killWorkerInMs !== undefined && msg.killWorkerInMs > 0) {
    setTimeout(() => {
      if (stopped) return
      // Stop producing FIRST, so the file really does end here — a worker death
      // that only reported itself would be testing the message and not the
      // containment. `fatal` is set directly rather than through fail(), which
      // would post {event:'fatal'} and make this the OTHER gate.
      fatal = 'induced worker death (?killworker)'
      // Uncaught, on the worker's own turn of the event loop: the only thing
      // that fires `worker.onerror` on the main thread.
      throw new Error('induced worker death (?killworker)')
    }, msg.killWorkerInMs)
  }
}

function onFrame(msg: RawVideoFrameMsg): void {
  const frame = msg.frame
  stats.framesIn++
  noteOrigin(msg.atMs)
  if (fatal || stopped || !encoder) {
    frame.close()
    return
  }
  if (!shapeSettled) adoptFrameSize(frame)
  // The channel's t=0. Its LENGTH comes from the stop instant instead (see
  // stop()): a static source delivers one frame, so the span of arrivals is not
  // the span of the channel.
  if (firstFrameAtMs === null) firstFrameAtMs = msg.atMs
  // Keep the picture so a source that goes quiet can still be encoded.
  try {
    lastFrame?.close()
    lastFrame = frame.clone()
  } catch {
    /* a frame that cannot be cloned simply has no keep-alive behind it */
  }
  // F13: the encoder is mid-reconfigure. These few milliseconds of frames are
  // NOT encoded — one of them at the old geometry is a second SPS in the file
  // and the whole channel stops decoding. `lastFrame` is already kept above, so
  // the keep-alive puts the picture in as soon as the encoder is ready.
  if (encoderPending) {
    frame.close()
    return
  }
  // DROP, NEVER QUEUE. A queue that grows without bound turns a slow encoder
  // into unbounded memory and a take that ends minutes after the press; the
  // composite makes the same choice for the same reason.
  if (encoder.encodeQueueSize > MAX_ENCODER_QUEUE) {
    stats.framesDropped++
    frame.close()
    return
  }
  try {
    encodeAt(frame, msg.atMs, false)
  } finally {
    frame.close()
  }
}

async function stop(atMs: number): Promise<Extract<RawVideoReply, { cmd: 'stop' }>> {
  if (keepAliveTimer) clearInterval(keepAliveTimer)
  keepAliveTimer = null
  // ONE LAST KEEP-ALIVE AT THE STOP INSTANT, before anything is torn down.
  // A channel's LENGTH is how long it was live, not how long frames happened
  // to arrive — a static screen delivers ONE frame and would otherwise declare
  // a duration of 0 and vanish from the timeline (found on the deployed build:
  // "13 frames encoded of 1 in" with durationMs 0, and the editor opened the
  // take as audio-only). Emitting here also means the file actually COVERS the
  // length it declares, so the tail band measures a real thing.
  if (lastFrame && firstFrameAtMs !== null) encodeAt(lastFrame, atMs, true)
  stopped = true
  lastFrame?.close()
  lastFrame = null
  try {
    // THE DRAIN THIS PATH GETS FOR FREE, and it is the reason X6 is worth
    // doing beyond CPU. The MediaRecorder path could not be asked to finish:
    // P0-tail-raw had to STARVE the source to 1 fps and then probe, because
    // ending the track makes Chrome stop the recorder and discard its backlog.
    // Here the encoder is ours and flush() means flush.
    if (encoder && encoder.state === 'configured') await encoder.flush()
    await muxChain
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.finalize()
    }
  } catch (err) {
    fail(err)
  }
  try {
    encoder?.close()
  } catch {
    /* already closed */
  }
  encoder = null
  // The live span, from the first frame to the stop — see the keep-alive above.
  const durationMs = firstFrameAtMs !== null ? Math.max(0, atMs - firstFrameAtMs) : 0
  const bytes = stats.bytes
  try {
    handle?.flush()
    handle?.close()
  } catch {
    /* handle already gone */
  }
  handle = null
  return {
    ok: true,
    cmd: 'stop',
    bytes,
    durationMs,
    firstFrameAtMs,
    stats: { ...stats },
  }
}

async function cancel(): Promise<void> {
  stopped = true
  if (keepAliveTimer) clearInterval(keepAliveTimer)
  keepAliveTimer = null
  lastFrame?.close()
  lastFrame = null
  try {
    encoder?.close()
  } catch {
    /* already closed */
  }
  encoder = null
  try {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel()
    }
  } catch {
    /* nothing to cancel */
  }
  try {
    handle?.close()
  } catch {
    /* already closed */
  }
  handle = null
}
