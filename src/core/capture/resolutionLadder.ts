/**
 * Stepwise capture degradation (task O6).
 *
 * O6 wants capture at the source's native resolution, and the ONLY reason that
 * is not simply a constant change is the 2026-08-22 freeze: a 4K surface is
 * paid for several times over on one GPU, and when it collapses the user gets
 * a frozen picture with no warning. The cap (CAPTURE_MAX_*, 1080p30) was the
 * fix, and it is a blunt one — it costs every 1440p and 4K user their
 * resolution whether or not their machine could have kept up.
 *
 * The task's shape is therefore "native BEHIND MEASURED BACKPRESSURE": start
 * high, watch delivery, and step DOWN before delivery collapses rather than
 * after. This file is that decision, and it is pure so it can be tested at the
 * boundaries where it matters — which is the same treatment compositorWatchdog
 * got, and for the same reason: the consequence of getting it wrong is a
 * ruined take that nobody can reproduce on demand.
 *
 * THREE RULES THE LADDER MUST OBEY, each of which is a way this could go wrong:
 *
 *  1. NEVER STEP UP. A machine that recovered for a second must not re-raise
 *     the resolution mid-take: changing a channel's frame size after its
 *     recorder started is exactly what P0-tail-raw is careful never to do, and
 *     a file whose dimensions change part-way is a file the render has to
 *     special-case forever. Down is a one-way door.
 *  2. GIVE THE ENCODER TIME TO WAKE UP. Note 6: a fresh process's first
 *     VideoEncoder pays a multi-second init, and every "2-10 fps" panic in this
 *     project's history was that init being measured. The ladder does not look
 *     until output has actually started, and then only over a window.
 *  3. ONE STEP AT A TIME, with a settle period. Dropping 4K → 1080p on a single
 *     bad second would give up resolution the machine might well have held; and
 *     re-measuring immediately after a step would score the step's own
 *     transient as a failure and cascade to the floor.
 *  4. A SOURCE THAT SENT NOTHING DID NOT FAIL (P0-ladder-static). getDisplayMedia
 *     emits frames ON CHANGE: a document nobody is scrolling delivers 0 fps and
 *     that is health, not collapse. Judging delivery against a wall-clock 30
 *     stepped real takes down permanently for being still. The ladder therefore
 *     judges against what actually ARRIVED — backpressure is frames the
 *     compositor could not keep up with, and where nothing arrived there is
 *     nothing to have fallen behind on.
 */

export interface LadderRung {
  label: string
  /** Absent on a rung that only changes the RATE. */
  width?: number
  height?: number
  /** Present only on the rate rung. */
  fps?: number
}

/**
 * Native is not a rung: it is whatever the source is, and the ladder's job is
 * to name where to go when native does not hold. 1440p then 1080p, because
 * those are the two shapes a screen recording is actually watched at, and
 * because 1080p is the cap that shipped and is known to work.
 */
export const DEGRADE_RUNGS: LadderRung[] = [
  { label: '1440p', width: 2560, height: 1440 },
  { label: '1080p', width: 1920, height: 1080 },
]

/**
 * THE RATE IS GIVEN BACK FIRST, and only a take that has a rate to give.
 *
 * `stepDisplayDown` used to say the rate was left alone on purpose — "this
 * ladder trades PIXELS for keeping up, and dropping the rate as well would
 * change two things at once". That was right for as long as the rate was a
 * constant 30: there was nothing to give back, so pixels were the only
 * currency. F15 made the rate follow the source, and then the FIRST thing a
 * struggling take should return is the thing it most recently asked for.
 *
 * IT IS ALSO THE CHEAPER LOSS, measured on prod 2026-08-29 on one machine and
 * one source, `?sourcefps=1&screensize=3456x2234`:
 *     3456x2234 @60  the composite encoded NOTHING, raw kept 8 of 305 frames
 *     3456x2234 @30  composite healthy, raw kept 493 of 574
 *     2560x1440 @60  composite kept 81 %
 *     1920x1080 @60  composite kept 90 %
 * Halving the rate rescued the whole take where two resolution steps did not —
 * because the composite draws the source into its own 1920x1080 canvas SIXTY
 * times a second whatever the source's size, so shrinking the source does not
 * touch the cost that is actually killing it.
 *
 * A 30 fps take gets exactly the rungs it always got, in the same order.
 */
export function rungsFor(requestedFps: number): LadderRung[] {
  return requestedFps > 30
    ? [{ label: '30 fps', fps: 30 }, ...DEGRADE_RUNGS]
    : DEGRADE_RUNGS
}

