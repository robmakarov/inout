/**
 * Stepwise capture degradation — AND RECOVERY (task O6, rewritten 2026-08-29).
 *
 * WHAT THIS FILE STOPPED DOING, and why the rename: it used to step the
 * RESOLUTION down. It no longer touches resolution at all, and both halves of
 * that are Robert's, in his words on the day a 60 fps game tab froze his
 * machine:
 *
 *   "if something needs to be dropped it must be fps not resolution, but you
 *    must make it work max resolution 60 fps"
 *   "no screen proportion changes"
 *   "i want it to go back to max smoothly as suffering eases immediately"
 *
 * THE MEASUREMENT AGREED WITH HIM BEFORE HE SAID IT, which is the part worth
 * keeping. A resolution step could not work, and his own console proved it:
 * `display stepped 3024×1964@30 → 2217×1440@30` and then, at stop,
 * `screen channel recorded 3024x1964 (the track said 2217x1440)`. The raw
 * channel's VideoEncoder is configured ONCE, at start, and a frame size cannot
 * change mid-file (P0-tail-raw is careful about exactly this) — so after a
 * resolution step Chrome was UPSCALING every frame back to the original size
 * for it. The step cost more than it saved. It was a guard that made things
 * worse, and it had been shipping.
 *
 * A RATE STEP HAS NONE OF THAT. The frame size never changes, so every encoder
 * keeps the configuration it was opened with, every file keeps one geometry,
 * and no proportion moves. Frames simply arrive less often, or more often
 * again. That is also why this ladder can go BACK UP where the old one could
 * not: rule 1 below was written about SIZE, and it is still true about size —
 * it just has nothing left to govern here.
 *
 * THE RULES, each of which is a way this could go wrong:
 *
 *  1. NEVER CHANGE THE SIZE. Not down, not up, not ever. A file whose
 *     dimensions change part-way is a file the render has to special-case
 *     forever, and the raw channel cannot follow it anyway.
 *  2. GIVE THE ENCODER TIME TO WAKE UP. Note 6: a fresh process's first
 *     VideoEncoder pays a multi-second init, and every "2-10 fps" panic in this
 *     project's history was that init being measured. Judging inside it reads
 *     as a hardware failure — and a 6-second version of this rule cost a
 *     healthy 1440p60 take three quarters of its frames on the day it shipped.
 *  3. ONE STEP AT A TIME, with a settle period, in BOTH directions. Re-measuring
 *     immediately after a step scores the step's own transient.
 *  4. A SOURCE THAT SENT NOTHING DID NOT FAIL (P0-ladder-static). getDisplayMedia
 *     emits frames ON CHANGE: a document nobody is scrolling delivers 0 fps and
 *     that is health, not collapse. Backpressure is frames the compositor could
 *     not keep up with, so the ruler is what ARRIVED.
 *  5. RECOVERY IS SLOWER AND STRICTER THAN COLLAPSE. Going back up on the first
 *     good second would oscillate, and an oscillating frame rate is more
 *     visible to a watcher than a low steady one. Up needs a higher bar held
 *     for longer.
 */

/** A rung is a RATE now, and nothing else. */
export interface LadderRung {
  label: string
  fps: number
}

/**
 * The rates a struggling take may move between, richest first.
 *
 * THE FLOOR IS 30 AND IT IS ROBERT'S: "but not less than 30 fps i guess". So
 * there are exactly two rungs and the ladder is 60 ⇄ 30. A take that cannot
 * hold 30 has nothing here to give — which is the world this product lived in
 * before 60 fps existed at all, and the watchdog is still what answers it.
 *
 * Two rungs is not a small ladder, it is the whole range: 30 is the floor of
 * the product and 60 is its ceiling, so this can always return a struggling
 * take to exactly what it asked for.
 */
export const RATE_RUNGS = [60, 30] as const

/** Below this share of the frames that arrived, encoding is failing rather than varying. */
export const DELIVERY_FLOOR_RATIO = 0.6
/**
 * Rule 5: recovery needs delivery this close to what arrived. Deliberately far
 * above the floor — the gap between the two is what stops the ladder hunting.
 */
export const RECOVERY_RATIO = 0.95
/** Rule 2: nothing is judged until the encoder has produced output for this long. */
export const WARMUP_MS = 4_000
/**
 * Rule 2's UPPER BOUND. "An encoder that has not produced yet is initialising"
 * was written with no ceiling, so INITIALISING and NEVER GOING TO PRODUCE
 * ANYTHING were the same state forever — and this ladder, the thing that exists
 * to rescue the second one, was switched off by the first. Measured on prod:
 * a 3456x2234@60 composite encoded ZERO frames, `firstOutputAtMs` stayed null
 * for the whole take, and the watchdog killed the composite at 15 s having
 * never once consulted this file.
 *
 * It sits just under that 15 s and no lower: at 6 s it fired on a 2560x1440@60
 * take measured to keep 81 % of its frames, and cut it to 132 frames from 508.
 */
