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
import { startLiveComposite } from '@core/capture/liveComposite'
import { canLiveCompositeV2, startLiveCompositeV2 } from '@core/capture/liveCompositeV2'
import type { CompositeRecording } from '@core/types'

interface Rig {
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
function makeRig(width: number, height: number, audioCtx: AudioContext | null): Rig {
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

interface FileProbe {
  durationSec: number
  decodedAt: number[]
  frameCount: number
  width: number | null
  height: number | null
  /** Presentation time of the LAST decodable frame — the tail evidence. */
  lastFrameSec: number | null
}

async function probeComposite(blob: Blob): Promise<FileProbe | null> {
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
    for await (const sample of sink.samples()) {
      frameCount++
      lastFrameSec = sample.timestamp
      sample.close()
    }
    return {
      durationSec: Math.round(duration * 1000) / 1000,
      decodedAt,
      frameCount,
      width: track.displayWidth,
      height: track.displayHeight,
      lastFrameSec: lastFrameSec === null ? null : Math.round(lastFrameSec * 1000) / 1000,
    }
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
  } | null
  error?: string
}

async function runEngine(
  engine: 'v1' | 'v2',
  width: number,
  height: number,
  takeMs: number,
): Promise<EngineRun> {
  const audioCtx = new AudioContext({ sampleRate: 48000 })
  await audioCtx.resume()
  const rig = makeRig(width, height, audioCtx)
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
    await new Promise((r) => setTimeout(r, takeMs))
    const composite: CompositeRecording | null = await handle.stop()
    // Read AFTER stop: the final stats only exist once the encoder drained.
    const stats =
      engine === 'v2' ? (handle as unknown as { stats(): unknown }).stats() : null
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
  }[]
  notes: string[]
}

export async function runCompositorEngine(
  opts: { takeMs?: number; sizes?: [number, number][] } = {},
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
  const runs: EngineRun[] = []
  for (const [w, h] of sizes) {
    // v1 first each round: it is the incumbent, and running it on the colder
    // machine is the conservative order for a claim that v2 is faster.
    runs.push(await runEngine('v1', w, h, takeMs))
    await new Promise((r) => setTimeout(r, 1500))
    runs.push(await runEngine('v2', w, h, takeMs))
    await new Promise((r) => setTimeout(r, 1500))
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
    }
  })
  return {
    capableOfV2: capable,
    takeMs,
    runs,
    comparison,
    notes: [
      'deliveredFps counts frames IN THE FILE, not frames offered to the encoder — a frame the encoder dropped is a frame the viewer never sees',
      'longTasks totalMs is main-thread time spent in tasks over 50 ms during the take; v1 composites there, v2 does not',
      'tailGapMs is take length minus the last decodable frame: v1 can only ask MediaRecorder to stop, v2 drains its own encoder',
      'the 4K row is the 2026-08-22 PO scenario (a 4K game tab) reproduced with a canvas that genuinely repaints every frame',
    ],
  }
}
