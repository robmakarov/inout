/**
 * WHAT A WEDGE LEAVES BEHIND ON THE MACHINE — because the console does not count.
 *
 * stallForensics.ts works out the witness statement and prints it. That was
 * enough while somebody was watching a console; it is worth nothing in the
 * field, and the field is the only place this bug lives:
 *
 *   - `[capture:forensics]` is a console line, and the ruling (Robert,
 *     2026-08-30) is "i will not do anything in console".
 *   - the `display_wedge` analytics event goes to a NOOP SINK in production
 *     (analytics.ts) — nothing is shipped anywhere.
 *
 * So after a wedge the only thing readable off his profile was four counters
 * in `inout.displayWedge.v1`, which is why two field reports of "it goes
 * unresponsive after the refresh" are still unconvicted. This file is the
 * fix: a small ring of dated entries in localStorage that an agent can read
 * in seconds over the browser MCP (see the playbook in docs/SCREEN_WEDGE.md),
 * with the user asked for nothing at all.
 *
 * It records the four moments the case turns on:
 *
 *   wedge  — a screen request that never settled, with the forensics
 *   reload  — the recovery ritual firing (so a missing boot after it means
 *             the reload was requested and never committed)
 *   boot    — the reloaded document running its script, then mounting its UI
 *             (script with no mount = the reload landed and the app never
 *             painted, which is exactly the P1 report)
 *   block   — the main thread stalled after that boot, while VISIBLE, long
 *             enough for a person to call the app unresponsive
 *
 * Observation only. Nothing here changes a request, a budget, or a message,
 * and every path is wrapped: a witness must never be able to kill the thing
 * it watches (the same rule stallForensics.ts is written under).
 */

const KEY = 'inout.wedgeJournal.v1'

/** Bounded so a bad night cannot grow localStorage without limit. Two dozen
 *  entries is several wedges' worth of story and a few KB. */
const MAX_ENTRIES = 24

export type WedgeJournalKind = 'wedge' | 'reload' | 'boot' | 'block' | 'settle'

export interface WedgeJournalEntry {
  /** Epoch ms — the one field every entry has, and the only one that lets a
   *  reader line this up against what Robert says happened when. */
  t: number
  kind: WedgeJournalKind
  /** wedge: which rung the request rode on, and the lifetime wedge count. */
  level?: number
  count?: number
  /** wedge: 'wedge' | 'permission' | 'stale' — the classification acted on. */
  stall?: string
  /** wedge: the forensics (stallForensics.ts). */
  focus?: string
  waitedMs?: number
  deliveries?: number
  pageAgeMs?: number
  /** boot/block: ms since the reload that this document came back from. */
  sinceReloadMs?: number
  /** boot: 'script' = the bundle ran · 'mount' = the UI mounted.
   *  block: the warm-up step the boot was in when the thread went away
   *  (noteBootPhase — prearm.ts names each awaited step). */
  phase?: string
  /** block: how long the main thread was unavailable, and where the tab was. */
  blockedMs?: number
  vis?: string
  /** wedge: what the press asked for, e.g. 'screen+tab-audio+camera+mic' —
   *  so a wedge can be told apart by what rode in the same request. */
  channels?: string
  /** settle: a screen request that came back AFTER the take gave up on it —
   *  how late, what it brought, and whether anyone still wanted it. The one
   *  entry that decides whether an abandoned request can ever come back, or
   *  whether it is gone the moment our budget expires. */
  lateMs?: number
  outcome?: string
  claimed?: boolean
  /** wedge: how many requests from this document were still unsettled when
   *  this one was dispatched. Chrome takes one screen request at a time, so
   *  anything above zero is the collision that hangs it. */
  pending?: number
}

let mem: WedgeJournalEntry[] | null = null

function load(): WedgeJournalEntry[] {
  if (mem) return mem
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '')
    mem = Array.isArray(parsed) ? (parsed.filter((e) => e && typeof e === 'object') as WedgeJournalEntry[]) : []
  } catch {
    mem = []
  }
  return mem
}

