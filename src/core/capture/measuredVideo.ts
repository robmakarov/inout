/**
 * Measured video capture — replaces MediaRecorder for screen / camera when
 * WebCodecs VideoEncoder is available.
 *
 * Pipeline: paced <video> sampler → OffscreenCanvas (encoder-sized) →
 * VideoEncoder (AVC, 2s keyframes) → mediabunny EncodedVideoPacketSource →
 * fragmented MP4 → durable positioned OPFS writer.
 *
 * Packet timestamps follow wall clock from the first frame (µs).
 * startOffsetMs = performance.now() at first frame − session epoch.
 *
 * Why not MediaStreamTrackProcessor for stamps: waiting on VideoEncoder stalls
 * the processor (silent frame drops → sync outliers). A paced <video> sampler
 * with wall-clock stamps keeps duration and flash timing stable; encoder size
 * must match the VideoFrame (OffscreenCanvas) or the encoder dies ~1s in.
 *
 * MediaRecorder remains the capability fallback (session.ts).
 */

import {
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny'

export const MEASURED_VIDEO_MIME = 'video/mp4'
const KEYFRAME_INTERVAL_S = 2
const MAX_ENCODER_QUEUE = 8
const TARGET_FPS = 60
const FRAME_PERIOD_MS = 1000 / TARGET_FPS
const FRAME_DURATION_US = Math.round(1e6 / TARGET_FPS)
const CODEC_CANDIDATES = ['avc1.640028', 'avc1.4D401F', 'avc1.42E01E'] as const
/**
 * <video> presents canvas.captureStream frames ~1–2 ticks late vs wall stamp.
 * Shift the channel later on the session timeline so flash onset matches click
 * (positive flash+click residual ≈ this lag before correction).
 */
const PRESENTATION_LAG_MS = 14

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function canMeasureVideoCapture(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof HTMLVideoElement !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  )
}

async function pickVideoConfig(
  width: number,
  height: number,
  bitrate: number,
): Promise<VideoEncoderConfig> {
  for (const codec of CODEC_CANDIDATES) {
    for (const hw of ['prefer-software', 'no-preference', 'prefer-hardware'] as const) {
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate,
        framerate: TARGET_FPS,
        latencyMode: 'realtime',
        hardwareAcceleration: hw,
      }
      const support = await VideoEncoder.isConfigSupported(config)
      if (support.supported) {
        return { ...config, ...(support.config ?? {}), width, height, codec }
      }
    }
  }
  throw new Error('measured video: no supported AVC VideoEncoder config')
}

export interface MeasuredVideoHandle {
  readonly mimeType: string
  readonly firstOffset: Promise<number>
  stop(): Promise<{
    bytes: number
    durationMs: number
    startOffsetMs: number
    width: number
    height: number
    framesEncoded: number
    framesDropped: number
  }>
  cancel(): Promise<void>
}

