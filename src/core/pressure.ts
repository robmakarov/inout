/**
 * THE PRODUCT'S ONE PRESSURE INSTRUMENT — task E1, and it is deliberately not
 * in capture/. M1 inherits it as max's emergency floor and F16b's background
 * render reads the same reading to pace itself ("one detector, many
 * consumers"), so a ladder-local heuristic under capture/ would have to be
 * copied twice, and the second copy would disagree with the first.
 *
 * WHAT IT IS FOR: today's ladder judges deliveredFps, which is a verdict on
 * frames ALREADY LOST. Robert's bar for elastic is "it must go up and down very
 * fast and responsive, never too much" — and a step that lands after the loss
 * cannot meet it, because the loss it was supposed to prevent is in the file.
 * So this reads the LEADING signals and answers "is loss coming", not "did loss
 * happen".
 *
 * ── THE CAPABILITY PROBE, AND WHY THE AUDIT'S TWO CANDIDATES ARE BOTH OUT ──
 * The task named two: the Compute Pressure API (PressureObserver) and Long
 * Animation Frames. Measured on prod 2026-09-01, on Robert's own Chrome 151 and
 * on Chromium 148, and both are REFUTED — not for being unsupported, but for
 * being silent in the only regime that matters.
 *
 * A TAKE RUNS WITH THIS DOCUMENT HIDDEN. That is not an edge case, it is the
 * product: Robert presses record and switches to the thing he is recording, so
 * INOUT's tab is in the background for essentially the whole take. Measured
 * there, in one window, with a deliberate 3.0 s main-thread busy loop as the
 * stimulus:
 *
 *   PressureObserver     supported, knownSources ['cpu'], observe() resolved
 *                        with no error, 0 records in 74 s.
 *   long-animation-frame supported, 0 entries.
 *   longtask             supported, 0 entries.
 *   main-thread ticker   16 ms setInterval → 11 ticks in 12.9 s. The hidden tab
 *                        clamps it to ~1 Hz, so it reads 984 ms LATE at idle and
 *                        3568 ms during the burn. It saw the stall (so the
 *                        stimulus was real and on that thread) and it cannot
 *                        tell that stall apart from being backgrounded.
 *   WORKER ticker        16 ms setInterval inside a dedicated worker of the same
 *                        hidden page → 472 ticks in 8 s (59 Hz, unthrottled),
 *                        max lateness 27 ms, total 125 ms.
 *
 * So perf/mainThreadWatch.ts's instrument — the one the task pointed at — is
 * unusable DURING a take, and the worker is the thread to ask. That is also the
 * right thread on the merits: the compositor and the video encoder live in it,
 * and their contention is the thing that starves a take. The main thread's
 * lateness matters for the EDITOR (T2, F16b), where the document is visible;
 * `platform` below is kept as an optional input for exactly that consumer, and
 * a recording take simply reports it unmeasured rather than faking a nominal.
 *
 * ── THE R1 RULE APPLIES TO A DETECTOR TOO, WITH ONE INVERSION ──
 * An unread dimension is never a passed one, so every signal here is nullable
 * and a null is reported in `unmeasured` rather than scored as 0. The inversion:
 * a report card FAILS on missing data, and a detector must not — a detector that
 * fires because it cannot see is a detector that steps a healthy take down. So
 * unmeasured signals do not contribute, the reading says which ones were absent,
 * and `blind` is true when NOTHING could be read.
 *
 * ── WHY THE WORST SIGNAL WINS, RATHER THAN A BLEND ──
 * Averaging hides the one thing that is failing behind four that are fine — the
 * same defect R1 found in the chroma score and G1 found in the sync band. The
 * level is the worst strain, and the reading NAMES the signal that produced it,
 * so every step this causes can say what it saw.
 */

/**
 * The Compute Pressure vocabulary, on purpose. The platform signal is useless
 * to a recording take (see the probe) but it is the right shape, and a visible
 * consumer (the editor) can hand its records straight in as one more input
 * rather than needing a second scale to be invented for it.
 */
export type PressureLevel = 'nominal' | 'fair' | 'serious' | 'critical'

/** Ordering, so consumers can compare levels without a lookup table. */
export const PRESSURE_ORDER: Record<PressureLevel, number> = {
  nominal: 0,
  fair: 1,
  serious: 2,
  critical: 3,
}

export function atLeast(level: PressureLevel, min: PressureLevel): boolean {
  return PRESSURE_ORDER[level] >= PRESSURE_ORDER[min]
}

/**
 * One interval's worth of leading signals. EVERY FIELD IS NULLABLE and null
 * means "nobody measured this", never "this was fine".
 *
 * All of them are per-interval rather than since-start: a take that recovers
 * must stop being judged on how it began (the same correction captureLadder
 * already applies to deliveredFps).
 */
