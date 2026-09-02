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
import { auditElastic, startElasticLog, takeElasticLog, type ElasticAudit, type ElasticEvent } from '@core/elasticLog'
import { noteTakeActive } from '@core/backgroundWork'
import { warmRigEncoder } from '../rigWarm'
import { makeRig } from './compositorEngine'

/** Cores left alone so the take, the page and this rig are not the load. */
const CORES_SPARED = 2
/** How many contending 1440p60 encoders the `encode` load opens. */
const ENCODE_LOAD_STREAMS = 3

export interface LoadHandle {
  stop: () => void
}

/**
 * A max60-class load: cores spinning, a 4K surface repainting, and a SECOND
 * hardware VideoEncoder competing for the same encode path. The third is the
 * one that moves the encoder queue — a busy CPU alone lengthens the worker's
 * ticks and leaves the encoder untouched, and the whole point of reading four
 * signals is to find out which one moves first.
 */
export function startLoad(kind: 'none' | 'cpu' | 'encode' | 'all'): LoadHandle {
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
  burst: number
  /** E2 — the level each hardware block read this tick. */
  blocks: Record<string, string>
  ownLevel: string
  fps: number
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
  from: 'predicted' | 'measured' | 'probe'
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
  /** E2 — when the reading first said `critical`, which is the ONLY level that
   *  may now move the picture (captureLadder rule 8). */
  firstCriticalAtMs: number | null
  /** firstDrop − firstSerious. THE GATE'S NUMBER. */
  leadMs: number | null
  /** E2's version of the same: firstDrop − firstCritical. The lead the PICTURE
   *  step actually gets, now that `serious` only sheds the unseen work. */
  leadFromCriticalMs: number | null
  /** ms from the load switching ON to the first DOWN step (null = never). */
  downLatencyMs: number | null
  /** ms from the load switching OFF to the first UP step. Null when the take
   *  had already climbed back before the load lifted — which is a pass, not a
   *  gap, and is why `upAfterHeadroomMs` below is the gate's real number. */
  upLatencyMs: number | null
  /**
   * E2's UP GATE, measured where it actually happens: ms from the FIRST reading
   * that showed headroom (the first sample below `serious` after the last one
   * at or above it) to the climb that followed. Independent of when a synthetic
   * load happens to stop, so it answers "up within 600 ms of headroom" on any
   * cell where the ladder ever climbed.
   */
  upAfterHeadroomMs: number[]
  /** The longest unbroken stretch the take spent below the rate it asked for.
   *  E2's gate: a wrong reading may not hold a take down > 20 s. */
  maxBelowRequestedMs: number
  /** Every refusal to move the picture, by reason — the ordering rule's other
   *  half, and the only way to see that `serious` was READ and DECLINED. */
  holds: Record<string, number>
  /** E2's layer two: frames kept only because the absorber was there, and how
   *  many frames deep it was allowed to be on this machine. */
  framesBurst: number | null
  burstFrames: number | null
  /** Each step paired with the reading that was standing when it was taken —
   *  the ONLY way to check "no picture step below critical" after the fact. */
  stepLevels: { atMs: number; direction: 'down' | 'up'; from: string; level: string; ownLevel: string }[]
  /** THE TAKE'S OWN LEDGER, and the ordering gate read off it. */
  elastic: ElasticEvent[]
  elasticAudit: ElasticAudit
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
  /** E2's gates, answered as numbers off the detector-on lane. */
  e2: unknown
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
  // E2 — the ledger is the SESSION's job in the product; the rig has no session,
  // so it opens and closes one itself. Without it every shed is dropped on the
  // floor and the ordering gate has nothing to read. `noteTakeActive` is the
  // other half: the background broker only sheds while a take is running, and
  // "the unseen work went first" is a claim about that broker.
  startElasticLog(performance.now())
  noteTakeActive(true)
  const audioCtx = new AudioContext({ sampleRate: 48000 })
  await audioCtx.resume()
  const rig = makeRig(width, height, audioCtx)
  const key = `exp-pressure-${detector ? 'on' : 'off'}-${Date.now()}.mp4`
  const samples: Sample[] = []
  const steps: StepEvent[] = []
  // The rig owns the rate here because there is no session; E2's report needs
  // to know what rung each sample was taken at.
  let currentFps = fps
  /** E2's pin gate: the longest unbroken stretch spent below the requested rate. */
  let belowSince: number | null = null
  let maxBelowRequestedMs = 0
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
      currentFps = rung.fps
      if (rung.fps < fps) belowSince ??= atMs
      else if (belowSince !== null) {
        maxBelowRequestedMs = Math.max(maxBelowRequestedMs, atMs - belowSince)
        belowSince = null
      }
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
        ownLevel: reading.ownLevel,
        blocks: Object.fromEntries(
          Object.values(reading.blocks).map((b) => [b.block, b.measured ? b.level : 'unmeasured']),
        ),
        burst: signals.burst ?? 0,
        fps: currentFps,
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

  if (belowSince !== null) {
    maxBelowRequestedMs = Math.max(maxBelowRequestedMs, takeMs - belowSince)
  }
  const marks = handle.pressureMarks()
  void marks.firstSeriousAtMs
  const stats = handle.stats()
  const recording = await handle.stop()
  noteTakeActive(false)
  const elasticLog = takeElasticLog()
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
  const firstCritical = samples.find((x) => x.level === 'critical')?.atMs ?? null
  const firstDown = steps.find((x) => x.direction === 'down') ?? null
  const firstUpAfterLoad = steps.find((x) => x.direction === 'up' && x.atMs >= loadOffAtMs) ?? null

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
    firstCriticalAtMs: firstCritical,
    firstUnderFloorAtMs: firstUnderFloor,
    firstDropAtMs: firstDrop,
    leadMs: firstSerious !== null && firstDrop !== null ? firstDrop - firstSerious : null,
    leadFromCriticalMs:
      firstCritical !== null && firstDrop !== null ? firstDrop - firstCritical : null,
    downLatencyMs: firstDown ? firstDown.atMs - loadOnAtMs : null,
    upLatencyMs: firstUpAfterLoad ? firstUpAfterLoad.atMs - loadOffAtMs : null,
    maxBelowRequestedMs: Math.round(maxBelowRequestedMs),
    holds: marks.holds,
    upAfterHeadroomMs: steps
      .filter((st) => st.direction === 'up')
      .map((st) => {
        const before = samples.filter((x) => x.atMs < st.atMs)
        let i = before.length - 1
        while (i >= 0 && before[i]!.level !== 'serious' && before[i]!.level !== 'critical') i--
        const firstClear = before[i + 1]
        return firstClear ? st.atMs - firstClear.atMs : -1
      })
      .filter((x) => x >= 0),
    stepLevels: steps.map((st) => {
      const near = [...samples].reverse().find((x) => x.atMs <= st.atMs) ?? samples[0]
      return {
        atMs: st.atMs,
        direction: st.direction,
        from: st.from,
        level: near?.level ?? 'unread',
        ownLevel: near?.ownLevel ?? 'unread',
      }
    }),
    framesBurst: stats?.framesBurst ?? null,
    burstFrames: stats?.burstFrames ?? null,
    elastic: elasticLog.events,
    elasticAudit: auditElastic(elasticLog),
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
      ? `lead ${off.leadMs === null ? 'UNMEASURED' : `${off.leadMs} ms`} ` +
        `(from critical ${off.leadFromCriticalMs === null ? 'UNMEASURED' : `${off.leadFromCriticalMs} ms`}) · ` +
        `dropped ${off.framesDropped ?? '?'} (detector off) → ${on.framesDropped ?? '?'} (on) · ` +
        `steps ${on.steps.map((s) => `${s.direction}@${s.sinceLoadChangeMs}ms/${s.from}`).join(', ') || 'NONE'}`
      : 'single lane — no comparison'

  // E2's OWN GATES, answered as numbers off the detector-on lane rather than
  // left to a reader to compute. Each line is one of the task's gates.
  const e2 = on
    ? {
        // THE GATE: "no picture step below `critical`". Every DOWN step is
        // paired with the reading that was standing when it was taken, and any
        // step whose reading was not `critical` is a failure. The autopsy path
        // ('measured') is listed separately: it is the delivery ruler reporting
        // loss that has already happened, not a prediction.
        pictureStepsBelowCritical: on.stepLevels.filter(
          (x) => x.from === 'predicted' && x.direction === 'down' && x.level !== 'critical',
        ),
        stepLevels: on.stepLevels,
        upLatencyMs: on.upLatencyMs,
        upAfterHeadroomMs: on.upAfterHeadroomMs,
        downLatencyMs: on.downLatencyMs,
        leadFromCriticalMs: off?.leadFromCriticalMs ?? null,
        maxBelowRequestedMs: on.maxBelowRequestedMs,
        holds: on.holds,
        burst: { framesBurst: on.framesBurst, burstFrames: on.burstFrames },
        ordering: on.elasticAudit.line,
        orderingOk: on.elasticAudit.ok,
        audio: {
          paddedFrames: on.audioPaddedFrames,
          droppedNotReady: on.audioDroppedNotReady,
          acrossSteps: on.audioAcrossSteps,
        },
      }
    : null

  return { load, cores: navigator.hardwareConcurrency || 0, lanes, verdict, e2 }
}
