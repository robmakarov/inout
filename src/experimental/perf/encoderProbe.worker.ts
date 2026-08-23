/**
 * EXPERIMENTAL — the same encoder probe, INSIDE A WORKER.
 *
 * Everything else about v2's throughput has been eliminated with numbers (the
 * encoder, the codec, hardwareAcceleration, latencyMode, the queue cap, the GL
 * canvas, the texture upload of real capture frames, the muxer, the disk write
 * and the disk barrier). One variable was never tested because it is the one
 * thing the main thread cannot check about itself: v2 encodes in a WORKER.
 *
 * So this runs the identical loop here. Same painting, same backpressure, same
 * config. If a worker-side encoder is fast, the wall is in how frames reach the
 * compositor; if it is slow, the wall is the worker itself and v2's premise —
 * "take capture off the main thread" — collides with the platform.
 */

interface RunMsg {
  frames: number
  width: number
  height: number
  hardwareAcceleration: 'no-preference' | 'prefer-hardware' | 'prefer-software'
  latencyMode: 'quality' | 'realtime'
  queueCap: number
}

function paint(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, i: number): void {
  const hue = (i * 7) % 360
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, `hsl(${hue}, 60%, 22%)`)
  g.addColorStop(1, `hsl(${(hue + 80) % 360}, 60%, 38%)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(((i * 23) % (w + 200)) - 200, h * 0.3, 200, h * 0.25)
  ctx.font = `bold ${Math.round(h / 8)}px monospace`
  ctx.fillText(String(i), w * 0.05, h * 0.8)
}

async function run(msg: RunMsg): Promise<unknown> {
  const canvas = new OffscreenCanvas(msg.width, msg.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return { error: 'no 2d context in worker' }
  let out = 0
  let bytes = 0
  let error: string | undefined
  const encoder = new VideoEncoder({
    output: (chunk) => {
      out++
      bytes += chunk.byteLength
    },
    error: (err) => {
      error = String(err)
    },
  })
  const config: VideoEncoderConfig = {
    codec: 'avc1.4D402A',
    width: msg.width,
    height: msg.height,
    bitrate: 8_000_000,
    framerate: 30,
    hardwareAcceleration: msg.hardwareAcceleration,
    latencyMode: msg.latencyMode,
  }
  const support = await VideoEncoder.isConfigSupported(config)
  if (!support.supported) return { error: 'config unsupported in worker' }
  encoder.configure(config)
  const t0 = performance.now()
  let queueWait = 0
  let framesIn = 0
  let peakQueue = 0
  for (let i = 0; i < msg.frames; i++) {
    paint(ctx, msg.width, msg.height, i)
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / 30) })
    if (encoder.encodeQueueSize > peakQueue) peakQueue = encoder.encodeQueueSize
    const w0 = performance.now()
    while (encoder.encodeQueueSize > msg.queueCap) {
      await new Promise((r) => setTimeout(r, 1))
      if (error) break
    }
    queueWait += performance.now() - w0
    if (error) {
      frame.close()
      break
    }
    encoder.encode(frame, { keyFrame: i % 60 === 0 })
    frame.close()
    framesIn++
  }
  await encoder.flush()
  const wallMs = Math.round(performance.now() - t0)
  try {
    encoder.close()
  } catch {
    /* already closed */
  }
  return {
    where: 'worker',
    hardwareAcceleration: msg.hardwareAcceleration,
    latencyMode: msg.latencyMode,
    framesIn,
    framesOut: out,
    bytes,
    wallMs,
    queueWaitMs: Math.round(queueWait),
    peakQueue,
    fps: wallMs > 0 ? Math.round((out / (wallMs / 1000)) * 10) / 10 : 0,
    error,
  }
}

self.onmessage = (e: MessageEvent<RunMsg>) => {
  run(e.data).then(
    (result) => self.postMessage(result),
    (err) => self.postMessage({ error: err instanceof Error ? err.message : String(err) }),
  )
}
