/**
 * EXPERIMENTAL — E1's instrument: DOES THE DETECTOR LEAD THE LOSS, AND BY HOW
 * MUCH?
 *
 * The task's bands cannot be chosen, they have to be read off a machine: strain
 * is normalised as "fraction of the way to a lost frame", so the question is
 * where an idle take's readings stop and a starving take's begin. This runs one
 * take through three phases on the SAME machine in the SAME run — idle, loaded,
 * idle again — and reports every leading signal per phase. The gap between
 * phase 1 and phase 2 is the band.
 *
 * AND IT MEASURES THE LEAD DIRECTLY, which is the gate. Two lanes:
 *   detector OFF — nothing steps, so both instants exist in one take: when
 *                  pressure first said 'serious', and when delivery first fell
 *                  under the old ladder's floor. The difference IS the lead.
 *   detector ON  — the step lands, so the second instant never arrives. What
 *                  this lane reports instead is responsiveness (load on → step
 *                  down, load off → step up) and the frames the prediction
 *                  saved, against the other lane's losses on the same load.
 *
 * WHY THE LOAD IS SIZED DOWN from loadedSync's (every core + 4K paints): this
 * machine has 8 GB and a rig that OOM-kills the session measures nothing. The
 * shape is kept — cores busy AND the GPU/encoder path contended, because CPU
 * alone leaves the compositor free — and the size is a parameter.
 */

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny'
import { blobStore } from '@core/store'
import { startLiveCompositeV2 } from '@core/capture/liveCompositeV2'
import { setPressureDetector, type PressureReading, type PressureSignals } from '@core/pressure'
import { warmRigEncoder } from '../rigWarm'
import { makeRig } from './compositorEngine'

/** Cores left alone so the take, the page and this rig are not the load. */
const CORES_SPARED = 2
/** How many contending 1440p60 encoders the `encode` load opens. */
const ENCODE_LOAD_STREAMS = 3

interface LoadHandle {
  stop: () => void
}

/**
 * A max60-class load: cores spinning, a 4K surface repainting, and a SECOND
 * hardware VideoEncoder competing for the same encode path. The third is the
 * one that moves the encoder queue — a busy CPU alone lengthens the worker's
 * ticks and leaves the encoder untouched, and the whole point of reading four
 * signals is to find out which one moves first.
 */
function startLoad(kind: 'none' | 'cpu' | 'encode' | 'all'): LoadHandle {
  const stops: (() => void)[] = []

  if (kind === 'cpu' || kind === 'all') {
    const src = `onmessage=()=>{for(;;){let x=0;for(let i=0;i<1e7;i++)x+=Math.sqrt(i);postMessage(x)}}`
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))
    const n = Math.max(2, (navigator.hardwareConcurrency || 8) - CORES_SPARED)
    const workers: Worker[] = []
    for (let i = 0; i < n; i++) {
      const w = new Worker(url)
      w.onmessage = () => undefined
      w.postMessage(1)
      workers.push(w)
    }
    const canvas = document.createElement('canvas')
    canvas.width = 3840
    canvas.height = 2160
    const g = canvas.getContext('2d')
    // setInterval, not rAF: a headless/occluded window stops rAF, and a load
    // that quietly stops loading turns the loaded cell into a second idle one.
    const timer = setInterval(() => {
      if (!g) return
      for (let i = 0; i < 6; i++) {
        const grad = g.createLinearGradient(0, 0, 3840, 2160)
        grad.addColorStop(0, `hsl(${(i * 37) % 360}, 60%, 40%)`)
        grad.addColorStop(1, '#000')
        g.fillStyle = grad
        g.fillRect(0, 0, 3840, 2160)
      }
    }, 16)
    stops.push(() => {
      clearInterval(timer)
      for (const w of workers) w.terminate()
    })
  }

  if (kind === 'encode' || kind === 'all') {
    // REAL ENCODERS ON REAL FRAMES, discarded — this exists to occupy the media
    // engine, not to make a file.
    //
    // AND IT IS SIZED AT 1440p, NOT 1080p, BECAUSE MEASUREMENT SAID SO. One
    // extra 1920x1080@60 encoder moved this machine's composite from 11.0 ms of
    // encode latency to 13.7 — i.e. not at all — and six spinning cores plus 4K
    // paints moved it to 13.4. On Apple silicon the video encoder is its own
    // block: CPU load does not reach it, and the only thing that contends with a
    // take's encoder is another encoder of comparable weight. That is also the
    // real-world shape — what starved Robert's take was his own max60 take, not
    // the browser's CPU.
    for (let k = 0; k < ENCODE_LOAD_STREAMS; k++) {
      const canvas = document.createElement('canvas')
      canvas.width = 2560
      canvas.height = 1440
      const g = canvas.getContext('2d')
      let enc: VideoEncoder | null = null
      let n = 0
      try {
        enc = new VideoEncoder({ output: () => undefined, error: () => undefined })
        enc.configure({
          codec: 'avc1.640033',
          width: 2560,
          height: 1440,
          framerate: 60,
          bitrate: 20_000_000,
          latencyMode: 'realtime',
        })
      } catch {
        enc = null
      }
      const timer = setInterval(() => {
        if (!enc || !g || enc.state !== 'configured') return
        g.fillStyle = `hsl(${(n * 7 + k * 90) % 360}, 70%, 45%)`
        g.fillRect(0, 0, 2560, 1440)
        g.fillStyle = '#fff'
        g.fillRect((n * 37) % 2400, 100, 160, 1100)
        if (enc.encodeQueueSize < 8) {
          const frame = new VideoFrame(canvas, { timestamp: n * 16_666 })
          try {
            enc.encode(frame, { keyFrame: n % 120 === 0 })
          } finally {
            frame.close()
          }
        }
        n++
      }, 16)
      stops.push(() => {
        clearInterval(timer)
        try {
          enc?.close()
        } catch {
          /* already closed */
        }
      })
    }
  }

  return {
    stop: () => {
      for (const s of stops) s()
    },
  }
}

