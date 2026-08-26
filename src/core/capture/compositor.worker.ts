/**
 * O4 step 2 — the live composite, off the main thread.
 *
 * v1 (liveComposite.ts) paid for every composited frame four times: the source
 * was decoded into a <video>, the compositor read that element with drawImage
 * on the MAIN thread, canvas.captureStream re-encoded the canvas, and the
 * on-screen preview decoded the same source a second time. It also redrew on a
 * fixed 30 Hz tick whether or not anything had changed, and it had no keyframe
 * control and no way to drain the encoder at stop.
 *
 * This worker takes VideoFrames straight off MediaStreamTrackProcessor (no
 * <video>, no decode), composites them on an OffscreenCanvas, encodes with
 * VideoEncoder (hardware where the platform offers it), muxes fragmented MP4,
 * and writes it through its OWN SyncAccessHandle — so bytes land on disk as
 * they are produced and a tab kill leaves a playable prefix rather than
 * nothing. Drawing is FRAME-DRIVEN: a static screen costs one keep-alive frame
 * per second instead of thirty identical ones.
 *
 * Two deliberate non-goals, both recorded so they are decisions and not gaps:
 *   · The compositor is 2D, not WebGPU. WebGPU's importExternalTexture would
 *     save a copy per frame, but the cost this task set out to remove was the
 *     main thread and the redundant decodes, and both are gone without it.
 *     Adding a third rendering backend before that claim is measured would be
 *     building on an unproven premise.
 *   · The audio is MIXED ON THE MAIN THREAD and arrives here as PCM. The mix
 *     graph (gain staging + the limiter that only engages on genuine pileups)
 *     is tuned and shipped; re-implementing it here would risk audible change
 *     for no benefit, because WebAudio cannot run in a worker anyway.
 */