export const DEAD_ENCODER_MS = 12_000
/** Rule 3: after a step either way, wait this long before judging the result. */
export const SETTLE_MS = 3_000
/** How long delivery must stay under the floor before stepping down. */
export const SUSTAINED_MS = 2_000
/** Rule 5: how long delivery must stay healthy before stepping back up. */
export const RECOVERY_MS = 6_000

/**
 * The rates this take can move between, richest first.
 *
 * Capped at what the take actually asked for — a 30 fps take never climbs to
 * 60, because 60 was never recorded and the encoder was not configured for it.
 */
export function rungsFor(requestedFps: number): LadderRung[] {
  const top = Math.max(30, Math.round(requestedFps))
  return RATE_RUNGS.filter((r) => r <= top).map((fps) => ({ label: `${fps} fps`, fps }))
}

export interface LadderInput {
  nowMs: number
  /** performance.now() when the composite started. */
  startedAtMs: number
  /** First real (non-keep-alive) encoder output, or null if none yet. */
  firstOutputAtMs: number | null
  /** When the last step was applied, either direction, or null. */
  lastStepAtMs: number | null
  /** How long encoding has continuously failed to keep up with arrivals, ms. */
  underFloorForMs: number
  /** How long encoding has continuously kept up comfortably, ms (rule 5). */
  aboveRecoveryForMs: number
  /** Real (non-keep-alive) frames per second that reached the encoder recently. */
  deliveredFps: number
  /**
   * Frames per second that ARRIVED from the sources recently. This is the
   * ruler (rule 4): a static screen reads 0 here and is left alone, however
   * far below the current rate it sits.
   */
  arrivedFps: number
  /** The rate the take was started at — the ceiling this ladder may climb to. */
  requestedFps: number
  /** The rate currently being asked of the source. */
  currentFps: number
}

export interface LadderVerdict {
  rung: LadderRung
  direction: 'down' | 'up'
  reason: string
}

/**
 * Should this take change rate, and to what? null = stay where you are, which
 * is the answer in every case the ladder is not certain about.
 */
export function ladderVerdict(input: LadderInput): LadderVerdict | null {
  const rungs = rungsFor(input.requestedFps)
  const at = rungs.findIndex((r) => r.fps === input.currentFps)
  const index = at >= 0 ? at : 0
  // Rule 3: let a step settle before judging its result, in either direction.
  if (input.lastStepAtMs !== null && input.nowMs - input.lastStepAtMs < SETTLE_MS) return null

  // Rule 2: an encoder that has not produced yet is initialising, not failing —
  // until it has been silent longer than any initialisation takes, at which
  // point it is failing in the loudest way available.
  const firstOutputAtMs = input.firstOutputAtMs
  const silent = firstOutputAtMs === null
  if (firstOutputAtMs === null) {
    if (input.nowMs - input.startedAtMs < DEAD_ENCODER_MS) return null
  } else if (input.nowMs - firstOutputAtMs < WARMUP_MS) return null

  // Rule 4: demand is what arrived, capped at what is currently being asked for
  // (the cadence gate drops the excess on purpose — that is not failure). Zero
  // demand means the source sent nothing, and a source that sent nothing
  // because nothing changed has not failed.
  const demandFps = Math.min(input.arrivedFps, input.currentFps)
  if (!(demandFps > 0)) return null
  const ratio = input.deliveredFps / demandFps

  // ---- DOWN -----------------------------------------------------------------
  if (ratio < DELIVERY_FLOOR_RATIO && input.underFloorForMs >= SUSTAINED_MS) {
    const next = rungs[index + 1]
    if (next) {
      return {
        rung: next,
        direction: 'down',
        reason: silent
          ? `the encoder has produced NOTHING in ${Math.round(input.nowMs - input.startedAtMs)} ms ` +
            `while ${demandFps.toFixed(1)} fps arrived → ${next.label}`
          : `encoded ${input.deliveredFps.toFixed(1)} of ${demandFps.toFixed(1)} arriving fps ` +
            `(${Math.round(ratio * 100)} % kept) for ${Math.round(input.underFloorForMs)} ms → ${next.label}`,
      }
    }
    return null
  }

  // ---- UP (rule 5) ----------------------------------------------------------
  // Never from silence: an encoder that has produced nothing has proved
  // nothing, and climbing on that would be climbing on no evidence at all.
  if (silent) return null
  if (ratio >= RECOVERY_RATIO && input.aboveRecoveryForMs >= RECOVERY_MS) {
    const back = rungs[index - 1]
    if (back) {
      return {
        rung: back,
        direction: 'up',
        reason:
          `encoded ${input.deliveredFps.toFixed(1)} of ${demandFps.toFixed(1)} arriving fps ` +
          `(${Math.round(ratio * 100)} % kept) for ${Math.round(input.aboveRecoveryForMs)} ms → ${back.label}`,
      }
    }
  }
  return null
}
