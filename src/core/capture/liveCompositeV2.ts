/**
 * O4 step 2 — main-thread driver for the worker compositor.
 *
 * Same contract as liveComposite.ts (v1) on purpose: session.ts picks one and
 * everything downstream — instant export, salvage, the composite-invalid rules
 * — is untouched. What changes is everything behind it:
 *
 *   v1: source → <video> decode → main-thread drawImage on a 30 Hz tick →
 *       canvas.captureStream → MediaRecorder → blob writes
 *   v2: source → MediaStreamTrackProcessor → transfer to worker → composite +
 *       VideoEncoder + fMP4 → SyncAccessHandle, frame-driven
 *
 * The main thread now does no pixel work at all: it reads frames and posts
 * them (transferable, so nothing is copied).
 *
 * WHAT STAYS ON THIS THREAD, and why:
 *   · The audio MIX. WebAudio has no worker, and this graph's gain staging and
 *     limiter behaviour are shipped and tuned; it is tapped as PCM instead of
 *     being rebuilt.
 *   · The LIVENESS TICK. A frozen source delivers no frames at all, so frame
 *     arrivals alone can never notice it. The AudioWorklet tick keeps firing in
 *     a background tab (rAF does not, and recording means switching away), and
 *     the last frame's own timestamp is the media clock it samples.
 */
import { blobStore } from '@core/store'
import type { CompositorMsg, CompositorReply, CompositorStats } from './compositor.worker'
import type { CameraPose, CompositeRecording, FrameIntakeKind, TakeGlue } from '../types'
import { SourceLiveness, type LivenessEvent } from './sourceLiveness'
import { watchdogVerdict } from './compositorWatchdog'
import {
  DELIVERY_FLOOR_RATIO,
  FAILED_CLIMB_MS,
  RECOVERY_RATIO,
  ladderDecision,
  type LadderRung,
  type LadderStepMeta,
} from './captureLadder'
import {
  pressureDetectorEnabled,
  readPressure,
  type HardwareBlock,
  type PressureLevel,
  type PressureReading,
  type PressureSignals,
} from '../pressure'
import { backgroundPaceEnabled, currentPace, noteTakePressure } from '../backgroundWork'
import { passDoor } from '../door'
import { burstAbsorberEnabled } from './burstBudget'
import { painterChoice } from './painterChoice'
import {
  INTAKE_DECLARATION,
  intakeArmed,
  canSampleElement,
  intakeChoice,
  intakeFps,
  intakeOrder,
  intakeStateLine,
  trackProcessorCtor,
} from './frameIntake'
import { startElementSampler, type ElementSamplerHandle } from './frameIntakeElement'

/**
 * The composite's rate when nothing says otherwise — what this engine wrote
 * before F15, and what every take whose source does not offer more still gets.
 */
const FPS = 30
/**
 * The composite's shape when nothing says otherwise — what this engine wrote
 * before F13, and what every take without a frame to follow still gets.
 */
const W = 1920
const H = 1080
const VIDEO_BITS = 8_000_000
const AUDIO_BITS = 128_000
const FPS_LOG_MS = 10_000
/**
 * How long to wait for the compositor to prove it can paint the preview before
 * giving up and leaving the caller's own preview in place. Everything on this
 * path has a deadline (note 3) — and a preview that never arrives must cost the
 * user a fallback, not a blank rectangle.
 */
const PREVIEW_ATTACH_BUDGET_MS = 3000

/**
 * Watchdog: see compositorWatchdog.ts. The honest signal is the rate that
 * reaches the FILE, measured from the encoder's FIRST OUTPUT — a cold
 * encoder's multi-second initialization is not a slow machine, and killing a
 * take during it was exactly how the whole engine got misdiagnosed as
 * "2-10 fps" (2026-08-24). Keep-alive frames are excluded so a static
 * composition is left alone.
 */

/**
 * One worklet, two jobs: it taps the mixed PCM and it is the liveness tick.
 *
 * Two rules it inherits from the measured-audio worklet, both learned the hard
 * way and both re-learned here when they were left out:
 *  · Quanta that arrive STARVED after audio has started become SILENCE, not
 *    nothing. The timeline is sample-counted, so a skipped quantum splices it —
 *    every sample after it moves early and the splice itself is a step
 *    discontinuity. Leaving them out measured as a −33 dB spur.
 *  · Quanta BEFORE the first live sample are the context's startup catch-up and
 *    must be dropped, or the take begins with fast-forwarded silence.
 *
 * Each batch carries the AudioContext time of its FIRST sample. Wall-clocking
 * a batch when it arrives on the main thread is wrong whenever the port has
 * queued (it queues during worker start), and that error lands entirely on the
 * anchor — it placed the whole audio track ~430 ms late.
 */
const TAP_SOURCE = `
class InoutCompositeTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = []
    this.frames = 0
    this.channels = 2
    this.sawLive = false
    this.silentTicks = 0
    this.batchFrames = 1024
    this.batchStartTime = 0
  }
  process(inputs) {
    const chans = inputs[0]
    const live = chans && chans.length && chans[0] && chans[0].length
    if (!live && !this.sawLive) {
      // Nothing yet (or no audio in this take at all): still tick so the
      // liveness detector keeps watching the video sources.
      this.silentTicks++
      if (this.silentTicks >= 6) {
        this.silentTicks = 0
        this.port.postMessage({ tick: true })
      }
      return true
    }
    if (this.frames === 0) this.batchStartTime = currentTime
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
    if (this.frames >= this.batchFrames) this.flush()
    return true
  }
  flush() {
    if (!this.frames) return
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
    this.port.postMessage(
      { frames: total, channels: ch, planar, contextTime: this.batchStartTime },
      [planar.buffer],
    )
    this.buf = []
    this.frames = 0
  }
}
registerProcessor('inout-composite-tap', InoutCompositeTap)
`

let tapUrl: string | null = null
function tapModuleUrl(): string {
  tapUrl ??= URL.createObjectURL(new Blob([TAP_SOURCE], { type: 'application/javascript' }))
  return tapUrl
}

const LADDER_FLOOR = DELIVERY_FLOOR_RATIO

export interface LiveCompositeV2Inputs {
  screen?: MediaStream
  camera?: MediaStream
  audio: MediaStream[]
}

