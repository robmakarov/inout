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
  | { cmd: 'stop' }
  | { cmd: 'cancel' }

export interface RawVideoStats {
  framesIn: number
  framesEncoded: number
  framesDropped: number
  keyframeCount: number
  bytes: number
  videoBytes: number
  codec: string
  hardware: string
  writeCalls: number
  flushes: number
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

const CODEC_CANDIDATES = ['avc1.42E01E', 'avc1.4D402A', 'avc1.640028'] as const

async function pickVideoConfig(
  width: number,
  height: number,
  bitrate: number,
  framerate: number,
): Promise<{ config: VideoEncoderConfig; hardware: string }> {
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

/** Main-thread stamp of the first frame that reached the encoder. */
let firstFrameAtMs: number | null = null
let lastFrameAtMs: number | null = null
let lastKeySec = -Infinity
let baseTimestampUs: number | null = null

const stats: RawVideoStats = {
  framesIn: 0,
  framesEncoded: 0,
  framesDropped: 0,
  keyframeCount: 0,
  bytes: 0,
  videoBytes: 0,
  codec: '',
  hardware: '',
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
      void stop().then(
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
}

function onFrame(msg: RawVideoFrameMsg): void {
  const frame = msg.frame
  stats.framesIn++
  if (fatal || stopped || !encoder) {
    frame.close()
    return
  }
  // THE CHANNEL'S LENGTH IS THE SPAN OF FRAMES THAT ARRIVED, not of frames
  // that were encoded. Advancing this only past the drop check made a take
  // with drops near the end declare itself SHORTER than its own file — 869 ms
  // short on one 15 s run — and a channel that under-declares its length slides
  // every other channel against it on the timeline.
  if (firstFrameAtMs === null) firstFrameAtMs = msg.atMs
  lastFrameAtMs = msg.atMs
  // DROP, NEVER QUEUE. A queue that grows without bound turns a slow encoder
  // into unbounded memory and a take that ends minutes after the press; the
  // composite makes the same choice for the same reason.
  if (encoder.encodeQueueSize > MAX_ENCODER_QUEUE) {
    stats.framesDropped++
    frame.close()
    return
  }
  try {
    // The channel's own timeline starts at its first frame, so the file's t=0
    // is that frame — startOffsetMs places it on the session timeline, exactly
    // as MediaRecorder's file epoch does.
    if (baseTimestampUs === null) baseTimestampUs = frame.timestamp
    const tSec = (frame.timestamp - baseTimestampUs) / 1e6
    const keyFrame = tSec - lastKeySec >= KEYFRAME_INTERVAL_S || stats.framesEncoded === 0
    if (keyFrame) lastKeySec = tSec
    encoder.encode(frame, { keyFrame })
  } catch (err) {
    fail(err)
  } finally {
    frame.close()
  }
}

async function stop(): Promise<Extract<RawVideoReply, { cmd: 'stop' }>> {
  stopped = true
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
  const durationMs =
    firstFrameAtMs !== null && lastFrameAtMs !== null ? lastFrameAtMs - firstFrameAtMs : 0
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