export async function startMeasuredVideoCapture(opts: {
  track: MediaStreamTrack
  kind: 'screen' | 'camera'
  epoch: number
  writer: import('@core/store').PositionedDurableWriter
}): Promise<MeasuredVideoHandle> {
  const settings = opts.track.getSettings()
  const srcW = settings.width && settings.width > 0 ? settings.width : 1280
  const srcH = settings.height && settings.height > 0 ? settings.height : 720
  const scale = Math.min(1, 960 / srcW)
  const width = Math.max(2, Math.round(srcW * scale) & ~1)
  const height = Math.max(2, Math.round(srcH * scale) & ~1)
  const bitrate = opts.kind === 'screen' ? 2_500_000 : 1_500_000
  const config = await pickVideoConfig(width, height, bitrate)

  const videoEl = document.createElement('video')
  videoEl.muted = true
  videoEl.playsInline = true
  videoEl.setAttribute('playsinline', '')
  videoEl.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px;opacity:0'
  videoEl.srcObject = new MediaStream([opts.track])
  document.documentElement.appendChild(videoEl)
  await videoEl.play().catch(() => undefined)

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('measured video: OffscreenCanvas 2d unavailable')

  let bytesWritten = 0
  const sinkStream = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      await opts.writer.write(chunk.data, chunk.position)
      bytesWritten = Math.max(bytesWritten, chunk.position + chunk.data.byteLength)
    },
  })

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
    target: new StreamTarget(sinkStream),
  })
  const packetSource = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(packetSource, { frameRate: TARGET_FPS })
  await output.start()

  let muxChain: Promise<void> = Promise.resolve()
  let encodeError: Error | null = null
  let framesIn = 0
  let framesEncoded = 0
  let framesDropped = 0
  let startOffsetMs: number | null = null
  let firstWallMs: number | null = null
  let lastPacketTimestampUs = 0
  let lastEncodedTsUs = -1
  let lastKeySec = -Infinity
  let stopped = false

  let resolveFirst!: (ms: number) => void
  const firstOffset = new Promise<number>((r) => {
    resolveFirst = r
  })

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      framesEncoded++
      lastPacketTimestampUs = Math.max(lastPacketTimestampUs, chunk.timestamp)
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      muxChain = muxChain.then(() => packetSource.add(packet, meta)).catch((err) => {
        encodeError = err instanceof Error ? err : new Error(String(err))
      })
    },
    error: (err) => {
      encodeError = err instanceof Error ? err : new Error(String(err))
      console.error('[capture] VideoEncoder error', err)
    },
  })
  encoder.configure(config)

  const encodeOne = async (): Promise<boolean> => {
    if (encodeError || encoder.state !== 'configured') return false
    if (videoEl.readyState < 2 || videoEl.videoWidth === 0) return false

    while (!stopped && !encodeError && encoder.encodeQueueSize >= MAX_ENCODER_QUEUE) {
      await sleep(1)
    }
    if (stopped || encodeError || encoder.state !== 'configured') return false

    const now = performance.now()
    if (firstWallMs === null) {
      firstWallMs = now
      startOffsetMs = now - opts.epoch + PRESENTATION_LAG_MS
      resolveFirst(startOffsetMs)
      console.info(
        `[capture] measured video ${opts.kind} first-frame offset=${startOffsetMs.toFixed(1)}ms ` +
          `size=${videoEl.videoWidth}x${videoEl.videoHeight}→${width}x${height} ` +
          `codec=${config.codec} fps=${TARGET_FPS}`,
      )
    }

    const wallTs = Math.max(0, Math.round((now - firstWallMs) * 1000))
    const timestampUs = Math.max(lastEncodedTsUs + 1, wallTs)
    lastEncodedTsUs = timestampUs
    framesIn++

    const tSec = timestampUs / 1e6
    const keyFrame = tSec - lastKeySec >= KEYFRAME_INTERVAL_S
    if (keyFrame) lastKeySec = tSec

    ctx.drawImage(videoEl, 0, 0, width, height)
    const frame = new VideoFrame(canvas, {
      timestamp: timestampUs,
      duration: FRAME_DURATION_US,
    })
    try {
      encoder.encode(frame, { keyFrame })
    } finally {
      frame.close()
    }
    return true
  }

  const pump = (async () => {
    try {
      for (let i = 0; i < 100 && videoEl.videoWidth === 0 && !stopped; i++) await sleep(20)
      while (!stopped && framesIn === 0) {
        const ok = await encodeOne()
        if (!ok) {
          if (encodeError) throw encodeError
          await sleep(10)
        }
      }
      let nextDue = performance.now()
      while (!stopped) {
        nextDue += FRAME_PERIOD_MS
        try {
          const ok = await encodeOne()
          if (!ok && encodeError) break
          if (!ok) framesDropped++
        } catch (err) {
          encodeError = err instanceof Error ? err : new Error(String(err))
          break
        }
        const delay = nextDue - performance.now()
        if (!stopped && delay > 0) await sleep(delay)
        if (performance.now() > nextDue + FRAME_PERIOD_MS) nextDue = performance.now()
      }
    } catch (err) {
      if (!encodeError) encodeError = err instanceof Error ? err : new Error(String(err))
    }
  })()

  await firstOffset

  const finish = async (cancel: boolean): Promise<{
    bytes: number
    durationMs: number
    startOffsetMs: number
    width: number
    height: number
    framesEncoded: number
    framesDropped: number
  }> => {
    if (!cancel && !encodeError && encoder.state === 'configured' && firstWallMs !== null) {
      try {
        await encodeOne()
      } catch (err) {
        if (!encodeError) encodeError = err instanceof Error ? err : new Error(String(err))
      }
    }
    stopped = true
    await pump.catch(() => undefined)

    try {
      if (!cancel && encoder.state === 'configured') await encoder.flush()
    } catch (err) {
      if (!encodeError) encodeError = err instanceof Error ? err : new Error(String(err))
    }
    try {
      if (encoder.state !== 'closed') encoder.close()
    } catch {
      /* */
    }
    await muxChain

    try {
      videoEl.pause()
      videoEl.srcObject = null
      videoEl.remove()
    } catch {
      /* */
    }

    if (cancel) {
      try {
        await output.cancel()
      } catch {
        /* */
      }
      await opts.writer.abort().catch(() => undefined)
      if (startOffsetMs === null) resolveFirst(0)
      return {
        bytes: 0,
        durationMs: 0,
        startOffsetMs: startOffsetMs ?? 0,
        width,
        height,
        framesEncoded,
        framesDropped,
      }
    }

    if (encodeError) throw encodeError
    await output.finalize()
    await opts.writer.close()

    if (startOffsetMs === null) {
      startOffsetMs = 0
      resolveFirst(0)
    }
    const durationMs = lastPacketTimestampUs / 1000
    console.info(
      `[capture] measured video ${opts.kind} stop frames=${framesEncoded}/${framesIn} ` +
        `dropped=${framesDropped} dur=${durationMs.toFixed(0)}ms bytes=${bytesWritten}`,
    )

    return {
      bytes: bytesWritten,
      durationMs,
      startOffsetMs,
      width,
      height,
      framesEncoded,
      framesDropped,
    }
  }

  return {
    mimeType: `${MEASURED_VIDEO_MIME};codecs=${config.codec}`,
    firstOffset,
    stop: () => finish(false),
    cancel: async () => {
      await finish(true)
    },
  }
}

/** Pure helper — rebase a capture timestamp so the first frame is file t=0. */
export function rebaseFrameTimestampUs(frameTsUs: number, firstFrameTsUs: number): number {
  return Math.max(0, frameTsUs - firstFrameTsUs)
}