/** Below this share of the frames that arrived, encoding is failing rather than varying. */
export const DELIVERY_FLOOR_RATIO = 0.6
/** Rule 2: nothing is judged until the encoder has produced output for this long. */
export const WARMUP_MS = 4_000
/**
 * Rule 2's UPPER BOUND, and the hole it closes cost a take its whole composite.
 *
 * "An encoder that has not produced yet is initialising" is true and it is why
 * rule 2 exists (note 6: a fresh process's first VideoEncoder pays a
 * multi-second init, and every "2-10 fps" panic in this project was that init
 * being measured). But it was written with no ceiling, so INITIALISING and
 * NEVER GOING TO PRODUCE ANYTHING were the same state forever — and the ladder,
 * the thing that exists to rescue exactly that, was switched off by it.
 *
 * MEASURED ON PROD 2026-08-29, `?sourcefps=1&screensize=3456x2234&screenfps=60`
 * — a real monitor's worth of pixels at 60: the composite encoded ZERO frames,
 * `firstOutputAtMs` stayed null for the whole take, the ladder never once ran,
 * and the watchdog gave up at 15 s and killed the composite. The same source at
 * 2560x1440@60 keeps 81 % of its frames, so the rung the ladder would have
 * stepped to was there the whole time.
 *
 * IT IS A LAST RESORT, NOT A SECOND WARM-UP RULE, and the first attempt at it
 * got that wrong in exactly the way rule 2 was written to prevent. At 6 s this
 * fired on 2560x1440@60 — a configuration MEASURED to keep 81 % of its frames —
 * because that composite's encoder had simply not produced its first output
 * yet under a heavy source. The ladder then stepped a healthy take down to 30
 * and it kept 132 frames instead of 508. Note 6, one more time: judging inside
 * the init reads as a hardware failure.
 *
 * So it sits just under the watchdog's 15 s instead. That is the only window
 * where this rung can be certain: past it the composite is being killed
 * anyway, so asking for less can only beat losing it, and below it the honest
 * answer is still "the encoder is waking up".
 */
export const DEAD_ENCODER_MS = 12_000
/** Rule 3: after a step, wait this long before judging the new rung. */
export const SETTLE_MS = 3_000
/** How long delivery must stay under the floor before a step. */
export const SUSTAINED_MS = 2_000

export interface LadderInput {
  nowMs: number
  /** performance.now() when the composite started. */
  startedAtMs: number
  /** First real (non-keep-alive) encoder output, or null if none yet. */
  firstOutputAtMs: number | null
  /** When the last step was applied, or null if the ladder has not stepped. */
  lastStepAtMs: number | null
  /** How long encoding has continuously failed to keep up with arrivals, ms. */
  underFloorForMs: number
  /** Real (non-keep-alive) frames per second that reached the encoder recently. */
  deliveredFps: number
  /**
   * Frames per second that ARRIVED from the sources recently. This is the
   * ruler (Rule 4): a static screen reads 0 here and is left alone, however
   * far below `requestedFps` it sits.
   */
  arrivedFps: number
  /** Frames per second the take asked for — arrivals above it are deliberately
   *  dropped by the cadence gate, so demand is capped at this rate. */
  requestedFps: number
  /** Rungs already taken — the ladder only ever descends. */
  stepsTaken: number
}

export interface LadderVerdict {
  /** The rung to move to. */
  rung: LadderRung
  reason: string
}

/**
 * Should capture step down, and to what? null = stay where you are, which is
 * the answer in every case the ladder is not certain about.
 */
export function ladderVerdict(input: LadderInput): LadderVerdict | null {
  // Rule 1: the floor is the floor.
  const rungs = rungsFor(input.requestedFps)
  if (input.stepsTaken >= rungs.length) return null
  // Rule 2: an encoder that has not produced yet is initialising, not failing —
  // until it has been silent longer than any initialisation takes, at which
  // point it is failing in the loudest way available and is precisely what this
  // ladder is for. See DEAD_ENCODER_MS.
  if (input.firstOutputAtMs === null) {
    if (input.nowMs - input.startedAtMs < DEAD_ENCODER_MS) return null
  } else if (input.nowMs - input.firstOutputAtMs < WARMUP_MS) return null
  // Rule 3: let a step settle before judging its result.
  if (input.lastStepAtMs !== null && input.nowMs - input.lastStepAtMs < SETTLE_MS) return null
  if (input.underFloorForMs < SUSTAINED_MS) return null
  if (!(input.requestedFps > 0)) return null
  // Rule 4: demand is what arrived, capped at the requested rate (the cadence
  // gate drops the excess of a 60 fps source on purpose — that is not failure).
  // Zero demand means the source sent nothing, and a source that sent nothing
  // because nothing changed is not a source that failed.
  const demandFps = Math.min(input.arrivedFps, input.requestedFps)
  if (!(demandFps > 0)) return null
  const ratio = input.deliveredFps / demandFps
  if (ratio >= DELIVERY_FLOOR_RATIO) return null
  const rung = rungs[input.stepsTaken]!
  return {
    rung,
    reason:
      (input.firstOutputAtMs === null
        ? `the encoder has produced NOTHING in ${Math.round(input.nowMs - input.startedAtMs)} ms while ` +
          `${demandFps.toFixed(1)} fps arrived — `
        : `encoded ${input.deliveredFps.toFixed(1)} of ${demandFps.toFixed(1)} arriving fps ` +
          `(${Math.round(ratio * 100)} % kept) for ${Math.round(input.underFloorForMs)} ms `) +
      `→ ${rung.label}`,
  }
}
