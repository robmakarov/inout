/**
 * Measured video capture — replaces MediaRecorder for screen / camera when
 * WebCodecs VideoEncoder is available.
 *
 * Pipeline: paced <video> sampler → OffscreenCanvas (encoder-sized) →
 * VideoEncoder (AVC, 2s keyframes) → mediabunny EncodedVideoPacketSource →
 * fragmented MP4 → durable positioned OPFS writer.
 *
 * Sampling cadence comes from requestVideoFrameCallback (fires per presented
 * frame — no poll quantization), with a paced watchdog for static content /
 * rVFC silence. Stamps stay wall-clock-at-sample + PRESENTATION_LAG_MS anchor:
 * empirically correct per the oracle (a captureTime anchor measured +25ms
 * biased — see comment at encodeOne).
 *
 * Why not MediaStreamTrackProcessor for stamps: waiting on VideoEncoder stalls
 * the processor (silent frame drops → sync outliers). Encoder-busy now DROPS
 * the frame instead of blocking the sampler for the same reason; encoder size
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
 * Fallback stamp only (no rVFC metadata): <video> presents frames ~1–2 ticks
 * late vs wall stamp. The primary path uses metadata.captureTime and needs no
 * constant.
 */
const PRESENTATION_LAG_MS = 14

/** rVFC types incl. captureTime (present for capture-backed tracks in Chromium). */
interface FrameMetadata {
  captureTime?: DOMHighResTimeStamp
  presentationTime?: DOMHighResTimeStamp
}
type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMetadata) => void) => number
  cancelVideoFrameCallback?: (id: number) => void
}

/**
 * Anchor diagnostics (oracle instrumentation for the bimodal ~0.6/+13ms sync
 * modes): per encoded frame i<20 — [source 'r'|'w', cb-dispatch delay ms
 * (now−presentationTime), presentation pipeline age ms
 * (presentationTime−captureTime)], null where metadata is absent.
 * Exposed at globalThis.__inoutVideoDiag[kind]; read by the oracle rig.
 */
