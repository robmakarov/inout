/**
 * EXPERIMENTAL — O4 step 2 evidence: v1 vs v2 live composite, back to back.
 *
 * The claim under test is the one the task was written on: the old pixel path
 * pays for every frame several times over on the MAIN THREAD, and that is what
 * collapses under a 4K surface. So this drives BOTH engines from the SAME
 * synthetic sources in the same browser, and measures the two things that
 * decide it — how much main-thread time capture costs, and how many frames
 * actually reach the file when the source is 4K.
 *
 * It also checks the promise the product makes about stops: the last second of
 * a take must be IN the file. v1 could only ask MediaRecorder to stop; v2 owns
 * the encoder and drains it, so this measures the gap between the take length
 * and the last decodable frame for both.
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { blobStore } from '@core/store'
import { startLiveComposite, type LiveCompositeStats } from '@core/capture/liveComposite'
import { canLiveCompositeV2, startLiveCompositeV2 } from '@core/capture/liveCompositeV2'
import type { CompositeRecording } from '@core/types'

export interface Rig {
  screen: MediaStream
  camera: MediaStream
  audio: MediaStream[]
  /** Frames the SOURCE actually produced — the denominator for delivery. */
  sourceFrames: () => number
  stop: () => void
}

/**
 * A canvas that genuinely repaints every frame at the requested size. A static
 * canvas would let both engines look perfect: the capturer would emit ~1 fps
 * and there would be nothing to keep up with.
 */
export function makeRig(width: number, height: number, audioCtx: AudioContext | null): Rig {
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
    // Real motion across the whole surface: this is what a 4K game tab costs.
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

  const audio: MediaStream[] = []
  let stopAudio: () => void = () => undefined
  if (audioCtx) {
    const osc = new OscillatorNode(audioCtx, { frequency: 440 })
    const gain = new GainNode(audioCtx, { gain: 0.2 })
    const dest = audioCtx.createMediaStreamDestination()
    osc.connect(gain).connect(dest)
    osc.start()
    audio.push(dest.stream)
    stopAudio = () => {
      try {
        osc.stop()
      } catch {
        /* already stopped */
      }
    }
  }

  return {
    screen: screen.captureStream(60),
    camera: cam.captureStream(30),
    audio,
    sourceFrames: () => frames,
    stop: () => {
      cancelAnimationFrame(raf)
      stopAudio()
    },
  }
}

/** O8's shipped tail band, in ms. Kept in step with scripts/oracle-gate.mjs. */
export const TAIL_BAND_MS = 400

interface LongTasks {
  count: number
  totalMs: number
  maxMs: number
}

function watchLongTasks(): { stop: () => LongTasks } {
  const acc: LongTasks = { count: 0, totalMs: 0, maxMs: 0 }
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        acc.count++
        acc.totalMs += entry.duration
        if (entry.duration > acc.maxMs) acc.maxMs = entry.duration
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    observer = null
  }
  return {
    stop: () => {
      observer?.disconnect()
      return {
        count: acc.count,
        totalMs: Math.round(acc.totalMs),
        maxMs: Math.round(acc.maxMs),
      }
    },
  }
}

export interface FileProbe {
  durationSec: number
  decodedAt: number[]
  frameCount: number
  width: number | null
  height: number | null
  /** Presentation time of the LAST decodable frame — the tail evidence. */
  lastFrameSec: number | null
  /**
   * Presentation time of the last decodable frame AT OR BEFORE `cutoffSec`.
   * A file may legitimately run past the length its channel declares (P0-tail-raw
   * drains at 1 fps, and those frames carry real timestamps), and then
   * `lastFrameSec` answers a different question than "did the take keep its
   * ending". Only set when a cutoff was asked for.
   */
  lastFrameBeforeCutoffSec?: number | null
}

export async function probeComposite(blob: Blob, cutoffSec?: number): Promise<FileProbe | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return null
    const duration = await input.computeDuration()
    const sink = new VideoSampleSink(track)
    const decodedAt: number[] = []
    for (const t of [0.2, duration / 2, Math.max(0, duration - 0.3)]) {
      const s = await sink.getSample(t)
      if (s) {
        decodedAt.push(Math.round(s.timestamp * 1000) / 1000)
        s.close()
      }
    }
    // Walk to the end for the true last frame and an exact frame count.
    let frameCount = 0
    let lastFrameSec: number | null = null
    let lastBeforeCutoff: number | null = null
    for await (const sample of sink.samples()) {
      frameCount++
      lastFrameSec = sample.timestamp
      if (cutoffSec !== undefined && sample.timestamp <= cutoffSec) lastBeforeCutoff = sample.timestamp
      sample.close()
    }
    const probe: FileProbe = {
      durationSec: Math.round(duration * 1000) / 1000,
      decodedAt,
      frameCount,
      width: track.displayWidth,
      height: track.displayHeight,
      lastFrameSec: lastFrameSec === null ? null : Math.round(lastFrameSec * 1000) / 1000,
    }
    if (cutoffSec !== undefined) {
      probe.lastFrameBeforeCutoffSec =
        lastBeforeCutoff === null ? null : Math.round(lastBeforeCutoff * 1000) / 1000
    }
    return probe
  } finally {
    input.dispose()
  }
}

