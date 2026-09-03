/**
 * THE DOOR — task M1, with S1 folded into it (Robert 2026-09-02, DECISIONS
 * robert (17): "fold S1 into M1 then").
 *
 * WHAT IT IS. Every change to what a take records — its RATE, its RESOLUTION,
 * its QUALITY, or WHICH CHANNELS RUN — passes through `passDoor`, and passing
 * through it is how the change is made. The record is not a side effect of the
 * decision, it IS the decision: the caller cannot reach the primitive that
 * moves a dial without a `DoorTicket`, and the only place a ticket exists is
 * inside the call that has already written the line.
 *
 * WHY IT IS SHAPED THAT WAY, and it is Robert's reasoning rather than mine: a
 * WRITTEN RULE IS NOT STRUCTURAL PREVENTION. "Log every degradation" was true
 * of this codebase for months and the 2026-09-02 audit still found seven
 * adaptive systems, four of which could quietly make a take worse and say
 * nothing — because a rule decays and a mechanism does not. So degrading a take
 * invisibly is not forbidden here, it is unavailable.
 *
 * WHAT IT IS NOT. It is not a policy: the door decides nothing. The ladder
 * still decides the rate, the budget still decides the plan, the watchdog still
 * decides to drop the composite. The door is where those decisions become acts,
 * which is exactly why it can see all of them.
 *
 * THE SEVEN IT WAS BUILT FOR (the audit's count, and the count itself is the
 * evidence — there were never two elastic systems, there were seven, because
 * there was no door): the frame-rate ladder · the encoder budget's pre-take
 * reduction · the composite watchdog's whole-mix drop · the background-work
 * broker · the export QP governor · the capture encoders' bitrate mode, i.e.
 * Chrome's own rate control · and Chrome's own capture adaptation, which cannot
 * be owned and is therefore DETECTED and written down like everything else.
 *
 * ── THE THREE RULES IT INHERITS FROM elasticLog.ts, all learned expensively ──
 *  · IT COSTS THE TAKE NOTHING. One object per DECISION — never per frame — on
 *    a capped array, with a clock read the caller already had.
 *  · IT NEVER THROWS. A witness must not be able to kill the thing it watches.
 *    An `apply` that throws is the CALLER's error and is re-thrown untouched;
 *    everything this module does around it is inside a catch that swallows.
 *  · IT IS BOUNDED, and it keeps the count of what it dropped, because "we lost
 *    some" is a different fact from "there were none".
 *
 * ── ONE WRITE, TWO VIEWS ──
 * E2 built the elastic ledger (core/elasticLog.ts) and its header says, in
 * advance, that M1's door writes into it. It does: a decision carrying a
 * `layer` is part of the ORDER OF DEFENCE and is mirrored into that ledger, so
 * `stopStats.elastic` still means exactly what E2's grader reads and the two
 * ledgers cannot disagree about a take. Everything else — the pre-take
 * decisions, the codec rungs, Chrome's own adaptation — lives only here, where
 * the report card's `decisions` dimension grades it.
 *
 * AND THE MIRROR HAPPENS ON THE OUTCOME, NOT THE INTENTION. This is a defect
 * the door removes rather than a refinement: liveCompositeV2 wrote `60 → 30
 * fps` into the elastic log at the moment the ladder DECIDED it, and in max
 * mode session.ts then refused to step — so takes that never lost a frame
 * carried a ledger line saying their picture had halved. Here a refusal is
 * recorded as a refusal.
 */
import { elasticLogOpen, noteElastic } from './elasticLog'
import type {
  CaptureDial,
  DoorDecider,
  DoorDecision,
  DoorMeasured,
  DoorOutcome,
  ElasticLayer,
  HardwareBlock,
  PressureLevel,
} from './types'

export type { CaptureDial, DoorDecider, DoorDecision, DoorMeasured, DoorOutcome }

/**
 * THE TICKET, and it is the whole enforcement.
 *
 * `DOOR` is a module-private unique symbol, so no code outside this file can
 * write a value of this type — not with a cast to a structural type, not by
 * building the object by hand, because the key cannot be named. Every function
 * that actually moves a dial takes one. A new fallback that wants to narrow a
 * track therefore cannot compile until it asks the door, and asking the door is
 * what writes the line. That is the "test asserts the door is the only way in"
 * half made unnecessary by construction; the test (door.enforced.test.ts) then
 * covers the half a type cannot reach — a path that calls the platform API
 * directly instead of the door's wrapper.
 */
declare const DOOR: unique symbol