/**
 * `warmup` is its own phase and not part of `idle-before`, because the ladder
 * does not judge inside it either (rule 2, WARMUP_MS) — and folding an encoder's
 * cold start into the idle population is how a band gets set from a transient.
 * Measured here: a first-VideoEncoder init reads 1246 ms of encode latency on a
 * machine doing nothing.
 */
type Phase = 'warmup' | 'idle-before' | 'loaded' | 'idle-after'

interface Sample {
  atMs: number
  phase: Phase
  level: string
  strain: number
  leader: string | null
  queueMean: number | null
  encodeLatencyMs: number | null
  workerLateMaxMs: number | null
  workerLateMeanMs: number | null
  perFrameCostMs: number | null
  staleRatio: number | null
  dropped: number
  /** The audio counters as of this tick — the seam evidence, sampled all along
   *  rather than only around a step, so "unchanged" is a series and not a pair. */
  audioPadded: number
  audioDroppedNotReady: number
}

interface StepEvent {
  atMs: number
  /** ms since the load switched, positive after — the responsiveness number. */
  sinceLoadChangeMs: number
  direction: 'down' | 'up'
  from: 'predicted' | 'measured'
  fps: number
  reason: string
}

interface Band {
  n: number
  median: number | null
  p90: number | null
  max: number | null
}

function band(values: (number | null)[]): Band {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b)
  if (!v.length) return { n: 0, median: null, p90: null, max: null }
  const at = (q: number): number => v[Math.min(v.length - 1, Math.floor(q * v.length))]!
  const r = (x: number): number => Math.round(x * 1000) / 1000
  return { n: v.length, median: r(at(0.5)), p90: r(at(0.9)), max: r(v[v.length - 1]!) }
}

function bandsFor(samples: Sample[]): Record<string, Band> {
  return {
    strain: band(samples.map((s) => s.strain)),
    queueMean: band(samples.map((s) => s.queueMean)),
    encodeLatencyMs: band(samples.map((s) => s.encodeLatencyMs)),
    workerLateMaxMs: band(samples.map((s) => s.workerLateMaxMs)),
    workerLateMeanMs: band(samples.map((s) => s.workerLateMeanMs)),
    perFrameCostMs: band(samples.map((s) => s.perFrameCostMs)),
    staleRatio: band(samples.map((s) => s.staleRatio)),
  }
}

