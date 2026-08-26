/**
 * EXPERIMENTAL — O4: WHICH HALF IS SLOW, THE WORKER FILE OR ITS ENVIRONMENT?
 *
 * The fifth session left a paradox: encoderProbe.worker.ts runs v2's entire
 * data path at 60 fps with 13 ms of encoder latency, while compositor.worker.ts
 * in situ encodes 9 frames of 452 with the encoder returning each one ~4.5 s
 * late — and the in-situ worker's own JS is measurably idle (handler 78 ms of a
 * 10 s take). Every in-engine A/B kept the ENGINE's environment; every fast
 * probe cell ran in a bare rig. Nothing has ever crossed them.
 *
 * So this drives the PRODUCTION worker file — untouched — from the probe's own
 * feeder, and then adds the engine environment back one piece at a time:
 *
 *   control    encoderProbe.worker.ts, composite+mux — the known-fast cell,
 *              re-measured so every comparison below is same-day, same-machine
 *   bare       compositor.worker.ts, no AudioContext anywhere on the page
 *   idlectx    + an AudioContext with the tap worklet ticking but NO audio
 *              source and NO AudioEncoder (sampleRate:null) — this is exactly
 *              what the "noAudio" in-situ A/B still had, and the probe never did
 *   audio      + a real oscillator mix tapped as PCM batches into the worker,
 *              AudioEncoder configured (sampleRate 48000) — full in-situ audio
 *
 * If `bare` is slow, the difference is in the FILE after all. If `bare` is fast
 * and a later cell collapses, the added piece is the wall. If everything here
 * is fast, the wall is in what remains of liveCompositeV2: the pump loop, the
 * liveness bookkeeping, or the rig's own second AudioContext.
 */

import { blobStore } from '@core/store'
import { startLiveCompositeV2 } from '@core/capture/liveCompositeV2'
import { warmVideoEncoder } from '@core/capture/encoderWarm'
import type {
  CompositorMsg,
  CompositorReply,
  CompositorStats,
} from '@core/capture/compositor.worker'

/** Same painted content as encoderProbe's rig, so fps numbers are comparable. */
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

interface TrackProcessorLike {
  readable: ReadableStream<VideoFrame>
}
type TPCtor = new (init: { track: MediaStreamTrack }) => TrackProcessorLike

function trackProcessor(): TPCtor | null {
  const g = globalThis as { MediaStreamTrackProcessor?: TPCtor }
  return typeof g.MediaStreamTrackProcessor === 'function' ? g.MediaStreamTrackProcessor : null
}

/**
 * The o4step2 RIG's sources, reproduced exactly: the screen canvas is painted
 * DIRECTLY (no OffscreenCanvas bridge), with the default alpha-carrying 2D
 * context, full-surface gradient + moving bar + frame counter per rAF — which
 * on this display is ~120 paints/s into a captureStream(60).
 */
function makeRigSources(width: number, height: number): {
  screen: MediaStreamTrack
  camera: MediaStreamTrack
  screenStream: MediaStream
  cameraStream: MediaStream
  stop: () => void
} {
  const screen = document.createElement('canvas')
  screen.width = width
  screen.height = height
  const sg = screen.getContext('2d')!
  const cam = document.createElement('canvas')
  cam.width = 640
  cam.height = 480
  const cg = cam.getContext('2d')!
  let frames = 0
  let raf = 0
  const t0 = performance.now()
  const draw = (): void => {
    const t = (performance.now() - t0) / 1000
    const hue = (t * 40) % 360
    const grad = sg.createLinearGradient(0, 0, width, height)
    grad.addColorStop(0, `hsl(${hue}, 55%, 18%)`)
    grad.addColorStop(1, `hsl(${(hue + 90) % 360}, 55%, 32%)`)
    sg.fillStyle = grad
    sg.fillRect(0, 0, width, height)
    sg.fillStyle = '#ffffff'
    const bar = width / 8
    sg.fillRect(((t * width) / 2) % (width + bar) - bar, 0, bar, height)
    sg.font = `bold ${Math.round(height / 8)}px monospace`
    sg.fillText(String(frames), width * 0.1, height * 0.5)
    cg.fillStyle = '#7f7f7f'
    cg.fillRect(0, 0, 640, 480)
    cg.fillStyle = '#e2554f'
    cg.beginPath()
    cg.arc(320 + Math.sin(t * 3) * 200, 240 + Math.cos(t * 2) * 150, 48, 0, Math.PI * 2)
    cg.fill()
    frames++
    raf = requestAnimationFrame(draw)
  }
  draw()
  const screenStream = screen.captureStream(60)
  const cameraStream = cam.captureStream(30)
  const st = screenStream.getVideoTracks()[0]!
  const ct = cameraStream.getVideoTracks()[0]!
  return {
    screen: st,
    camera: ct,
    screenStream,
    cameraStream,
    stop: () => {
      cancelAnimationFrame(raf)
      st.stop()
      ct.stop()
    },
  }
}