export interface EngineRun {
  engine: 'v1' | 'v2'
  sourceWidth: number
  sourceHeight: number
  takeMs: number
  /** Frames the rig painted — what a perfect engine would have delivered. */
  sourceFrames: number
  bytes: number
  compositeDurationMs: number
  /** Frames in the FILE ÷ take seconds. This is the gate number. */
  deliveredFps: number | null
  longTasks: LongTasks
  file: FileProbe | null
  /** Take length minus the last decodable frame. Small = the tail survived. */
  tailGapMs: number | null
  /** O8's tail band (≤400 ms), evaluated HERE — under load, which is the only
   *  place it has ever been able to fail. */
  tailBandPass: boolean | null
  /** v1 only — what the compositor itself saw, including the stop drain. */
  v1Stats: LiveCompositeStats | null
  /** The SAME source recorded as a plain raw channel, for its own tail gap:
   *  refusing the instant path only helps if the fallback still has an ending. */
  rawChannel: { bytes: number; frameCount: number; lastFrameSec: number | null; tailGapMs: number | null } | null
  /** Why the watchdog gave up, when it did. */
  degradeReason?: string
  /** v2 only — what the encoder itself reported. */
  encoder: {
    codec: string | null
    hardware: string | null
    framesIn: number
    framesEncoded: number
    framesDropped: number
    keepAliveFrames: number
    peakQueue: number
    videoBytes: number
    audioBytes: number
    keyframeCount: number
    keyframeSharePct: number
    achievedMbps: number
    requestedMbps: number
    backend: string | null
    msPerPaint: number
    msPerFrameCreate: number
    msPerEncodeCall: number
    /** The path nobody had timed: mux, disk write, disk barrier. */
    muxMs: number
    writeMs: number
    flushMs: number
    writeCalls: number
    framesGated: number
    framesStale: number
    /** Which side of the thread boundary is slow — see the worker's stats. */
    handlerMs: number
    idleMs: number
    maxIdleMs: number
    configJson: string | null
    msPerEncodeLatency: number
    outputMs: number
  } | null
  error?: string
}

interface RawLane {
  stop(takeMs: number): Promise<EngineRun['rawChannel']>
}

/** A plain MediaRecorder on the same source, i.e. exactly what a raw channel is. */
function startRawLane(stream: MediaStream, key: string): RawLane {
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) =>
    MediaRecorder.isTypeSupported(m),
  )
  if (!mime) return { stop: async () => null }
  let bytes = 0
  let chain = Promise.resolve()
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
  const opened = blobStore.createWriteStream(key).then((w) => {
    const writer = w.getWriter()
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return
      chain = chain.then(() =>
        writer.write(e.data).then(
          () => {
            bytes += e.data.size
          },
          () => undefined,
        ),
      )
    }
    recorder.start(1000)
    return writer
  })
  return {
    async stop(takeMs: number) {
      const writer = await opened
      if (recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          recorder.onstop = () => resolve()
          try {
            recorder.requestData()
            recorder.stop()
          } catch {
            resolve()
          }
        })
      }
      await chain
      await writer.close().catch(() => undefined)
      try {
        const probe = await probeComposite(await blobStore.read(key))
        return {
          bytes,
          frameCount: probe?.frameCount ?? 0,
          lastFrameSec: probe?.lastFrameSec ?? null,
          tailGapMs:
            probe?.lastFrameSec == null ? null : Math.round(takeMs - probe.lastFrameSec * 1000),
        }
      } catch {
        return null
      } finally {
        await blobStore.remove(key).catch(() => undefined)
      }
    },
  }
}