export interface PressureLaneReport {
  detector: boolean
  fps: number
  size: [number, number]
  takeMs: number
  loadOnAtMs: number
  loadOffAtMs: number
  /** Per-phase distribution of every signal — the bands come from these. */
  phases: Record<Phase, { samples: number; bands: Record<string, Band> }>
  /** Level counts per phase: how often the detector said what. */
  levels: Record<Phase, Record<string, number>>
  steps: StepEvent[]
  /**
   * THE LEAD. Both are on the composite's own clock. `leadMs` is only present
   * in the detector-off lane, because a lane that steps never reaches the
   * floor — which is the point of the whole task, and also why the number has
   * to come from the control.
   */
  firstSeriousAtMs: number | null
  /**
   * When delivery first fell under the old ladder's floor. UNRELIABLE AS A LEAD
   * BASELINE and kept only because it is what the shipped ladder watches: the
   * ruler flickers under it on takes that lose nothing — measured at 25.1 s into
   * a completely idle 60 fps take with ZERO frames dropped.
   */
  firstUnderFloorAtMs: number | null
  /** The first interval that actually LOST a frame. This is the honest end of
   *  the lead: pressure seen → frames genuinely gone. */
  firstDropAtMs: number | null
  /** firstDrop − firstSerious. THE GATE'S NUMBER. */
  leadMs: number | null
  /** The old ruler's version of the same, for comparison. */
  leadVsFloorMs: number | null
  /** What the file lost, from the worker's own counters. */
  framesIn: number | null
  framesEncoded: number | null
  framesDropped: number | null
  maxEncodeGapMs: number | null
  /** THE AUDIO GATE: none of these may move because of a step. */
  audioFrames: number | null
  audioPaddedFrames: number | null
  audioDroppedNotReady: number | null
  /** Largest hole between consecutive audio packets in the finished file, ms. */
  maxAudioGapMs: number | null
  /** …and where it is, so a hole at a step is distinguishable from one at t=0. */
  maxAudioGapAtSec: number | null
  /** Audio counters sampled around each step: the delta across the seam. */
  audioAcrossSteps: {
    atMs: number
    paddedBefore: number
    paddedAfter: number
    droppedBefore: number
    droppedAfter: number
  }[]
  degradeReason: string | null
}

export interface PressureLeadReport {
  load: 'none' | 'cpu' | 'encode' | 'all'
  cores: number
  lanes: PressureLaneReport[]
  verdict: string
}

async function audioGaps(blob: Blob): Promise<{ maxMs: number | null; atSec: number | null }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const a = await input.getPrimaryAudioTrack()
    if (!a) return { maxMs: null, atSec: null }
    const stamps: number[] = []
    for await (const packet of new EncodedPacketSink(a).packets()) stamps.push(packet.timestamp)
    if (stamps.length < 2) return { maxMs: null, atSec: null }
    stamps.sort((x, y) => x - y)
    let maxMs = 0
    let atSec = 0
    for (let i = 1; i < stamps.length; i++) {
      const gap = (stamps[i]! - stamps[i - 1]!) * 1000
      if (gap > maxMs) {
        maxMs = gap
        atSec = Math.round(stamps[i - 1]! * 100) / 100
      }
    }
    return { maxMs: Math.round(maxMs * 100) / 100, atSec }
  } finally {
    input.dispose()
  }
}