export interface LiveCompositeV2Options {
  onSourceLiveness?: (kind: 'screen' | 'camera', event: LivenessEvent) => void
  /** Fired when the watchdog gives up, so the caller can fall back to v1. */
  onDegrade?: (reason: string) => void
  /**
   * O6 — step the SOURCE down a rung before giving up on it. The compositor
   * sees delivery, the session owns the tracks, so the verdict travels and the
   * constraint is applied there. Absent = the ladder never runs, which is the
   * default.
   */
  onDegradeStep?: (
    rung: LadderRung,
    reason: string,
    from: 'predicted' | 'measured' | 'probe',
    /**
     * M1 — WHAT THE LADDER SAW, travelling with the verdict so the door can
     * record the step where it is APPLIED rather than where it was decided.
     * This file used to write the elastic ledger line itself, at the moment of
     * the verdict, and the session then refused to step in max mode: every max
     * take under load carried a ledger saying its picture had halved when
     * nothing had moved. The record belongs to the act, not the intention.
     */
    step: LadderStepMeta,
  ) => void
  /**
   * E1 — every pressure sample, four times a second, as read. The product does
   * not need this (the ladder consumes the reading in here); the RIG does, and
   * the gate "quote the detector's lead time" is unanswerable without the raw
   * series. Absent on every production take.
   */
  onPressure?: (reading: PressureReading, signals: PressureSignals) => void
  /**
   * The session epoch (performance.now()), so the composite can say WHERE ITS
   * OWN CLOCK STARTS on the recording timeline (P0-instant-sync). Omitted by
   * rigs that drive this engine directly: then the file declares no offset and
   * consumers keep the old assume-zero behaviour rather than a guess.
   */
  epochMs?: number
  /**
   * THE COMPOSITE'S OWN GEOMETRY (task F13). The session derives it from the
   * take's video channel so a portrait source is composited portrait instead of
   * being cropped into a landscape constant. Omitted — by every rig that drives
   * this engine directly, and by the session whenever the frame does not follow
   * the source — leaves it at the 1920x1080 this engine has always written.
   */
  width?: number
  height?: number
  /**
   * F13, second pass: let the compositor take the shape from the first frame it
   * actually receives rather than from `width`/`height`, which on a phone are
   * `track.getSettings()` — the SENSOR's landscape dimensions, not the rotated
   * portrait frames the camera delivers. `width`/`height` stay the guess the
   * take starts with and the answer when nothing ever arrives.
   */
  followSource?: boolean
  /** The pixel budget the adopted shape is resolved at (long edge). */
  longEdge?: number
  /**
   * THE COMPOSITE'S RATE (task F15). The session derives it from the take's
   * video channel, capped at the ceiling core/rate.ts holds; omitted, this
   * engine paints and encodes at the 30 it always has. It is also the rate the
   * degradation ladder scores delivery against — a 60 fps take that only gets
   * 30 frames out is real backpressure and must step down, and a 30 fps take
   * must not be judged against 60.
   */
  fps?: number
  /** Fired once the composite's shape is settled, so the UI can stop showing
   *  the guess. Called with the geometry the FILE is being written at. */
  onGeometry?: (size: { width: number; height: number }) => void
  /**
   * J6 — DOES THE GLUED COPY BECOME A FILE? `false` is the shipped default
   * (`core/glue.ts`, Robert 2026-09-04 (27)): the compositor paints every
   * frame, blits the preview and keeps the liveness beat, and opens no encoder,
   * no muxer, no file and no audio mix. `stop()` then resolves `null`, which is
   * the same answer the session has always handled for a take with no
   * composite. Absent means `true` — every rig that drives this engine directly
   * gets the engine it had.
   */
  record?: boolean
}

export interface LiveCompositeV2Handle {
  /** UI1: move the camera PiP while the take runs. Null restores the default
   *  corner. Fire-and-forget — the next painted frame is the acknowledgement. */
  setCameraPose(pose: CameraPose | null): void
  stop(): Promise<CompositeRecording | null>
  cancel(): Promise<void>
  /** Engine evidence — read by the session for the console line and by tests. */
  stats(): CompositorStats | null
  /**
   * E1's lead-time evidence, as two instants on this engine's own clock: when
   * the leading signals first said 'serious', and when delivery first fell
   * under the floor — i.e. when the OLD ladder would first have had a case.
   * The gap between them is the lead. Read by the rig; nothing in the product
   * consults it.
   */
  pressureMarks(): {
    firstSeriousAtMs: number | null
    firstCriticalAtMs: number | null
    firstUnderFloorAtMs: number | null
    startedAtMs: number
    /** E2 — every refusal to move the picture, counted by reason. The ordering
     *  ruling is as much about the steps NOT taken as the ones taken. */
    holds: Record<string, number>
  }
  /**
   * Hand the compositor a canvas to paint the live preview into (O4-polish).
   * Resolves TRUE only once a frame has actually landed on it, so the caller
   * can drop its own preview without a blank flash; false means keep it.
   */
  attachPreview(canvas: HTMLCanvasElement): Promise<boolean>
  /**
   * J6 — ONE PRESSURE READING, FROM SOMEWHERE ELSE.
   *
   * E1 built one detector for many consumers and M1 lifted the sampler out of
   * this worker so the two threads that own encoder counters could share it.
   * This is the third move in that line: with the composite painting and not
   * encoding, the encoder whose queue actually says whether this take is in
   * trouble is the RAW SCREEN channel's, in `rawVideo.worker.ts` — so the
   * session reads it there and hands it in here, where the ladder, the ledger
   * and F16b's background-render brake all already live.
   *
   * Nothing else changes: the same `notePressure` the worker's own event used
   * to call, so a `?glue=record` take and a shipped one run the identical
   * ladder off the identical detector, and only the instrument differs.
   */
  notePressure(signals: PressureSignals): void
  /**
   * J6 — HOW THIS TAKE WAS COMPOSED, whether or not it left a file.
   *
   * `CompositeRecording` used to be the only carrier of P9's rung and O4's
   * backend, and a paint-only take has no CompositeRecording. Both are runtime
   * fall-throughs, so a take that cannot name them cannot be read — the oracle
   * cells print `made=<intake>/<painter>` off exactly this. Readable at any
   * time; the frame count is whatever the last stats event carried, and is
   * exact after stop().
   */
  machinery(): TakeGlue
}

