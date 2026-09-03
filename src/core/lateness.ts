/**
 * MAIN-THREAD LATENESS — scheduled versus actual, as a number a card can grade
 * (task G7, 2026-09-02).
 *
 * WHAT IT IS FOR. Phase 1 claims "no editor stall > 30 ms" and nothing in this
 * repo could read that claim: B10's stalls (35-201 ms, the size probe encoding
 * 300 frames on the main thread ~11 s after the editor opens) were found by
 * hand, in one script, on one drag, after Robert had already felt them. A
 * dimension on the card turns that into an instrument: every take and every
 * editor open answers the question without anybody asking it.
 *
 * ── THE ONE DESIGN DECISION, AND IT IS NOT A PREFERENCE ──
 * The clock is in a worker (`latenessBeat.worker.ts`), not on the main thread.
 * A take runs with the document HIDDEN and Chrome clamps a hidden page's timers
 * to ~1 Hz; E1 measured a 16 ms main-thread ticker reading 984 ms late at idle
 * there, against the same page's worker ticker at 59 Hz / 27 ms worst
 * (core/pressure.ts). A main-thread timer would therefore report the throttle
 * as a stall on every take. The worker posts a schedule, the main thread stamps
 * the arrival, and the lateness is the difference — the main thread's own
 * queueing delay, which is what "stall" means to a person.
 *
 * ── WHAT IT COSTS, AND THE BUDGET IT IS BUILT AGAINST ──
 * G7's gate is < 1 ms of main thread per second of capture. Per beat the main
 * thread does: one `performance.now()`, one subtraction, one histogram index,
 * two comparisons. Everything that grows with the length of the take —
 * percentiles, windows — is O(1) by construction: a fixed histogram, a rolling
 * window, the worst three kept. Nothing is allocated per sample. The sampler
 * measures its own cost on one beat in 64 and reports it (`selfCostMsPerSec`),
 * and the rig (`scripts/g7-lateness.mjs --cost`) measures it again from the
 * outside, where the event dispatch this cannot see is included.
 *
 * ── RULE 1 OF THE CARD APPLIES ──
 * No score for a measurement not taken. A take without a summary reads
 * `unmeasured`, a reading taken by the fallback timer on a hidden document is
 * marked `clamped` and is never quoted as machine lateness, and beats that
 * never arrived are counted (`missed`) so a starved page reports a floor rather
 * than a clean number.
 *
 * AGENT/DEV SURFACE ONLY (Robert 2026-09-02: bug data is not shown to users).
 * Nothing here renders, and nothing here can change a capture decision.
 */
import type { LatenessOwner, LatenessSummary, LatenessWindow } from './types'

/** One frame at 60 fps. "More than one frame late" is the defect line G7 was
 *  written around; the band a card FAILS on is the Phase-1 claim (30 ms). */
export const FRAME_MS = 1000 / 60

/** Phase-1's claim, in one constant, read by the report card. */
export const STALL_FAIL_MS = 30

/** The schedule. One frame: fine enough that a 35 ms stall is measured to
 *  within 16 ms of the truth, coarse enough to fit the budget (60 beats/s). */
export const DEFAULT_PERIOD_MS = 16

/** The window a "worst window" is. One second, because that is the unit a stall
 *  is described in ("it hung for a second") and it makes the worst window's
 *  start directly quotable. */
export const WINDOW_MS = 1000

/** How long the editor's own reading runs: G7 says the editor's FIRST 15 s, and
 *  B10's size probe lands ~11 s into it. */
export const EDITOR_WINDOW_MS = 15_000

/**
 * Histogram edges, ms. Upper bound of each bucket; the last one is unbounded.
 * Chosen so the two lines that matter fall ON an edge — one frame (16.7) and
 * the Phase-1 claim (30) — and so B10's range (35-201) is spread over five
 * buckets rather than swallowed by one.
 */
export const LATENESS_BUCKETS_MS = [1, 2, 4, 8, FRAME_MS, 25, 30, 50, 75, 100, 150, 200, 300, 500, 1000]