import {
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny'
import { createGLCompositor, type GLCompositor } from './compositorGL'

const ROOT_DIR = 'blobs'
/** Keyframe cadence — the smart-cut prerequisite (O5) and the salvage anchor. */
const KEYFRAME_INTERVAL_S = 2
/** Beyond this the encoder is behind; drop rather than queue (a queued frame
 * is latency the user pays for at stop). */
const MAX_ENCODER_QUEUE = 6
/** A static composition still needs a frame occasionally or the timeline
 * stalls and players show nothing between events. */
const KEEPALIVE_MS = 1000
/**
 * A GPU barrier after the draw, so that paint timing measures the GPU rather
 * than the enqueue. OFF by default — the barrier itself serialises the pipeline,
 * so it is an instrument, not a setting. Measured with it on, 2026-08-23: 2.05
 * and 2.84 ms of real GPU per composited frame at 1080p, which is not the wall.
 */
const PROBE_GPU = false

interface SyncAccessHandle {
  write(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number
  flush(): void
  close(): void
  getSize(): number
  truncate?(size: number): void
}

export interface CompositorStartMsg {
  cmd: 'start'
  key: string
  width: number
  height: number
  fps: number
  videoBitrate: number
  audioBitrate: number
  /** Present when the take has any audio channel. */
  sampleRate: number | null
  channelCount: number
}

export interface CompositorFrameMsg {
  cmd: 'frame'
  kind: 'screen' | 'camera'
  /** Main-thread wall clock at the moment the frame was read, ms since epoch
   * start. ONE clock for the whole composite — a worker's performance.now()
   * has a different time origin, so timestamps are never computed here. */
  atMs: number
  frame: VideoFrame
}

export interface CompositorAudioMsg {
  cmd: 'audio'
  /** Interleaved-by-plane Float32 (channel-major), as the PCM worklet emits. */
  planar: Float32Array
  frames: number
  channels: number
  /** Wall clock of the FIRST sample of this batch, ms since epoch start. */
  atMs: number
  /**
   * performance.now() when the MAIN THREAD received this batch. Deliberately
   * NOT derived from the audio clock like `atMs` is: this is the only stamp in
   * the message that keeps time when the audio graph does not, which is what
   * lets the timeline notice it has fallen behind (see the padding below).
   */
  recvMs: number
}

/**
 * O4-polish: the recording preview stops decoding the sources a SECOND time.
 *
 * The composite is already being painted here, once, from frames that never
 * touch a <video> element. The preview used to re-decode both sources into two
 * <video> tags on the main thread and re-create the composition in CSS — the
 * last redundant decodes in the capture path. The main thread hands over a
 * canvas instead (transferControlToOffscreen, so this worker owns it) and the
 * composite is blitted into it right after each encode.
 */
export interface CompositorPreviewMsg {
  cmd: 'preview'
  canvas: OffscreenCanvas
}

export type CompositorMsg =
  | CompositorStartMsg
  | CompositorFrameMsg
  | CompositorAudioMsg
  | CompositorPreviewMsg
  | { cmd: 'stop' }
  | { cmd: 'cancel' }

export interface CompositorStats {
  framesIn: number
  framesEncoded: number
  framesDropped: number
  keepAliveFrames: number
  bytes: number
  durationMs: number
  audioFrames: number
  /**
   * Sample frames that reached this worker and were NEVER encoded, split by
   * why. A short audio track desyncs the whole take — audio is sample-counted
   * while video is wall-stamped, so every dropped frame moves the rest of the
   * audio EARLIER against the picture, for the remainder of the take. That
   * used to happen behind a bare `return` with nothing counted (PO 2026-08-25,
   * a take beside a 4K game: "sounds go faster than video"). It is counted now.
   */
  audioDroppedNotReady: number
  audioDroppedLead: number
  /**
   * Silence inserted to hold the audio timeline against the wall clock. >0
   * means the audio graph lost real time and the take would otherwise have
   * drifted by exactly this much.
   */
  audioPaddedFrames: number
  /**
   * Longest stretch with NO frame in the file, ms. This is what a viewer sees
   * as a freeze, so it is measured rather than inferred from drop counts.
   */
  maxEncodeGapMs: number
  /** What the encoder actually negotiated — evidence, not decoration. */
  codec: string | null
  hardware: string | null
  /** Which compositor backend ran — 'webgl2' or the slow '2d' fallback. */
  backend: 'webgl2' | '2d' | null
  /** Largest number of frames the encoder was behind at any point. */
  peakQueue: number
  /**
   * Where the bits actually went (task O11a). Owning the encoder makes this
   * free: every packet is already in hand, so the keyframe share and the
   * achieved-vs-requested bitrate are counted rather than guessed.
   */
  videoBytes: number
  audioBytes: number
  keyframeBytes: number
  keyframeCount: number
  requestedVideoBitrate: number
  /**
   * Where the per-frame time goes, accumulated in ms. The composite was
   * encoder-bound at ~10 fps and the three candidates — compositing, turning
   * the canvas into a VideoFrame, and the encode call itself — are not
   * distinguishable from the outside, so they are timed separately here.
   */
  paintMs: number
  frameMs: number
  encodeMs: number
  /** Durability barriers actually taken — one per FLUSH_INTERVAL_MS of writes. */
  flushes: number
  /**
   * THE PATH NOBODY TIMED (2026-08-23). paint/frame/encode accounted for ~1.4 ms
   * per encoded frame while the engine delivered 7.7 fps, and an isolated
   * VideoEncoder on the same machine does 150-188 fps at 1080p — so the missing
   * time is downstream of the encode CALL, in the mux and the disk barrier that
   * run inside the encoder's own output callback.
   */
  muxMs: number
  writeMs: number
  flushMs: number
  writeCalls: number
  /** Arrivals the CADENCE gate rejected (too soon after the last encode). */
  framesGated: number
  /** Arrivals stamped BEFORE the last encode — i.e. the gate was closed against
   *  frames that were already in the worker's message queue. */
  framesStale: number
  /**
   * WHICH SIDE OF THE THREAD BOUNDARY IS SLOW (2026-08-23). Everything inside
   * this worker has now been cleared by probe: a bare encoder does 169 fps
   * here, and the FULL v2 shape — transferred capture frames, the production GL
   * compositor, the same encoder, the same backpressure — does 59.7 fps with
   * zero drops (`npm run exp -- encprobe`, rows worker:transfer and
   * worker:composite). So the question is no longer "what costs so much" but
   * "is this worker even busy". handlerMs is time spent INSIDE onmessage;
   * idleMs is the wall clock between one message finishing and the next
   * arriving. CAREFUL WITH idleMs: it is "not inside onmessage", which also
   * covers the encoder's own output callbacks and every promise continuation,
   * so it is NOT proof the thread is free. outputMs is what separates them —
   * the synchronous cost of the encoder's output callback, which is where the
   * packet copy, the mux hand-off and the disk barrier all live.
   */
  handlerMs: number
  idleMs: number
  /** Longest single starve — one long main-thread task shows up here. */
  maxIdleMs: number
  /** The config the encoder was ACTUALLY configured with, after
   *  isConfigSupported normalised it. Evidence, not decoration: every probe
   *  that reaches 60 fps builds its own config by hand. */
  configJson: string | null
  /** Encoder latency: encode() call → the matching output callback. */
  encodeLatencyMs: number
  outputs: number
  /** Synchronous time spent INSIDE the encoders' output callbacks. */
  outputMs: number
  /** GPU time behind the draw, measured with a barrier rather than by timing
   *  the JS enqueue (which times nothing). Only accumulated when probing. */
  gpuMs: number
  /**
   * WHERE THIS FILE'S CLOCK STARTS, as a MAIN-THREAD performance.now() stamp
   * (every arrival is stamped there, so this is directly comparable with the
   * session epoch). Timestamp 0 in the composite is this instant — usually the
   * first audio batch, because the mix is already running when the first video
   * frame arrives. The main thread turns it into
   * CompositeRecording.startOffsetMs; without it both packet-copying export
   * paths assume 0 and ship the video early (P0-instant-sync).
   */
  originAtMs: number | null
  /** Time spent blitting the composite into the preview canvas (O4-polish).
   *  Zero when nothing asked for a preview. */
  previewMs: number
}

export type CompositorReply =
  | { ok: true; cmd: 'start' }
  /** Deliberately NOT sent on receipt: the reply waits for the first frame to
   *  actually reach the preview canvas, so the caller can swap away from its
   *  own preview without a blank flash in between. */
  | { ok: true; cmd: 'preview' }
  | { ok: true; cmd: 'stop'; stats: CompositorStats }
  | { ok: true; cmd: 'cancel' }
  | { ok: false; cmd: string; error: string }
  | { event: 'error'; error: string }
  /** Pushed once a second so the watchdog on the main thread can see the
   * encoder falling behind while there is still time to degrade. */
  | { event: 'stats'; stats: CompositorStats }

/**
 * Baseline and Main FIRST, High last — the opposite of a quality ranking, and
 * deliberately so. isConfigSupported() says yes to High on this machine and
 * then encodes it in software at ~10 fps for 1080p; platform realtime encoders
 * (VideoToolbox here) commonly expose Baseline/Main only. A profile nobody can
 * encode in hardware is not a better file, it is a dropped-frame file.
 */
const CODEC_CANDIDATES = ['avc1.42E01E', 'avc1.4D402A', 'avc1.640028'] as const

async function pickVideoConfig(
  width: number,
  height: number,
  bitrate: number,
  framerate: number,
): Promise<{ config: VideoEncoderConfig; hardware: string }> {
  // Hardware first: this is the whole point of owning the encoder. Software is
  // the honest fallback rather than a failure.
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference', 'prefer-software'] as const) {
    for (const codec of CODEC_CANDIDATES) {
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate,
        framerate,
        latencyMode: 'realtime',
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
        return { config: { ...config, ...(support.config ?? {}), width, height, codec }, hardware: hardwareAcceleration }
      }
    }
  }
  throw new Error('compositor: no supported AVC VideoEncoder config')
}

