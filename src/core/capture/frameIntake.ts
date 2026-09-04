/**
 * WHICH INTAKE FEEDS THE CAPTURE COMPOSITOR (task P9).
 *
 * The contract and the three rungs are documented on `FrameIntakeKind` in
 * core/types.ts. This file is only the CHOOSING: the probes that say which
 * rungs this machine has, the order they are tried in, and the switch.
 *
 * PROBES, NEVER NAMES. Not one line here asks what browser is running. A rung
 * is available because its constructor answers, and the browser's name appears
 * only where a person has to be told something true.
 *
 * WHY IT IS NOT CALLED "frame source": `inout.frame.source` is already taken,
 * and it means something else entirely — which SOURCE the composite takes its
 * SHAPE from (core/frame.ts, F13). This is the INTAKE: how frames get in.
 *
 *   ?intake=auto | main | worker | element      (URL, this take)
 *   localStorage['inout.capture.intake']        (sticky)
 *
 * `auto` is the default and is what every take has always done on a machine
 * with a main-thread track processor: `main`. Asking for a rung this machine
 * does not have falls through to the next one rather than failing a take — the
 * engine never refuses a record press.
 *
 * MEASURED 2026-09-04, Chrome 152 on this Mac, headless AND headed, because the
 * task was written expecting the opposite and a session nearly quoted three
 * oracle cells as evidence for a rung that had not run:
 *
 *   main thread   MediaStreamTrackProcessor  YES
 *   worker        MediaStreamTrackProcessor  NO      VideoEncoder YES
 *   MediaStreamTrack transfer to a worker    DataCloneError
 *                 ("does not have a transferable type", on a canvas track)
 *
 * CHROMIUM AND WEBKIT ARE EXACT COMPLEMENTS ON THIS ONE API: the processor is
 * on the page here and in the worker there. So `worker-processor` CANNOT BE
 * EXERCISED ON CHROMIUM AT ALL — its probe correctly answers no and the walk
 * falls to the sampler, which is the behaviour proven here. Its own evidence
 * needs a real WebKit and does not exist yet (Robert declined the Playwright
 * download, 2026-09-04). Do not re-derive this by reading a spec.
 *
 * AND A WARNING FOR WHOEVER TAKES THAT CELL: the oracle rig's source is a
 * CANVAS captureStream, and a canvas track is the one that refused to transfer
 * above. If WebKit refuses it too, the rig needs a getDisplayMedia or
 * getUserMedia track before the worker rung can be measured through it at all.
 */
import type { FrameIntakeDeclaration, FrameIntakeKind } from '../types'

export type IntakeChoice = 'auto' | 'main' | 'worker' | 'element'

const FLAG_KEY = 'inout.capture.intake'

let override: IntakeChoice | null = null

function parse(v: string | null): IntakeChoice | null {
  return v === 'auto' || v === 'main' || v === 'worker' || v === 'element' ? v : null
}

function fromSearch(): IntakeChoice | null {
  if (typeof location === 'undefined') return null
  return parse(new URLSearchParams(location.search).get('intake'))
}

function fromStorage(): IntakeChoice | null {
  try {
    return parse(localStorage.getItem(FLAG_KEY))
  } catch {
    return null
  }
}

/** The intake this take should ASK for; the probes still have the last word. */
export function intakeChoice(): IntakeChoice {
  return fromSearch() ?? override ?? fromStorage() ?? 'auto'
}

export function setIntakeChoice(c: IntakeChoice | null): void {
  override = c
  try {
    if (c === null) localStorage.removeItem(FLAG_KEY)
    else localStorage.setItem(FLAG_KEY, c)
  } catch {
    /* memory-only */
  }
}

/** MediaStreamTrackProcessor — still absent from the TS DOM lib. */
export interface TrackProcessorLike {
  readable: ReadableStream<VideoFrame>
}
export type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => TrackProcessorLike

/**
 * The processor on THIS thread. Called from the main thread it answers for the
 * `main-processor` rung; the worker calls the same function about itself,
 * which is why it takes no argument and reads `globalThis`.
 */
export function trackProcessorCtor(): TrackProcessorCtor | null {
  const g = globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }
  return typeof g.MediaStreamTrackProcessor === 'function' ? g.MediaStreamTrackProcessor : null
}

/**
 * Can a VideoFrame be BUILT here, from a picture that is already on the page?
 *
 * `typeof VideoFrame === 'function'` is not the question — the constructor has
 * several overloads and the one this rung needs is the CanvasImageSource one.
 * So it is built once, on a 1x1 canvas, and closed: no element, no stream, no
 * device, and the answer is the constructor's own rather than a guess about
 * it. Cached, because a take must not pay for it twice.
 */
let sampleProbe: boolean | null = null
export function canSampleElement(): boolean {
  if (sampleProbe !== null) return sampleProbe
  sampleProbe = false
  if (typeof document === 'undefined' || typeof AudioWorkletNode === 'undefined') return false
  const Ctor = (globalThis as { VideoFrame?: new (src: CanvasImageSource, init: { timestamp: number }) => VideoFrame })
    .VideoFrame
  if (typeof Ctor !== 'function') return false
  try {
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    new Ctor(c, { timestamp: 0 }).close()
    sampleProbe = true
  } catch {
    sampleProbe = false
  }
  return sampleProbe
}