/** Cost self-measurement: one beat in this many is timed. */
const COST_EVERY = 64

/* ───────────────────────── the flag ───────────────────────── */

/**
 * `?lateness=0` turns the sampler off for a load. Default ON: it is the
 * instrument every stall claim is read against, and a claim that only holds
 * when nobody is measuring is not a claim. The flag exists because the COST
 * GATE needs an A/B — measuring "what does sampling cost" requires a load that
 * does not sample — and because a user who wants their machine left alone
 * should not have to argue with us (prerenderFlag.ts's precedent).
 *
 * `?latebeat=N` overrides the schedule period for one load. Not a product
 * knob: it is how the cost curve is measured (16 ms vs 32 ms vs 64 ms).
 */
function search(name: string): string | null {
  if (typeof location === 'undefined') return null
  return new URLSearchParams(location.search).get(name)
}

export function latenessEnabled(): boolean {
  return search('lateness') !== '0'
}

export function latenessPeriodMs(): number {
  const raw = Number(search('latebeat'))
  return Number.isFinite(raw) && raw >= 4 && raw <= 1000 ? raw : DEFAULT_PERIOD_MS
}

/* ───────────────────── the accumulator (pure) ───────────────────── */

/**
 * Every sample the sampler takes goes through here, and NOTHING ELSE DOES — so
 * the grading arithmetic is testable without a browser, a worker or a clock.
 */
export class LatenessTally {
  readonly periodMs: number
  private readonly histogram: number[]
  private samples = 0
  private overFrame = 0
  private maxMs = 0
  private maxAtMs = 0
  private firstAtMs: number | null = null
  private lastAtMs = 0
  private lastSeq = 0
  private missed = 0
  /** The window being filled, and the three worst finished ones. */
  private winStart = 0
  private winMax = 0
  private winLate = 0
  private winSamples = 0
  private worst: LatenessWindow[] = []
  private owners: LatenessOwner[] = []
  private hiddenMs = 0
  private costMs = 0
  private costSamples = 0

  constructor(periodMs: number = DEFAULT_PERIOD_MS) {
    this.periodMs = periodMs
    this.histogram = new Array<number>(LATENESS_BUCKETS_MS.length + 1).fill(0)
  }

  /** `atMs` is from the sampler's start; `lateMs` is arrival − due. */
  push(atMs: number, lateMs: number, seq?: number): void {
    const late = lateMs > 0 ? lateMs : 0
    if (this.firstAtMs === null) {
      this.firstAtMs = atMs
      this.winStart = Math.floor(atMs / WINDOW_MS) * WINDOW_MS
    }
    this.lastAtMs = atMs
    if (seq !== undefined) {
      // The worker's sequence is the schedule's own count, so a beat that never
      // reached the main thread is a hole in it. This is the only way a frozen
      // page is distinguishable from a quiet one.
      if (this.lastSeq && seq > this.lastSeq + 1) this.missed += seq - this.lastSeq - 1
      this.lastSeq = seq
    }
    this.samples++
    if (late > FRAME_MS) this.overFrame++
    if (late > this.maxMs) {
      this.maxMs = late
      this.maxAtMs = atMs
    }
    let b = 0
    while (b < LATENESS_BUCKETS_MS.length && late > LATENESS_BUCKETS_MS[b]) b++
    this.histogram[b]++
    // Roll the window forward. A stall longer than a window leaves the windows
    // it covered empty, which is correct: nothing was sampled in them.
    while (atMs >= this.winStart + WINDOW_MS) {
      this.closeWindow()
      this.winStart += WINDOW_MS
    }
    this.winSamples++
    this.winLate += late
    if (late > this.winMax) this.winMax = late
  }

  private closeWindow(): void {
    if (this.winSamples > 0) {
      this.keepWorst({
        startMs: this.winStart,
        maxMs: round(this.winMax),
        lateMs: round(this.winLate),
        samples: this.winSamples,
      })
    }
    this.winMax = 0
    this.winLate = 0
    this.winSamples = 0
  }