async function pickAudioConfig(
  sampleRate: number,
  channels: number,
  bitrate: number,
): Promise<AudioEncoderConfig> {
  const config: AudioEncoderConfig = {
    codec: 'mp4a.40.2',
    sampleRate,
    numberOfChannels: channels,
    bitrate,
  }
  const support = await AudioEncoder.isConfigSupported(config)
  if (!support.supported) throw new Error('compositor: AAC AudioEncoder unsupported')
  return { ...config, ...(support.config ?? {}) }
}

// ---------------------------------------------------------------------------

let handle: SyncAccessHandle | null = null
let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
/** The preview the main thread handed over, if any (O4-polish). */
let previewCtx: OffscreenCanvasRenderingContext2D | null = null
/** True until the first blit lands — the 'preview' reply is held until then. */
let previewAwaitingFirstPaint = false
/** WebGL2 backend; null means the 2D fallback is in use. */
let gl: GLCompositor | null = null
let output: Output | null = null
let videoSource: EncodedVideoPacketSource | null = null
let audioSource: EncodedAudioPacketSource | null = null
let videoEncoder: VideoEncoder | null = null
let audioEncoder: AudioEncoder | null = null
let muxChain: Promise<void> = Promise.resolve()
let fatal: string | null = null

let W = 1920
let H = 1080
let FPS = 30
let startedAtMs: number | null = null
let lastEncodedMs = -Infinity
/**
 * When a frame was last ACTUALLY encoded, as opposed to last attempted.
 *
 * These have to be two different numbers, and conflating them is what froze
 * PO's game takes (2026-08-25: "4k game in other tab freezes, but not all the
 * time and other inputs are fine"). `lastEncodedMs` advances even on a DROP,
 * deliberately — otherwise the next source frame a few ms later passes the
 * cadence gate and hammers a busy encoder at the source rate. But the keep-alive
 * read that same field to decide whether anything had reached the file lately,
 * so while the encoder queue stayed full every arriving frame reset the
 * keep-alive's clock, the keep-alive never fired, and NOTHING was encoded for
 * as long as the pressure lasted. Measured on a saturated take: gaps of
 * 4.0-4.6 s between consecutive frames in the composite, which is a picture
 * frozen for four seconds while the audio and the raw channels ran on fine.
 */
let lastEncodeOkMs = -Infinity
let lastEncodedTsUs = -1
let lastKeySec = -Infinity
let keepAliveTimer: ReturnType<typeof setInterval> | null = null
let statsTimer: ReturnType<typeof setInterval> | null = null
let stopped = false

/** Newest frame per source; the composite always paints the latest of each. */
const latest: Partial<Record<'screen' | 'camera', VideoFrame>> = {}
let audioFramesTotal = 0
let audioSampleRate = 48000
let audioStartAtMs: number | null = null
/** Leading samples that predate the composite timeline; trimmed, not shifted. */
let audioSkipFrames = 0

