/**
 * EXPERIMENTAL — O4: is WebCodecs the wall, or is our CONFIG the wall?
 *
 * The previous session isolated v2's ~10 fps to the encoder rather than to our
 * code (0.86 ms compositing, 0.05 ms making the VideoFrame, 0.03 ms in the
 * encode call, queue pinned at 5 of 6) and concluded "wait for a machine that
 * gives WebCodecs a real hardware encoder". That conclusion has an untested
 * assumption inside it: that `prefer-hardware` GOT hardware. Chrome accepts the
 * config either way and never says which it used.
 *
 * So this feeds the same shape of work — paint, make a VideoFrame, encode —
 * through a small matrix of configs and measures frames per second OUT. If
 * prefer-hardware and prefer-software land on the same number, the answer is
 * that everything here is software and the remedy is a config, not a machine.
 * If they differ, the wall is real and the deferral stands.
 *
 * No production code is touched: this is a measurement, not a change.
 */

interface ProbeConfig {
  label: string
  codec: string
  hardwareAcceleration: HardwareAcceleration
  latencyMode: LatencyMode
  /** Backpressure ceiling, mirroring the worker's own. */
  queueCap: number
  /**
   * Which canvas the VideoFrame comes from. The v2 compositor composites in
   * WebGL2 and encodes the GL canvas, and a GL-backed frame is not the same
   * object to an encoder as a 2D one — the GPU work behind it may still be in
   * flight when the encoder takes it.
   */
  source: '2d' | 'webgl2'
}

type HardwareAcceleration = 'no-preference' | 'prefer-hardware' | 'prefer-software'
type LatencyMode = 'quality' | 'realtime'

export interface ProbeResult {
  label: string
  source: string
  codec: string
  hardwareAcceleration: string
  latencyMode: string
  queueCap: number
  supported: boolean
  framesIn: number
  framesOut: number
  wallMs: number
  /** Frames the encoder actually produced per second of wall clock. */
  fps: number
  /** Time the feeder spent blocked on the queue — the encoder's own pace. */
  queueWaitMs: number
  peakQueue: number
  bytes: number
  /** Same config, run again in reverse order — an ordering check, not a retry. */
  fpsSecondPass?: number
  fpsWorst?: number
  error?: string
}