async function runEngine(
  engine: 'v1' | 'v2',
  width: number,
  height: number,
  takeMs: number,
  withRawLane: boolean,
  withAudio = true,
): Promise<EngineRun> {
  const audioCtx = new AudioContext({ sampleRate: 48000 })
  await audioCtx.resume()
  // A take with no audio gives v2 no AudioEncoder and the muxer no second
  // track — the two ingredients the encprobe rows could not reproduce.
  const rig = makeRig(width, height, withAudio ? audioCtx : null)
  const key = `exp-o4-${engine}-${width}-${Date.now()}.mp4`
  const watcher = watchLongTasks()
  const base: EngineRun = {
    engine,
    sourceWidth: width,
    sourceHeight: height,
    takeMs,
    sourceFrames: 0,
    bytes: 0,
    compositeDurationMs: 0,
    deliveredFps: null,
    longTasks: { count: 0, totalMs: 0, maxMs: 0 },
    file: null,
    tailGapMs: null,
    tailBandPass: null,
    v1Stats: null,
    rawChannel: null,
    encoder: null,
  }
  try {
    const inputs = { screen: rig.screen, camera: rig.camera, audio: rig.audio }
    const handle =
      engine === 'v2'
        ? await startLiveCompositeV2(inputs, key, {
            onDegrade: (reason) => {
              base.degradeReason = reason
            },
          })
        : await startLiveComposite(inputs, key)
    // A raw channel of the SAME source, recorded ALONGSIDE for the whole take:
    // the composite is not the only MediaRecorder in a take, and if the raw
    // channels lose their tails too then refusing the instant path buys
    // nothing. Started here, with the composite — a lane started at stop
    // records nothing, which is how the first version of this measured a
    // 9851 ms "tail gap" on a 149 ms file.
    const raw = withRawLane
      ? startRawLane(rig.screen, `exp-o4-raw-${engine}-${width}-${Date.now()}.webm`)
      : null
    await new Promise((r) => setTimeout(r, takeMs))
    const composite: CompositeRecording | null = await handle.stop()
    base.rawChannel = raw ? await raw.stop(takeMs).catch(() => null) : null
    // Read AFTER stop: the final stats only exist once the encoder drained.
    const stats =
      engine === 'v2' ? (handle as unknown as { stats(): unknown }).stats() : null
    if (engine === 'v1') {
      base.v1Stats = (handle as unknown as { stats(): LiveCompositeStats }).stats()
    }
    base.sourceFrames = rig.sourceFrames()
    base.longTasks = watcher.stop()
    const s = stats as {
      codec: string | null
      hardware: string | null
      framesIn: number
      framesEncoded: number
      framesDropped: number
      keepAliveFrames: number
      peakQueue: number
      videoBytes: number
      audioBytes: number
      keyframeCount: number
      keyframeBytes: number
      requestedVideoBitrate: number
      backend: string | null
      paintMs: number
      frameMs: number
      encodeMs: number
      muxMs: number
      writeMs: number
      flushMs: number
      writeCalls: number
      framesGated: number
      framesStale: number
      handlerMs: number
      idleMs: number
      maxIdleMs: number
      configJson: string | null
      encodeLatencyMs: number
      outputs: number
      outputMs: number
    } | null
    if (s) {
      const seconds = Math.max(0.001, takeMs / 1000)
      base.encoder = {
        codec: s.codec,
        hardware: s.hardware,
        framesIn: s.framesIn,
        framesEncoded: s.framesEncoded,
        framesDropped: s.framesDropped,
        keepAliveFrames: s.keepAliveFrames,
        peakQueue: s.peakQueue,
        videoBytes: s.videoBytes,
        audioBytes: s.audioBytes,
        keyframeCount: s.keyframeCount,
        keyframeSharePct: Math.round((s.keyframeBytes / Math.max(1, s.videoBytes)) * 1000) / 10,
        achievedMbps: Math.round(((s.videoBytes * 8) / seconds / 1e6) * 100) / 100,
        requestedMbps: Math.round((s.requestedVideoBitrate / 1e6) * 100) / 100,
        backend: s.backend,
        msPerPaint: Math.round((s.paintMs / Math.max(1, s.framesEncoded)) * 100) / 100,
        msPerFrameCreate: Math.round((s.frameMs / Math.max(1, s.framesEncoded)) * 100) / 100,
        msPerEncodeCall: Math.round((s.encodeMs / Math.max(1, s.framesEncoded)) * 100) / 100,
        muxMs: Math.round(s.muxMs ?? 0),
        writeMs: Math.round(s.writeMs ?? 0),
        flushMs: Math.round(s.flushMs ?? 0),
        writeCalls: s.writeCalls ?? 0,
        framesGated: s.framesGated ?? 0,
        framesStale: s.framesStale ?? 0,
        handlerMs: Math.round(s.handlerMs ?? 0),
        idleMs: Math.round(s.idleMs ?? 0),
        maxIdleMs: Math.round(s.maxIdleMs ?? 0),
        configJson: s.configJson ?? null,
        msPerEncodeLatency: Math.round((s.encodeLatencyMs ?? 0) / Math.max(1, s.outputs ?? 1)),
        outputMs: Math.round(s.outputMs ?? 0),
      }
    }
    if (!composite) {
      base.error = 'composite returned null (watchdog aborted or produced nothing)'
      return base
    }
    base.bytes = composite.bytes ?? 0
    base.compositeDurationMs = composite.durationMs
    const blob = await blobStore.read(key)
    base.file = await probeComposite(blob)
    if (base.file) {
      base.deliveredFps = Math.round((base.file.frameCount / (takeMs / 1000)) * 10) / 10
      if (base.file.lastFrameSec !== null) {
        base.tailGapMs = Math.round(takeMs - base.file.lastFrameSec * 1000)
        base.tailBandPass = base.tailGapMs <= TAIL_BAND_MS
      }
    }
    return base
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err)
    base.longTasks = watcher.stop()
    return base
  } finally {
    rig.stop()
    for (const s of [rig.screen, rig.camera, ...rig.audio]) for (const t of s.getTracks()) t.stop()
    if (audioCtx.state !== 'closed') await audioCtx.close().catch(() => undefined)
    await blobStore.remove(key).catch(() => undefined)
  }
}