/**
 * THE AUDIO TIMELINE IS HELD AGAINST THE WALL CLOCK (PO 2026-08-25: a take
 * recorded beside a 4K game, "sounds go faster than video" from ~20 s in).
 *
 * This file carries its two tracks on two different clocks — video is stamped
 * with each frame's arrival (wall), audio is sample-counted. That is fine while
 * the audio graph renders in real time, and it is NOT fine when the machine is
 * saturated: measured on a loaded 60 s take, the AudioContext rendered 56.1 s
 * of quanta in 59.2 s of wall time, so the audio track came out ~3 s short and
 * every sample after the loss sat ~3 s EARLY against the picture. Sample
 * counting cannot see this by construction: it counts what arrived, so what
 * never arrived costs nothing and the whole rest of the take slides.
 *
 * The remedy is the one the raw mic worklet already applies one level down
 * (measuredAudio.ts: "starved quanta MUST become silence, not be skipped"),
 * lifted to the batch level: when the timeline has fallen behind the wall by
 * more than a batch or so, PAD it with silence to where it should be. Audio is
 * only ever added, never removed or moved, so a healthy take is untouched and a
 * starved one carries an honest short silence where the machine choked instead
 * of a permanent offset.
 *
 * `audioWallOrigin` is a MIN-FILTER, and that is what makes it safe: message
 * delivery can only ever be LATE, so the minimum of (received − timeline)
 * converges on the true origin and a burst of late batches cannot fake a gap.
 * Same estimator the measured-audio anchor uses, for the same reason.
 */
let audioWallOrigin = Infinity
let lastAudioRecvMs = -Infinity
/** Last sample per channel of the previous batch — the fade-out needs a value. */
let lastAudioSample: Float32Array | null = null
/** Below this, do nothing: normal batching jitter is ~21 ms and must not pad. */
const AUDIO_PAD_MIN_MS = 80
/** One batch may not conjure more than this much silence, whatever the stamp says. */
const AUDIO_PAD_MAX_MS = 1000
/**
 * The origin STOPS MOVING after this much audio, exactly as the measured-audio
 * anchor's window does. A min-filter that runs forever keeps ratcheting down on
 * the luckiest batch of the whole take, and every ratchet is silence padded in
 * that nothing was ever missing — over a long take that walks the audio LATE.
 * Three seconds is enough batches to find the floor and short enough that the
 * audio-vs-wall rate difference cannot bias it.
 */
const AUDIO_ORIGIN_WINDOW_S = 3
/** ~1.3 ms, the same ramp the PCM worklet uses on its own silence splices. */
const AUDIO_PAD_FADE = 64

const stats: CompositorStats = {
  framesIn: 0,
  framesEncoded: 0,
  framesDropped: 0,
  keepAliveFrames: 0,
  bytes: 0,
  durationMs: 0,
  audioFrames: 0,
  audioDroppedNotReady: 0,
  audioDroppedLead: 0,
  audioPaddedFrames: 0,
  maxEncodeGapMs: 0,
  codec: null,
  hardware: null,
  backend: null,
  peakQueue: 0,
  videoBytes: 0,
  audioBytes: 0,
  keyframeBytes: 0,
  keyframeCount: 0,
  requestedVideoBitrate: 0,
  paintMs: 0,
  frameMs: 0,
  encodeMs: 0,
  flushes: 0,
  muxMs: 0,
  writeMs: 0,
  flushMs: 0,
  writeCalls: 0,
  framesGated: 0,
  handlerMs: 0,
  idleMs: 0,
  maxIdleMs: 0,
  configJson: null,
  encodeLatencyMs: 0,
  outputs: 0,
  outputMs: 0,
  gpuMs: 0,
  framesStale: 0,
  originAtMs: null,
  previewMs: 0,
}

function post(reply: CompositorReply): void {
  self.postMessage(reply)
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (!fatal) {
    fatal = message
    post({ event: 'error', error: message })
  }
}

function releaseLatest(): void {
  for (const kind of ['screen', 'camera'] as const) {
    latest[kind]?.close()
    delete latest[kind]
  }
}

function roundedRectPath(
  c: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  c.beginPath()
  if (typeof c.roundRect === 'function') {
    c.roundRect(x, y, w, h, r)
    return
  }
  const radius = Math.min(r, w / 2, h / 2)
  c.moveTo(x + radius, y)
  c.arcTo(x + w, y, x + w, y + h, radius)
  c.arcTo(x + w, y + h, x, y + h, radius)
  c.arcTo(x, y + h, x, y, radius)
  c.arcTo(x, y, x + w, y, radius)
  c.closePath()
}

/** The PiP rect, shared by both backends so they cannot drift apart. */
function pipRect(camera: VideoFrame): { x: number; y: number; w: number; h: number; r: number; border: number } {
  const scale = W / 1920
  const w = 0.24 * W
  const aspect =
    camera.displayWidth && camera.displayHeight ? camera.displayWidth / camera.displayHeight : 4 / 3
  const h = w / aspect
  const margin = 24 * scale
  return { x: W - w - margin, y: H - h - margin, w, h, r: 16 * scale, border: 1.5 * scale }
}

/**
 * The DEFAULT composition, and it must stay pixel-identical to
 * compose/layout.ts — an unedited export packet-copies this file, so any
 * disagreement between the two is a visible jump on the way to the editor.
 */
