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

const ROOT_DIR = 'blobs'
/** Keyframe cadence — the smart-cut prerequisite (O5) and the salvage anchor. */
const KEYFRAME_INTERVAL_S = 2
/** Beyond this the encoder is behind; drop rather than queue (a queued frame
 * is latency the user pays for at stop). */
const MAX_ENCODER_QUEUE = 6
/** A static composition still needs a frame occasionally or the timeline
 * stalls and players show nothing between events. */
const KEEPALIVE_MS = 1000

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
}

export type CompositorMsg =
  | CompositorStartMsg
  | CompositorFrameMsg
  | CompositorAudioMsg
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
  /** What the encoder actually negotiated — evidence, not decoration. */
  codec: string | null
  hardware: string | null
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
}

export type CompositorReply =
  | { ok: true; cmd: 'start' }
  | { ok: true; cmd: 'stop'; stats: CompositorStats }
  | { ok: true; cmd: 'cancel' }
  | { ok: false; cmd: string; error: string }
  | { event: 'error'; error: string }
  /** Pushed once a second so the watchdog on the main thread can see the
   * encoder falling behind while there is still time to degrade. */
  | { event: 'stats'; stats: CompositorStats }

const CODEC_CANDIDATES = ['avc1.640028', 'avc1.4D402A', 'avc1.42E01E'] as const

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

const stats: CompositorStats = {
  framesIn: 0,
  framesEncoded: 0,
  framesDropped: 0,
  keepAliveFrames: 0,
  bytes: 0,
  durationMs: 0,
  audioFrames: 0,
  codec: null,
  hardware: null,
  peakQueue: 0,
  videoBytes: 0,
  audioBytes: 0,
  keyframeBytes: 0,
  keyframeCount: 0,
  requestedVideoBitrate: 0,
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

/**
 * The DEFAULT composition, and it must stay pixel-identical to
 * compose/layout.ts — an unedited export packet-copies this file, so any
 * disagreement between the two is a visible jump on the way to the editor.
 */
function paint(): void {
  const c = ctx
  if (!c) return
  const screen = latest.screen
  const camera = latest.camera
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
  const scale = W / 1920
  const pipW = 0.24 * W
  const aspect =
    camera.displayWidth && camera.displayHeight ? camera.displayWidth / camera.displayHeight : 4 / 3
  const pipH = pipW / aspect
  const margin = 24 * scale
  const r = 16 * scale
  const x = W - pipW - margin
  const y = H - pipH - margin
  c.save()
  roundedRectPath(c, x, y, pipW, pipH, r)
  c.clip()
  c.drawImage(camera, x, y, pipW, pipH)
  c.restore()
  roundedRectPath(c, x, y, pipW, pipH, r)
  c.strokeStyle = 'rgba(255,255,255,0.25)'
  c.lineWidth = 1.5 * scale
  c.stroke()
}

function encodeComposite(atMs: number, keepAlive: boolean): void {
  const enc = videoEncoder
  if (!enc || stopped || fatal || enc.state !== 'configured' || !canvas) return
  if (startedAtMs === null) startedAtMs = atMs
  // Never queue behind a slow encoder: a backlog at stop is exactly the tail
  // the product promises not to lose.
  if (enc.encodeQueueSize >= MAX_ENCODER_QUEUE) {
    stats.framesDropped++
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

  paint()
  const frame = new VideoFrame(canvas, {
    timestamp: timestampUs,
    duration: Math.round(1e6 / FPS),
  })
  try {
    enc.encode(frame, { keyFrame })
    if (keepAlive) stats.keepAliveFrames++
  } catch (err) {
    fail(err)
  } finally {
    frame.close()
  }
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

  canvas = new OffscreenCanvas(W, H)
  ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('compositor: OffscreenCanvas 2d unavailable')

  const { config, hardware } = await pickVideoConfig(W, H, msg.videoBitrate, msg.fps)
  stats.codec = config.codec
  stats.hardware = hardware

  // Every chunk is written AND FLUSHED where the muxer says it goes, so a tab
  // kill leaves a file whose fragments are all complete up to the last write.
  const sink = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      const h = handle
      if (!h) return
      const written = h.write(chunk.data, { at: chunk.position })
      h.flush()
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
      stats.framesEncoded++
      stats.videoBytes += chunk.byteLength
      if (chunk.type === 'key') {
        stats.keyframeCount++
        stats.keyframeBytes += chunk.byteLength
      }
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      muxChain = muxChain.then(() => videoSource?.add(packet, meta)).catch(fail)
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
        muxChain = muxChain.then(() => audioSource?.add(packet, meta)).catch(fail)
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
    const sinceLast = performance.now() - performanceOriginOffset - lastEncodedMs
    if (sinceLast >= KEEPALIVE_MS) {
      encodeComposite(lastEncodedMs + sinceLast, true)
    }
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

self.onmessage = async (ev: MessageEvent<CompositorMsg>) => {
  const msg = ev.data
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
        break
      }
      case 'audio': {
        noteOrigin(msg.atMs)
        if (stopped || fatal || !audioEncoder || audioEncoder.state !== 'configured') return
        if (audioStartAtMs === null) audioStartAtMs = msg.atMs
        if (startedAtMs === null) startedAtMs = msg.atMs
        // Sample-counted, so the audio timeline can never drift or gap even if
        // a message is late; the wall stamp only places sample 0.
        const timestampUs = Math.round(
          (audioStartAtMs - startedAtMs) * 1000 + (audioFramesTotal / audioSampleRate) * 1e6,
        )
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate: audioSampleRate,
          numberOfFrames: msg.frames,
          numberOfChannels: msg.channels,
          timestamp: timestampUs,
          data: msg.planar,
        })
        try {
          audioEncoder.encode(data)
          audioFramesTotal += msg.frames
          stats.audioFrames = audioFramesTotal
        } finally {
          data.close()
        }
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
  }
}