export interface O4Step2Report {
  capableOfV2: boolean
  takeMs: number
  runs: EngineRun[]
  comparison: {
    resolution: string
    v1DeliveredFps: number | null
    v2DeliveredFps: number | null
    v1MainThreadMs: number
    v2MainThreadMs: number
    v1TailGapMs: number | null
    v2TailGapMs: number | null
    v1TailBandPass: boolean | null
    v1RawTailGapMs: number | null
  }[]
  /** The whole point of the load rig: does O8's tail band hold under it? */
  tailBandMs: number
  tailBandPass: boolean
  notes: string[]
}

export async function runCompositorEngine(
  opts: {
    takeMs?: number
    sizes?: [number, number][]
    engines?: ('v1' | 'v2')[]
    /**
     * Record a raw channel off the same source, as production does. OFF by
     * default and deliberately so: it is a second encoder competing for the
     * same GPU, so switching it on silently would have made every engine
     * number in this harness incomparable with the ones already recorded.
     */
    rawLane?: boolean
    /** Run the take SILENT: isolates the audio encoder + the muxer's second
     *  track, which is the last difference between v2 in situ and the probe
     *  rows that hit 59.7 fps. */
    noAudio?: boolean
  } = {},
): Promise<O4Step2Report> {
  const takeMs = opts.takeMs ?? 8000
  const sizes: [number, number][] = opts.sizes ?? [
    [1920, 1080],
    [3840, 2160],
  ]
  const capable = canLiveCompositeV2({
    screen: new MediaStream(),
    camera: new MediaStream(),
    audio: [],
  })
  // One engine at a time is a real option, not a convenience: an A/B of a v1
  // change must not share a machine with a v2 run that loads it differently.
  const engines = opts.engines ?? ['v1', 'v2']
  const runs: EngineRun[] = []
  for (const [w, h] of sizes) {
    // v1 first each round: it is the incumbent, and running it on the colder
    // machine is the conservative order for a claim that v2 is faster.
    for (const engine of engines) {
      runs.push(await runEngine(engine, w, h, takeMs, opts.rawLane ?? false, opts.noAudio !== true))
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  const comparison = sizes.map(([w, h]) => {
    const v1 = runs.find((r) => r.engine === 'v1' && r.sourceWidth === w)
    const v2 = runs.find((r) => r.engine === 'v2' && r.sourceWidth === w)
    return {
      resolution: `${w}x${h}`,
      v1DeliveredFps: v1?.deliveredFps ?? null,
      v2DeliveredFps: v2?.deliveredFps ?? null,
      v1MainThreadMs: v1?.longTasks.totalMs ?? 0,
      v2MainThreadMs: v2?.longTasks.totalMs ?? 0,
      v1TailGapMs: v1?.tailGapMs ?? null,
      v2TailGapMs: v2?.tailGapMs ?? null,
      v1TailBandPass: v1?.tailBandPass ?? null,
      v1RawTailGapMs: v1?.rawChannel?.tailGapMs ?? null,
    }
  })
  return {
    capableOfV2: capable,
    takeMs,
    runs,
    comparison,
    tailBandMs: TAIL_BAND_MS,
    // The band is only meaningful where it was measured: a run that produced no
    // file cannot pass it.
    tailBandPass: runs.every((r) => r.tailBandPass !== false),
    notes: [
      'deliveredFps counts frames IN THE FILE, not frames offered to the encoder — a frame the encoder dropped is a frame the viewer never sees',
      'longTasks totalMs is main-thread time spent in tasks over 50 ms during the take; v1 composites there, v2 does not',
      'tailGapMs is take length minus the last decodable frame: v1 can only ask MediaRecorder to stop, v2 drains its own encoder',
      'the 4K row is the 2026-08-22 PO scenario (a 4K game tab) reproduced with a canvas that genuinely repaints every frame',
      'tailBandPass is O8 \u2264400 ms evaluated HERE, under load — the band has always existed, it had just never been run anywhere it could fail',
      'rawChannel records the SAME source through a plain MediaRecorder: if the raw channels lose their tails too, refusing the instant path buys nothing',
    ],
  }
}