async function runLane(opts: {
  detector: boolean
  takeMs: number
  loadOnAtMs: number
  loadOffAtMs: number
  width: number
  height: number
  fps: number
  load: 'none' | 'cpu' | 'encode' | 'all'
  warmupMs: number
}): Promise<PressureLaneReport> {
  const { detector, takeMs, loadOnAtMs, loadOffAtMs, width, height, fps, load, warmupMs } = opts
  setPressureDetector(detector)

  // Warm the encoder the way production does at mount. Without it the take pays
  // a first-VideoEncoder init DURING the recording and every signal in phase 1
  // reads like a starving machine (note 10: check the instrument first).
  await warmRigEncoder()
  const audioCtx = new AudioContext({ sampleRate: 48000 })
  await audioCtx.resume()
  const rig = makeRig(width, height, audioCtx)
  const key = `exp-pressure-${detector ? 'on' : 'off'}-${Date.now()}.mp4`
  const samples: Sample[] = []
  const steps: StepEvent[] = []
  const audioAcrossSteps: PressureLaneReport['audioAcrossSteps'] = []
  let degradeReason: string | null = null
  let loadHandle: LoadHandle | null = null
  let t0 = 0

  const phaseAt = (ms: number): Phase =>
    ms < warmupMs ? 'warmup' : ms < loadOnAtMs ? 'idle-before' : ms < loadOffAtMs ? 'loaded' : 'idle-after'

  const handle = await startLiveCompositeV2({ screen: rig.screen, camera: rig.camera, audio: rig.audio }, key, {
    width,
    height,
    fps,
    onDegrade: (reason) => {
      degradeReason = reason
    },
    onDegradeStep: (rung, reason, from) => {
      const atMs = performance.now() - t0
      const ref = atMs < loadOffAtMs ? loadOnAtMs : loadOffAtMs
      steps.push({
        atMs: Math.round(atMs),
        sinceLoadChangeMs: Math.round(atMs - ref),
        direction: rung.fps < fps ? 'down' : 'up',
        from,
        fps: rung.fps,
        reason,
      })
      // THE ACTUATOR, the same call session.stepDisplayDown makes. The rig owns
      // the track here because there is no session; what it does to a canvas
      // capture track is reported rather than assumed.
      const track = rig.screen.getVideoTracks()[0]
      void track?.applyConstraints({ frameRate: { max: rung.fps } }).catch(() => undefined)
    },
    onPressure: (reading: PressureReading, signals: PressureSignals) => {
      const atMs = performance.now() - t0
      samples.push({
        atMs: Math.round(atMs),
        phase: phaseAt(atMs),
        level: reading.level,
        strain: Math.round(reading.strain * 1000) / 1000,
        leader: reading.leader?.signal ?? null,
        queueMean: signals.queueMean,
        encodeLatencyMs: signals.encodeLatencyMs,
        workerLateMaxMs: signals.workerLateMaxMs,
        workerLateMeanMs: signals.workerLateMeanMs,
        perFrameCostMs: signals.perFrameCostMs,
        staleRatio:
          signals.stale !== null && signals.arrivals ? signals.stale / signals.arrivals : null,
        dropped: signals.dropped ?? 0,
        audioPadded: handleStats().padded,
        audioDroppedNotReady: handleStats().droppedNotReady,
      })
    },
  })

  function handleStats(): { padded: number; droppedNotReady: number } {
    const s = handle.stats()
    return { padded: s?.audioPaddedFrames ?? 0, droppedNotReady: s?.audioDroppedNotReady ?? 0 }
  }

  t0 = performance.now()
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  await sleep(loadOnAtMs)
  loadHandle = startLoad(load)
  await sleep(loadOffAtMs - loadOnAtMs)
  loadHandle.stop()
  loadHandle = null
  await sleep(takeMs - loadOffAtMs)

  const marks = handle.pressureMarks()
  void marks.firstSeriousAtMs
  const stats = handle.stats()
  const recording = await handle.stop()
  rig.stop()
  await audioCtx.close().catch(() => undefined)

  let gaps: { maxMs: number | null; atSec: number | null } = { maxMs: null, atSec: null }
  if (recording) {
    const blob = await blobStore.read(recording.blobKey).catch(() => null)
    if (blob) gaps = await audioGaps(blob)
    await blobStore.remove(recording.blobKey).catch(() => undefined)
  }

  // THE AUDIO GATE, read off the series rather than off two reads taken at the
  // step itself: a counter sampled at the instant of a step has not yet seen
  // what the step cost. One second either side, from the samples already taken.
  for (const step of steps) {
    const before = [...samples].reverse().find((x) => x.atMs <= step.atMs - 1000) ?? samples[0]
    const after = samples.find((x) => x.atMs >= step.atMs + 1000) ?? samples[samples.length - 1]
    if (!before || !after) continue
    audioAcrossSteps.push({
      atMs: step.atMs,
      paddedBefore: before.audioPadded,
      paddedAfter: after.audioPadded,
      droppedBefore: before.audioDroppedNotReady,
      droppedAfter: after.audioDroppedNotReady,
    })
  }

  const firstDrop = samples.find((x) => x.dropped > 0)?.atMs ?? null

  const byPhase = (p: Phase): Sample[] => samples.filter((s) => s.phase === p)
  const levelCounts = (p: Phase): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const s of byPhase(p)) out[s.level] = (out[s.level] ?? 0) + 1
    return out
  }
  const phases = ['warmup', 'idle-before', 'loaded', 'idle-after'] as const

  // ONE CLOCK. The composite's own `startedAt` runs ~100 ms ahead of the rig's
  // t0 (it is set inside startLiveCompositeV2, before the call returns), so a
  // lead computed from a mark on one clock and a drop on the other is wrong by
  // that much. Both ends come off the SAMPLES, which are stamped on t0 — the
  // handle's marks stay in the report as the engine's own view.
  const firstSerious =
    samples.find((x) => x.level === 'serious' || x.level === 'critical')?.atMs ?? null
  const firstUnderFloor =
    marks.firstUnderFloorAtMs === null ? null : Math.round(marks.firstUnderFloorAtMs - marks.startedAtMs)

  return {
    detector,
    fps,
    size: [width, height],
    takeMs,
    loadOnAtMs,
    loadOffAtMs,
    phases: Object.fromEntries(
      phases.map((p) => [p, { samples: byPhase(p).length, bands: bandsFor(byPhase(p)) }]),
    ) as PressureLaneReport['phases'],
    levels: Object.fromEntries(phases.map((p) => [p, levelCounts(p)])) as PressureLaneReport['levels'],
    steps,
    firstSeriousAtMs: firstSerious,
    firstUnderFloorAtMs: firstUnderFloor,
    firstDropAtMs: firstDrop,
    leadMs: firstSerious !== null && firstDrop !== null ? firstDrop - firstSerious : null,
    leadVsFloorMs:
      firstSerious !== null && firstUnderFloor !== null ? firstUnderFloor - firstSerious : null,
    framesIn: stats?.framesIn ?? null,
    framesEncoded: stats?.framesEncoded ?? null,
    framesDropped: stats?.framesDropped ?? null,
    maxEncodeGapMs: stats ? Math.round(stats.maxEncodeGapMs) : null,
    audioFrames: stats?.audioFrames ?? null,
    audioPaddedFrames: stats?.audioPaddedFrames ?? null,
    audioDroppedNotReady: stats?.audioDroppedNotReady ?? null,
    maxAudioGapMs: gaps.maxMs,
    maxAudioGapAtSec: gaps.atSec,
    audioAcrossSteps,
    degradeReason,
  }
}