function paint(): void {
  const screen = latest.screen
  const camera = latest.camera
  if (gl) {
    gl.begin(!!screen)
    if (screen) {
      const s = Math.min(W / screen.displayWidth, H / screen.displayHeight)
      const dw = screen.displayWidth * s
      const dh = screen.displayHeight * s
      gl.draw(screen, (W - dw) / 2, (H - dh) / 2, dw, dh, 0, 0)
      if (camera) {
        const p = pipRect(camera)
        gl.draw(camera, p.x, p.y, p.w, p.h, p.r, p.border)
      }
    } else if (camera) {
      const s = Math.max(W / camera.displayWidth, H / camera.displayHeight)
      const dw = camera.displayWidth * s
      const dh = camera.displayHeight * s
      gl.draw(camera, (W - dw) / 2, (H - dh) / 2, dw, dh, 0, 0)
    }
    return
  }
  const c = ctx
  if (!c) return
  c.fillStyle = '#0a0a0c'
  c.fillRect(0, 0, W, H)
  if (screen) {
    c.fillStyle = '#000000'
    c.fillRect(0, 0, W, H)
    const s = Math.min(W / screen.displayWidth, H / screen.displayHeight)
    const dw = screen.displayWidth * s
    const dh = screen.displayHeight * s
    c.drawImage(screen, (W - dw) / 2, (H - dh) / 2, dw, dh)
    if (camera) paintPip(c, camera)
  } else if (camera) {
    const s = Math.max(W / camera.displayWidth, H / camera.displayHeight)
    const dw = camera.displayWidth * s
    const dh = camera.displayHeight * s
    c.drawImage(camera, (W - dw) / 2, (H - dh) / 2, dw, dh)
  }
}

function paintPip(c: OffscreenCanvasRenderingContext2D, camera: VideoFrame): void {
  const { x, y, w: pipW, h: pipH, r, border } = pipRect(camera)
  c.save()
  roundedRectPath(c, x, y, pipW, pipH, r)
  c.clip()
  c.drawImage(camera, x, y, pipW, pipH)
  c.restore()
  roundedRectPath(c, x, y, pipW, pipH, r)
  c.strokeStyle = 'rgba(255,255,255,0.25)'
  c.lineWidth = border
  c.stroke()
}

/**
 * Show the frame that was just composited. Same task as the draw — the GL
 * backend does not preserve its drawing buffer (that is the readback it exists
 * to avoid), so this has to happen before the task yields, exactly like the
 * VideoFrame construction above it.
 */
function blitPreview(): void {
  const p = previewCtx
  if (!p || !canvas) return
  const t0 = performance.now()
  try {
    p.drawImage(canvas, 0, 0, p.canvas.width, p.canvas.height)
  } catch {
    // A preview that cannot be painted must never cost the take its encoder.
    previewCtx = null
    return
  }
  stats.previewMs += performance.now() - t0
  if (previewAwaitingFirstPaint) {
    previewAwaitingFirstPaint = false
    post({ ok: true, cmd: 'preview' })
  }
}

function encodeComposite(atMs: number, keepAlive: boolean): void {
  const enc = videoEncoder
  if (!enc || stopped || fatal || enc.state !== 'configured' || !canvas) return
  if (startedAtMs === null) {
    startedAtMs = atMs
    stats.originAtMs = atMs
  }
  // Never queue behind a slow encoder: a backlog at stop is exactly the tail
  // the product promises not to lose.
  //
  // lastEncodedMs advances even on a drop, and that matters: without it the
  // next source frame (a few ms later at 60 fps) passes the cadence gate and
  // attempts again, so a busy encoder gets hammered at the SOURCE rate and the
  // drop counter reports a catastrophe that is really just a spin.
  if (enc.encodeQueueSize >= MAX_ENCODER_QUEUE) {
    stats.framesDropped++
    lastEncodedMs = atMs
    return
  }
  if (enc.encodeQueueSize > stats.peakQueue) stats.peakQueue = enc.encodeQueueSize
  const relMs = Math.max(0, atMs - startedAtMs)
  const timestampUs = Math.max(lastEncodedTsUs + 1, Math.round(relMs * 1000))
  lastEncodedTsUs = timestampUs
  lastEncodedMs = atMs
  const tSec = timestampUs / 1e6
  const keyFrame = tSec - lastKeySec >= KEYFRAME_INTERVAL_S
  if (keyFrame) lastKeySec = tSec

  const tPaint = performance.now()
  paint()
  if (PROBE_GPU) gl?.finish()
  const tFrame = performance.now()
  if (PROBE_GPU) stats.gpuMs += tFrame - tPaint
  stats.paintMs += tFrame - tPaint
  const frame = new VideoFrame(canvas, {
    timestamp: timestampUs,
    duration: Math.round(1e6 / FPS),
  })
  const tEncode = performance.now()
  stats.frameMs += tEncode - tFrame
  try {
    submittedAt.push(performance.now())
    enc.encode(frame, { keyFrame })
    // Only here, and never on the drop path above: this is what the keep-alive
    // trusts to tell whether the FILE has had a frame lately.
    const gapMs = lastEncodeOkMs === -Infinity ? 0 : atMs - lastEncodeOkMs
    if (gapMs > stats.maxEncodeGapMs) stats.maxEncodeGapMs = gapMs
    lastEncodeOkMs = atMs
    if (keepAlive) stats.keepAliveFrames++
  } catch (err) {
    fail(err)
  } finally {
    frame.close()
    stats.encodeMs += performance.now() - tEncode
  }
  // LAST, and counted on its own: the preview must never inflate paintMs,
  // frameMs or encodeMs — an added cost that quietly lands inside an existing
  // metric is how a rig starts lying (note 10). Still the same task as the
  // draw, which is what the GL backend requires.
  blitPreview()
}

