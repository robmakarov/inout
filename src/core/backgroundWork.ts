/**
 * WHAT A BACKGROUND JOB IS ALLOWED TO SPEND RIGHT NOW — task F16b.
 *
 * Robert, 2026-09-01 (DECISIONS (3)): "render can be parallel to record, it
 * just must not fuck up ... make it elastic too". PERFECT = PARALLEL AND
 * PROVABLY HARMLESS, NOT PAUSED. The priority order is absolute —
 * CAPTURE > EDITING > BACKGROUND RENDER — but the mechanism is elasticity: the
 * background render is the FIRST load shed on the machine, throttled all the
 * way to paused before anything of the take's is touched, and ramping back the
 * moment the pressure clears.
 *
 * This file is the BROKER, not a second detector. `core/pressure.ts` is the
 * product's one instrument (E1, "one detector, many consumers"); capture
 * publishes its readings here and background work subscribes. It sits in
 * `core/` beside pressure.ts for the same reason pressure.ts is not in
 * capture/: the publisher is capture and the consumer is compose, and neither
 * may import the other.
 *
 * ── THE POLICY, AND THE ASYMMETRY IT IS BUILT ON ──
 * Being wrong about a background job costs a pre-render that arrives later —
 * and a late pre-render still saves time, because every miss falls through to
 * rendering on demand (F16's permanent contract). Being wrong the other way
 * costs the take, which cannot be re-recorded. So:
 *
 *   no take running          FULL     nothing to be polite to.
 *   take + nominal           HALF     parallel, paced in chunks.
 *   take + fair              TRICKLE  still moving, mostly out of the way.
 *   take + serious/critical  PAUSED   shed completely, before the composite,
 *                                     before anything of the take's.
 *   take + NOTHING READABLE  PAUSED   a blind reading is not a healthy one
 *                                     (R1's rule). The detector's own inversion
 *                                     — "unmeasured must not fire a step" —
 *                                     applies to CAPTURE, where firing damages
 *                                     the take. Here the thing that gets shed
 *                                     is the job, so blind sheds.
 *
 * The duty cycles are not chosen by taste: they are what `npm run exp -- f16b`
 * measures a max60 take against, three-way (no job / elastic job / unthrottled
 * job as the positive control). A number that harms the take is a number that
 * changes, and the handoff carries the run.
 */
import { elasticLogOpen } from './elasticLog'
import { passDoor } from './door'
import { atLeast, type HardwareBlock, type PressureLevel, type PressureReading } from './pressure'
import type { PaceSource, WorkPace } from './types'

export type { WorkPace }

export const PACE_DUTY: Record<WorkPace, number> = {
  full: 1,
  half: 0.5,
  trickle: 0.2,
  paused: 0,
}

/**
 * How long a clear reading has to hold before the job climbs back a rung.
 *
 * E1 measured this machine's recovery at 442-576 ms after a load lifts, so a
 * second of quiet is one full recovery plus margin — long enough that a job
 * does not chatter against a flickering reading, short enough that the ramp
 * back is a ramp and not a restart. The step DOWN has no such delay: a
 * prediction that waits is not a prediction (E1's whole assignment).
 */
export const RAMP_UP_AFTER_MS = 1000

/**
 * How long a hand on the editor keeps the job out of the way.
 *
 * Robert's priority order is CAPTURE > EDITING > BACKGROUND RENDER, and until
 * this existed only the first half was implemented — the job ran flat out
 * beside somebody dragging a playhead. Measured on 2026-09-02 in a real,
 * visible editor (`node scripts/editor-drag-cost.mjs`): the steady drag pays
 * almost nothing (p95 scheduling lateness 1.4-1.5 ms alone, 2.2-3.2 ms beside
 * the render), but the FIRST seek of a drag hit one stall of 35-201 ms in four
 * runs of seven — the player's decoder starting up against a render that is
 * saturating the same decode path.
 *
 * TRICKLE, NOT PAUSE, and the difference is F16's whole design: "editing is
 * when the machine is idle" — the render is SUPPOSED to make progress while
 * someone reviews a take. What it must not do is make the hand stutter, so it
 * steps down for as long as the hand is moving and climbs straight back.
 */
export const EDITING_QUIET_MS = 700

