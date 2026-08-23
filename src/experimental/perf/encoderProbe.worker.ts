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
  /**
   * 'paint'    — the worker paints its own canvas (the original probe)
   * 'transfer' — frames arrive TRANSFERRED from the main thread and are only
   *              counted and closed: the cost of the crossing, alone
   * 'composite'— transferred frames go through the PRODUCTION GL compositor and
   *              the encoder, i.e. everything v2 does except the muxer and disk
   */
  mode?: 'paint' | 'transfer' | 'composite'
}

interface FrameMsg {
  cmd: 'frame'
  frame: VideoFrame
  i: number
}

interface EndMsg {
  cmd: 'end'
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

/**
 * THE FED MODES. The main thread reads a real capture track and transfers each
 * VideoFrame here; this side either drops it on the floor ('transfer') or does
 * exactly what the production compositor does with it ('composite'). Between
 * the two, and against the 'paint' mode above, the crossing is priced on its
 * own instead of being the last unexamined suspect.
 */
async function runFed(msg: RunMsg): Promise<unknown> {
  const composite = msg.mode === 'composite'
  let comp: import('@core/capture/compositorGL').GLCompositor | null = null
  if (composite) {
    const { createGLCompositor } = await import('@core/capture/compositorGL')
    comp = createGLCompositor(msg.width, msg.height)
    if (!comp) return { error: 'no WebGL2 compositor in worker' }
  }
  let out = 0
  let bytes = 0
  let error: string | undefined
  let encoder: VideoEncoder | null = null
  if (composite) {
    encoder = new VideoEncoder({
      output: (chunk) => {
        out++
        bytes += chunk.byteLength
      },
      error: (err) => {
        error = String(err)
      },
    })
    encoder.configure({
      codec: 'avc1.4D402A',
      width: msg.width,
      height: msg.height,
      bitrate: 8_000_000,
      framerate: 30,
      hardwareAcceleration: msg.hardwareAcceleration,
      latencyMode: msg.latencyMode,
    })
  }

  let framesIn = 0
  let peakQueue = 0
  let dropped = 0
  let t0 = 0
  let tLast = 0
  /** Wall time from the frame ARRIVING to this side being done with it. */
  let handleMs = 0

  return new Promise((resolve) => {
    const finish = async (): Promise<void> => {
      if (encoder) await encoder.flush().catch(() => undefined)
      const wallMs = Math.round(tLast - t0)
      try {
        encoder?.close()
      } catch {
        /* already closed */
      }
      comp?.dispose()
      resolve({
        where: `worker:${msg.mode}`,
        hardwareAcceleration: msg.hardwareAcceleration,
        latencyMode: msg.latencyMode,
        framesIn,
        framesOut: composite ? out : framesIn,
        framesDropped: dropped,
        bytes,
        wallMs,
        msPerFrameHandled: framesIn > 0 ? Math.round((handleMs / framesIn) * 100) / 100 : 0,
        queueWaitMs: 0,
        peakQueue,
        fps: wallMs > 0 ? Math.round(((composite ? out : framesIn) / (wallMs / 1000)) * 10) / 10 : 0,
        error,
      })
    }
    self.onmessage = (ev: MessageEvent<FrameMsg | EndMsg>) => {
      const m = ev.data
      if (m.cmd === 'end') {
        void finish()
        return
      }
      const arrived = performance.now()
      if (t0 === 0) t0 = arrived
      tLast = arrived
      framesIn++
      if (!composite || !comp || !encoder) {
        m.frame.close()
        handleMs += performance.now() - arrived
        return
      }
      if (encoder.encodeQueueSize > peakQueue) peakQueue = encoder.encodeQueueSize
      if (encoder.encodeQueueSize >= msg.queueCap + 1) {
        // Same backpressure rule the production worker uses.
        dropped++
        m.frame.close()
        handleMs += performance.now() - arrived
        return
      }
      comp.begin(true)
      comp.draw(m.frame, 0, 0, msg.width, msg.height, 0, 0)
      m.frame.close()
      const frame = new VideoFrame(comp.canvas, {
        timestamp: Math.round((framesIn * 1e6) / 30),
        duration: Math.round(1e6 / 30),
      })
      try {
        encoder.encode(frame, { keyFrame: framesIn % 60 === 1 })
      } catch (err) {
        error = String(err)
      } finally {
        frame.close()
      }
      handleMs += performance.now() - arrived
    }
    self.postMessage({ ready: true })
  })
}

self.onmessage = (e: MessageEvent<RunMsg>) => {
  const mode = e.data.mode ?? 'paint'
  const job = mode === 'paint' ? run(e.data) : runFed(e.data)
  job.then(
    (result) => self.postMessage(result),
    (err) => self.postMessage({ error: err instanceof Error ? err.message : String(err) }),
  )
}