async function start(msg: CompositorStartMsg): Promise<void> {
  W = msg.width
  H = msg.height
  FPS = msg.fps

  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(ROOT_DIR, { create: true })
  const file = await dir.getFileHandle(msg.key, { create: true })
  handle = await (
    file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> }
  ).createSyncAccessHandle()
  handle.truncate?.(0)

  // WebGL2 first: a capture VideoFrame is already in GPU memory, and drawing
  // it through a 2D context reads it back every frame (measured at ~150 ms per
  // 1080p frame, i.e. 6.7 fps — see compositorGL.ts).
  gl = createGLCompositor(W, H)
  if (gl) {
    canvas = gl.canvas
  } else {
    console.warn('[capture] compositor: WebGL2 unavailable, falling back to 2D (slow)')
    canvas = new OffscreenCanvas(W, H)
    ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('compositor: no WebGL2 and no OffscreenCanvas 2d')
  }

  const { config, hardware } = await pickVideoConfig(W, H, msg.videoBitrate, msg.fps)
  stats.codec = config.codec
  stats.hardware = hardware
  stats.configJson = JSON.stringify(config)
  stats.backend = gl ? 'webgl2' : '2d'

  /**
   * Every chunk is written AND FLUSHED where the muxer says it goes, so a tab
   * kill leaves a file whose fragments are complete up to the last write.
   *
   * Batching the flush on a 250 ms timer was tried, on the theory that a
   * synchronous disk barrier per chunk was throttling the encoder. It was not:
   * batching measured no better (6.5 fps against 10.5 on the per-chunk build,
   * inside this machine's run-to-run spread). So the barrier stays per chunk,
   * where it buys the strongest salvage guarantee this engine can offer.
   */
  const sink = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      const h = handle
      if (!h) return
      const t0 = performance.now()
      const written = h.write(chunk.data, { at: chunk.position })
      const t1 = performance.now()
      h.flush()
      const t2 = performance.now()
      stats.writeMs += t1 - t0
      stats.flushMs += t2 - t1
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
  if (msg.sampleRate) {
    audioSampleRate = msg.sampleRate
    audioSource = new EncodedAudioPacketSource('aac')
    output.addAudioTrack(audioSource)
  }
  await output.start()

  stats.requestedVideoBitrate = msg.videoBitrate
  videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      const tOut = performance.now()
      stats.framesEncoded++
      stats.outputs++
      const submitted = submittedAt.shift()
      if (submitted !== undefined) stats.encodeLatencyMs += tOut - submitted
      stats.videoBytes += chunk.byteLength
      if (chunk.type === 'key') {
        stats.keyframeCount++
        stats.keyframeBytes += chunk.byteLength
      }
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      muxChain = muxChain
        .then(async () => {
          const t0 = performance.now()
          await videoSource?.add(packet, meta)
          stats.muxMs += performance.now() - t0
        })
        .catch(fail)
      stats.outputMs += performance.now() - tOut
    },
    error: fail,
  })
  videoEncoder.configure(config)

  if (msg.sampleRate) {
    const audioConfig = await pickAudioConfig(msg.sampleRate, msg.channelCount, msg.audioBitrate)
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        stats.audioBytes += chunk.byteLength
        const packet = EncodedPacket.fromEncodedChunk(chunk)
        muxChain = muxChain
          .then(async () => {
            const t0 = performance.now()
            await audioSource?.add(packet, meta)
            stats.muxMs += performance.now() - t0
          })
          .catch(fail)
      },
      error: fail,
    })
    audioEncoder.configure(audioConfig)
  }

  // Push stats so the main-thread watchdog can see the encoder falling behind
  // while degrading is still possible, rather than discovering it at stop.
  statsTimer = setInterval(() => {
    if (!stopped) post({ event: 'stats', stats: { ...stats } })
  }, 1000)

  // Keep-alive: a composition nobody is changing still needs a frame per
  // second. Cheap by construction — it repaints the same latest frames.
  keepAliveTimer = setInterval(() => {
    if (stopped || fatal || startedAtMs === null) return
    const nowMain = performance.now() - performanceOriginOffset
    // Against the last frame that actually REACHED the encoder — see
    // lastEncodeOkMs. Reading lastEncodedMs here meant a busy encoder silently
    // suppressed the keep-alive it exists to trigger.
    if (nowMain - lastEncodeOkMs >= KEEPALIVE_MS) encodeComposite(nowMain, true)
  }, KEEPALIVE_MS / 2)
}