  private keepWorst(w: LatenessWindow): void {
    this.worst.push(w)
    this.worst.sort((a, b) => b.maxMs - a.maxMs)
    if (this.worst.length > 3) this.worst.length = 3
  }

  /** Long-animation-frame / longtask attribution, worst first, at most five. */
  noteOwner(owner: LatenessOwner): void {
    this.owners.push(owner)
    this.owners.sort((a, b) => b.durationMs - a.durationMs)
    if (this.owners.length > 5) this.owners.length = 5
  }

  noteHidden(ms: number): void {
    this.hiddenMs += ms
  }

  /** One beat in COST_EVERY is timed; the total is scaled back up. */
  noteCost(ms: number): void {
    this.costMs += ms
    this.costSamples++
  }

  get count(): number {
    return this.samples
  }

  summary(source: 'worker-beat' | 'timer', clamped: boolean): LatenessSummary {
    // The open window counts too — a take that stops mid-window still stalled.
    this.closeWindow()
    const spanMs = this.firstAtMs === null ? 0 : Math.max(0, this.lastAtMs - this.firstAtMs)
    const spanSec = spanMs / 1000
    return {
      source,
      periodMs: this.periodMs,
      spanMs: Math.round(spanMs),
      samples: this.samples,
      missed: this.missed,
      maxMs: round(this.maxMs),
      maxAtMs: Math.round(this.maxAtMs),
      p50Ms: this.quantile(0.5),
      p95Ms: this.quantile(0.95),
      overFrame: this.overFrame,
      frameMs: round(FRAME_MS),
      histogram: [...this.histogram],
      worstWindows: [...this.worst],
      owners: [...this.owners],
      hiddenRatio: spanMs > 0 ? Math.min(1, round(this.hiddenMs / spanMs)) : 0,
      ...(clamped ? { clamped: true } : null),
      // Mean cost of a TIMED beat, charged to every beat, over the span. The
      // three decimals are not false precision: the gate is 1 ms/s and the
      // honest reading is a few hundredths, which would round to zero.
      selfCostMsPerSec:
        this.costSamples > 0 && spanSec > 0
          ? round3(((this.costMs / this.costSamples) * this.samples) / spanSec)
          : 0,
    }
  }

  /**
   * BUCKET-INTERPOLATED, and the summary says so. Exact order statistics over
   * an hour of 60 Hz sampling would mean keeping 216,000 numbers alive inside a
   * take, which breaks the rule this instrument was allowed under. The exact
   * MAX is kept separately, because the worst sample is the one a defect is
   * argued from and an estimate of it would not be worth having.
   */
  private quantile(q: number): number {
    if (!this.samples) return 0
    const want = q * this.samples
    let seen = 0
    for (let b = 0; b < this.histogram.length; b++) {
      const n = this.histogram[b]
      if (seen + n < want) {
        seen += n
        continue
      }
      const lo = b === 0 ? 0 : LATENESS_BUCKETS_MS[b - 1]
      const hi = b < LATENESS_BUCKETS_MS.length ? LATENESS_BUCKETS_MS[b] : this.maxMs
      if (n === 0) return round(lo)
      return round(lo + ((want - seen) / n) * (hi - lo))
    }
    return round(this.maxMs)
  }
}

const round = (n: number): number => Math.round(n * 10) / 10
const round3 = (n: number): number => Math.round(n * 1000) / 1000

/* ───────────────────────── the sampler ───────────────────────── */

export interface LatenessRun {
  /** Stop sampling and return what it saw. Idempotent: the second call returns
   *  the same summary rather than a second, empty one. */
  stop(): LatenessSummary | null
}

interface StartOptions {
  /** Stop on its own after this long (the editor's 15 s). */
  autoStopMs?: number
  /** Called with the summary when the run ends, however it ends. */
  onDone?: (s: LatenessSummary) => void
  periodMs?: number
}

/**
 * Start sampling. Returns a handle even when the instrument is off or the
 * platform cannot support it — `stop()` then returns null and the card reads
 * `unmeasured`, which is the truth about that take.
 */