/**
 * FAULT INJECTION, EVIDENCE ONLY (O4-polish's e2e wedge case). Nothing in the
 * product sets this; the o4wedge rig does, to drive the two fallback rungs that
 * unit tests cannot reach — a start failure and a mid-take degrade — through the
 * REAL session, so what is proven is that the take survives them and that the
 * export lands on the right path, not that a pure function returns the right
 * verdict. The oracle's `injectTailLossMs` is the same pattern.
 */
export interface CompositeFault {
  /** Throw before the worker exists → the session's v1 fallback takes the take. */
  startFails?: boolean
  /** Fire the real degrade path this long after start → composite refused. */
  degradeAfterMs?: number
}
let fault: CompositeFault | null = null
export function setCompositeFault(f: CompositeFault | null): void {
  fault = f
}
export function getCompositeFault(): CompositeFault | null {
  return fault
}

export function canLiveCompositeV2(inputs: LiveCompositeV2Inputs): boolean {
  if (!inputs.screen && !inputs.camera) return false
  return (
    // P9: ANY intake, not the main-thread processor specifically — but a
    // machine that has no processor on the page reaches v2 only when a rung is
    // asked for by name, because THAT is a change to which engine a user's take
    // is made by and its evidence is not taken yet. `intakeArmed` carries the
    // whole reason; which rung runs is decided at start, where the worker can
    // be asked.
    intakeArmed() &&
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    !!navigator.storage?.getDirectory
  )
}