/**
 * The main thread owns the clock, but the keep-alive fires here, so the worker
 * needs to express its own now() on the main thread's timeline. Every frame
 * message carries the main thread's wall reading; the difference against this
 * worker's own performance.now() at that moment is the (constant) offset
 * between the two time origins.
 */
let performanceOriginOffset = 0
let originSamples = 0

function noteOrigin(mainMs: number): void {
  const delta = performance.now() - mainMs
  // Min-filter: message delivery can only make the worker's reading LATE
  // relative to the main thread's stamp, never early.
  if (originSamples === 0 || delta < performanceOriginOffset) performanceOriginOffset = delta
  originSamples++
}

async function stop(): Promise<CompositorStats> {
  stopped = true
  if (keepAliveTimer) clearInterval(keepAliveTimer)
  if (statsTimer) clearInterval(statsTimer)
  keepAliveTimer = null
  statsTimer = null
  // DRAIN, in order: this is the tail the product promises. flush() returns
  // only once every queued frame has been encoded and handed to the muxer.
  try {
    if (videoEncoder && videoEncoder.state === 'configured') await videoEncoder.flush()
    if (audioEncoder && audioEncoder.state === 'configured') await audioEncoder.flush()
  } catch (err) {
    fail(err)
  }
  await muxChain.catch(() => undefined)
  try {
    videoEncoder?.close()
    audioEncoder?.close()
  } catch {
    /* already closed */
  }
  try {
    await output?.finalize()
  } catch (err) {
    fail(err)
  }
  await muxChain.catch(() => undefined)
  releaseLatest()
  gl?.dispose()
  gl = null
  try {
    handle?.flush()
    handle?.close()
  } catch {
    /* already closed */
  }
  handle = null
  stats.durationMs = lastEncodedTsUs >= 0 ? Math.round(lastEncodedTsUs / 1000) : 0
  return stats
}

async function cancel(): Promise<void> {
  stopped = true
  if (keepAliveTimer) clearInterval(keepAliveTimer)
  if (statsTimer) clearInterval(statsTimer)
  keepAliveTimer = null
  statsTimer = null
  releaseLatest()
  try {
    videoEncoder?.close()
    audioEncoder?.close()
  } catch {
    /* already closed */
  }
  try {
    handle?.close()
  } catch {
    /* already closed */
  }
  handle = null
}

/** When the previous message handler finished — the other end of an idle gap. */
let lastHandlerEndedAt = 0
/** When each submitted frame entered the encoder, FIFO — paired with outputs. */
const submittedAt: number[] = []

