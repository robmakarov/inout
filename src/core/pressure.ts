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
 *
 * ── AND THE READING IS ALSO PER HARDWARE BLOCK (E2) ──
 * Robert, 2026-09-02: down "just not let user loose his data because of
 * overload", and the block under pressure is the one that must be unloaded. A1
 * is the evidence: a starved CPU lost tab audio while the video encoders sat
 * idle, and every response available at the time moved the encoders. One
 * whole-machine number cannot tell those apart, so every signal declares which
 * block it is a signal ABOUT, and the reading carries a level per block beside
 * the worst-wins one. Consumers that only want "how bad is it" read `level` and
 * are unchanged; consumers that have to choose WHAT to shed read `blocks`.
 *
 * `disk` is declared and, today, never measured: no per-interval disk signal
 * exists in the compositor (B5's guard samples storage growth on the main
 * thread, once a second, for a different question). It reads `unmeasured`
 * rather than `nominal`, which is R1's rule and is also the honest answer.
 */

/**
 * The Compute Pressure vocabulary, on purpose. The platform signal is useless
 * to a recording take (see the probe) but it is the right shape, and a visible
 * consumer (the editor) can hand its records straight in as one more input
 * rather than needing a second scale to be invented for it.
 *
 * The spelling lives in `core/types.ts` because a take PERSISTS it (E2's
 * elastic ledger carries the level that decided each event), and the contract
 * file is where a persisted vocabulary belongs. Re-exported here so every
 * existing consumer keeps importing it from the instrument.
 */
import type { HardwareBlock, PressureLevel } from './types'

export type { HardwareBlock, PressureLevel }

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
 * The four blocks, in the order a reading reports them. The type itself is in
 * `core/types.ts` — see above. Deliberately four and not "every signal": a
 * block is something that can be unloaded independently of the others. On Apple
 * silicon the video encoder is its own block and CPU load does not reach it
 * (measured in pressureLead: six spinning cores plus 4K paints moved this
 * machine's encode latency from 11.0 ms to 13.4 — i.e. not at all), which is
 * exactly why "the machine is busy" is not an answer to "what should stop".
 */
export const HARDWARE_BLOCKS: readonly HardwareBlock[] = ['encoder', 'cpu', 'gpu', 'disk']

/**
 * Which block each signal is a signal ABOUT. One table, so a signal cannot be
 * added without answering the question.
 */
export const SIGNAL_BLOCK: Record<string, HardwareBlock> = {
  'encoder-queue': 'encoder',
  'encode-latency': 'encoder',
  'worker-lateness': 'cpu',
  'frame-cost': 'cpu',
  'stale-arrivals': 'cpu',
  'gpu-cost': 'gpu',
  platform: 'cpu',
}

/**
 * …AND WHETHER IT IS A SIGNAL ABOUT THIS TAKE'S OWN WORK — rule 7, generalised,
 * and the reason the picture step is not simply "the machine is at critical".
 *
 * A rate step removes work THIS TAKE is doing: fewer encodes, fewer paints,
 * fewer bytes. Every signal below is measured on the take's own pipeline and so
 * answers to it. `platform` is the browser's whole-machine hint — it can read
 * critical because of a build in another window, and halving Robert's frame
 * rate does not help that. It still counts towards the level (the unseen work
 * genuinely should be shed for it); it may not move the picture alone.
 */
export const OWN_WORK_SIGNALS: readonly string[] = [
  'encoder-queue',
  'encode-latency',
  'worker-lateness',
  'frame-cost',
  'stale-arrivals',
  'gpu-cost',
]

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
  /**
   * GPU time per encoded frame, ms — the `gpu` block's only signal, and it is
   * null unless the worker was asked to fence (`?probegpu=1`).
   *
   * NOT MEASURED BY DEFAULT ON PURPOSE: reading it costs a `gl.finish()` per
   * frame, which is a synchronous stall on the thread this detector exists to
   * keep free. So the honest default is that the GPU block reads `unmeasured`,
   * not `nominal` — an unread dimension is never a passed one (R1).
   */
  gpuPerFrameMs: number | null
  /** Arrivals stamped BEFORE the last encode this interval — the source is
   *  already ahead of the worker. */
  stale: number | null
  /** Arrivals this interval, the denominator for `stale`. */
  arrivals: number | null
  /** Frames the full queue refused this interval. NOT a leading signal — it is
   *  the loss itself, kept so a reading can never say "nominal" while the file
   *  is losing frames. */
  dropped: number | null
  /**
   * E2 — frames this interval that were only kept because the burst absorber
   * was there (queue past its steady bound, under the burst bound). NOT scored:
   * the queue depth that admitted them is already the signal, and counting the
   * consequence as well would double it. It is here because it is the ONE event
   * that says layer two of the order of defence actually did something, and
   * that has to reach the take's ledger.
   */
  burst: number | null
  /** A visible consumer's PressureObserver record, if it has one. Null during
   *  a take: measured silent in a hidden tab (see the header). */
  platform: PressureLevel | null
}