interface AnchorDiag {
  offsetMs: number
  frames: [string, number | null, number | null][]
}
const DIAG_FRAMES = 20
function diagSink(): Record<string, AnchorDiag> {
  const g = globalThis as { __inoutVideoDiag?: Record<string, AnchorDiag> }
  return (g.__inoutVideoDiag ??= {})
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** MediaStreamTrackProcessor (Chromium) — not yet in TS DOM libs. */
interface TrackProcessorLike {
  readable: ReadableStream<VideoFrame>
}
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => TrackProcessorLike

function trackProcessorCtor(): TrackProcessorCtor | null {
  const g = globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }
  return typeof g.MediaStreamTrackProcessor === 'function' ? g.MediaStreamTrackProcessor : null
}

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

  const diag: AnchorDiag = { offsetMs: NaN, frames: [] }
  diagSink()[opts.kind] = diag
  const recordDiag = (src: string, now: number, meta?: FrameMetadata): void => {
    if (diag.frames.length >= DIAG_FRAMES) return
    diag.frames.push([
      src,
      meta?.presentationTime !== undefined ? Math.round((now - meta.presentationTime) * 10) / 10 : null,
      meta?.presentationTime !== undefined && meta?.captureTime !== undefined
        ? Math.round((meta.presentationTime - meta.captureTime) * 10) / 10
        : null,
    ])
  }

  // Timing model (EMPIRICAL — measured by the oracle, do not "improve" from
  // first principles): stamp at drawImage sampling wall time; anchor shifted
  // +PRESENTATION_LAG_MS. An rVFC captureTime anchor measured WORSE (+25ms
  // mean bias, 2026-07-16 ×10 matrix) because drawImage samples the PRESENTED
  // frame, not the captured one. rVFC's value here is cadence, not stamps.
  const encodeOne = (): boolean => {
    if (stopped || encodeError || encoder.state !== 'configured') return false
    if (videoEl.readyState < 2 || videoEl.videoWidth === 0) return false
    // Never block the sampler on the encoder (that stall was the sync-outlier
    // source) — drop this frame and let the next one carry the timeline.
    if (encoder.encodeQueueSize >= MAX_ENCODER_QUEUE) {
      framesDropped++
      return false
    }

    const now = performance.now()
    if (firstWallMs === null) {
      firstWallMs = now
      startOffsetMs = now - opts.epoch + PRESENTATION_LAG_MS
      diag.offsetMs = Math.round(startOffsetMs * 10) / 10
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

  // PRIMARY: MediaStreamTrackProcessor — frames arrive straight off the
  // capture path carrying their own µs timestamps: no <video> presentation
  // pipeline (whose 0–2-frame depth was the unobservable ±15ms sync variance),
  // no compositor throttling. Encoder-busy drops the frame (never blocks the
  // reader — EE's original stall objection). Per-frame ts = source-clock delta
  // from frame 0; anchor = wall clock at first frame read (delivery ≈ instant).
  const TP = trackProcessorCtor()
  let firstSrcTsUs: number | null = null
  let cancelReader: (() => void) | null = null
  /**
   * Min-filter anchor (the measured-audio trick): the first frame read may
   * have been CAPTURED long before we read it (queued during setup), so
   * readWall anchors late → uniform positive sync bias. Delivery can only be
   * late, never early, so candidates (readWall − srcClockDelta) are one-sided
   * and their MIN converges on the true capture wall of frame 0.
   */
  const ANCHOR_WINDOW_US = 3_000_000
  let anchorWallMs = Infinity

  const handleTpFrame = (frame: VideoFrame): void => {
    try {
      if (stopped || encodeError || encoder.state !== 'configured') return
      if (encoder.encodeQueueSize >= MAX_ENCODER_QUEUE) {
        framesDropped++
        return
      }
      const readWall = performance.now()
      if (firstWallMs === null || firstSrcTsUs === null) {
        firstWallMs = readWall
        firstSrcTsUs = frame.timestamp
        startOffsetMs = readWall - opts.epoch
        diag.offsetMs = Math.round(startOffsetMs * 10) / 10
        resolveFirst(startOffsetMs)
        console.info(
          `[capture] measured video ${opts.kind} first-frame offset=${startOffsetMs.toFixed(1)}ms ` +
            `path=trackprocessor size=${frame.displayWidth}x${frame.displayHeight}→${width}x${height} ` +
            `codec=${config.codec}`,
        )
      }
      const srcTs = Math.max(0, frame.timestamp - firstSrcTsUs)
      if (srcTs <= ANCHOR_WINDOW_US) {
        const cand = readWall - srcTs / 1000
        if (cand < anchorWallMs) anchorWallMs = cand
      }
      const timestampUs = Math.max(lastEncodedTsUs + 1, srcTs)
      lastEncodedTsUs = timestampUs
      framesIn++
      // Diag second column = delivery jitter: read wall vs source-clock position.
      recordDiag('t', readWall, { presentationTime: firstWallMs + timestampUs / 1000 })

      const tSec = timestampUs / 1e6
      const keyFrame = tSec - lastKeySec >= KEYFRAME_INTERVAL_S
      if (keyFrame) lastKeySec = tSec

      ctx.drawImage(frame, 0, 0, width, height)
      const scaled = new VideoFrame(canvas, { timestamp: timestampUs, duration: FRAME_DURATION_US })
      try {
        encoder.encode(scaled, { keyFrame })
      } finally {
        scaled.close()
      }
    } finally {
      frame.close()
    }
  }

  const rvfcEl = videoEl as RvfcVideo
  let rvfcId = 0
  let pump: Promise<void>
  if (TP) {
    const reader = new TP({ track: opts.track }).readable.getReader()
    cancelReader = () => void reader.cancel().catch(() => undefined)
    pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done || stopped) {
            value?.close()
            break
          }
          try {
            handleTpFrame(value)
          } catch (err) {
            if (!encodeError) encodeError = err instanceof Error ? err : new Error(String(err))
          }
        }
      } catch (err) {
        if (!encodeError) encodeError = err instanceof Error ? err : new Error(String(err))
      }
    })()
  } else {
    // FALLBACK: rVFC-cadenced <video> sampler + paced watchdog (wall stamps).
    const hasRvfc = typeof rvfcEl.requestVideoFrameCallback === 'function'
    // Head start: let rVFC deliver the anchor frame before the watchdog may.
    let lastSampleAt = performance.now()
    const onFrame = (now: number, meta: FrameMetadata): void => {
      if (stopped) return
      lastSampleAt = performance.now()
      try {
        if (encodeOne()) recordDiag('r', now, meta)
      } catch (err) {
        if (!encodeError) encodeError = err instanceof Error ? err : new Error(String(err))
      }
      if (!stopped && rvfcEl.requestVideoFrameCallback) {
        rvfcId = rvfcEl.requestVideoFrameCallback(onFrame)
      }
    }
    if (hasRvfc && rvfcEl.requestVideoFrameCallback) {
      rvfcId = rvfcEl.requestVideoFrameCallback(onFrame)
    }

    pump = (async () => {
      try {
        for (let i = 0; i < 100 && videoEl.videoWidth === 0 && !stopped; i++) await sleep(20)
        let nextDue = performance.now()
        while (!stopped) {
          nextDue += FRAME_PERIOD_MS
          const sinceSample = performance.now() - lastSampleAt
          if (!hasRvfc || sinceSample >= 2 * FRAME_PERIOD_MS) {
            try {
              if (encodeOne()) recordDiag('w', performance.now())
            } catch (err) {
              if (!encodeError) encodeError = err instanceof Error ? err : new Error(String(err))
              break
            }
          }
          if (encodeError) break
          const delay = nextDue - performance.now()
          if (!stopped && delay > 0) await sleep(delay)
          if (performance.now() > nextDue + FRAME_PERIOD_MS) nextDue = performance.now()
        }
      } catch (err) {
        if (!encodeError) encodeError = err instanceof Error ? err : new Error(String(err))
      }
    })()
  }

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
    if (!TP && !cancel && !encodeError && encoder.state === 'configured' && firstWallMs !== null) {
      try {
        encodeOne()
      } catch (err) {
        if (!encodeError) encodeError = err instanceof Error ? err : new Error(String(err))
      }
    }
    stopped = true
    if (rvfcId && rvfcEl.cancelVideoFrameCallback) rvfcEl.cancelVideoFrameCallback(rvfcId)
    cancelReader?.()
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
    } else if (TP && anchorWallMs !== Infinity) {
      // Refined min-filter anchor beats the provisional first-read value.
      startOffsetMs = Math.max(0, anchorWallMs - opts.epoch)
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