/** Add one entry. Oldest fall off the front; storage refusal degrades to memory. */
export function appendWedgeJournal(entry: Omit<WedgeJournalEntry, 't'> & { t?: number }): void {
  try {
    const all = load()
    all.push({ ...entry, t: entry.t ?? Date.now() })
    if (all.length > MAX_ENTRIES) all.splice(0, all.length - MAX_ENTRIES)
    try {
      localStorage.setItem(KEY, JSON.stringify(all))
    } catch {
      /* memory-only tab — still readable in this session */
    }
  } catch {
    /* never break a take to record one */
  }
}

/** The whole story, oldest first. For an agent reading the machine, and tests. */
export function readWedgeJournal(): readonly WedgeJournalEntry[] {
  return load()
}

/** Test seam — module state outlives test cases. */
export function __resetWedgeJournal(): void {
  mem = null
  bootPhase = ''
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}

let bootPhase = ''

/**
 * WHAT THE BOOT WAS DOING WHEN THE THREAD WENT AWAY. The warm-up (prearm.ts)
 * names each awaited step before it runs; a `block` entry carries the last
 * name, so a freeze convicts a step instead of a duration. Six blocks of
 * ~20 s were read off Robert's machine before this existed, and each could
 * only say "after mount".
 */
export function noteBootPhase(phase: string): void {
  bootPhase = phase
}

/**
 * IS THE APP ALIVE AFTER THE RITUAL'S RELOAD? Robert, twice: after the refresh
 * "it goes unresponsive without any actions". A page cannot report its own
 * freeze from inside the freeze, but it can report it AFTERWARDS: a paced
 * timer that comes back late by N seconds means the main thread was gone for
 * N seconds, and the entry is written on the first tick that runs again.
 *
 * The one trap here is already in the case file as a RETRACTED "found it": a
 * hidden tab's timers are throttled by Chrome, which reads as a block and is
 * not one. So a tick is only ever believed when the tab was visible for the
 * whole interval — any visibilitychange in between disqualifies it.
 *
 * Returns its own stop function. Self-limiting: it stops at `windowMs`, so it
 * costs a healthy boot one timer for a minute and a half and nothing after.
 */
export function watchBootLiveness(
  sinceReloadMs: number,
  { windowMs = 90_000, sampleMs = 500, floorMs = 1_000, now = () => Date.now() } = {},
): () => void {
  let stopped = false
  let sawHidden = false
  let worst = 0
  let expected = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const started = now()

  const onVis = (): void => {
    sawHidden = true
  }
  try {
    document.addEventListener('visibilitychange', onVis)
  } catch {
    /* no DOM — observe nothing rather than throw into a boot path */
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    try {
      document.removeEventListener('visibilitychange', onVis)
    } catch {
      /* same guard as the install */
    }
  }

  const tick = (): void => {
    if (stopped) return
    const at = now()
    const late = at - expected
    const hidden = sawHidden || (typeof document !== 'undefined' && document.visibilityState !== 'visible')
    sawHidden = false
    // Only a visible tab's lateness is evidence; only a NEW worst is worth an
    // entry, so a long freeze writes one line rather than filling the ring.
    if (!hidden && late > floorMs && late > worst + 500) {
      worst = late
      appendWedgeJournal({
        kind: 'block',
        blockedMs: Math.round(late),
        sinceReloadMs: Math.round(sinceReloadMs + (at - started)),
        vis: 'visible',
        ...(bootPhase ? { phase: bootPhase } : {}),
      })
    }
    if (at - started >= windowMs) {
      stop()
      return
    }
    expected = at + sampleMs
    timer = setTimeout(tick, sampleMs)
  }

  expected = now() + sampleMs
  timer = setTimeout(tick, sampleMs)
  return stop
}