export interface DoorTicket {
  readonly [DOOR]: true
  /**
   * The change was not made after all. Records the decision as REFUSED with
   * this reason instead of applied — `max would not let the ladder step` is a
   * fact about the take, and a silent nothing is not.
   */
  refuse(why: string): void
  /** Numbers learned while applying — what the platform actually gave back.
   *  Merged into the decision's `measured`. */
  note(measured: DoorMeasured): void
}

export interface DoorRequest {
  dial: CaptureDial
  decidedBy: DoorDecider
  action: 'shed' | 'restore' | 'set'
  what: string
  why: string
  /** Present ⇒ this is part of E2's order of defence and is mirrored into the
   *  elastic ledger when it is APPLIED. */
  layer?: ElasticLayer
  block?: HardwareBlock
  level?: PressureLevel
  measured?: DoorMeasured
  /** A performance.now() the caller already had. */
  nowMs?: number
  /** Set by `adoptDoorDecision` for a decision taken inside a worker. */
  fromWorker?: boolean
}

/** Same bound as the elastic ledger, for the same reason: a 124-minute take
 *  that hunts once a minute writes ~250 lines, and this is well clear of it. */
const MAX_DECISIONS = 400

interface Entry {
  /** Raw performance.now() — `atMs` is derived against the take's epoch on
   *  read, so an arming decision reads negative instead of being re-based. */
  raw: number
  d: DoorDecision
}

let entries: Entry[] = []
let dropped = 0
/** The take's epoch, once it has one. Null between takes. */
let epoch: number | null = null
/** Index into `entries` where the take being armed began. Null when no take is
 *  being armed — an export's decisions are recorded and belong to no take. */
let armedFrom: number | null = null

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * A TAKE IS BEING ARMED: every decision from here belongs to it.
 *
 * Deliberately separate from `openDoor` below, because the two most consequential
 * decisions in this whole system are taken BEFORE the take has a clock — O15's
 * encoder budget narrows the screen and F15's rate budget holds the frame rate
 * down, both inside `arm()`, both invisible in every ledger this project had.
 */
export function armDoor(): void {
  armedFrom = entries.length
  epoch = null
}

/** The take started: this is its clock origin. Decisions taken while arming
 *  keep their place and read NEGATIVE against it, which is what they are. */
export function openDoor(epochMs: number): void {
  epoch = epochMs
  if (armedFrom === null) armedFrom = entries.length
}

/** True while a take owns the door (armed or running). */
export function doorArmed(): boolean {
  return armedFrom !== null
}

function decisionOf(e: Entry): DoorDecision {
  const base = epoch ?? e.raw
  return { ...e.d, atMs: Math.round(e.raw - base) }
}

export interface DoorLog {
  decisions: DoorDecision[]
  /** Decisions dropped off the front of the ring. 0 on every ordinary take. */
  droppedDecisions: number
}

/** Read without closing — for a rig watching a take in flight, and for the
 *  console reader. */
export function readDoorLog(): DoorLog {
  return { decisions: entries.map(decisionOf), droppedDecisions: dropped }
}

/**
 * The take's decisions, at stop, and the take releases the door. Everything
 * before the arm mark (a previous take's tail, an export that ran between
 * takes) stays in the ring for the console reader and is NOT part of this take.
 */
export function takeDoorLog(): DoorLog {
  const from = armedFrom ?? 0
  const out = { decisions: entries.slice(from).map(decisionOf), droppedDecisions: dropped }
  armedFrom = null
  epoch = null
  dropped = 0
  return out
}

/** Test seam — module state outlives test cases. */
export function resetDoorForTests(): void {
  entries = []
  dropped = 0
  epoch = null
  armedFrom = null
}

function push(raw: number, d: DoorDecision): Entry {
  const e: Entry = { raw, d }
  entries.push(e)
  if (entries.length > MAX_DECISIONS) {
    entries.shift()
    dropped++
    if (armedFrom !== null && armedFrom > 0) armedFrom--
  }
  return e
}

/** The mirror into E2's ledger, on the OUTCOME. Only the order of defence. */
function mirror(e: Entry): void {
  const d = e.d
  if (!d.layer || d.outcome !== 'applied') return
  if (d.action !== 'shed' && d.action !== 'restore') return
  if (!elasticLogOpen()) return
  noteElastic(
    {
      layer: d.layer,
      action: d.action,
      what: d.what,
      why: d.why,
      ...(d.block ? { block: d.block } : null),
      ...(d.level ? { level: d.level } : null),
    },
    e.raw,
  )
}

function settle(e: Entry, outcome: DoorOutcome, why?: string): void {
  try {
    if (e.d.outcome !== 'applied') return // already refused; the first word wins
    e.d.outcome = outcome
    if (why) e.d.outcomeWhy = why
    if (outcome === 'applied') mirror(e)
  } catch {
    /* a take is never worth losing to a note about it */
  }
}