/** The probe's two synthetic sources: a repainting 1080p screen + a 640×480 cam. */
function makeSources(width: number, height: number): {
  screen: MediaStreamTrack
  camera: MediaStreamTrack
  stop: () => void
} {
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
  const cam = document.createElement('canvas')
  cam.width = 640
  cam.height = 480
  const cctx = cam.getContext('2d', { alpha: false })!
  let j = 0
  let camRaf = 0
  const camTick = (): void => {
    cctx.fillStyle = '#7f7f7f'
    cctx.fillRect(0, 0, 640, 480)
    cctx.fillStyle = '#e2554f'
    cctx.beginPath()
    cctx.arc(320 + Math.sin(j / 12) * 200, 240 + Math.cos(j / 18) * 150, 48, 0, Math.PI * 2)
    cctx.fill()
    j++
    camRaf = requestAnimationFrame(camTick)
  }
  camTick()
  const screen = bridge.captureStream(60).getVideoTracks()[0]!
  const camera = cam.captureStream(30).getVideoTracks()[0]!
  return {
    screen,
    camera,
    stop: () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(camRaf)
      screen.stop()
      camera.stop()
    },
  }
}

/**
 * The tap worklet, same shape as liveCompositeV2's: batches ~1024 frames of
 * PCM, and while it has never seen a live sample it posts a bare tick every
 * 6 quanta — which is what the engine's main thread receives 60×/s even on a
 * silent take.
 */
const TAP_SOURCE = `
class ExpBisectTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = []
    this.frames = 0
    this.channels = 2
    this.sawLive = false
    this.silentTicks = 0
  }
  process(inputs) {
    const chans = inputs[0]
    const live = chans && chans.length && chans[0] && chans[0].length
    if (!live && !this.sawLive) {
      this.silentTicks++
      if (this.silentTicks >= 6) {
        this.silentTicks = 0
        this.port.postMessage({ tick: true })
      }
      return true
    }
    const n = live ? chans[0].length : 128
    if (live) {
      this.sawLive = true
      this.channels = chans.length
      const copy = []
      for (let c = 0; c < chans.length; c++) copy.push(chans[c].slice(0))
      this.buf.push({ n, data: copy })
    } else {
      this.buf.push({ n, data: null })
    }
    this.frames += n
    if (this.frames >= 1024) {
      const total = this.frames
      const ch = this.channels
      const planar = new Float32Array(ch * total)
      let off = 0
      for (const q of this.buf) {
        if (q.data) {
          for (let c = 0; c < ch && c < q.data.length; c++) planar.set(q.data[c], c * total + off)
        }
        off += q.n
      }
      this.port.postMessage({ frames: total, channels: ch, planar }, [planar.buffer])
      this.buf = []
      this.frames = 0
    }
    return true
  }
}
registerProcessor('exp-bisect-tap', ExpBisectTap)
`

interface AudioEnv {
  sampleRate: number | null
  /** Wired by the caller once the worker is ready; null = drop batches. */
  onBatch: ((b: { planar: Float32Array; frames: number; channels: number }) => void) | null
  ticks: number
  batches: number
  close: () => Promise<void>
}

/** 'idle' = context + ticking tap, no source (the noAudio in-situ shape).
 *  'live' = oscillator mix tapped as PCM, exactly the engine's audio side. */