function paint(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, i: number): void {
  // Content matters: a static frame encodes for free and would measure nothing.
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

async function probeOne(cfg: ProbeConfig, frames: number, width: number, height: number): Promise<ProbeResult> {
  const base: ProbeResult = {
    label: cfg.label,
    source: cfg.source,
    codec: cfg.codec,
    hardwareAcceleration: cfg.hardwareAcceleration,
    latencyMode: cfg.latencyMode,
    queueCap: cfg.queueCap,
    supported: false,
    framesIn: 0,
    framesOut: 0,
    wallMs: 0,
    fps: 0,
    queueWaitMs: 0,
    peakQueue: 0,
    bytes: 0,
  }
  const config: VideoEncoderConfig = {
    codec: cfg.codec,
    width,
    height,
    bitrate: 8_000_000,
    framerate: 30,
    hardwareAcceleration: cfg.hardwareAcceleration,
    latencyMode: cfg.latencyMode,
  }
  try {
    const support = await VideoEncoder.isConfigSupported(config)
    base.supported = !!support.supported
    if (!base.supported) return base
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err)
    return base
  }

  const canvas = new OffscreenCanvas(width, height)
  const ctx = cfg.source === '2d' ? canvas.getContext('2d', { alpha: false }) : null
  const glCtx = cfg.source === 'webgl2' ? canvas.getContext('webgl2', { alpha: false }) : null
  if (cfg.source === '2d' && !ctx) {
    base.error = 'no 2d context'
    return base
  }
  if (cfg.source === 'webgl2' && !glCtx) {
    base.error = 'no webgl2 context'
    return base
  }
  let out = 0
  let bytes = 0
  const encoder = new VideoEncoder({
    output: (chunk) => {
      out++
      bytes += chunk.byteLength
    },
    error: (err) => {
      base.error = String(err)
    },
  })
  try {
    encoder.configure(config)
    const t0 = performance.now()
    let queueWait = 0
    for (let i = 0; i < frames; i++) {
      if (ctx) paint(ctx, width, height, i)
      else if (glCtx) {
        // Same shape of GPU work the compositor does: draw, then hand the
        // canvas straight to a VideoFrame with no readback of our own.
        glCtx.viewport(0, 0, width, height)
        glCtx.clearColor((i % 60) / 60, 0.3, 1 - (i % 60) / 60, 1)
        glCtx.clear(glCtx.COLOR_BUFFER_BIT)
        glCtx.enable(glCtx.SCISSOR_TEST)
        glCtx.scissor((i * 23) % width, Math.round(height * 0.3), 200, Math.round(height * 0.25))
        glCtx.clearColor(1, 1, 1, 1)
        glCtx.clear(glCtx.COLOR_BUFFER_BIT)
        glCtx.disable(glCtx.SCISSOR_TEST)
      }
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / 30) })
      if (encoder.encodeQueueSize > base.peakQueue) base.peakQueue = encoder.encodeQueueSize
      const w0 = performance.now()
      while (encoder.encodeQueueSize > cfg.queueCap) {
        await new Promise((r) => setTimeout(r, 1))
        if (base.error) break
      }
      queueWait += performance.now() - w0
      if (base.error) {
        frame.close()
        break
      }
      encoder.encode(frame, { keyFrame: i % 60 === 0 })
      frame.close()
      base.framesIn++
    }
    await encoder.flush()
    base.wallMs = Math.round(performance.now() - t0)
    base.queueWaitMs = Math.round(queueWait)
    base.framesOut = out
    base.bytes = bytes
    base.fps = base.wallMs > 0 ? Math.round((out / (base.wallMs / 1000)) * 10) / 10 : 0
    return base
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err)
    return base
  } finally {
    try {
      encoder.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * The production compositor path, minus the worker and the muxer: real captured
 * VideoFrames uploaded into the GL compositor, then encoded. This is the last
 * bisect step — if THIS is slow while a bare GL canvas is fast, the cost is the
 * texture upload of a capture frame, which is exactly what WebGPU's
 * importExternalTexture exists to remove.
 */
export async function probeCompositorPath(
  frames: number,
  width: number,
  height: number,
): Promise<ProbeResult> {
  const base: ProbeResult = {
    label: 'production GL compositor + real capture frames',
    source: 'webgl2+texImage2D',
    codec: 'avc1.4D402A',
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
    queueCap: 5,
    supported: true,
    framesIn: 0,
    framesOut: 0,
    wallMs: 0,
    fps: 0,
    queueWaitMs: 0,
    peakQueue: 0,
    bytes: 0,
  }
  const TP = (globalThis as { MediaStreamTrackProcessor?: new (i: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } })
    .MediaStreamTrackProcessor
  if (!TP) {
    base.error = 'MediaStreamTrackProcessor unavailable'
    return base
  }
  const { createGLCompositor } = await import('@core/capture/compositorGL')
  const comp = createGLCompositor(width, height)
  if (!comp) {
    base.error = 'no WebGL2 compositor'
    return base
  }
  // A source that genuinely repaints, captured as a real MediaStream — the
  // frames the compositor gets in production are capture frames, not canvases.
  const src = new OffscreenCanvas(width, height)
  const sctx = src.getContext('2d', { alpha: false })!
  const bridge = document.createElement('canvas')
  bridge.width = width
  bridge.height = height
  const bctx = bridge.getContext('2d', { alpha: false })!
  let raf = 0
  let i = 0
  const tick = (): void => {
    paint(sctx, width, height, i++)
    bctx.drawImage(src, 0, 0)
    raf = requestAnimationFrame(tick)
  }
  tick()
  const stream = bridge.captureStream(60)
  const track = stream.getVideoTracks()[0]!
  const reader = new TP({ track }).readable.getReader()

  let out = 0
  let bytes = 0
  const encoder = new VideoEncoder({
    output: (chunk) => {
      out++
      bytes += chunk.byteLength
    },
    error: (err) => {
      base.error = String(err)
    },
  })
  try {
    encoder.configure({
      codec: base.codec,
      width,
      height,
      bitrate: 8_000_000,
      framerate: 30,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'realtime',
    })
    const t0 = performance.now()
    let queueWait = 0
    while (base.framesIn < frames) {
      const { value, done } = await reader.read()
      if (done || !value) break
      comp.begin(true)
      comp.draw(value, 0, 0, width, height, 0, 0)
      value.close()
      const frame = new VideoFrame(comp.canvas, {
        timestamp: Math.round((base.framesIn * 1e6) / 30),
        duration: Math.round(1e6 / 30),
      })
      if (encoder.encodeQueueSize > base.peakQueue) base.peakQueue = encoder.encodeQueueSize
      const w0 = performance.now()
      while (encoder.encodeQueueSize > base.queueCap) {
        await new Promise((r) => setTimeout(r, 1))
        if (base.error) break
      }
      queueWait += performance.now() - w0
      if (base.error) {
        frame.close()
        break
      }
      encoder.encode(frame, { keyFrame: base.framesIn % 60 === 0 })
      frame.close()
      base.framesIn++
    }
    await encoder.flush()
    base.wallMs = Math.round(performance.now() - t0)
    base.queueWaitMs = Math.round(queueWait)
    base.framesOut = out
    base.bytes = bytes
    base.fps = base.wallMs > 0 ? Math.round((out / (base.wallMs / 1000)) * 10) / 10 : 0
    return base
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err)
    return base
  } finally {
    cancelAnimationFrame(raf)
    try {
      encoder.close()
    } catch {
      /* already closed */
    }
    await reader.cancel().catch(() => undefined)
    track.stop()
    comp.dispose()
  }
}

/** The same loop, inside a worker — see encoderProbe.worker.ts. */
async function probeInWorker(
  frames: number,
  width: number,
  height: number,
  hardwareAcceleration: HardwareAcceleration,
  latencyMode: LatencyMode,
): Promise<Record<string, unknown>> {
  const worker = new Worker(new URL('./encoderProbe.worker.ts', import.meta.url), { type: 'module' })
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker probe timed out')), 120_000)
      worker.onmessage = (e: MessageEvent<Record<string, unknown>>) => {
        clearTimeout(timer)
        resolve(e.data)
      }
      worker.onerror = (e) => {
        clearTimeout(timer)
        reject(new Error(e.message))
      }
      worker.postMessage({ frames, width, height, hardwareAcceleration, latencyMode, queueCap: 5 })
    })
  } finally {
    worker.terminate()
  }
}