export function startLateness(opts: StartOptions = {}): LatenessRun {
  if (!latenessEnabled() || typeof performance === 'undefined') {
    return { stop: () => null }
  }
  const periodMs = opts.periodMs ?? latenessPeriodMs()
  const tally = new LatenessTally(periodMs)
  const t0 = performance.now()
  const origin = performance.timeOrigin
  let stopped = false
  let result: LatenessSummary | null = null
  let source: 'worker-beat' | 'timer' = 'worker-beat'
  let worker: Worker | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let beats = 0

  /* Visibility, so a reading can say what kind of page it was taken on. A take
     is hidden for essentially all of its length and the editor for none of it;
     the same number means different things on the two. */
  const doc = typeof document === 'undefined' ? null : document
  let hiddenSince = doc?.hidden ? t0 : null
  const onVisibility = (): void => {
    const now = performance.now()
    if (doc?.hidden) {
      hiddenSince = now
    } else if (hiddenSince !== null) {
      tally.noteHidden(now - hiddenSince)
      hiddenSince = null
    }
  }
  doc?.addEventListener('visibilitychange', onVisibility)

  /* Who was on the thread. Absent on a hidden document — neither API reports
     there (E1: 0 entries in 74 s) — which is exactly why this is attribution
     and not the measurement. */
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) tally.noteOwner(describeOwner(e, t0))
    })
    try {
      observer.observe({
        type: 'long-animation-frame',
        // Below the Phase-1 claim, so the entry that explains a 35 ms stall
        // exists. The browser clamps this to its own floor (16 ms) if it is
        // lower than that.
        durationThreshold: STALL_FAIL_MS - 5,
      } as PerformanceObserverInit)
    } catch {
      observer.observe({ entryTypes: ['longtask'] })
    }
  } catch {
    observer = null
  }

  const onBeat = (due: number, workerLateMs: number, seq: number): void => {
    const timed = beats++ % COST_EVERY === 0
    const now = performance.now()
    // WHY THE WORKER'S OWN LATENESS IS SUBTRACTED: a starved worker serves a
    // beat late, and charging that to the main thread would read a busy machine
    // as an unresponsive page. What is left is the main thread's own queueing.
    const late = origin + now - due - workerLateMs
    tally.push(now - t0, late, seq)
    if (timed) tally.noteCost(performance.now() - now)
  }

  const finish = (): LatenessSummary | null => {
    if (stopped) return result
    stopped = true
    if (timer !== null) clearTimeout(timer)
    doc?.removeEventListener('visibilitychange', onVisibility)
    if (hiddenSince !== null) tally.noteHidden(performance.now() - hiddenSince)
    try {
      observer?.disconnect()
    } catch {
      /* nothing to disconnect */
    }
    if (worker) {
      try {
        worker.postMessage({ type: 'stop' })
      } catch {
        /* already gone */
      }
      worker.terminate()
      worker = null
    }
    if (!tally.count) return null
    result = tally.summary(source, source === 'timer' && (doc?.hidden ?? false))
    opts.onDone?.(result)
    return result
  }

  try {
    worker = new Worker(new URL('./latenessBeat.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (ev: MessageEvent<{ due: number; workerLateMs: number; seq: number }>) => {
      onBeat(ev.data.due, ev.data.workerLateMs, ev.data.seq)
    }
    worker.onerror = () => {
      // A dead clock is not a dead instrument: fall back, and SAY which one
      // took the reading, because on a hidden document they do not mean the
      // same thing.
      worker = null
      startTimerFallback()
    }
    worker.postMessage({ type: 'start', periodMs })
  } catch {
    worker = null
    startTimerFallback()
  }

  function startTimerFallback(): void {
    source = 'timer'
    const started = performance.now()
    let seq = 0
    const tick = (): void => {
      if (stopped) return
      seq++
      const due = started + seq * periodMs
      const now = performance.now()
      tally.push(now - t0, now - due, seq)
      let next = started + (seq + 1) * periodMs
      if (next <= now) {
        seq = Math.ceil((now - started) / periodMs)
        next = started + (seq + 1) * periodMs
      }
      timer = setTimeout(tick, next - now)
    }
    timer = setTimeout(tick, periodMs)
  }

  if (opts.autoStopMs !== undefined) {
    // The auto-stop is itself a main-thread timer, so on a hidden document it
    // fires late — which costs nothing here: the window is defined by what was
    // sampled, and the summary carries its own span.
    setTimeout(finish, opts.autoStopMs)
  }

  return { stop: finish }
}