export async function startLiveCompositeV2(
  inputs: LiveCompositeV2Inputs,
  blobKey: string,
  options: LiveCompositeV2Options = {},
): Promise<LiveCompositeV2Handle> {
  // F13: the caller's frame, or the constant this engine shipped with.
  const outW = options.width && options.width > 0 ? options.width : W
  const outH = options.height && options.height > 0 ? options.height : H
  // F15: the caller's rate, same contract. P9 may lower it before the press if
  // the chosen intake cannot pace it — never silently, and never at the press.
  const askedFps = options.fps && options.fps > 0 ? Math.round(options.fps) : FPS
  let outFps = askedFps
  // J6: absent means the engine that shipped before the ruling.
  const record = options.record !== false
  if (fault?.startFails) {
    // Before the worker, before OPFS: the shape of a real capability failure.
    throw new Error('live composite v2: injected start failure (o4wedge)')
  }

  const worker = new Worker(new URL('./compositor.worker.ts', import.meta.url), { type: 'module' })
  let latestStats: CompositorStats | null = null
  let workerError: string | null = null
  let degraded = false
  let torndown = false
  /** F13: the shape has been reported to the caller once, and only once. */
  let geometryReported = false
  const reportGeometry = (st: CompositorStats): void => {
    if (geometryReported || !st.outWidth || !st.outHeight) return
    geometryReported = true
    options.onGeometry?.({ width: st.outWidth, height: st.outHeight })
  }

  /**
   * P9 — what the worker last said about a source it reads ITSELF. Empty on
   * every other rung. Declared up here, not beside the liveness map, because
   * the message handler below closes over it and the intake probe now yields
   * between the two.
   */
  const beats = new Map<'screen' | 'camera', { frames: number; mediaSec: number; live: boolean }>()

  const pending = new Map<string, { resolve: (r: CompositorReply) => void; reject: (e: Error) => void }>()
  worker.onmessage = (ev: MessageEvent<CompositorReply>) => {
    const reply = ev.data
    if ('event' in reply) {
      if (reply.event === 'source') {
        beats.set(reply.kind, { frames: reply.frames, mediaSec: reply.mediaSec, live: reply.live })
        return
      }
      if (reply.event === 'stats') {
        latestStats = reply.stats
        reportGeometry(reply.stats)
        checkWatchdog(reply.stats)
      } else if (reply.event === 'pressure') {
        notePressure(reply.signals)
      } else {
        workerError = reply.error
        console.warn('[capture] compositor worker error', reply.error)
        degrade(`encoder error: ${reply.error}`)
      }
      return
    }
    const waiter = pending.get(reply.cmd)
    if (waiter) {
      pending.delete(reply.cmd)
      waiter.resolve(reply)
    }
  }
  worker.onerror = (ev) => {
    workerError = ev.message || 'compositor worker failed'
    for (const p of pending.values()) p.reject(new Error(workerError))
    pending.clear()
    degrade('worker crashed')
  }

  const call = (msg: CompositorMsg, transfer?: Transferable[]): Promise<CompositorReply> =>
    new Promise((resolve, reject) => {
      pending.set(msg.cmd, { resolve, reject })
      worker.postMessage(msg, transfer ?? [])
    })

  // ---- P9: WHICH INTAKE FEEDS THIS TAKE ----------------------------------
  //
  // PROBES, NEVER NAMES. Three rungs in a fixed order, each tried by asking its
  // constructor rather than by asking what browser this is. `auto` is the
  // shipped order and, on a machine with a main-thread processor, is exactly
  // what every take before the seam did. An explicit ask moves its rung to the
  // front of the order and NOTHING else: a rung this machine does not have
  // still falls through, because the engine never refuses a record press.
  //
  // The worker rung is the only one that cannot be probed from here — WebKit
  // exposes the processor in workers and nowhere else — so it is asked, once,
  // and only by a machine that is not already on the rung above it. The shipped
  // Chromium path never sends this message.
  let workerProbe: boolean | null = null
  const workerHasProcessor = async (): Promise<boolean> => {
    if (workerProbe === null) {
      const reply = await call({ cmd: 'probe' })
      workerProbe = 'trackProcessor' in reply && reply.trackProcessor === true
    }
    return workerProbe
  }
  const wanted = intakeChoice()
  /** Every rung passed over on the way down, and what it was missing. */
  const refused: string[] = []
  let intake: FrameIntakeKind | null = null
  for (const rung of intakeOrder(wanted)) {
    if (rung === 'main-processor') {
      if (trackProcessorCtor() !== null) intake = rung
      else refused.push('main-processor: no track processor on the page')
    } else if (rung === 'element-sampler') {
      if (canSampleElement()) intake = rung
      else refused.push('element-sampler: no VideoFrame from an element')
    } else if (await workerHasProcessor()) intake = rung
    else refused.push('worker-processor: no track processor in the worker')
    if (intake) break
  }
  if (!intake) {
    worker.terminate()
    throw new Error('live composite v2: no frame intake on this machine')
  }
  const declared = INTAKE_DECLARATION[intake]
  outFps = intakeFps(declared, askedFps)
  // THE STATE LINE, BEFORE THE PRESS. A rung that quietly does less than the
  // one above it is the defect this seam exists to prevent, so what this one
  // can do is said out loud — and said again on the report card afterwards,
  // off `CompositeRecording.intake`.
  console.info(
    `[capture] composite intake: ${intakeStateLine(declared, askedFps)}` +
      (wanted === 'auto' ? '' : ` (asked for ${wanted})`) +
      // WHY IT IS NOT THE RUNG ABOVE. A fall-through that says only what it
      // landed on reads exactly like a rung that was never asked for, which is
      // how three oracle cells were nearly quoted as evidence for a rung that
      // had not run (2026-09-04, and the cell line's `made=` is the other half
      // of the same fix).
      (refused.length ? ` — past ${refused.join(', ')}` : ''),
  )

  const startedAt = performance.now()
  const degrade = (reason: string): void => {
    if (degraded) return
    degraded = true
    console.warn(`[capture] composite v2 degraded: ${reason} — falling back`)
    options.onDegrade?.(reason)
  }
  if (fault?.degradeAfterMs !== undefined) {
    // The REAL degrade path, not a stand-in for it: the rig proves the take
    // survives what the watchdog does, so it has to be what the watchdog calls.
    setTimeout(() => degrade('injected wedge (o4wedge)'), fault.degradeAfterMs)
  }

  /** First non-keep-alive output, seen through the 1 Hz stats events — the
   *  watchdog's clock starts here, so encoder initialization is not "slow". */
  let firstOutputAt: number | null = null
  // O6's ladder state. Lives beside the watchdog because it reads the same
  // stats and answers the gentler half of the same question: the watchdog says
  // "give up on the composite", the ladder says "ask the source for less first".
  let currentFps = outFps
  let lastStepAt: number | null = null
  let underFloorSince: number | null = null
  let aboveRecoverySince: number | null = null
  let lastRealFrames = 0
  let lastInFrames = 0
  let lastStatsAt: number | null = null
  // E1's pressure state. Delivery is sampled once a second by the stats event;
  // pressure four times a second by its own. Both feed one verdict, so the
  // last delivery reading is kept here rather than recomputed.
  const pressureOn = pressureDetectorEnabled()
  let lastDeliveredFps = 0
  let lastArrivedFps = 0
  let pressureLevel: PressureLevel | null = null
  let pressureOwnLevel: PressureLevel | null = null
  let pressureWhy: string | null = null
  let pressureBlock: HardwareBlock | null = null
  let seriousSince: number | null = null
  let clearSince: number | null = null
  /** Lead-time evidence: the first instant each side of the question fired. */
  let firstSeriousAt: number | null = null
  let firstCriticalAt: number | null = null
  let firstUnderFloorAt: number | null = null
  /**
   * E2 — rule 5's replacement. A climb undone within FAILED_CLIMB_MS was a
   * climb into headroom that was not there; each one widens the next climb's
   * confirmation window, and one that holds resets the count.
   */
  let failedClimbs = 0
  let lastUpAt: number | null = null
  /** E2 — every refusal to move the picture, by reason, for the certification. */
  const holds: Record<string, number> = {}
  /** E2 — the burst absorber's engagement, deduplicated: one ledger line per
   *  episode, not one per interval, or a loaded minute writes 240 lines. */
  let burstOpen = false

  function notePressure(signals: PressureSignals): void {
    const now = performance.now()
    const reading = readPressure(signals)
    options.onPressure?.(reading, signals)
    /**
     * F16b — THE SAME READING, TO THE OTHER CONSUMER. E1 built one detector
     * for many consumers; this is the second one. It is published BEFORE the
     * capture flag below on purpose: `?pressure=0` turns off the ladder's
     * right to ACT on a reading, and it must not also blind the background
     * render, which is the thing that gets shed instead of the take.
     */
    noteTakePressure(reading)
    // BEFORE the flag, deliberately. The lead-time gate is answered by a
    // `?pressure=0` control run — the only take in which both instants exist,
    // because a take that steps never reaches the floor — so the mark has to be
    // taken whether or not the detector is allowed to act on it.
    if (!reading.blind && (reading.level === 'serious' || reading.level === 'critical')) {
      firstSeriousAt ??= now
      if (reading.level === 'critical') firstCriticalAt ??= now
    }
    // E2's LAYER TWO, on the take's ledger. The absorber is inside the worker
    // and has no other voice; without this line the one layer that keeps frames
    // instead of giving something up would be the only invisible one.
    const absorbed = signals.burst ?? 0
    if (absorbed > 0 && !burstOpen) {
      burstOpen = true
      passDoor(
        {
          dial: 'quality',
          decidedBy: 'absorber',
          layer: 'burst',
          action: 'shed',
          what: `encoder burst absorber engaged (${absorbed} frame(s) held this interval)`,
          why: reading.leader ? `${reading.leader.signal}: ${reading.leader.detail}` : reading.line,
          ...(reading.leader ? { block: reading.leader.block } : null),
          level: reading.level,
          measured: { framesHeld: absorbed, queueMean: signals.queueMean, cliff: signals.queueCliff },
          nowMs: now,
        },
        () => {
          /* the absorber is inside the worker: the act is the worker's, and the
             door's job here is that it cannot happen unrecorded. */
        },
      )
    } else if (absorbed === 0 && burstOpen) {
      burstOpen = false
      passDoor(
        {
          dial: 'quality',
          decidedBy: 'absorber',
          layer: 'burst',
          action: 'restore',
          what: 'encoder queue back inside its steady bound',
          why: reading.line,
          nowMs: now,
        },
        () => undefined,
      )
    }
    if (!pressureOn) return
    // A blind reading is not a nominal one — it is no reading at all, and
    // feeding it in as 'nominal' would let the ladder climb on nothing.
    if (reading.blind) {
      pressureLevel = null
      pressureOwnLevel = null
      pressureBlock = null
      seriousSince = null
      clearSince = null
      return
    }
    pressureLevel = reading.level
    pressureOwnLevel = reading.ownLevel
    pressureBlock = reading.leader?.block ?? null
    pressureWhy = reading.leader ? `${reading.leader.signal}: ${reading.leader.detail}` : null
    if (reading.level === 'serious' || reading.level === 'critical') {
      seriousSince = seriousSince ?? now
      clearSince = null
    } else {
      seriousSince = null
      clearSince = clearSince ?? now
    }
    evaluateLadder(now)
  }

  /**
   * ONE VERDICT, TWO CLOCKS (E1). Delivery is sampled once a second by the
   * stats event; pressure four times a second by its own. Both call this, so a
   * predictive step lands within a quarter second of the signals agreeing
   * instead of waiting for the next stats tick — which was the difference
   * between "responsive" and "a second late" before anything else was tuned.
   */
  function evaluateLadder(now: number): void {
    if (!options.onDegradeStep || degraded) return
    // E2, rule 8(c) — has layer one already gone? TRUE when there is nothing to
    // shed: `?bgpace=0` turns the brake off entirely, and a take must not be
    // left unprotected because the thing that was supposed to go first does not
    // exist. What this forbids is stepping the picture WHILE the background
    // render is still running flat out.
    const unseenWorkShed = !backgroundPaceEnabled() || currentPace() !== 'full'
    const { verdict, hold } = ladderDecision({
      nowMs: now,
      startedAtMs: startedAt,
      firstOutputAtMs: firstOutputAt,
      lastStepAtMs: lastStepAt,
      underFloorForMs: underFloorSince === null ? 0 : now - underFloorSince,
      aboveRecoveryForMs: aboveRecoverySince === null ? 0 : now - aboveRecoverySince,
      deliveredFps: lastDeliveredFps,
      arrivedFps: lastArrivedFps,
      requestedFps: outFps,
      currentFps,
      pressureLevel,
      pressureOwnLevel,
      unseenWorkShed,
      pressureSeriousForMs: seriousSince === null ? 0 : now - seriousSince,
      pressureClearForMs: clearSince === null ? 0 : now - clearSince,
      pressureWhy,
      pressureBlock,
      failedClimbs,
    })
    if (!verdict) {
      if (hold) holds[hold] = (holds[hold] ?? 0) + 1
      return
    }
    const previousFps = currentFps
    currentFps = verdict.rung.fps
    // Rule 5's replacement: a climb undone within FAILED_CLIMB_MS widens the
    // next one's window; a climb that survives it resets the count. Read BEFORE
    // lastStepAt moves, because the interval being measured ends here.
    if (verdict.direction === 'down') {
      if (lastUpAt !== null && now - lastUpAt < FAILED_CLIMB_MS) failedClimbs++
    } else {
      if (lastUpAt !== null && now - lastUpAt >= FAILED_CLIMB_MS) failedClimbs = 0
      lastUpAt = now
    }
    lastStepAt = now
    underFloorSince = null
    aboveRecoverySince = null
    seriousSince = null
    clearSince = null
    console.warn(
      `[capture] capture ladder ${verdict.direction === 'up' ? 'recovering' : 'backing off'} ` +
        `(${verdict.from}): ${verdict.reason}`,
    )
    // E2's LAYER THREE GOES THROUGH THE DOOR (M1), and it is written by
    // whoever APPLIES it — see the note on `onDegradeStep` above. The verdict
    // travels with everything the ledger line needs.
    options.onDegradeStep?.(verdict.rung, verdict.reason, verdict.from, {
      direction: verdict.direction,
      previousFps,
      block: (verdict.block as HardwareBlock | undefined) ?? null,
      level: pressureLevel,
    })
  }

  function checkLadder(now: number, real: number, framesIn: number): void {
    // Delivered fps over the interval between stats events, not since the
    // start: a take that recovers should stop being judged on how it began.
    if (lastStatsAt !== null && now > lastStatsAt) {
      const fps = ((real - lastRealFrames) * 1000) / (now - lastStatsAt)
      const inFps = ((framesIn - lastInFrames) * 1000) / (now - lastStatsAt)
      const requested = outFps
      // P0-ladder-static: demand is what ARRIVED, capped at the requested rate
      // (the cadence gate drops a 60 fps source's excess on purpose). A static
      // screen delivers 0 fps by design and must never read as backpressure.
      // Demand is judged against what is CURRENTLY asked for, not against what
      // the take started at: once the ladder has stepped down, holding the take
      // to its original rate would score a healthy 30 fps as a 50 % failure and
      // it could never climb back.
      const demand = Math.min(inFps, currentFps)
      const ratio = demand > 0 ? fps / demand : 1
      lastDeliveredFps = fps
      lastArrivedFps = inFps
      void requested
      if (demand > 0 && ratio < LADDER_FLOOR) {
        underFloorSince ??= now
        // Lead-time evidence: the instant the AUTOPSY would first have had a
        // case. With the detector on, a step has usually already happened by
        // here and this never fires — which is why the honest number comes off
        // a `?pressure=0` control run, where both instants exist in one take.
        firstUnderFloorAt ??= now
      } else underFloorSince = null
      if (demand > 0 && ratio >= RECOVERY_RATIO) aboveRecoverySince ??= now
      else aboveRecoverySince = null
      evaluateLadder(now)
    }
    lastStatsAt = now
    lastRealFrames = real
    lastInFrames = framesIn
  }

  function checkWatchdog(s: CompositorStats): void {
    if (degraded) return
    const now = performance.now()
    const real = s.framesEncoded - s.keepAliveFrames
    if (real > 0 && firstOutputAt === null) firstOutputAt = now
    checkLadder(now, real, s.framesIn)
    const verdict = watchdogVerdict({
      nowMs: now,
      startedAtMs: startedAt,
      firstOutputAtMs: firstOutputAt,
      realFramesEncoded: real,
      framesDropped: s.framesDropped,
    })
    if (verdict) degrade(verdict)
  }

  // ---- liveness: last frame timestamp per source, sampled on the tick ------
  const liveness = new Map<
    'screen' | 'camera',
    {
      det: SourceLiveness
      /**
       * P9: is the SOURCE still live? A function, not the track, because the
       * `worker-processor` rung has given its track away and a detached handle
       * reads as ended — the worker's beat answers for it instead. Every rung
       * answers the same question; only the evidence differs.
       */
      live: () => boolean
      lastMediaSec: number
      frames: number
      framesAtLog: number
    }
  >()
  let lastFpsLog = startedAt

  const sampleLiveness = (): void => {
    const now = performance.now()
    for (const [kind, s] of liveness) {
      // P9: on the rung where the worker holds the track, the worker is also
      // the only thing that can count frames — take its beat as this source's
      // arrivals and media clock. Empty on every other rung.
      const beat = beats.get(kind)
      if (beat) {
        s.frames = beat.frames
        s.lastMediaSec = beat.mediaSec
      }
      // Frame silence is ambiguous on this frame-driven path (a static screen
      // delivers nothing); the track's own health decides — see sourceLiveness.
      const ev = s.det.sample(
        now,
        s.lastMediaSec,
        s.live(),
        // H4: has this source EVER produced a frame? A static screen has (its
        // first one); a sensor-off camera has not, and no other signal on the
        // track tells them apart.
        s.frames > 0,
      )
      if (ev) {
        console.warn(`[capture] ${kind} source ${ev}`)
        options.onSourceLiveness?.(kind, ev)
      }
    }
    if (now - lastFpsLog >= FPS_LOG_MS) {
      const windowSec = (now - lastFpsLog) / 1000
      lastFpsLog = now
      for (const [kind, s] of liveness) {
        console.info(
          `[capture] ${kind} delivering ${((s.frames - s.framesAtLog) / windowSec).toFixed(1)} fps ` +
            `(v2 worker compositor)`,
        )
        s.framesAtLog = s.frames
      }
    }
  }

  // ---- audio mix, unchanged from v1 in behaviour --------------------------
  const audioCtx = new AudioContext({ sampleRate: 48000 })
  await audioCtx.audioWorklet.addModule(tapModuleUrl())
  const tap = new AudioWorkletNode(audioCtx, 'inout-composite-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    // EXPLICIT STEREO IN, because the encoder is configured for stereo and the
    // batches were not guaranteed to be. The input count defaulted to the MAX
    // of whatever was connected, so an all-mono take (a mono mic, alone or with
    // mono tab audio) delivered 1-channel batches to a 2-channel AAC encoder —
    // a mismatch nothing downstream could have reconciled. v1 never had this
    // hazard: it mixes through a MediaStreamDestination, which is stereo
    // whatever it is fed, and matching that is the point. A genuinely mono
    // source is simply duplicated across both channels, exactly as the measured
    // mic path already does on an unreported channelCount.
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  })
  /**
   * J6 — THE MIX IS PART OF THE FILE, THE TICK IS NOT.
   *
   * The worklet above has two jobs (see TAP_SOURCE): it carries the mixed PCM
   * into the file, and it is the take's hidden-tab-proof liveness clock. Only
   * the first belongs to the composite's encode. With `record: false` nothing
   * is connected to its input — no MediaStreamSource, no limiter, no gain
   * stage — so `process()` sees an empty input and takes the branch that was
   * written for a take with no audio at all: it ticks, and the frozen-screen
   * detector keeps watching. The AAC encode, the batch copies and the
   * postMessage traffic all go with the file.
   */
  const hasAudio = inputs.audio.length > 0 && record
  if (hasAudio) {
    if (inputs.audio.length === 1) {
      audioCtx.createMediaStreamSource(inputs.audio[0]!).connect(tap)
    } else {
      const limiter = audioCtx.createDynamicsCompressor()
      limiter.threshold.value = -3
      limiter.knee.value = 3
      limiter.ratio.value = 12
      limiter.attack.value = 0.003
      limiter.release.value = 0.25
      limiter.connect(tap)
      const perSource = audioCtx.createGain()
      perSource.gain.value = 0.7
      perSource.connect(limiter)
      for (const s of inputs.audio) audioCtx.createMediaStreamSource(s).connect(perSource)
    }
  }
  // The tap must be pulled for process() to run at all.
  tap.connect(audioCtx.destination)
  await audioCtx.resume()

  /**
   * One correspondence between the audio clock and the wall clock, taken here
   * and never re-taken. Every batch's wall time is then derived from its own
   * context timestamp, so however long the worker takes to start — and however
   * long the port queues — the audio anchor cannot move.
   */
  const ctxRefTime = audioCtx.currentTime
  const ctxRefWall = performance.now()
  const wallForContextTime = (t: number): number => ctxRefWall + (t - ctxRefTime) * 1000

  // Assigned BEFORE the worker start round-trip: a port only begins delivering
  // when a handler exists, and batches captured in the meantime must keep the
  // capture times they were stamped with, not the time they were handed over.
  const queuedAudio: {
    planar: Float32Array
    frames: number
    channels: number
    atMs: number
    recvMs: number
  }[] = []
  let workerReady = false
  let audioBatches = 0

  const sendAudio = (batch: {
    planar: Float32Array
    frames: number
    channels: number
    atMs: number
    recvMs: number
  }): void => {
    audioBatches++
    worker.postMessage({ cmd: 'audio', ...batch } satisfies CompositorMsg, [batch.planar.buffer])
  }

  tap.port.onmessage = (
    ev: MessageEvent<{ tick?: boolean; frames?: number; channels?: number; planar?: Float32Array; contextTime?: number }>,
  ) => {
    if (torndown) return
    // Taken FIRST: this stamp is the take's only witness that is independent of
    // the audio clock, and the handler below does real work.
    const recvMs = performance.now()
    sampleLiveness()
    const { frames, channels, planar, contextTime } = ev.data
    if (!frames || !channels || !planar || contextTime === undefined) return
    const batch = { planar, frames, channels, atMs: wallForContextTime(contextTime), recvMs }
    if (workerReady) sendAudio(batch)
    else queuedAudio.push(batch)
  }

  const startReply = await call({
    cmd: 'start',
    key: blobKey,
    width: outW,
    height: outH,
    fps: outFps,
    followSource: options.followSource === true,
    // E2's runtime fallback (the frozen rule): `?burst=0` is the shipped
    // "drop the seventh frame" behaviour, and the A/B control its gate is read
    // against. Read here because a worker cannot see the page's URL.
    burst: burstAbsorberEnabled(),
    // O4's painter, read here for the same reason as `burst`: a worker cannot
    // see the page's URL. A machine without WebGPU falls through inside the
    // worker rather than being decided against here.
    painter: painterChoice(),
    // P9: only the rung where the worker reads tracks itself needs to be told
    // what this thread's clock reads. Every other rung stamps its frames here
    // and the field stays absent, so the shipped message is unchanged.
    ...(intake === 'worker-processor' ? { mainNowMs: performance.now() } : null),
    longEdge: options.longEdge,
    videoBitrate: VIDEO_BITS,
    audioBitrate: AUDIO_BITS,
    sampleRate: hasAudio ? audioCtx.sampleRate : null,
    channelCount: 2,
    // J6 — paint, or paint and encode. Sent always rather than conditionally so
    // the worker never has to guess which engine asked it.
    record,
  })
  if (!('ok' in startReply) || !startReply.ok) {
    worker.terminate()
    await audioCtx.close().catch(() => undefined)
    throw new Error('error' in startReply ? startReply.error : 'compositor start failed')
  }
  workerReady = true
  /** O4's answer, kept for the take's own record (see CompositeRecording). */
  let painterBackend: 'webgpu' | 'webgl2' | '2d' | null = null
  // ON THE PAGE'S CONSOLE, because the worker's own is invisible to every rig
  // and to the black box. It says what was ASKED for too when the two differ,
  // so a machine that fell back says so instead of quietly reading as a
  // successful WebGPU take (O4).
  {
    const asked = painterChoice()
    const got = 'backend' in startReply ? startReply.backend : 'unknown'
    if ('backend' in startReply) painterBackend = startReply.backend
    console.info(
      `[capture] composite painter: ${got}${got === asked ? '' : ` (asked for ${asked})`}`,
    )
  }
  for (const batch of queuedAudio) sendAudio(batch)
  queuedAudio.length = 0

  // ---- frame intake: one of three, chosen above (P9) ------------------------
  const readers: { cancel: () => void }[] = []
  let sampler: ElementSamplerHandle | null = null
  const watch = (kind: 'screen' | 'camera', live: () => boolean): void => {
    liveness.set(kind, { det: new SourceLiveness(), live, lastMediaSec: -1, frames: 0, framesAtLog: 0 })
  }
  const videoTrack = (stream: MediaStream): MediaStreamTrack | null => stream.getVideoTracks()[0] ?? null

  const pump = (stream: MediaStream, kind: 'screen' | 'camera'): void => {
    const TP = trackProcessorCtor()
    const track = videoTrack(stream)
    if (!TP || !track) return
    watch(kind, () => track.readyState === 'live' && !track.muted)
    const reader = new TP({ track }).readable.getReader()
    readers.push({ cancel: () => void reader.cancel().catch(() => undefined) })
    void (async () => {
      for (;;) {
        let result: ReadableStreamReadResult<VideoFrame>
        try {
          result = await reader.read()
        } catch {
          break
        }
        const { value, done } = result
        if (done || torndown || degraded) {
          value?.close()
          break
        }
        const state = liveness.get(kind)
        if (state) {
          state.frames++
          state.lastMediaSec = value.timestamp / 1e6
        }
        // Transferred, not copied — the worker owns and closes it.
        worker.postMessage({ cmd: 'frame', kind, atMs: performance.now(), frame: value } satisfies CompositorMsg, [
          value,
        ])
      }
    })()
  }

  /**
   * THE WORKER READS THE TRACK ITSELF. A CLONE is transferred, never the take's
   * own track: the same MediaStream feeds the raw channel recorder and the
   * preview, and transferring detaches the handle this page holds. The clone is
   * the worker's to stop; the original dies with the session, as it always has.
   *
   * A transfer that is refused is not a dead take — the sampler below is a
   * complete intake and takes over. That can only happen on an engine whose
   * worker HAS a processor but will not hand it a track, which no engine does
   * today; it is here because the alternative is a take with no picture.
   */
  const handOver = async (stream: MediaStream, kind: 'screen' | 'camera'): Promise<boolean> => {
    const track = videoTrack(stream)
    if (!track) return true
    const clone = track.clone()
    try {
      await call({ cmd: 'source', kind, track: clone }, [clone as unknown as Transferable])
    } catch (err) {
      clone.stop()
      console.warn(`[capture] composite intake: ${kind} track could not be transferred`, err)
      return false
    }
    watch(kind, () => beats.get(kind)?.live ?? true)
    return true
  }

  const attachSampler = async (): Promise<void> => {
    sampler = await startElementSampler({
      screen: inputs.screen,
      camera: inputs.camera,
      audioContext: audioCtx,
      fps: outFps,
      onFrame: (kind, frame, atMs, mediaSec) => {
        if (torndown || degraded) {
          frame.close()
          return
        }
        const state = liveness.get(kind)
        if (state) {
          state.frames++
          state.lastMediaSec = mediaSec
        }
        // Transferred, not copied — the worker owns and closes it, exactly as
        // on the processor rungs.
        worker.postMessage({ cmd: 'frame', kind, atMs, frame } satisfies CompositorMsg, [frame])
      },
    })
    for (const [kind, stream] of [
      ['screen', inputs.screen],
      ['camera', inputs.camera],
    ] as const) {
      if (!stream) continue
      const track = videoTrack(stream)
      if (!track) continue
      watch(kind, () => track.readyState === 'live' && !track.muted)
    }
  }

  if (intake === 'main-processor') {
    if (inputs.screen) pump(inputs.screen, 'screen')
    if (inputs.camera) pump(inputs.camera, 'camera')
  } else if (intake === 'worker-processor') {
    const screenOk = inputs.screen ? await handOver(inputs.screen, 'screen') : true
    const cameraOk = screenOk && inputs.camera ? await handOver(inputs.camera, 'camera') : screenOk
    if (!screenOk || !cameraOk) {
      intake = 'element-sampler'
      await attachSampler()
    }
  } else {
    await attachSampler()
  }

  const teardown = async (): Promise<void> => {
    if (torndown) return
    torndown = true
    tap.port.onmessage = null
    sampler?.stop()
    for (const r of readers) r.cancel()
    try {
      tap.disconnect()
    } catch {
      /* already gone */
    }
    if (audioCtx.state !== 'closed') await audioCtx.close().catch(() => undefined)
  }

  return {
    stats: () => latestStats,
    // J6 — the reading arrives from the raw screen encoder's worker when this
    // composite has none of its own. Same detector, same ladder, same ledger.
    notePressure,
    machinery: () => ({
      recorded: record,
      engine: 'v2',
      intake,
      ...(painterBackend ? { painter: painterBackend } : null),
      framesPainted: latestStats?.framesEncoded ?? 0,
    }),
    pressureMarks: () => ({
      firstSeriousAtMs: firstSeriousAt,
      firstCriticalAtMs: firstCriticalAt,
      firstUnderFloorAtMs: firstUnderFloorAt,
      startedAtMs: startedAt,
      holds: { ...holds },
    }),

    setCameraPose(pose: CameraPose | null): void {
      if (torndown || degraded || workerError) return
      try {
        worker.postMessage({ cmd: 'campose', pose } satisfies CompositorMsg)
      } catch {
        // A worker that has gone away simply keeps the pose it last painted.
      }
    },

    async attachPreview(el: HTMLCanvasElement): Promise<boolean> {
      if (torndown || degraded || workerError) return false
      let off: OffscreenCanvas
      try {
        off = el.transferControlToOffscreen()
      } catch {
        // Already transferred (a re-render handing over the same element), or
        // the browser has no OffscreenCanvas: the <video> preview stays.
        return false
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const reply = await Promise.race([
          call({ cmd: 'preview', canvas: off } satisfies CompositorMsg, [off]),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), PREVIEW_ATTACH_BUDGET_MS)
          }),
        ])
        if (!reply) {
          pending.delete('preview')
          console.info('[capture] composite preview did not paint in time — keeping the source preview')
          return false
        }
        return 'ok' in reply && reply.ok
      } catch {
        return false
      } finally {
        if (timer) clearTimeout(timer)
      }
    },

    async stop() {
      const wallMs = performance.now() - startedAt
      await teardown()
      // J6 — THERE IS NO FILE, AND THAT IS NOT A FAILURE. `null` is the answer
      // the session has always had for "this take has no composite"; the drain
      // below has nothing to drain, and `blobStore.remove` would be reaching
      // for a key nothing ever created.
      if (!record) {
        let painted = latestStats?.framesEncoded ?? 0
        try {
          const reply = await call({ cmd: 'stop' })
          if ('ok' in reply && reply.ok && reply.cmd === 'stop') painted = reply.stats.framesEncoded
        } catch {
          /* the count is evidence, not the take */
        } finally {
          worker.terminate()
        }
        console.info(
          `[capture] composite painted ${painted} frames and encoded none (J6, ?glue=record puts the ` +
            `second encoder and its file back)`,
        )
        return null
      }
      if (degraded) {
        await call({ cmd: 'cancel' }).catch(() => undefined)
        worker.terminate()
        await blobStore.remove(blobKey).catch(() => undefined)
        return null
      }
      let stats: CompositorStats | null = null
      try {
        const reply = await call({ cmd: 'stop' })
        if ('ok' in reply && reply.ok && reply.cmd === 'stop') stats = reply.stats
      } catch (err) {
        console.warn('[capture] composite v2 stop failed', err)
      } finally {
        worker.terminate()
      }
      if (!stats || stats.bytes === 0 || stats.framesEncoded === 0 || workerError) {
        await blobStore.remove(blobKey).catch(() => undefined)
        return null
      }
      latestStats = stats
      const seconds = Math.max(0.001, stats.durationMs / 1000)
      // O11a: where the bits went, counted rather than guessed.
      console.info(
        `[capture] composite v2 ${stats.codec} ${stats.hardware} — ` +
          `${stats.framesEncoded} frames (${stats.framesDropped} dropped, ${stats.keepAliveFrames} keep-alive, ` +
          `peak queue ${stats.peakQueue}), ${audioBatches} audio batches; ` +
          `video ${(stats.videoBytes / 1024).toFixed(0)} KB at ` +
          `${((stats.videoBytes * 8) / seconds / 1e6).toFixed(2)} Mbps of ` +
          `${(stats.requestedVideoBitrate / 1e6).toFixed(1)} Mbps requested, ` +
          `keyframes ${stats.keyframeCount} = ${((stats.keyframeBytes / Math.max(1, stats.videoBytes)) * 100).toFixed(0)}% of video bytes, ` +
          `audio ${(stats.audioBytes / 1024).toFixed(0)} KB` +
          // O4-polish: what the preview blit costs, per frame, measured rather
          // than asserted. Absent from the line when nothing asked for one.
          (stats.previewMs > 0
            ? `; preview ${(stats.previewMs / Math.max(1, stats.framesEncoded)).toFixed(2)} ms/frame ` +
              `(${stats.previewMs.toFixed(0)} ms total)`
            : ''),
      )
      const composite: CompositeRecording = {
        blobKey,
        engine: 'v2',
        // P9/O4: which rung and which backend actually ran. Both fall through
        // at runtime, so a take that does not carry them cannot be read.
        intake,
        ...(painterBackend ? { painter: painterBackend } : null),
        mimeType: 'video/mp4',
        // The encoder's own last timestamp is the truth; wall time includes
        // teardown and would overstate the file by the drain.
        durationMs: Math.round(stats.durationMs || wallMs),
        // F13: what the worker actually WROTE, which is not always what it was
        // asked for — the first frame may have turned it.
        width: stats.outWidth || outW,
        height: stats.outHeight || outH,
        // F15: the cadence gate's rate, which IS the file's rate — the worker
        // encodes at most one frame per 1000/fps ms and stamps every frame's
        // duration from it.
        fps: outFps,
        bytes: stats.bytes,
      }
      // WHERE THIS FILE'S ZERO SITS IN THE TAKE (P0-instant-sync). The worker
      // stamps its origin with the MAIN-THREAD clock that stamped the arrival,
      // so the subtraction is between two readings of one clock.
      if (options.epochMs !== undefined && stats.originAtMs !== null) {
        const offset = Math.round(stats.originAtMs - options.epochMs)
        composite.startOffsetMs = offset
        console.info(`[capture] composite v2 clock starts +${offset}ms into the take`)
      }
      return composite
    },

    async cancel() {
      await teardown()
      try {
        await call({ cmd: 'cancel' })
      } catch {
        /* worker may already be gone */
      }
      worker.terminate()
      // J6: nothing was ever written under this key on a paint-only take.
      if (record) await blobStore.remove(blobKey).catch(() => undefined)
    },
  }
}
