/**
 * EVERY TAKE'S VERDICT, ON THE MACHINE, WITHOUT ASKING ROBERT FOR ANYTHING.
 *
 * The card itself (reportCard.ts) can be recomputed from any take that is still
 * in IndexedDB — but takes get deleted, and the fleet this instrument is for is
 * the one that accumulates over weeks. So the verdict LINE of every take is
 * written here as it stops: a small ring in localStorage, the same shape and
 * the same reasons as capture/wedgeJournal.ts (Robert, 2026-08-30: "i will not
 * do anything in console"; analytics is a noop sink in production).
 *
 * One line per take, oldest first. An agent reads the whole fleet in one
 * expression over the browser MCP — see docs/TAKE_REPORT.md.
 */
import type { ReportCard, Verdict } from './reportCard'

export const TAKE_REPORT_KEY = 'inout.takeReport.v1'

/** Bounded. Six weeks of Robert's daily takes is well inside this, and the
 *  full card of any take still in the repo can always be recomputed. */
const MAX_ENTRIES = 60

export interface TakeReportEntry {
  /** Epoch ms the take stopped. */
  t: number
  id: string
  durationMs: number
  verdict: Verdict
  /** The one line. */
  line: string
  /** The dimensions that failed, by id — what to grep a fleet for. */
  failed?: string[]
}

let mem: TakeReportEntry[] | null = null

function load(): TakeReportEntry[] {
  if (mem) return mem
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TAKE_REPORT_KEY) ?? '')
    mem = Array.isArray(parsed)
      ? (parsed.filter((e) => e && typeof e === 'object') as TakeReportEntry[])
      : []
  } catch {
    mem = []
  }
  return mem
}

/** Record one take's verdict. Never throws: a witness must not be able to kill
 *  the thing it watches (wedgeJournal.ts's rule, and this runs at stop, where
 *  the take is already made and nothing may endanger handing it over). */
export function appendTakeReport(card: ReportCard): void {
  try {
    const failed = card.dimensions.filter((d) => d.status === 'fail').map((d) => d.id)
    const entry: TakeReportEntry = {
      t: card.createdAt,
      id: card.recordingId,
      durationMs: Math.round(card.durationMs),
      verdict: card.verdict,
      line: card.line,
      ...(failed.length ? { failed } : null),
    }
    const all = load()
    const at = all.findIndex((e) => e.id === entry.id)
    if (at >= 0) all[at] = entry
    else all.push(entry)
    if (all.length > MAX_ENTRIES) all.splice(0, all.length - MAX_ENTRIES)
    try {
      localStorage.setItem(TAKE_REPORT_KEY, JSON.stringify(all))
    } catch {
      /* memory-only tab — still readable in this session */
    }
  } catch {
    /* never cost a take its handover to record a verdict about it */
  }
}

/**
 * A TAKE THAT COULD NOT BE GRADED IS STILL A TAKE, AND THE RING MUST SAY SO.
 *
 * The card is built behind two dynamic imports at stop (S1 keeps the report
 * modules off first paint), and the whole block ended in `.catch(() =>
 * undefined)`. A tab that has been open for hours — which is every tab that
 * records anything long — has watched deploys go by, and this PWA keeps the
 * last three builds; a chunk older than that is simply gone, the import
 * rejects, and the take is never graded by anyone. That is not theoretical:
 * rec_cff9nmm7trmh, the 46-minute take that opened at 553.6 minutes, is
 * absent from this ring entirely. Nothing said the take was ungraded, so
 * nothing said the take was anything.
 *
 * An `incomplete` line costs one entry and is never a pass.
 */
export function appendUngradedTake(id: string, createdAt: number, durationMs: number, why: string): void {
  try {
    const entry: TakeReportEntry = {
      t: createdAt,
      id,
      durationMs: Math.round(durationMs),
      verdict: 'incomplete',
      line: `${id} · ${(durationMs / 60000).toFixed(1)} min · NOT GRADED — ${why}`,
    }
    const all = load()
    const at = all.findIndex((e) => e.id === entry.id)
    if (at >= 0) all[at] = entry
    else all.push(entry)
    if (all.length > MAX_ENTRIES) all.splice(0, all.length - MAX_ENTRIES)
    try {
      localStorage.setItem(TAKE_REPORT_KEY, JSON.stringify(all))
    } catch {
      /* memory-only tab — still readable in this session */
    }
  } catch {
    /* the same rule as above: a witness may not endanger the take */
  }
}

/** The fleet, oldest first. For an agent reading the machine, and tests. */
export function readTakeReports(): readonly TakeReportEntry[] {
  return load()
}

/** Test seam — module state outlives test cases. */
export function __resetTakeReports(): void {
  mem = null
  try {
    localStorage.removeItem(TAKE_REPORT_KEY)
  } catch {
    /* nothing to clear */
  }
}