export interface EncoderProbeReport {
  width: number
  height: number
  frames: number
  results: ProbeResult[]
  /** The decisive comparison: identical loop, main thread vs worker. */
  worker: Record<string, unknown>[]
  verdict: {
    bestFps: number
    bestLabel: string
    /** prefer-hardware ÷ prefer-software on the same codec. ~1 means the two
     *  are the same encoder, i.e. nothing here is running in hardware. */
    hardwareOverSoftware: number | null
    realtimeOverQuality: number | null
    /** WebGL2-sourced fps ÷ 2D-sourced fps, same encoder config. */
    webgl2Over2d: number | null
  }
  notes: string[]
}

export async function runEncoderProbe(
  opts: { frames?: number; width?: number; height?: number } = {},
): Promise<EncoderProbeReport> {
  const frames = opts.frames ?? 60
  const width = opts.width ?? 1920
  const height = opts.height ?? 1080
  const codecs = ['avc1.4D402A', 'avc1.640028']
  const configs: ProbeConfig[] = []
  for (const codec of codecs) {
    for (const hardwareAcceleration of [
      'prefer-hardware',
      'no-preference',
      'prefer-software',
    ] as HardwareAcceleration[]) {
      for (const latencyMode of ['realtime', 'quality'] as LatencyMode[]) {
        configs.push({
          label: `${codec} ${hardwareAcceleration} ${latencyMode}`,
          codec,
          hardwareAcceleration,
          latencyMode,
          queueCap: 5,
          source: '2d',
        })
      }
    }
  }
  // The comparison that matters for v2: the same encode, fed from a WebGL2
  // canvas instead of a 2D one.
  for (const hardwareAcceleration of ['prefer-hardware', 'prefer-software'] as HardwareAcceleration[]) {
    configs.push({
      label: `avc1.4D402A ${hardwareAcceleration} realtime WEBGL2`,
      codec: 'avc1.4D402A',
      hardwareAcceleration,
      latencyMode: 'realtime',
      queueCap: 5,
      source: 'webgl2',
    })
  }
  // One deep-queue variant: the worker caps backpressure at 5, and a cap that
  // is too tight can starve an encoder that likes to work in batches.
  configs.push({
    label: 'avc1.4D402A prefer-hardware realtime queue30',
    codec: 'avc1.4D402A',
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
    queueCap: 30,
    source: '2d',
  })

  // WARM-UP, thrown away. The first encode of a session pays for GPU/driver
  // setup and JIT, and the first row of a matrix would otherwise be charged for
  // it — which is exactly how a config gets blamed for being slow.
  await probeOne(configs[0]!, Math.min(30, frames), width, height)

  const results: ProbeResult[] = []
  // Two passes in OPPOSITE order: if a config is slow in both, it is the
  // config; if it is only slow when it runs first, it was the ordering.
  for (const cfg of configs) {
    results.push(await probeOne(cfg, frames, width, height))
    await new Promise((r) => setTimeout(r, 300))
  }
  for (const cfg of [...configs].reverse()) {
    const second = await probeOne(cfg, frames, width, height)
    const first = results.find((r) => r.label === cfg.label)
    if (first) {
      first.fpsSecondPass = second.fps
      // Report the WORSE of the two: a config that is only fast sometimes is
      // not a config we can build an engine on.
      first.fpsWorst = Math.min(first.fps, second.fps)
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  results.push(await probeCompositorPath(frames, width, height))

  // Warm-up in the worker too, for the same reason it exists on this thread.
  await probeInWorker(Math.min(30, frames), width, height, 'prefer-hardware', 'realtime').catch(
    () => ({}),
  )
  const worker: Record<string, unknown>[] = []
  for (const hw of ['prefer-hardware', 'prefer-software'] as HardwareAcceleration[]) {
    worker.push(
      await probeInWorker(frames, width, height, hw, 'realtime').catch((err: unknown) => ({
        where: 'worker',
        hardwareAcceleration: hw,
        error: err instanceof Error ? err.message : String(err),
      })),
    )
  }

  const ok = results.filter((r) => r.supported && !r.error && r.fps > 0)
  const worstOf = (r: ProbeResult): number => r.fpsWorst ?? r.fps
  const best = ok.reduce<ProbeResult | null>((a, b) => (!a || worstOf(b) > worstOf(a) ? b : a), null)
  const pick = (hw: string, lat: string): number | null => {
    const r = ok.find(
      (x) => x.codec === 'avc1.4D402A' && x.hardwareAcceleration === hw && x.latencyMode === lat && x.queueCap === 5,
    )
    return r ? worstOf(r) : null
  }
  const hwFps = pick('prefer-hardware', 'realtime')
  const swFps = pick('prefer-software', 'realtime')
  const rtFps = hwFps
  const qFps = pick('prefer-hardware', 'quality')
  return {
    width,
    height,
    frames,
    results,
    worker,
    verdict: {
      bestFps: best ? worstOf(best) : 0,
      bestLabel: best?.label ?? 'none',
      hardwareOverSoftware:
        hwFps !== null && swFps !== null && swFps > 0 ? Math.round((hwFps / swFps) * 100) / 100 : null,
      realtimeOverQuality:
        rtFps !== null && qFps !== null && qFps > 0 ? Math.round((rtFps / qFps) * 100) / 100 : null,
      webgl2Over2d: (() => {
        const gl = ok.find((x) => x.source === 'webgl2' && x.hardwareAcceleration === 'prefer-hardware')
        return gl && hwFps ? Math.round((worstOf(gl) / hwFps) * 100) / 100 : null
      })(),
    },
    notes: [
      'this feeds the same shape of work the v2 compositor does — paint, make a VideoFrame, encode — with the same backpressure ceiling, so its fps is directly comparable with the compositor deliveredFps',
      'hardwareOverSoftware ~1.0 means prefer-hardware and prefer-software landed on the SAME encoder: nothing here is accelerated, and the remedy is a config or a platform, not patience',
      'isConfigSupported says nothing about hardware — Chrome accepts these configs either way, which is exactly why this measurement exists',
    ],
  }
}