/**
 * MAY v2 TAKE THIS MACHINE? The synchronous half of `canLiveCompositeV2`, which
 * runs before a worker exists — and whether the processor lives in a WORKER
 * cannot be known from this thread at all, so the answer here is about the two
 * rungs this thread can see and the walk at start finds the rest.
 *
 * It is deliberately not "is there any intake".
 *
 * A machine WITH a main-thread processor is untouched: it always could run v2,
 * it still does, and it now does so through this seam. A machine WITHOUT one
 * records on v1 today, and moving it to v2 is a change to what a user's take is
 * made by — the frozen rule puts that behind Robert's yes, and behind the
 * evidence his yes would be given on: each rung's own oracle cell ON ITS OWN
 * ENGINE. Playwright's WebKit and Firefox are not downloaded (Robert,
 * 2026-09-04: "No, not now"), so those two cells do not exist and the arrival
 * waits.
 *
 * WHAT THAT DOES NOT MEAN: the seam is not off. Every Chromium take runs
 * through it, all three rungs run and are measured on Chromium, and asking for
 * one by name (`?intake=worker`, `?intake=element`, or the /?test panel row)
 * arms it anywhere — including on an engine with no main-thread processor,
 * which is how the two missing cells get taken the day the browsers are there.
 * What waits is one line: which engine a Safari or Firefox user gets by
 * DEFAULT.
 *
 * The sampler probe is second on purpose: on a machine with a main-thread
 * processor nothing builds a throwaway VideoFrame to answer a question already
 * answered.
 */
export function intakeArmed(): boolean {
  return trackProcessorCtor() !== null || (canSampleElement() && intakeChoice() !== 'auto')
}

/**
 * WHAT EACH RUNG CAN DO, stated once so nothing has to infer it.
 *
 * `maxFps` is Infinity for both processor rungs because a processor delivers
 * whatever the source delivers — the rung imposes no ceiling of its own. The
 * sampler's ceiling is its own tick: the ticker worklet fires every 3 render
 * quanta (128 frames each), which is 125 Hz at 48 kHz, and a sampler that must
 * not alias needs its tick comfortably above the rate it is pacing.
 */
export const INTAKE_DECLARATION: Record<FrameIntakeKind, FrameIntakeDeclaration> = {
  'main-processor': {
    kind: 'main-processor',
    maxFps: Infinity,
    frameClock: 'source',
    liveness: 'track',
    mainThreadPixels: false,
  },
  'worker-processor': {
    kind: 'worker-processor',
    maxFps: Infinity,
    frameClock: 'source',
    liveness: 'beat',
    mainThreadPixels: false,
  },
  'element-sampler': {
    kind: 'element-sampler',
    maxFps: 60,
    frameClock: 'sampled',
    liveness: 'track',
    mainThreadPixels: true,
  },
}

/**
 * THE ORDER THE RUNGS ARE TRIED IN.
 *
 * `auto` is the shipped order, and on a machine with a main-thread processor it
 * ends at the first rung — which is exactly what every take before this seam
 * did. An explicit ask moves its own rung to the FRONT and changes nothing
 * else: the rest of the order still follows, so asking for a rung this machine
 * does not have falls through instead of failing a take.
 *
 * `main` is the same list as `auto` because `auto` already starts there; saying
 * it is how a take pins the shipped rung on a machine that would otherwise pick
 * another, which is the A/B control every rung's evidence is read against.
 */
export function intakeOrder(wanted: IntakeChoice): FrameIntakeKind[] {
  if (wanted === 'worker') return ['worker-processor', 'element-sampler', 'main-processor']
  if (wanted === 'element') return ['element-sampler', 'main-processor', 'worker-processor']
  return ['main-processor', 'worker-processor', 'element-sampler']
}

/**
 * THE STATE LINE, said BEFORE the press and again on the report card after it.
 *
 * A rung that quietly does less than the one above it is the defect this task
 * exists to prevent, so the difference is spelled out in words rather than
 * left for someone to notice in a file. Plain enough for a person, exact
 * enough to diff between two takes.
 */
export function intakeStateLine(d: FrameIntakeDeclaration, askedFps: number): string {
  const rate = d.maxFps === Infinity ? "the source's own rate" : `up to ${d.maxFps} fps`
  const cap = askedFps > d.maxFps ? ` — this take asked for ${askedFps} and gets ${d.maxFps}` : ''
  const clock = d.frameClock === 'source' ? "each frame's own capture stamp" : 'the moment it was read'
  const px = d.mainThreadPixels ? 'the main thread builds each frame' : 'the main thread paints nothing'
  return `${d.kind}: ${rate}${cap}, timed by ${clock}, ${px}`
}

/**
 * The rate a rung may actually be asked for. The rung REFUSES the feature it
 * cannot deliver before the press instead of accepting the number and quietly
 * missing it — but it never refuses the PRESS.
 */
export function intakeFps(d: FrameIntakeDeclaration, askedFps: number): number {
  return Math.min(askedFps, d.maxFps)
}