/**
 * HOW LONG THE EDITOR'S OWN OPENING OUTRANKS A BACKGROUND RENDER — and why
 * "editing" could not just mean a hand that is already moving.
 *
 * Robert, 2026-09-02, on a 124-minute take: "when edit was open after long take
 * there was black screen for long time until it loaded."
 *
 * At the end of a take whose export must render, F16b starts a pre-render AT
 * STOP. `takeActive` is false by then and nobody has touched the editor yet, so
 * `paceFor` answers FULL and that render goes flat out — decoder, encoder and
 * disk — in the same seconds the editor is opening its channel blobs, starting
 * a <video> decoder per channel at the take's native resolution, and building
 * a filmstrip and a waveform. Every one of those competes with the render for
 * the same media engine, and the user is looking at black while they lose.
 *
 * The half of Robert's priority order that was missing is that OPENING an
 * editor is editing. `noteEditingActivity` only ever heard a pointer, so the
 * one moment the editor needs the machine most was the one moment it asked for
 * nothing. This is the same brake with a different trigger: the window opens
 * when the editor mounts and closes when its preview is on screen.
 *
 * BOUNDED, because the closing signal comes from the app and an app can fail to
 * send it — a take whose stage never paints must not hold the render down for
 * the rest of the session. Past the cap the window closes itself.
 */
export const EDITOR_OPENING_MAX_MS = 30_000

/**
 * How long a take may be judged from a reading that has stopped arriving.
 *
 * The composite posts pressure every 250 ms. Nothing for four intervals means
 * the instrument is gone (a degraded composite, a take with no composite at
 * all), which is `blind`, not `nominal`.
 */
export const READING_STALE_AFTER_MS = 1000

// ---------------------------------------------------------------------------
// THE FLAG. The frozen rule (never break a working path) asks every new engine
// to keep the old one reachable at runtime, and here the old one is simply "a
// background render spends the machine". `?bgpace=0` is that, and it is also
// the POSITIVE CONTROL the gate is measured against — Robert can run the same
// comparison on his own machine in one URL.
//
//   ?bgpace=1|0                              (this load only)
//   localStorage['inout.compose.bgpace']     (sticky)
// ---------------------------------------------------------------------------

const FLAG_KEY = 'inout.compose.bgpace'

function flagFromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('bgpace')
  return v === '1' ? true : v === '0' ? false : null
}

let flagOverride: boolean | null = null

export function backgroundPaceEnabled(): boolean {
  const url = flagFromSearch()
  if (url !== null) return url
  if (flagOverride !== null) return flagOverride
  try {
    const v = localStorage.getItem(FLAG_KEY)
    if (v === '1') return true
    if (v === '0') return false
  } catch {
    /* storage unavailable — the default stands */
  }
  return true
}

export function setBackgroundPace(on: boolean | null): void {
  flagOverride = on
  try {
    if (on === null) localStorage.removeItem(FLAG_KEY)
    else localStorage.setItem(FLAG_KEY, on ? '1' : '0')
  } catch {
    /* memory-only */
  }
}

export interface BackgroundWorkState {
  pace: WorkPace
  /** Why, in one clause. Never null — a pace with no reason is not auditable. */
  why: string
  /** True while a take is being recorded. */
  takeActive: boolean
  /** The last level published, or null when nothing readable has arrived. */
  level: PressureLevel | null
}

type Listener = (state: BackgroundWorkState) => void

const listeners = new Set<Listener>()