async function makeAudioEnv(mode: 'idle' | 'live'): Promise<AudioEnv> {
  const ctx = new AudioContext({ sampleRate: 48000 })
  const url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(url)
  const tap = new AudioWorkletNode(ctx, 'exp-bisect-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  })
  let osc: OscillatorNode | null = null
  if (mode === 'live') {
    osc = new OscillatorNode(ctx, { frequency: 440 })
    const gain = new GainNode(ctx, { gain: 0.2 })
    const dest = ctx.createMediaStreamDestination()
    osc.connect(gain).connect(dest)
    osc.start()
    ctx.createMediaStreamSource(dest.stream).connect(tap)
  }
  tap.connect(ctx.destination)
  await ctx.resume()
  const env: AudioEnv = {
    sampleRate: mode === 'live' ? ctx.sampleRate : null,
    onBatch: null,
    ticks: 0,
    batches: 0,
    close: async () => {
      tap.port.onmessage = null
      try {
        osc?.stop()
      } catch {
        /* already stopped */
      }
      try {
        tap.disconnect()
      } catch {
        /* already gone */
      }
      if (ctx.state !== 'closed') await ctx.close().catch(() => undefined)
      URL.revokeObjectURL(url)
    },
  }
  tap.port.onmessage = (
    ev: MessageEvent<{ tick?: boolean; frames?: number; channels?: number; planar?: Float32Array }>,
  ) => {
    if (ev.data.tick) {
      env.ticks++
      return
    }
    const { frames, channels, planar } = ev.data
    if (!frames || !channels || !planar) return
    env.batches++
    env.onBatch?.({ planar, frames, channels })
  }
  return env
}

export interface BisectCell {
  cell: string
  framesFed: number
  framesIn: number
  framesEncoded: number
  framesDropped: number
  framesGated: number
  /** framesEncoded ÷ the feed's own wall clock — the throughput verdict. */
  encodedFps: number
  msPerEncodeLatency: number
  peakQueue: number
  feedMs: number
  handlerMs: number
  idleMs: number
  outputMs: number
  muxMs: number
  writeMs: number
  flushMs: number
  bytes: number
  codec: string | null
  hardware: string | null
  backend: string | null
  audioTicks: number
  audioBatches: number
  /** mainwarm cell only: what the main-thread encoder warm itself cost. */
  warmMs?: number
  error?: string
}

/** Drives the PRODUCTION compositor.worker.ts exactly as the probe feeder
 *  drives its own worker: transferred frames at source rate, then stop. */
async function runProductionCell(
  cell: string,
  frames: number,
  width: number,
  height: number,
  audioMode: 'none' | 'idle' | 'live',
  sourceKind: 'probe' | 'rig' = 'probe',
): Promise<BisectCell> {
  const base: BisectCell = {
    cell,
    framesFed: 0,
    framesIn: 0,
    framesEncoded: 0,
    framesDropped: 0,
    framesGated: 0,
    encodedFps: 0,
    msPerEncodeLatency: 0,
    peakQueue: 0,
    feedMs: 0,
    handlerMs: 0,
    idleMs: 0,
    outputMs: 0,
    muxMs: 0,
    writeMs: 0,
    flushMs: 0,
    bytes: 0,
    codec: null,
    hardware: null,
    backend: null,
    audioTicks: 0,
    audioBatches: 0,
  }
  const TP = trackProcessor()
  if (!TP) return { ...base, error: 'MediaStreamTrackProcessor unavailable' }
  const audio = audioMode === 'none' ? null : await makeAudioEnv(audioMode)
  const key = `exp-o4worker-${cell}-${Date.now()}.mp4`
  const worker = new Worker(new URL('../../core/capture/compositor.worker.ts', import.meta.url), {
    type: 'module',
  })
  const sources = sourceKind === 'rig' ? makeRigSources(width, height) : makeSources(width, height)
  const screenReader = new TP({ track: sources.screen }).readable.getReader()
  const camReader = new TP({ track: sources.camera }).readable.getReader()
  try {
    const stats = await new Promise<CompositorStats>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('production cell timed out')), 120_000)
      let stopped = false
      worker.onmessage = (ev: MessageEvent<CompositorReply>) => {
        const reply = ev.data
        if ('event' in reply) {
          if (reply.event === 'error') {
            clearTimeout(timer)
            reject(new Error(reply.error))
          }
          return
        }
        if (!reply.ok) {
          clearTimeout(timer)
          reject(new Error(reply.error))
          return
        }
        if (reply.cmd === 'start') {
          void feed()
        } else if (reply.cmd === 'stop') {
          clearTimeout(timer)
          resolve(reply.stats)
        }
      }
      worker.onerror = (ev) => {
        clearTimeout(timer)
        reject(new Error(ev.message || 'worker failed'))
      }
      const feed = async (): Promise<void> => {
        if (audio) {
          audio.onBatch = (b) => {
            if (stopped) return
            worker.postMessage(
              {
                cmd: 'audio',
                planar: b.planar,
                frames: b.frames,
                channels: b.channels,
                atMs: performance.now(),
                recvMs: performance.now(),
              } satisfies CompositorMsg,
              [b.planar.buffer],
            )
          }
        }
        // The camera pump, independent, exactly as production runs one per source.
        void (async () => {
          for (;;) {
            const { value, done } = await camReader.read()
            if (done || !value) break
            if (stopped) {
              value.close()
              break
            }
            worker.postMessage(
              { cmd: 'frame', kind: 'camera', atMs: performance.now(), frame: value } satisfies CompositorMsg,
              [value],
            )
          }
        })().catch(() => undefined)
        const t0 = performance.now()
        let sent = 0
        while (sent < frames) {
          const { value, done } = await screenReader.read()
          if (done || !value) break
          worker.postMessage(
            { cmd: 'frame', kind: 'screen', atMs: performance.now(), frame: value } satisfies CompositorMsg,
            [value],
          )
          sent++
        }
        base.framesFed = sent
        base.feedMs = Math.round(performance.now() - t0)
        stopped = true
        worker.postMessage({ cmd: 'stop' } satisfies CompositorMsg)
      }
      worker.postMessage({
        cmd: 'start',
        key,
        width,
        height,
        fps: 30,
        videoBitrate: 8_000_000,
        audioBitrate: 128_000,
        sampleRate: audio?.sampleRate ?? null,
        channelCount: 2,
      } satisfies CompositorMsg)
    })
    base.framesIn = stats.framesIn
    base.framesEncoded = stats.framesEncoded
    base.framesDropped = stats.framesDropped
    base.framesGated = stats.framesGated
    base.encodedFps =
      base.feedMs > 0 ? Math.round((stats.framesEncoded / (base.feedMs / 1000)) * 10) / 10 : 0
    base.msPerEncodeLatency = Math.round(stats.encodeLatencyMs / Math.max(1, stats.outputs))
    base.peakQueue = stats.peakQueue
    base.handlerMs = Math.round(stats.handlerMs)
    base.idleMs = Math.round(stats.idleMs)
    base.outputMs = Math.round(stats.outputMs)
    base.muxMs = Math.round(stats.muxMs)
    base.writeMs = Math.round(stats.writeMs)
    base.flushMs = Math.round(stats.flushMs)
    base.bytes = stats.bytes
    base.codec = stats.codec
    base.hardware = stats.hardware
    base.backend = stats.backend
    return base
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  } finally {
    base.audioTicks = audio?.ticks ?? 0
    base.audioBatches = audio?.batches ?? 0
    if (audio) await audio.close()
    await screenReader.cancel().catch(() => undefined)
    await camReader.cancel().catch(() => undefined)
    sources.stop()
    worker.terminate()
    await blobStore.remove(key).catch(() => undefined)
  }
}