function isThenable(v: unknown): v is Promise<unknown> {
  return typeof (v as { then?: unknown } | null)?.then === 'function'
}

/**
 * MAKE A CHANGE TO THE TAKE, AND BE RECORDED FOR IT.
 *
 * The line is written FIRST and the change is made inside `apply`, which is
 * handed the only ticket that exists for it. Three outcomes, and all three are
 * kept: applied (the default), `t.refuse(why)` when the caller decides against
 * it after all, and `failed` when `apply` throws or its promise rejects — the
 * platform refusing a constraint is a fact about the take, and this codebase
 * used to swallow it into a console.warn.
 *
 * `apply` may be sync or async; the return value is passed through untouched
 * and so is any error it raises. The door adds nothing to the caller's control
 * flow — it only watches.
 */
export function passDoor<T>(req: DoorRequest, apply: (ticket: DoorTicket) => T): T {
  let e: Entry | null = null
  try {
    const d: DoorDecision = {
      atMs: 0, // derived on read against the take's epoch
      dial: req.dial,
      decidedBy: req.decidedBy,
      action: req.action,
      what: req.what,
      why: req.why,
      outcome: 'applied',
      ...(req.measured ? { measured: { ...req.measured } } : null),
      ...(req.block ? { block: req.block } : null),
      ...(req.level ? { level: req.level } : null),
      ...(req.layer ? { layer: req.layer } : null),
      ...(req.fromWorker ? { fromWorker: true } : null),
    }
    e = push(req.nowMs ?? now(), d)
  } catch {
    e = null
  }
  const entry = e
  const ticket = {
    refuse(why: string): void {
      try {
        if (!entry) return
        entry.d.outcome = 'refused'
        entry.d.outcomeWhy = why
      } catch {
        /* never throws */
      }
    },
    note(measured: DoorMeasured): void {
      try {
        if (!entry) return
        entry.d.measured = { ...entry.d.measured, ...measured }
      } catch {
        /* never throws */
      }
    },
  } as DoorTicket

  let out: T
  try {
    out = apply(ticket)
  } catch (err) {
    if (entry) settle(entry, 'failed', String(err))
    throw err
  }
  if (isThenable(out)) {
    return out.then(
      (v) => {
        if (entry) settle(entry, entry.d.outcome === 'refused' ? 'refused' : 'applied')
        return v
      },
      (err: unknown) => {
        if (entry) settle(entry, 'failed', String(err))
        throw err
      },
    ) as T
  }
  if (entry) settle(entry, entry.d.outcome === 'refused' ? 'refused' : 'applied')
  return out
}

/**
 * A DECISION TAKEN INSIDE A WORKER. The door is module state and a worker has
 * its own copy of every module, so a worker records into its own door and posts
 * the line out; the main thread adopts it here, into the one ledger the take
 * keeps. The worker's clock is not the page's, so `atMs` is the instant of
 * ADOPTION — within one message of the truth, and stated rather than pretended.
 */
export function adoptDoorDecision(d: Omit<DoorDecision, 'atMs'>, nowMs?: number): void {
  try {
    const e = push(nowMs ?? now(), { ...d, atMs: 0, fromWorker: true })
    if (d.outcome === 'applied') mirror(e)
  } catch {
    /* never throws */
  }
}

// ---------------------------------------------------------------------------
// THE TICKET-GATED PRIMITIVES. Every call in shipped code that moves one of the
// four dials is one of these — which is what `door.enforced.test.ts` asserts by
// scanning the source, because a type cannot stop a path from calling the
// platform API directly.
// ---------------------------------------------------------------------------

/**
 * THE ONLY WAY A LIVE SOURCE'S RATE OR RESOLUTION CHANGES.
 *
 * `applyConstraints` is the single primitive underneath every rate step, every
 * pre-take budget, and every cap in acquire.ts. It returns the promise it was
 * given — the caller keeps its own timeout, which is load-bearing: an
 * applyConstraints on a wedged device never settles (session.ts's
 * THROTTLE_BUDGET_MS is that scar), and the door must not hold a take open.
 */
export function constrainThroughDoor(
  ticket: DoorTicket,
  track: MediaStreamTrack,
  constraints: MediaTrackConstraints,
): Promise<void> {
  void ticket
  return track.applyConstraints(constraints)
}

/** The reading a decision was made on, in the form the ledger keeps it. */
export function measuredFromSettings(s: MediaTrackSettings): DoorMeasured {
  return {
    width: s.width ?? null,
    height: s.height ?? null,
    fps: s.frameRate ?? null,
  }
}