self.onmessage = async (ev: MessageEvent<CompositorMsg>) => {
  const msg = ev.data
  const handlerStart = performance.now()
  if (lastHandlerEndedAt > 0) {
    const idle = handlerStart - lastHandlerEndedAt
    stats.idleMs += idle
    if (idle > stats.maxIdleMs) stats.maxIdleMs = idle
  }
  try {
    switch (msg.cmd) {
      case 'start':
        await start(msg)
        post({ ok: true, cmd: 'start' })
        break
      case 'frame': {
        noteOrigin(msg.atMs)
        if (stopped || fatal) {
          msg.frame.close()
          return
        }
        stats.framesIn++
        latest[msg.kind]?.close()
        latest[msg.kind] = msg.frame
        // Frame-driven, capped at the output rate: two sources delivering 60 fps
        // must not encode 120 composites.
        if (msg.atMs - lastEncodedMs >= 1000 / FPS - 1) encodeComposite(msg.atMs, false)
        else {
          stats.framesGated++
          if (msg.atMs < lastEncodedMs) stats.framesStale++
        }
        break
      }
      case 'audio': {
        noteOrigin(msg.atMs)
        if (stopped || fatal || !audioEncoder || audioEncoder.state !== 'configured') {
          // Count what is being thrown away. Silence here is how a take loses
          // seconds of its audio timeline without a single line of evidence.
          if (!stopped && !fatal) stats.audioDroppedNotReady += msg.frames
          return
        }
        if (audioStartAtMs === null) {
          audioStartAtMs = msg.atMs
          if (startedAtMs === null) {
            startedAtMs = msg.atMs
            stats.originAtMs = msg.atMs
          }
          // The mix is usually already running when the first VIDEO frame
          // arrives, so the audio genuinely begins before the composite's
          // timeline does. That lead cannot be placed on a timeline that starts
          // at the first frame — and emitting it anyway is a negative timestamp,
          // which the muxer rightly refuses. Trim it: the audio that remains
          // still starts exactly at t0, so nothing desyncs.
          const leadMs = startedAtMs - audioStartAtMs
          if (leadMs > 0) audioSkipFrames = Math.round((leadMs / 1000) * audioSampleRate)
        }
        let { planar, frames } = msg
        if (audioSkipFrames > 0) {
          const skip = Math.min(audioSkipFrames, frames)
          audioSkipFrames -= skip
          stats.audioDroppedLead += skip
          if (skip >= frames) break
          const kept = frames - skip
          const trimmed = new Float32Array(msg.channels * kept)
          for (let c = 0; c < msg.channels; c++) {
            trimmed.set(planar.subarray(c * frames + skip, (c + 1) * frames), c * kept)
          }
          planar = trimmed
          frames = kept
        }
        // HOLD THE TIMELINE AGAINST THE WALL before placing this batch. Sample
        // counting is the ruler between batches; it just cannot see time that
        // never arrived, so the wall stamp gets a say about WHERE the ruler is.
        // See audioWallOrigin above for why a min-filter is the safe estimator.
        if (typeof msg.recvMs === 'number') {
          const timelineMs = (audioFramesTotal / audioSampleRate) * 1000
          const batchMs = (frames / audioSampleRate) * 1000
          // Only STEADY-STATE batches may date the origin. A context that has
          // just started delivers its catch-up burst back to back, and those
          // arrivals date the origin falsely early — which would pad silence
          // for time that was never lost. Same guard, same reason, as the
          // measured-audio anchor's.
          const steady = msg.recvMs - lastAudioRecvMs >= batchMs / 2
          if (steady && audioFramesTotal < AUDIO_ORIGIN_WINDOW_S * audioSampleRate) {
            const originCand = msg.recvMs - timelineMs
            if (originCand < audioWallOrigin) audioWallOrigin = originCand
          }
          lastAudioRecvMs = msg.recvMs
          const behindMs = msg.recvMs - audioWallOrigin - timelineMs
          if (audioWallOrigin !== Infinity && behindMs > AUDIO_PAD_MIN_MS) {
            const padFrames = Math.round(
              (Math.min(behindMs, AUDIO_PAD_MAX_MS) / 1000) * audioSampleRate,
            )
            // A step from the last sample straight to zero is a click, and this
            // codebase has paid for that lesson once already (the PCM worklet
            // fades every silence splice). Ramp out of the signal and back into
            // it, so the gap is heard as a gap and not as a pop at each end.
            const padData = new Float32Array(msg.channels * padFrames)
            const head = Math.min(AUDIO_PAD_FADE, padFrames)
            for (let c = 0; c < msg.channels; c++) {
              const from = lastAudioSample?.[c] ?? 0
              if (from !== 0) {
                const base = c * padFrames
                for (let i = 0; i < head; i++) padData[base + i] = from * (1 - i / head)
              }
            }
            const pad = new AudioData({
              format: 'f32-planar',
              sampleRate: audioSampleRate,
              numberOfFrames: padFrames,
              numberOfChannels: msg.channels,
              timestamp: Math.round((audioFramesTotal / audioSampleRate) * 1e6),
              data: padData as unknown as BufferSource,
            })
            try {
              audioEncoder.encode(pad)
              audioFramesTotal += padFrames
              stats.audioPaddedFrames += padFrames
              stats.audioFrames = audioFramesTotal
            } finally {
              pad.close()
            }
            // …and fade the resuming signal in, the other half of the splice.
            const tail = Math.min(AUDIO_PAD_FADE, frames)
            for (let c = 0; c < msg.channels; c++) {
              const base = c * frames
              for (let i = 0; i < tail; i++) planar[base + i] *= i / tail
            }
          }
        }
        if (msg.channels > 0 && frames > 0) {
          lastAudioSample ??= new Float32Array(msg.channels)
          for (let c = 0; c < msg.channels && c < lastAudioSample.length; c++) {
            lastAudioSample[c] = planar[c * frames + frames - 1] ?? 0
          }
        }
        // Sample-counted from here: between batches the ruler is exact, and the
        // wall only ever moves it FORWARD, above.
        const timestampUs = Math.max(
          0,
          Math.round((audioFramesTotal / audioSampleRate) * 1e6),
        )
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate: audioSampleRate,
          numberOfFrames: frames,
          numberOfChannels: msg.channels,
          timestamp: timestampUs,
          // The transferred view is always a plain ArrayBuffer here; TS widens
          // it to ArrayBufferLike because a SharedArrayBuffer is conceivable.
          data: planar as unknown as BufferSource,
        })
        try {
          audioEncoder.encode(data)
          audioFramesTotal += frames
          stats.audioFrames = audioFramesTotal
        } finally {
          data.close()
        }
        break
      }
      case 'preview': {
        const c = msg.canvas.getContext('2d', { alpha: false })
        if (!c) {
          post({ ok: false, cmd: 'preview', error: 'no 2d context on the preview canvas' })
          break
        }
        previewCtx = c
        previewAwaitingFirstPaint = true
        // No reply here: blitPreview() sends it once something is actually on
        // screen. If nothing ever paints, the caller's own deadline decides.
        break
      }
      case 'stop':
        post({ ok: true, cmd: 'stop', stats: await stop() })
        break
      case 'cancel':
        await cancel()
        post({ ok: true, cmd: 'cancel' })
        break
    }
  } catch (err) {
    post({ ok: false, cmd: msg.cmd, error: err instanceof Error ? err.message : String(err) })
  } finally {
    const end = performance.now()
    stats.handlerMs += end - handlerStart
    lastHandlerEndedAt = end
  }
}