/**
 * The REAL engine main-thread half (startLiveCompositeV2, untouched) driven by
 * either source kind. Against `rigsrc` this splits what remains: if the engine
 * is slow on probe sources while the hand feeder is fast on them, the engine's
 * own main-thread half is the wall; if both are fast and only rig sources are
 * slow, the sources are.
 */
async function runEngineCell(
  cell: string,
  takeMs: number,
  width: number,
  height: number,
  sourceKind: 'probe' | 'rig',
  extras: { rigCtx?: boolean; observer?: boolean; oscAudio?: boolean } = {},
): Promise<BisectCell> {
  const base: BisectCell = {
    cell,
    framesFed: 0,
    framesIn: 0,
    framesEncoded: 0,
    framesDropped: 0,
    framesGated: 0,
    encodedFps: 0,
    msPerEncodeLatency: 0,
    peakQueue: 0,
    feedMs: takeMs,
    handlerMs: 0,
    idleMs: 0,
    outputMs: 0,
    muxMs: 0,
    writeMs: 0,
    flushMs: 0,
    bytes: 0,
    codec: null,
    hardware: null,
    backend: null,
    audioTicks: 0,
    audioBatches: 0,
  }
  const key = `exp-o4worker-${cell}-${Date.now()}.mp4`
  const src = sourceKind === 'rig' ? makeRigSources(width, height) : null
  const probeSrc = sourceKind === 'rig' ? null : makeSources(width, height)
  const screenStream = src ? src.screenStream : new MediaStream([probeSrc!.screen])
  const cameraStream = src ? src.cameraStream : new MediaStream([probeSrc!.camera])
  let degradeReason: string | null = null
  // The three things runEngine adds around the engine, reproducible one at a
  // time: its own AudioContext (created and resumed even for noAudio runs), a
  // longtask PerformanceObserver, and the oscillator audio input.
  let rigCtx: AudioContext | null = null
  let osc: OscillatorNode | null = null
  const audioIn: MediaStream[] = []
  if (extras.rigCtx || extras.oscAudio) {
    rigCtx = new AudioContext({ sampleRate: 48000 })
    await rigCtx.resume()
    if (extras.oscAudio) {
      osc = new OscillatorNode(rigCtx, { frequency: 440 })
      const gain = new GainNode(rigCtx, { gain: 0.2 })
      const dest = rigCtx.createMediaStreamDestination()
      osc.connect(gain).connect(dest)
      osc.start()
      audioIn.push(dest.stream)
    }
  }
  let observer: PerformanceObserver | null = null
  if (extras.observer) {
    try {
      observer = new PerformanceObserver(() => undefined)
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      observer = null
    }
  }
  try {
    const handle = await startLiveCompositeV2(
      { screen: screenStream, camera: cameraStream, audio: audioIn },
      key,
      { onDegrade: (reason) => (degradeReason = reason) },
    )
    await new Promise((r) => setTimeout(r, takeMs))
    await handle.stop().catch(() => null)
    const stats = handle.stats()
    if (stats) {
      base.framesIn = stats.framesIn
      base.framesEncoded = stats.framesEncoded
      base.framesDropped = stats.framesDropped
      base.framesGated = stats.framesGated
      base.encodedFps = Math.round((stats.framesEncoded / (takeMs / 1000)) * 10) / 10
      base.msPerEncodeLatency = Math.round(stats.encodeLatencyMs / Math.max(1, stats.outputs))
      base.peakQueue = stats.peakQueue
      base.handlerMs = Math.round(stats.handlerMs)
      base.idleMs = Math.round(stats.idleMs)
      base.outputMs = Math.round(stats.outputMs)
      base.muxMs = Math.round(stats.muxMs)
      base.writeMs = Math.round(stats.writeMs)
      base.flushMs = Math.round(stats.flushMs)
      base.bytes = stats.bytes
      base.codec = stats.codec
      base.hardware = stats.hardware
      base.backend = stats.backend
    }
    if (degradeReason) base.error = `degraded: ${degradeReason}`
    return base
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  } finally {
    observer?.disconnect()
    try {
      osc?.stop()
    } catch {
      /* already stopped */
    }
    if (rigCtx && rigCtx.state !== 'closed') await rigCtx.close().catch(() => undefined)
    src?.stop()
    probeSrc?.stop()
    await blobStore.remove(key).catch(() => undefined)
  }
}