/**
 * What the browser said was on the thread. LoAF's `scripts` name a source URL
 * and a function; longtask names only a container. Either is worth more than
 * "something was slow", and the name is what turns a stall into a task id.
 */
function describeOwner(entry: PerformanceEntry, t0: number): LatenessOwner {
  const e = entry as PerformanceEntry & {
    blockingDuration?: number
    scripts?: { sourceURL?: string; sourceFunctionName?: string; invoker?: string; duration?: number }[]
    attribution?: { containerType?: string; containerName?: string; containerSrc?: string }[]
  }
  const script = [...(e.scripts ?? [])].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0]
  const attribution = e.attribution?.[0]
  const name =
    script?.sourceURL || script?.invoker
      ? `${trimUrl(script.sourceURL)}${script.sourceFunctionName ? ` ${script.sourceFunctionName}()` : ''}${
          script.invoker ? ` via ${script.invoker}` : ''
        }`.trim()
      : attribution?.containerSrc || attribution?.containerName
        ? `${attribution.containerType ?? 'frame'} ${attribution.containerName ?? attribution.containerSrc}`
        : // A long animation frame with NO script long enough to be named is
          // still worth telling apart: the browser reports where the frame's
          // time went, and "the render took 163 ms" and "something ran for
          // 163 ms" send a reader to different files.
          `${entry.entryType}${phaseOf(e)}`
  return {
    atMs: Math.round(entry.startTime - t0),
    durationMs: round(entry.duration),
    ...(e.blockingDuration !== undefined ? { blockingMs: round(e.blockingDuration) } : null),
    name,
  }
}

/**
 * Which half of a long animation frame it was. `renderStart` splits the frame:
 * before it is script and task work, after it is style, layout and paint. Empty
 * when the browser reports neither (a `longtask` entry has no phases).
 */
function phaseOf(e: PerformanceEntry & { renderStart?: number }): string {
  if (!e.renderStart || !e.duration) return ''
  const renderMs = e.startTime + e.duration - e.renderStart
  const scriptMs = e.renderStart - e.startTime
  return renderMs > scriptMs ? ' (render/style)' : ' (script/task)'
}

/** The last path segment plus its query-less name — a bundled chunk's full URL
 *  is 80 characters of hash and origin that name nothing. */
function trimUrl(url?: string): string {
  if (!url) return ''
  const clean = url.split('?')[0]
  const tail = clean.slice(clean.lastIndexOf('/') + 1)
  return tail || clean
}

/* ─────────────────── the editor's own 15 seconds ─────────────────── */

let editorSummary: LatenessSummary | null = null
let editorRun: LatenessRun | null = null
let editorRecordingId: string | null = null

/**
 * G7: the editor's FIRST 15 SECONDS, which is where B10 lives — the size probe
 * encodes 300 frames on the main thread about 11 s after the editor opens.
 * Started on the editor's mount, stopped by itself, kept for
 * `__inoutEditorReport()`.
 */
export function startEditorLateness(recordingId?: string): () => void {
  editorRun?.stop()
  editorSummary = null
  editorRecordingId = recordingId ?? null
  const run = startLateness({
    autoStopMs: EDITOR_WINDOW_MS,
    onDone: (s) => {
      editorSummary = s
    },
  })
  editorRun = run
  return () => {
    run.stop()
    if (editorRun === run) editorRun = null
  }
}

export function lastEditorLateness(): LatenessSummary | null {
  return editorSummary
}

/** Which take was open while that reading was taken — the editor's card says
 *  so, because "the editor stalled" is not a fact about the editor alone. */
export function lastEditorLatenessTake(): string | null {
  return editorRecordingId
}
