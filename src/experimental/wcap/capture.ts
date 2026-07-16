/**
 * EXPERIMENTAL — WebCodecs-native capture prototype (Experiment 4).
 *
 * NOT a migration: an alternative capture path measured side-by-side with
 * MediaRecorder. One video MediaStreamTrack goes through
 * MediaStreamTrackProcessor -> VideoEncoder (AVC, forced keyframe cadence) ->
 * mediabunny EncodedVideoPacketSource -> fragmented MP4 -> StreamTarget ->
 * OPFS (experimental dir).
 *
 * What the prototype exists to measure (vs the production MediaRecorder path
 * on the SAME source):
 *  - timestamp fidelity: VideoFrame.timestamp gives per-frame capture times;
 *    the first frame's timestamp IS the channel start offset (no onstart
 *    heuristic);
 *  - keyframe control: exact GOP cadence (smart-cut precondition);
 *  - crash durability: fragmented MP4 written incrementally is valid to the
 *    last fragment (pairs with Experiment 3's durable writer);
 *  - cost: encode queue depth, dropped frames, wall-clock CPU share;
 *  - export advantage: the resulting file is already AVC/MP4 (remux-only
 *    export for screen-only recordings).
 *
 * Deliberate scope cuts (documented, not hidden): single video track (audio
 * via AudioEncoder is the same pattern with AudioData; omitted to keep the
 * prototype reviewable), main-thread encoder (worker move is mechanical).
 */

import {
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny'
import { expDir } from '../shared/opfs'
import { getVideoTrackProcessor } from './webcodecs-types'

export interface WcapMetrics {
  framesIn: number
  framesEncoded: number
  framesDroppedBackpressure: number
  keyframes: number
  /** VideoFrame.timestamp of the first frame, µs — the real start offset. */
  firstFrameTimestampUs: number | null
  /** Max VideoEncoder queue depth observed. */
  maxQueueDepth: number
  /** Wall time spent inside encoder output handling, ms (rough CPU proxy). */
  muxMs: number
  captureWallMs: number
  fileBytes: number
  avgEncodeFps: number
}

export interface WcapResult {
  fileName: string
  metrics: WcapMetrics
}

const KEYFRAME_INTERVAL_S = 2
const MAX_ENCODER_QUEUE = 8

export async function captureTrackToFmp4(
  track: MediaStreamTrack,
  durationMs: number,
  opts?: { width?: number; height?: number; bitrate?: number; fileName?: string },
): Promise<WcapResult> {
  const Processor = getVideoTrackProcessor()
  if (!Processor) throw new Error('MediaStreamTrackProcessor unavailable (Chromium-only API)')

  const settings = track.getSettings()
  const width = opts?.width ?? settings.width ?? 1280
  const height = opts?.height ?? settings.height ?? 720
  const bitrate = opts?.bitrate ?? 8_000_000
  const fileName = opts?.fileName ?? `wcap-${Date.now()}.mp4`

  // Streamed, durable-ish output: fragmented MP4 through a WritableStream
  // into OPFS. (Production-grade durability would pair this with the sync-
  // access-handle worker from Experiment 3.)
  const dir = await expDir()
  const fileHandle = await dir.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()
  let fileBytes = 0
  const sinkStream = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      await writable.write({ type: 'write', data: chunk.data, position: chunk.position })
      fileBytes = Math.max(fileBytes, chunk.position + chunk.data.byteLength)
    },
  })

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
    target: new StreamTarget(sinkStream),
  })
  const source = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(source, { frameRate: 30 })
  await output.start()

  const metrics: WcapMetrics = {
    framesIn: 0,
    framesEncoded: 0,
    framesDroppedBackpressure: 0,
    keyframes: 0,
    firstFrameTimestampUs: null,
    maxQueueDepth: 0,
    muxMs: 0,
    captureWallMs: 0,
    fileBytes: 0,
    avgEncodeFps: 0,
  }

  let muxChain: Promise<void> = Promise.resolve()
  let encodeError: unknown = null

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const t0 = performance.now()
      metrics.framesEncoded++
      if (chunk.type === 'key') metrics.keyframes++
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      muxChain = muxChain.then(() => source.add(packet, meta)).catch((err) => {
        encodeError = err
      })
      metrics.muxMs += performance.now() - t0
    },
    error: (err) => {
      encodeError = err
    },
  })
  encoder.configure({
    codec: 'avc1.640028', // H.264 High@4.0 — same family production export targets
    width,
    height,
    bitrate,
    framerate: 30,
    latencyMode: 'realtime',
  })

  const processor = new Processor({ track, maxBufferSize: 4 })
  const reader = processor.readable.getReader()
  const t0 = performance.now()
  const deadline = t0 + durationMs
  let lastKeySec = -Infinity

  while (performance.now() < deadline) {
    const { value: frame, done } = await reader.read()
    if (done || !frame) break
    metrics.framesIn++
    if (metrics.firstFrameTimestampUs === null) metrics.firstFrameTimestampUs = frame.timestamp
    metrics.maxQueueDepth = Math.max(metrics.maxQueueDepth, encoder.encodeQueueSize)
    if (encoder.encodeQueueSize > MAX_ENCODER_QUEUE) {
      // Backpressure policy: drop rather than stall the tab. Counted, reported.
      metrics.framesDroppedBackpressure++
      frame.close()
      continue
    }
    const tSec = frame.timestamp / 1e6
    const keyFrame = tSec - lastKeySec >= KEYFRAME_INTERVAL_S
    if (keyFrame) lastKeySec = tSec
    encoder.encode(frame, { keyFrame })
    frame.close()
  }
  await reader.cancel().catch(() => undefined)

  await encoder.flush()
  encoder.close()
  await muxChain
  if (encodeError) throw encodeError instanceof Error ? encodeError : new Error(String(encodeError))
  await output.finalize()
  await writable.close()

  metrics.captureWallMs = performance.now() - t0
  metrics.fileBytes = fileBytes
  metrics.avgEncodeFps = metrics.framesEncoded / (metrics.captureWallMs / 1000)
  return { fileName, metrics }
}