export interface PressureContribution {
  signal: string
  /** 0 = idle, 1 = at the point where loss begins. */
  strain: number
  detail: string
  /** Which hardware block this is a signal about (E2). */
  block: HardwareBlock
  /** True when it measures work THIS take is doing — see OWN_WORK_SIGNALS. */
  ownWork: boolean
}

/** One block's own reading. `measured` false means nothing about this block
 *  could be read: it is `nominal` by necessity and is not evidence of health. */
export interface BlockReading {
  block: HardwareBlock
  level: PressureLevel
  strain: number
  leader: PressureContribution | null
  measured: boolean
}

export interface PressureReading {
  level: PressureLevel
  /** The worst strain across the signals that were readable. */
  strain: number
  /** The signal that produced the level, or null when nothing was readable. */
  leader: PressureContribution | null
  contributions: PressureContribution[]
  /** E2 — the same reading split by hardware block, so a consumer can unload
   *  the block that is actually under pressure instead of everything. */
  blocks: Record<HardwareBlock, BlockReading>
  /**
   * E2 — the worst strain across the signals that measure THIS TAKE'S OWN work,
   * and the level that goes with it. A rate step answers to this number and not
   * to `strain`, because halving the frame rate cannot relieve a machine that is
   * busy in another window.
   */
  ownLevel: PressureLevel
  ownStrain: number
  ownLeader: PressureContribution | null
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

function tagsFor(signal: string): { block: HardwareBlock; ownWork: boolean } {
  return {
    block: SIGNAL_BLOCK[signal] ?? 'cpu',
    ownWork: OWN_WORK_SIGNALS.includes(signal),
  }
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
    else contributions.push({ signal, strain, detail, ...tagsFor(signal) })
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
  add(
    'gpu-cost',
    s.gpuPerFrameMs ?? null,
    (s.gpuPerFrameMs ?? 0) / budget,
    `${(s.gpuPerFrameMs ?? 0).toFixed(1)} ms on the GPU per ${budget.toFixed(1)} ms frame`,
  )
  if (s.stale !== null && s.arrivals !== null && s.arrivals > 0) {
    contributions.push({
      signal: 'stale-arrivals',
      strain: s.stale / s.arrivals,
      detail: `${s.stale} of ${s.arrivals} arrivals were already behind`,
      ...tagsFor('stale-arrivals'),
    })
  } else unmeasured.push('stale-arrivals')
  if (s.platform !== null) {
    contributions.push({
      signal: 'platform',
      strain: PLATFORM_STRAIN[s.platform],
      detail: `the browser reports ${s.platform}`,
      ...tagsFor('platform'),
    })
  } else unmeasured.push('platform')

  // NOT a leading signal — the loss itself. It cannot lower a reading and it
  // cannot be the thing this detector waits for; it is here so no reading ever
  // says 'nominal' about an interval that dropped frames.
  const dropped = s.dropped ?? 0
  const lossFloor = dropped > 0 ? CRITICAL_AT : 0

  const worst = (list: PressureContribution[]): PressureContribution | null =>
    list.reduce<PressureContribution | null>(
      (best, c) => (best === null || c.strain > best.strain ? c : best),
      null,
    )

  const blind = contributions.length === 0
  const leader = worst(contributions)
  const strain = Math.max(leader?.strain ?? 0, lossFloor)
  const level = blind && dropped === 0 ? 'nominal' : levelFor(strain)

  // E2 — THE SAME MATH, PER BLOCK. Worst-wins inside a block for the same reason
  // it wins across them: a blend hides the one signal that is failing.
  const blocks = Object.fromEntries(
    HARDWARE_BLOCKS.map((b) => {
      const own = contributions.filter((c) => c.block === b)
      const blockLeader = worst(own)
      // The loss floor belongs to the block that does the dropping — the
      // encoder refuses the frame (compositor.worker's MAX_ENCODER_QUEUE), so a
      // dropped interval is an encoder-block fact and must not red the CPU.
      const floor = b === 'encoder' ? lossFloor : 0
      const s2 = Math.max(blockLeader?.strain ?? 0, floor)
      return [
        b,
        {
          block: b,
          level: levelFor(s2),
          strain: s2,
          leader: blockLeader,
          measured: own.length > 0,
        } satisfies BlockReading,
      ]
    }),
  ) as Record<HardwareBlock, BlockReading>

  // E2 — and the same math again over the take's OWN work alone. This is the
  // number the picture answers to.
  const ownContributions = contributions.filter((c) => c.ownWork)
  const ownLeader = worst(ownContributions)
  const ownStrain = Math.max(ownLeader?.strain ?? 0, lossFloor)
  const ownLevel = levelFor(ownStrain)

  const line = blind
    ? 'pressure UNREADABLE — no signal available'
    : dropped > 0 && lossFloor >= strain
      ? `pressure ${level} — ${dropped} frame(s) already dropped this interval`
      : `pressure ${level} (${strain.toFixed(2)}) — ${leader?.signal}: ${leader?.detail}`

  return {
    level,
    strain,
    leader,
    contributions,
    blocks,
    ownLevel,
    ownStrain,
    ownLeader,
    unmeasured,
    blind,
    line,
  }
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