/** The known-fast control: the probe worker, same feeder, same sources. */
async function runControlCell(frames: number, width: number, height: number): Promise<BisectCell> {
  const base: BisectCell = {
    cell: 'control-probe-worker',
    framesFed: 0,
    framesIn: 0,
    framesEncoded: 0,
    framesDropped: 0,
    framesGated: 0,
    encodedFps: 0,
    msPerEncodeLatency: 0,
    peakQueue: 0,
    feedMs: 0,
    handlerMs: 0,
    idleMs: 0,
    outputMs: 0,
    muxMs: 0,
    writeMs: 0,
    flushMs: 0,
    bytes: 0,
    codec: 'avc1.4D402A',
    hardware: 'prefer-hardware',
    backend: 'webgl2',
    audioTicks: 0,
    audioBatches: 0,
  }
  const TP = trackProcessor()
  if (!TP) return { ...base, error: 'MediaStreamTrackProcessor unavailable' }
  const worker = new Worker(new URL('./encoderProbe.worker.ts', import.meta.url), { type: 'module' })
  const sources = makeSources(width, height)
  const screenReader = new TP({ track: sources.screen }).readable.getReader()
  const camReader = new TP({ track: sources.camera }).readable.getReader()
  try {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe worker never ready')), 20_000)
      worker.onmessage = (e: MessageEvent<{ ready?: boolean; error?: string }>) => {
        if (e.data.error) {
          clearTimeout(timer)
          reject(new Error(e.data.error))
        } else if (e.data.ready) {
          clearTimeout(timer)
          resolve()
        }
      }
      worker.onerror = (e) => {
        clearTimeout(timer)
        reject(new Error(e.message))
      }
    })
    worker.postMessage({
      frames,
      width,
      height,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'realtime',
      queueCap: 5,
      mode: 'composite+mux',
      timestamps: 'wallclock',
    })
    await ready
    void (async () => {
      for (;;) {
        const { value, done } = await camReader.read()
        if (done || !value) break
        worker.postMessage({ cmd: 'frame', frame: value, i: -1, kind: 'camera' }, [
          value as unknown as Transferable,
        ])
      }
    })().catch(() => undefined)
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe cell timed out')), 120_000)
      worker.onmessage = (e: MessageEvent<Record<string, unknown>>) => {
        clearTimeout(timer)
        resolve(e.data)
      }
    })
    const t0 = performance.now()
    let sent = 0
    while (sent < frames) {
      const { value, done } = await screenReader.read()
      if (done || !value) break
      worker.postMessage({ cmd: 'frame', frame: value, i: sent, kind: 'screen' }, [
        value as unknown as Transferable,
      ])
      sent++
    }
    base.framesFed = sent
    base.feedMs = Math.round(performance.now() - t0)
    worker.postMessage({ cmd: 'end' })
    const r = (await result) as {
      framesIn?: number
      framesOut?: number
      framesDropped?: number
      msPerEncodeLatency?: number
      peakQueue?: number
      bytes?: number
      error?: string
    }
    base.framesIn = r.framesIn ?? 0
    base.framesEncoded = r.framesOut ?? 0
    base.framesDropped = r.framesDropped ?? 0
    base.encodedFps =
      base.feedMs > 0 ? Math.round(((r.framesOut ?? 0) / (base.feedMs / 1000)) * 10) / 10 : 0
    base.msPerEncodeLatency = r.msPerEncodeLatency ?? 0
    base.peakQueue = r.peakQueue ?? 0
    base.bytes = r.bytes ?? 0
    if (r.error) base.error = r.error
    return base
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await screenReader.cancel().catch(() => undefined)
    await camReader.cancel().catch(() => undefined)
    sources.stop()
    worker.terminate()
  }
}