export interface PressureSignals {
  /** Wall ms this sample covers. Below ~100 ms the ratios are noise. */
  intervalMs: number
  /** The frame period this take is trying to hold, ms. The denominator that
   *  turns every duration below into a fraction of the way to a lost frame. */
  frameBudgetMs: number

  /** Mean depth of the video encoder's queue at submit time, this interval.
   *  THE definitive leading signal: the drop happens when it reaches
   *  `queueCliff`, so this is literally distance-to-loss. */
  queueMean: number | null
  /** Depth at which the encoder path drops rather than queues. */
  queueCliff: number
  /**
   * Mean encode() → output callback latency this interval, ms.
   *
   * NOT NORMALISED AGAINST A FRAME BUDGET, and the first version of this file
   * was, which made it read `critical` on an idle machine: an encoder pipelines,
   * so a HEALTHY 60 fps take measured 19.2 ms of residence per frame against a
   * 16.7 ms frame. Latency is above one frame period by construction. What it
   * is genuinely bounded by is the pipeline itself — at most `queueCliff` frames
   * are ever in flight — so the honest denominator is the time it takes to drain
   * a full queue, `queueCliff × frameBudgetMs`. Measured against that, the same
   * idle take reads 0.19 and the loaded one 5.2.
   */
  encodeLatencyMs: number | null
  /**
   * MEAN scheduling lateness of the worker's own ticker this interval, ms —
   * thread starvation, measured on the thread that does the work.
   *
   * The mean and not the worst, and that is G1's lesson arriving a second time:
   * banding an extreme against a constant makes a longer window read worse for
   * being longer. Measured on an IDLE take, the worst tick in a 250 ms window
   * hit 81 ms against a 16.7 ms frame — a strain of 4.9, from a machine doing
   * nothing — while the mean over the same ticks stayed at 0.46 ms.
   */
  workerLateMeanMs: number | null
  /** The worst single tick over the same window. DIAGNOSTIC ONLY, deliberately
   *  not scored — see above. Kept because it is what names a one-off stall. */
  workerLateMaxMs: number | null
  /** Synchronous cost the worker spends per encoded frame (paint + frame +
   *  encode call), ms. At one frame budget the thread is fully spent. */
  perFrameCostMs: number | null
  /** Arrivals stamped BEFORE the last encode this interval — the source is
   *  already ahead of the worker. */
  stale: number | null
  /** Arrivals this interval, the denominator for `stale`. */
  arrivals: number | null
  /** Frames the full queue refused this interval. NOT a leading signal — it is
   *  the loss itself, kept so a reading can never say "nominal" while the file
   *  is losing frames. */
  dropped: number | null
  /** A visible consumer's PressureObserver record, if it has one. Null during
   *  a take: measured silent in a hidden tab (see the header). */
  platform: PressureLevel | null
}

export interface PressureContribution {
  signal: string
  /** 0 = idle, 1 = at the point where loss begins. */
  strain: number
  detail: string
}

export interface PressureReading {
  level: PressureLevel
  /** The worst strain across the signals that were readable. */
  strain: number
  /** The signal that produced the level, or null when nothing was readable. */
  leader: PressureContribution | null
  contributions: PressureContribution[]
  unmeasured: string[]
  /** True when NOT ONE signal could be read. A blind reading is 'nominal' by
   *  necessity and must never be treated as evidence of health. */
  blind: boolean
  /** One line, for a console and for a handoff. */
  line: string
}

/**
 * THE BANDS. Strain is already normalised to "fraction of the way to loss", so
 * these are where a reading stops being noise and starts being a prediction.
 *
 * MEASURED, NOT CHOSEN — `npm run exp -- pressure` reads every signal at idle
 * and under a max60-class load on the same machine in the same run, and these
 * are set from the gap between those two populations. The numbers behind them
 * are in the E1 handoff in .ai/TASKS.
 */
export const FAIR_AT = 0.5
export const SERIOUS_AT = 0.75
export const CRITICAL_AT = 1.0

function levelFor(strain: number): PressureLevel {
  if (strain >= CRITICAL_AT) return 'critical'
  if (strain >= SERIOUS_AT) return 'serious'
  if (strain >= FAIR_AT) return 'fair'
  return 'nominal'
}

const PLATFORM_STRAIN: Record<PressureLevel, number> = {
  nominal: 0.2,
  fair: FAIR_AT,
  serious: SERIOUS_AT,
  critical: CRITICAL_AT,
}

/**
 * Read the pressure. Pure, so the bands are testable without a machine and the
 * same function answers for capture, for a background render and for max's
 * emergency floor.
 */