export async function runPressureLead(opts?: {
  takeMs?: number
  loadOnAtMs?: number
  loadOffAtMs?: number
  width?: number
  height?: number
  fps?: number
  load?: 'none' | 'cpu' | 'encode' | 'all'
  warmupMs?: number
  lanes?: ('on' | 'off')[]
}): Promise<PressureLeadReport> {
  const takeMs = opts?.takeMs ?? 45_000
  const loadOnAtMs = opts?.loadOnAtMs ?? 12_000
  const loadOffAtMs = opts?.loadOffAtMs ?? 28_000
  const width = opts?.width ?? 1920
  const height = opts?.height ?? 1080
  const fps = opts?.fps ?? 60
  const load = opts?.load ?? 'all'
  const warmupMs = opts?.warmupMs ?? 6_000
  const wanted = opts?.lanes ?? ['off', 'on']

  const lanes: PressureLaneReport[] = []
  for (const which of wanted) {
    lanes.push(
      await runLane({
        detector: which === 'on',
        takeMs,
        loadOnAtMs,
        loadOffAtMs,
        width,
        height,
        fps,
        load,
        warmupMs,
      }),
    )
  }
  // Leave the flag where a user's own URL would leave it.
  setPressureDetector(null)

  const off = lanes.find((l) => !l.detector)
  const on = lanes.find((l) => l.detector)
  const verdict =
    off && on
      ? `lead ${off.leadMs === null ? 'UNMEASURED' : `${off.leadMs} ms`} · ` +
        `dropped ${off.framesDropped ?? '?'} (detector off) → ${on.framesDropped ?? '?'} (on) · ` +
        `steps ${on.steps.map((s) => `${s.direction}@${s.sinceLoadChangeMs}ms/${s.from}`).join(', ') || 'NONE'}`
      : 'single lane — no comparison'

  return { load, cores: navigator.hardwareConcurrency || 0, lanes, verdict }
}