let takeActive = false
let editingAt: number | null = null
/** When the editor started opening, or null when it is not opening. */
let editorOpeningAt: number | null = null
let level: PressureLevel | null = null
let leaderWhy: string | null = null
let leaderBlock: HardwareBlock | null = null
let readingAt = 0
let clearSince: number | null = null
let state: BackgroundWorkState = {
  pace: 'full',
  why: 'no take is recording',
  takeActive: false,
  level: null,
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function paceFor(t: number): { pace: WorkPace; why: string } {
  if (!backgroundPaceEnabled()) return { pace: 'full', why: 'the brake is off (?bgpace=0)' }
  if (!takeActive) {
    // NULL, not 0, for "nobody has touched the editor this session": a clock
    // that starts at zero (every fake-timer test, and a page at its first
    // frame) would read a zero here as a hand still on it.
    if (editingAt !== null && t - editingAt <= EDITING_QUIET_MS) {
      return { pace: 'trickle', why: 'a hand is on the editor' }
    }
    if (editorOpeningAt !== null && t - editorOpeningAt <= EDITOR_OPENING_MAX_MS) {
      // Which of them is still holding, because "the editor is opening" for
      // eight seconds is a question and not an answer.
      const holding = [...editorHolds.values()].join(' + ')
      return { pace: 'trickle', why: `the editor is opening — ${holding || 'nothing named'}` }
    }
    return { pace: 'full', why: 'no take is recording' }
  }
  const fresh = level !== null && t - readingAt <= READING_STALE_AFTER_MS
  if (!fresh) {
    return {
      pace: 'paused',
      why: level === null ? 'a take is recording and nothing readable has arrived' : 'the pressure reading went stale',
    }
  }
  const current = level as PressureLevel
  if (atLeast(current, 'serious')) {
    return { pace: 'paused', why: `pressure ${current}${leaderWhy ? ` — ${leaderWhy}` : ''}` }
  }
  // A rung is climbed only after the reading has been clear for long enough;
  // it is dropped the instant it is not.
  const clearedFor = clearSince === null ? 0 : t - clearSince
  if (current === 'fair') return { pace: 'trickle', why: `pressure fair${leaderWhy ? ` — ${leaderWhy}` : ''}` }
  if (clearedFor < RAMP_UP_AFTER_MS) {
    return { pace: 'trickle', why: `pressure nominal for ${Math.round(clearedFor)} ms — ramping back` }
  }
  return { pace: 'half', why: 'a take is recording and the machine is nominal' }
}

/**
 * THE ANSWER EXPIRES ON ITS OWN, so something has to ask again.
 *
 * Two of the rules above are about the passage of time rather than about an
 * event — a hand that stopped moving, and a pressure reading that stopped
 * arriving — and the consumer of this broker is a render in a WORKER that only
 * learns of a change when the main thread posts one. Without this timer a job
 * throttled for a drag would stay throttled after the hand lifted, and a job
 * shed for a take whose instrument died would never be told the take ended.
 * The timer exists only while an expiry is pending; an idle app schedules
 * nothing.
 */
let recheck: ReturnType<typeof setTimeout> | null = null

function scheduleRecheck(t: number): void {
  if (recheck !== null) {
    clearTimeout(recheck)
    recheck = null
  }
  const due: number[] = []
  if (editingAt !== null && t - editingAt <= EDITING_QUIET_MS) due.push(editingAt + EDITING_QUIET_MS)
  if (editorOpeningAt !== null && t - editorOpeningAt <= EDITOR_OPENING_MAX_MS) {
    due.push(editorOpeningAt + EDITOR_OPENING_MAX_MS)
  }
  if (takeActive && level !== null && t - readingAt <= READING_STALE_AFTER_MS) {
    due.push(readingAt + READING_STALE_AFTER_MS)
  }
  if (takeActive && clearSince !== null && t - clearSince < RAMP_UP_AFTER_MS) {
    due.push(clearSince + RAMP_UP_AFTER_MS)
  }
  if (due.length === 0) return
  const at = Math.min(...due)
  recheck = setTimeout(() => {
    recheck = null
    publish(now())
  }, Math.max(16, at - t + 10))
}

function publish(t: number): void {
  const next = paceFor(t)
  scheduleRecheck(t)
  if (next.pace === state.pace && next.why === state.why && takeActive === state.takeActive) {
    state = { ...state, level }
    return
  }
  const previous = state
  state = { pace: next.pace, why: next.why, takeActive, level }
  // E2 — THE TAKE'S LEDGER. Layer one of the order of defence is this file, and
  // the ruling is about ORDER, so the moment it moves has to be recorded on the
  // take's clock or "the unseen work went first" is an assertion rather than a
  // fact. Only during a take: the same broker paces the editor, and an editor
  // drag is not a shed.
  if (previous.pace !== state.pace && elasticLogOpen()) {
    const before = PACE_DUTY[previous.pace]
    const after = PACE_DUTY[state.pace]
    if (after !== before) {
      // M1 — THROUGH THE DOOR, which is now the only writer to that ledger.
      // The dial is `work` and not one of Robert's four: the unseen work is not
      // part of the take at all, which is exactly why it is the first thing
      // given up and why the order can only be read if both are on one ledger.
      passDoor(
        {
          dial: 'work',
          decidedBy: 'broker',
          layer: 'unseen',
          action: after < before ? 'shed' : 'restore',
          what: `background work ${previous.pace} → ${state.pace}`,
          why: state.why,
          ...(leaderBlock ? { block: leaderBlock } : null),
          ...(level ? { level } : null),
          measured: { dutyBefore: before, dutyAfter: after },
          nowMs: t,
        },
        () => undefined,
      )
    }
  }
  // Said out loud only when something is actually listening — i.e. when a
  // background job is pacing itself against this. Every take changes the pace
  // whether or not a job exists, and a console line for a brake nobody is
  // holding is noise on the one screen that has to stay readable.
  if (previous.pace !== state.pace && listeners.size > 0) {
    console.info(
      `[compose] background work ${state.pace === 'paused' ? 'PAUSED' : `-> ${state.pace} (${Math.round(PACE_DUTY[state.pace] * 100)}% duty)`} — ${state.why}`,
    )
  }
  for (const l of listeners) l(state)
}

/** Capture, at the top and the bottom of a take. */
export function noteTakeActive(active: boolean): void {
  if (takeActive === active) return
  takeActive = active
  if (!active) {
    level = null
    leaderWhy = null
    leaderBlock = null
    clearSince = null
  }
  publish(now())
}

/**
 * The editor, while somebody is actually working it — a drag, a scrub, a
 * handle. Cheap by contract: callers throttle, and this is one clock read.
 */
export function noteEditingActivity(): void {
  const t = now()
  const wasQuiet = editingAt === null || t - editingAt > EDITING_QUIET_MS
  editingAt = t
  if (wasQuiet) publish(t)
}

/**
 * THE EDITOR IS STILL BUILDING WHAT IT SHOWS — hold the render behind it.
 *
 * Take one of these when you start something the person is waiting to LOOK at
 * and release it when that thing is on screen. The window is refcounted since
 * E3 because there is more than one such thing and they do not finish
 * together: the preview's first painted frame, and the lane art under the
 * timeline. It closes when the last holder lets go, or at
 * EDITOR_OPENING_MAX_MS from the first, whichever comes first.
 *
 * Releasing twice is harmless and releasing out of order is fine — a hold is
 * its own token, not a counter, because both callers here are React effects
 * whose cleanups can and do run twice.
 */
const editorHolds = new Map<symbol, string>()

export function holdEditorAhead(what: string): () => void {
  const token = Symbol(what)
  editorHolds.set(token, what)
  if (editorOpeningAt === null) {
    editorOpeningAt = now()
    publish(editorOpeningAt)
  }
  return () => {
    if (!editorHolds.delete(token)) return
    if (editorHolds.size > 0) return
    if (editorOpeningAt === null) return
    editorOpeningAt = null
    publish(now())
  }
}

/**
 * One pressure reading from the take's own instrument (E1). Blind readings are
 * forwarded as blind — they are what "nobody could see" looks like, and this
 * broker must not launder them into health.
 */
export function noteTakePressure(reading: PressureReading): void {
  const t = now()
  readingAt = t
  if (reading.blind) {
    level = null
    leaderWhy = null
    leaderBlock = null
    clearSince = null
  } else {
    level = reading.level
    leaderWhy = reading.leader ? `${reading.leader.signal}: ${reading.leader.detail}` : null
    leaderBlock = reading.leader?.block ?? null
    if (atLeast(reading.level, 'fair')) clearSince = null
    else clearSince = clearSince ?? t
  }
  publish(t)
}

/**
 * The pace RIGHT NOW. Re-derived rather than returned from the cache, so a
 * reading that simply stopped arriving expires without anything having to
 * poll it.
 */
export function backgroundWorkState(): BackgroundWorkState {
  publish(now())
  return state
}

export function currentPace(): WorkPace {
  return backgroundWorkState().pace
}

/** Subscribe. Called immediately with the current state, then on every change. */
export function onBackgroundWorkChange(cb: Listener): () => void {
  listeners.add(cb)
  cb(backgroundWorkState())
  return () => listeners.delete(cb)
}

// ---------------------------------------------------------------------------
// E3 — WHEN THE WORK IS DUE, and why a job needs a pace of its own.
//
// Everything above answers one question: what may the machine spare? That is
// half of a pace. The other half is the job's own DEADLINE, and until E3 no
// job carried one — every background render subscribed to the same broker and
// obeyed it for its whole life, including the part of its life after somebody
// pressed Export and started waiting for it.
//
// THE DEFECT THAT NAMED THIS SEAM. `takePrerender` retires a running job to a
// user-visible export ("joining a running job is the point"), and F16's
// permanent contract, in Robert's words (2026-09-01, DECISIONS (3)), is that a
// pre-render "may only ever SAVE time". It could not keep that promise: the
// render was handed its pace source once, at start, and nothing revoked it, so
// a claimed job kept the brake written for work nobody had asked for. The
// geometry made it certain rather than unlucky — the Export button lives
// inside the element carrying `onPointerDownCapture={noteEditingActivity}`, so
// the very press that claims the job is the event that throttles it to
// `trickle`, and every pointer move over the editor while the person watches
// the dock renews that. An export that JOINED a pre-render could therefore
// finish LATER than the same export with no pre-render at all, which is the
// one thing F16 promised would never happen.
//
// So a deadline is not a heuristic here and it is not a guess about when
// Robert will press. It is one fact the app already knows and was throwing
// away: whether somebody is waiting.
// ---------------------------------------------------------------------------

/**
 * `background` nobody has asked for this file; the broker above owns its rate.
 * `now`        a person is waiting for it. There is no rate below full that
 *              meets that deadline, so the brake comes off — which is exactly
 *              what a user-visible export has always done (it is handed no
 *              pace source at all: types.ts, ExportOptions.pace).
 *
 * SAID OUT LOUD, because it is the one place `now` crosses Robert's priority
 * order: a claimed job runs at full even while a take is recording. That is
 * not new behaviour being introduced under a deadline — it is the behaviour a
 * user-visible export has always had, and the alternative is worse in exactly
 * the way F16 forbids. An export pressed during a take with no pre-render
 * behind it renders at full and finishes; the same press onto a pre-render
 * would be `paused` and finish NEVER, so having pre-rendered would have cost
 * the user the file. Reaching it takes pressing Export in one take's editor
 * while another take records.
 */
export type WorkDeadline = 'background' | 'now'

export interface JobPace extends PaceSource {
  deadline(): WorkDeadline
  /**
   * Somebody is waiting for this job now. ONE-WAY: a claim is `takePrerender`
   * handing the file to an export, and an export never becomes background work
   * again. A two-way switch would also be a way to re-brake a job a person is
   * watching, which is the defect this exists to remove.
   */
  claim(): void
  /** Drop the broker subscription. */
  dispose(): void
}

/**
 * One job's pace: the machine's answer until the job is claimed, `full` after.
 *
 * Per job and not global, because two jobs can be alive at once (a pre-render
 * beside a claimed export in the dock) and they no longer have the same
 * deadline. The subscription is what carries a claim into the export WORKER —
 * pipeline.ts forwards every change as a `pace` message and paceGate's `wake`
 * cuts a sleeping job's nap short, so the brake comes off within a message
 * rather than at the end of a 400 ms rest.
 */
export function createJobPace(): JobPace {
  let due: WorkDeadline = 'background'
  const subs = new Set<(level: WorkPace) => void>()
  let offBroker: (() => void) | null = null
  const level = (): WorkPace => (due === 'now' ? 'full' : currentPace())
  return {
    level,
    subscribe(cb) {
      subs.add(cb)
      // One broker subscription per job however many readers it has: the
      // render subscribes once, but the in-thread fallback and the worker
      // forwarder are two different callers of the same source.
      offBroker ??= onBackgroundWorkChange(() => {
        if (due === 'now') return
        for (const s of subs) s(level())
      })
      return () => {
        subs.delete(cb)
      }
    },
    deadline: () => due,
    claim() {
      if (due === 'now') return
      due = 'now'
      for (const s of subs) s('full')
    },
    dispose() {
      subs.clear()
      offBroker?.()
      offBroker = null
    },
  }
}

/** Test seam — module state outlives test cases. */
export function resetBackgroundWorkForTests(): void {
  listeners.clear()
  flagOverride = null
  if (recheck !== null) clearTimeout(recheck)
  recheck = null
  takeActive = false
  editingAt = null
  editorHolds.clear()
  editorOpeningAt = null
  level = null
  leaderWhy = null
  leaderBlock = null
  readingAt = 0
  clearSince = null
  state = { pace: 'full', why: 'no take is recording', takeActive: false, level: null }
}