export interface WorkerBisectReport {
  width: number
  height: number
  frames: number
  cells: BisectCell[]
  notes: string[]
}

export async function runWorkerBisect(
  opts: {
    frames?: number
    width?: number
    height?: number
    cells?: string[]
    /** false = measure COLD, exactly as every o4step2 v2 run ever ran. */
    warmup?: boolean
  } = {},
): Promise<WorkerBisectReport> {
  const frames = opts.frames ?? 600
  const width = opts.width ?? 1920
  const height = opts.height ?? 1080
  const wanted = opts.cells ?? ['control', 'bare', 'bare2', 'idlectx', 'audio']
  const cells: BisectCell[] = []
  // Warm-up, discarded: the first encoder of a session pays for GPU/driver
  // setup, and whichever cell ran first would otherwise be charged for it.
  if (opts.warmup !== false)
    await runProductionCell('warmup', Math.min(90, frames), width, height, 'none')
  const takeMs = Math.round((frames / 60) * 1000)
  for (const cell of wanted) {
    if (cell === 'control') cells.push(await runControlCell(frames, width, height))
    else if (cell === 'bare' || cell === 'bare2')
      cells.push({ ...(await runProductionCell(cell, frames, width, height, 'none')), cell })
    else if (cell === 'idlectx') cells.push(await runProductionCell(cell, frames, width, height, 'idle'))
    else if (cell === 'audio') cells.push(await runProductionCell(cell, frames, width, height, 'live'))
    else if (cell === 'rigsrc')
      cells.push(await runProductionCell(cell, frames, width, height, 'none', 'rig'))
    else if (cell === 'mainwarm') {
      // The production prewarm, verbatim: does a MAIN-thread encoder warm make
      // the WORKER's encoder fast? Run with {"warmup":false} in a fresh Chrome
      // or it proves nothing.
      const t0 = performance.now()
      await warmVideoEncoder()
      const warmMs = Math.round(performance.now() - t0)
      cells.push({ ...(await runProductionCell(cell, frames, width, height, 'none')), warmMs })
    }
    else if (cell === 'engine') cells.push(await runEngineCell(cell, takeMs, width, height, 'probe'))
    else if (cell === 'engine-rigsrc')
      cells.push(await runEngineCell(cell, takeMs, width, height, 'rig'))
    else if (cell === 'ctx')
      cells.push(await runEngineCell(cell, takeMs, width, height, 'rig', { rigCtx: true }))
    else if (cell === 'obs')
      cells.push(await runEngineCell(cell, takeMs, width, height, 'rig', { observer: true }))
    else if (cell === 'ctxaudio')
      cells.push(await runEngineCell(cell, takeMs, width, height, 'rig', { oscAudio: true }))
    else if (cell === 'insitu') {
      // The ACTUAL o4step2 path, verbatim, inside this harness — the cell that
      // has always been slow, next to the cells above that are not.
      const { runCompositorEngine } = await import('./compositorEngine')
      const r = (
        await runCompositorEngine({ takeMs, sizes: [[width, height]], engines: ['v2'] })
      ).runs[0]
      const e = r?.encoder
      cells.push({
        cell,
        framesFed: r?.sourceFrames ?? 0,
        framesIn: e?.framesIn ?? 0,
        framesEncoded: e?.framesEncoded ?? 0,
        framesDropped: e?.framesDropped ?? 0,
        framesGated: e?.framesGated ?? 0,
        encodedFps: e ? Math.round((e.framesEncoded / (takeMs / 1000)) * 10) / 10 : 0,
        msPerEncodeLatency: e?.msPerEncodeLatency ?? 0,
        peakQueue: e?.peakQueue ?? 0,
        feedMs: takeMs,
        handlerMs: e?.handlerMs ?? 0,
        idleMs: e?.idleMs ?? 0,
        outputMs: e?.outputMs ?? 0,
        muxMs: e?.muxMs ?? 0,
        writeMs: e?.writeMs ?? 0,
        flushMs: e?.flushMs ?? 0,
        bytes: r?.bytes ?? 0,
        codec: e?.codec ?? null,
        hardware: e?.hardware ?? null,
        backend: e?.backend ?? null,
        audioTicks: 0,
        audioBatches: 0,
        error: r?.error ?? r?.degradeReason,
      })
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return {
    width,
    height,
    frames,
    cells,
    notes: [
      'control is encoderProbe.worker.ts (the 60 fps cell); every other cell is the UNTOUCHED production compositor.worker.ts driven by the same feeder and sources',
      'bare2 repeats bare so a one-off cold cell cannot decide anything',
      'idlectx adds an AudioContext whose tap worklet ticks with no audio source and no AudioEncoder — the exact environment of the in-situ noAudio A/B',
      'audio adds the full engine audio side: oscillator mix, PCM batches into the worker, AudioEncoder configured',
      'the production cells gate 60 fps arrivals down to 30 by design, so a HEALTHY cell reads ~30 encodedFps, not 60',
    ],
  }
}