export function readPressure(s: PressureSignals): PressureReading {
  const budget = s.frameBudgetMs > 0 ? s.frameBudgetMs : 1000 / 30
  const contributions: PressureContribution[] = []
  const unmeasured: string[] = []

  const add = (signal: string, value: number | null, strain: number, detail: string): void => {
    if (value === null) unmeasured.push(signal)
    else contributions.push({ signal, strain, detail })
  }

  const cliff = s.queueCliff > 0 ? s.queueCliff : 1
  add(
    'encoder-queue',
    s.queueMean,
    (s.queueMean ?? 0) / cliff,
    `${(s.queueMean ?? 0).toFixed(2)} of ${cliff} frames queued`,
  )
  const drainMs = cliff * budget
  add(
    'encode-latency',
    s.encodeLatencyMs,
    (s.encodeLatencyMs ?? 0) / drainMs,
    `${(s.encodeLatencyMs ?? 0).toFixed(1)} ms in the encoder against ${drainMs.toFixed(0)} ms of pipeline`,
  )
  add(
    'worker-lateness',
    s.workerLateMeanMs,
    (s.workerLateMeanMs ?? 0) / budget,
    `${(s.workerLateMeanMs ?? 0).toFixed(2)} ms mean tick against a ${budget.toFixed(1)} ms frame`,
  )
  add(
    'frame-cost',
    s.perFrameCostMs,
    (s.perFrameCostMs ?? 0) / budget,
    `${(s.perFrameCostMs ?? 0).toFixed(1)} ms of work per ${budget.toFixed(1)} ms frame`,
  )
  if (s.stale !== null && s.arrivals !== null && s.arrivals > 0) {
    contributions.push({
      signal: 'stale-arrivals',
      strain: s.stale / s.arrivals,
      detail: `${s.stale} of ${s.arrivals} arrivals were already behind`,
    })
  } else unmeasured.push('stale-arrivals')
  if (s.platform !== null) {
    contributions.push({
      signal: 'platform',
      strain: PLATFORM_STRAIN[s.platform],
      detail: `the browser reports ${s.platform}`,
    })
  } else unmeasured.push('platform')

  // NOT a leading signal — the loss itself. It cannot lower a reading and it
  // cannot be the thing this detector waits for; it is here so no reading ever
  // says 'nominal' about an interval that dropped frames.
  const dropped = s.dropped ?? 0
  const lossFloor = dropped > 0 ? CRITICAL_AT : 0

  const blind = contributions.length === 0
  const leader = contributions.reduce<PressureContribution | null>(
    (best, c) => (best === null || c.strain > best.strain ? c : best),
    null,
  )
  const strain = Math.max(leader?.strain ?? 0, lossFloor)
  const level = blind && dropped === 0 ? 'nominal' : levelFor(strain)

  const line = blind
    ? 'pressure UNREADABLE — no signal available'
    : dropped > 0 && lossFloor >= strain
      ? `pressure ${level} — ${dropped} frame(s) already dropped this interval`
      : `pressure ${level} (${strain.toFixed(2)}) — ${leader?.signal}: ${leader?.detail}`

  return { level, strain, leader, contributions, unmeasured, blind, line }
}

// ---------------------------------------------------------------------------
// THE FLAG. One home for the subject, the same shape resolutionStep.ts uses.
// ---------------------------------------------------------------------------

const FLAG_KEY = 'inout.capture.pressure'

function flagFromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('pressure')
  return v === '1' ? true : v === '0' ? false : null
}

function flagFromStorage(): boolean | null {
  try {
    const v = localStorage.getItem(FLAG_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

let flagOverride: boolean | null = null

/**
 * ON BY DEFAULT, and this is the one place in the capture path where that is
 * the right answer rather than the risky one: E1's whole assignment is that the
 * ladder must stop being an autopsy, and a prediction nobody runs predicts
 * nothing. The FROZEN RULE is still kept — `?pressure=0` is a runtime fallback
 * to the exact ladder that shipped, in one URL parameter, with no rebuild.
 *
 * It changes nothing about WHAT a step does (the rate, never the size, capped
 * at the chosen step) and nothing at all in max, where the ladder is off.
 *
 *   ?pressure=1|0    (this load only)
 *   localStorage['inout.capture.pressure']   (sticky)
 */
export function pressureDetectorEnabled(): boolean {
  return flagFromSearch() ?? flagOverride ?? flagFromStorage() ?? true
}

export function setPressureDetector(on: boolean | null): void {
  flagOverride = on
  try {
    if (on === null) localStorage.removeItem(FLAG_KEY)
    else localStorage.setItem(FLAG_KEY, on ? '1' : '0')
  } catch {
    /* memory-only */
  }
}
