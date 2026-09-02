/**
 * EVERY SHED AND EVERY RECOVERY, IN ORDER, IN THE TAKE — task E2.
 *
 * Robert's 2026-09-02 ruling gave elastic an ORDER OF DEFENCE and not just a
 * bias: shed the unseen work first, absorb the burst second, move the picture
 * last. An order is a claim about what happened, and a claim nobody can read
 * after the fact is not a claim — the report card graded "did anything degrade"
 * off a single string (`stopStats.degradedWhy`), which cannot say whether the
 * background render was paused BEFORE the frame rate halved or after, and the
 * ordering is the whole ruling.
 *
 * So this is the take's elastic ledger: one line per shed and per restore, on
 * the take's own clock, ordered, bounded, and carried into `stopStats` at stop
 * where the card grades it (dimension `elastic`).
 *
 * IT IS NOT M1'S DOOR, and must not be mistaken for it. M1 makes the recording
 * of a decision the ACT of making it, enforced by a test that a bypassing path
 * fails the build. This is the ledger that door will write into; E2 fills it
 * from the three consumers that exist today (the background broker, the burst
 * absorber, the rate ladder) and M1 inherits both the type and the grader.
 *
 * RULES IT IS WRITTEN UNDER, all three learned the expensive way:
 *  · IT COSTS THE TAKE NOTHING. Appending is a push onto a capped array. No
 *    allocation per frame, no clock read the caller did not already have.
 *  · IT NEVER THROWS. A witness must not be able to kill the thing it watches
 *    (wedgeJournal.ts's rule, and this runs inside the capture path).
 *  · IT IS BOUNDED. A 124-minute take that hunts would otherwise grow this
 *    without limit; past the cap the oldest are dropped and the count of what
 *    was dropped is kept, because "we lost some" is a different fact from
 *    "there were none".
 */
// The event and the layer are CONTRACTS — a take persists them in
// `stopStats.elastic` — so they live in core/types.ts and are re-exported here,
// where the mechanism that writes them is.
import type { ElasticEvent, ElasticLayer } from './types'

export type { ElasticEvent, ElasticLayer }

export const LAYER_ORDER: Record<ElasticLayer, number> = { unseen: 0, burst: 1, picture: 2 }

/** A 124-minute take that hunted once a minute writes ~250 lines. 400 is well
 *  clear of that and still a few kB in the record. */
const MAX_EVENTS = 400

let events: ElasticEvent[] = []
let dropped = 0
let t0: number | null = null

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Capture, at the top of a take. Clears whatever the last take left. */
export function startElasticLog(startedAtMs?: number): void {
  events = []
  dropped = 0
  t0 = startedAtMs ?? now()
}

/** True while a take's ledger is open — the guard every appender uses, so an
 *  editor-time pace change is not recorded as if it happened in a take. */
export function elasticLogOpen(): boolean {
  return t0 !== null
}

/**
 * Append one line. `nowMs` is a performance.now() the caller already had (every
 * caller does); the ledger keeps it relative to the take's start so an event is
 * readable months later without the session's clock.
 */
export function noteElastic(event: Omit<ElasticEvent, 'atMs'>, nowMs?: number): void {
  try {
    if (t0 === null) return
    events.push({ ...event, atMs: Math.max(0, Math.round((nowMs ?? now()) - t0)) })
    if (events.length > MAX_EVENTS) {
      events.shift()
      dropped++
    }
  } catch {
    /* a take is never worth losing to a note about it */
  }
}

export interface ElasticLog {
  events: ElasticEvent[]
  /** Events dropped off the front of the ring. 0 on every ordinary take. */
  droppedEvents: number
}

/** Read it without closing it — for a rig watching a take in flight. */
export function readElasticLog(): ElasticLog {
  return { events: [...events], droppedEvents: dropped }
}

/** Capture, at stop: the ledger, and the log is closed. */
export function takeElasticLog(): ElasticLog {
  const out = readElasticLog()
  t0 = null
  events = []
  dropped = 0
  return out
}

/** Test seam — module state outlives test cases. */
export function resetElasticLogForTests(): void {
  events = []
  dropped = 0
  t0 = null
}

// ---------------------------------------------------------------------------
// THE GRADER, here rather than in the report card, because the ordering rule is
// a fact about this ledger and the card is one of two consumers (the E2 rig is
// the other, and a rig that re-implements the gate cannot prove the product).
// ---------------------------------------------------------------------------

export interface ElasticAudit {
  sheds: number
  restores: number
  pictureSheds: number
  unseenSheds: number
  burstSheds: number
  /** Picture steps that were NOT preceded by an unseen shed — the ruling's
   *  order of defence, violated. Each one is a failure. */
  outOfOrder: ElasticEvent[]
  /** Sheds still outstanding when the take stopped, by layer. A take that ends
   *  under load legitimately has these; they are reported, not failed. */
  unrecovered: ElasticLayer[]
  /** ms from each picture shed to the restore that undid it. */
  pictureRecoveryMs: number[]
  ok: boolean
  line: string
}

export function auditElastic(log: ElasticLog): ElasticAudit {
  const events = [...log.events].sort((a, b) => a.atMs - b.atMs)
  const outOfOrder: ElasticEvent[] = []
  const pictureRecoveryMs: number[] = []
  const open: Record<ElasticLayer, number[]> = { unseen: [], burst: [], picture: [] }
  let unseenShedOpen = 0
  let sheds = 0
  let restores = 0
  const count: Record<ElasticLayer, number> = { unseen: 0, burst: 0, picture: 0 }

  for (const e of events) {
    if (e.action === 'shed') {
      sheds++
      count[e.layer]++
      open[e.layer].push(e.atMs)
      if (e.layer === 'unseen') unseenShedOpen++
      // THE ORDERING GATE. A picture step is legal only while something unseen
      // is already shed — that is the ruling, and it is checked here rather
      // than trusted to the levels lining up.
      if (e.layer === 'picture' && unseenShedOpen === 0) outOfOrder.push(e)
    } else {
      restores++
      const at = open[e.layer].shift()
      if (e.layer === 'picture' && at !== undefined) pictureRecoveryMs.push(e.atMs - at)
      if (e.layer === 'unseen' && unseenShedOpen > 0) unseenShedOpen--
    }
  }

  const unrecovered = (Object.keys(open) as ElasticLayer[]).flatMap((l) =>
    open[l].map(() => l),
  )
  const ok = outOfOrder.length === 0
  const line = events.length
    ? `${sheds} shed / ${restores} restored — ` +
      `unseen ${count.unseen}, burst ${count.burst}, picture ${count.picture}` +
      (outOfOrder.length ? ` · ${outOfOrder.length} OUT OF ORDER` : ' · order held') +
      (unrecovered.length ? ` · ${unrecovered.length} still shed at stop` : '')
    : 'nothing was shed'

  return {
    sheds,
    restores,
    pictureSheds: count.picture,
    unseenSheds: count.unseen,
    burstSheds: count.burst,
    outOfOrder,
    unrecovered,
    pictureRecoveryMs,
    ok,
    line,
  }
}
