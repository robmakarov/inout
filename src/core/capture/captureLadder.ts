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
 *  7. AN AUTOPSY NEEDS A SECOND OPINION (task E1). See rule 7 at the delivery
 *     floor below: delivery falling while the encoder is provably idle means
 *     the SOURCE slowed, and stepping the rate down cannot fix that.
 *
 *  6. PREDICT, DO NOT AUTOPSY (task E1). deliveredFps is a verdict on frames
 *     ALREADY LOST — by the time this file could read a collapse, the file has
 *     the hole in it. So the leading signals (core/pressure.ts: the encoder's
 *     own queue depth, its latency, and the compositing thread's scheduling
 *     lateness) get to move the ladder FIRST, and the delivery floor stays as
 *     the backstop for everything the detector does not see. The autopsy path
 *     below is unchanged, deliberately: `?pressure=0` turns the prediction off
 *     and the ladder is exactly the ladder that shipped.
 *
 *  5. RECOVERY IS SLOWER AND STRICTER THAN COLLAPSE. Going back up on the first
 *     good second would oscillate, and an oscillating frame rate is more
 *     visible to a watcher than a low steady one. Up needs a higher bar held
 *     for longer.
 */

import { atLeast, type PressureLevel } from '../pressure'

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
 * Rule 6 — how long the leading signals must agree before a PREDICTIVE step.
 *
 * Four pressure samples (the worker posts one every 250 ms). One bad quarter
 * second is a keyframe or a window being dragged; four in a row is a machine.
 * Deliberately far below SUSTAINED_MS: the autopsy path has to wait 2 s for
 * proof of loss, and the whole point of this one is that it does not.
 */
export const PREDICT_SUSTAINED_MS = 750
/**
 * …AND `critical` DOES NOT WAIT AT ALL.
 *
 * `serious` means heading for trouble, so it is confirmed over four samples.
 * `critical` means strain >= 1.0 — at or past the point where the encoder
 * starts refusing frames — and waiting 750 ms to confirm THAT is waiting for
 * the thing to happen. Measured on this machine 2026-09-01: three separate
 * idle cells, ~350 samples, and the worst strain a HEALTHY 60 fps take ever
 * produced was 0.303, while the loaded phase of the same rig sat at a median of
 * 2.85. A single critical sample is 3.3x anything a well take has been seen to
 * do, and the collapse it reports is 163 ms from its first lost frame — there
 * is no room in that for a confirmation window.
 *
 * The cost if it is ever wrong is bounded and self-correcting: half the frame
 * rate for one settle plus one recovery, after which the ladder climbs back.
 */
export const PREDICT_CRITICAL_MS = 0
/**
 * Rule 6's up-path — how long pressure must read nominal before climbing.
 *
 * Robert: "i want it to go back to max smoothly as suffering eases
 * immediately". RECOVERY_MS is 6 s because delivery alone is weak evidence: a
 * healthy ratio at a low rate says the encoder is coping with LESS, not that
 * the machine is free. Pressure says the second thing directly, so with it the
 * climb needs less waiting — but it still needs BOTH, because a detector that
 * says nominal while frames are being lost is a detector with a hole in it.
 */
export const PRESSURE_CLEAR_MS = 2_500
/**
 * …AND THE VETO CANNOT HOLD FOREVER.
 *
 * The up-path's pressure veto is the one part of E1 that can make a take WORSE
 * than the ladder that shipped: before it, delivery healthy for RECOVERY_MS
 * climbed, full stop. Now a reading stuck at `serious` keeps a take at half its
 * rate indefinitely — and "indefinitely" is an hour of Robert's take, for a
 * detector that only has to be wrong once.
 *
 * So after three RECOVERY_MS of unbroken healthy delivery the ladder climbs
 * anyway and lets the detector step it straight back down if it was right. The
 * cost of being wrong that way is one step pair every ~20 s; the cost of the
 * veto being wrong without this is the whole take. Robert's own words decide
 * which is worse — "i want it to go back to max smoothly as suffering eases".
 */
export const VETO_MAX_MS = RECOVERY_MS * 3

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
  /**
   * Rule 6 — the leading reading for the interval just ended, or null when the
   * detector is off or has nothing to report. Null makes this file behave
   * exactly as it did before E1.
   */
  pressureLevel: PressureLevel | null
  /** How long pressure has been continuously at or above `serious`, ms. */
  pressureSeriousForMs: number
  /**
   * How long pressure has been continuously BELOW `serious`, ms.
   *
   * Below serious and not `nominal`, and the difference is the whole rule.
   * Measured in the real app 2026-09-01: a 1080p60 take with three encoders
   * open reads `fair` in its STEADY STATE on this machine — 20.2 ms of work per
   * 16.7 ms frame under load, and still above half a frame budget once the load
   * lifts. Requiring `nominal` to climb meant a take that stepped down never
   * came back up, which is worse than the hunting it was written to stop.
   */
  pressureClearForMs: number
  /** The leading signal's own words, for the reason line. */
  pressureWhy: string | null
}

export interface LadderVerdict {
  rung: LadderRung
  direction: 'down' | 'up'
  reason: string
  /**
   * Which half of rule 6 produced this. 'predicted' = the leading signals moved
   * it before any frame was lost; 'measured' = the delivery floor, i.e. the
   * autopsy backstop. Carried so a handoff can say which one actually fires on
   * a real machine instead of assuming the new path did.
   */
  from: 'predicted' | 'measured'
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

  // ---- DOWN (rule 6 first, then rule 4's autopsy) ---------------------------
  // The prediction goes FIRST because that is the whole of E1: if the leading
  // signals are already certain, waiting for the delivery floor is waiting for
  // the loss this step exists to prevent.
  const predictAfterMs =
    input.pressureLevel === 'critical' ? PREDICT_CRITICAL_MS : PREDICT_SUSTAINED_MS
  if (
    input.pressureLevel !== null &&
    atLeast(input.pressureLevel, 'serious') &&
    input.pressureSeriousForMs >= predictAfterMs
  ) {
    const next = rungs[index + 1]
    if (next) {
      return {
        rung: next,
        direction: 'down',
        from: 'predicted',
        reason:
          `pressure ${input.pressureLevel} for ${Math.round(input.pressureSeriousForMs)} ms ` +
          `(${input.pressureWhy ?? 'no leader'}) — stepping BEFORE frames are lost → ${next.label}`,
      }
    }
    // At the floor already: there is no rung left to give, and saying so is
    // more useful than silently returning null forever.
    return null
  }

  if (ratio < DELIVERY_FLOOR_RATIO && input.underFloorForMs >= SUSTAINED_MS) {
    // RULE 7, AND IT IS A CORRECTION TO RULE 4 RATHER THAN A NEW IDEA (E1).
    //
    // "A source that sent NOTHING did not fail" only ever covered zero. A source
    // that HALVED did fail this file, and it is not the encoder's fault: demand
    // sums every source's arrivals, so a 60 fps screen beside a 30 fps camera
    // makes `demand` 60 while the composite can only ever encode as fast as the
    // screen delivers. Measured 2026-09-01 on a take under pure CPU load — the
    // ladder stepped 60 → 30 reading "encoded 34.0 of 60.0 arriving fps (57 %
    // kept)" while the SAME take's encoder queue was 0.00 of 6, its encode
    // latency 15.9 ms of a 100 ms pipeline, and it dropped ZERO frames. The
    // step was useless (the source was the limit, not the rate asked of it) and
    // it cost the take half its frame rate for nothing.
    //
    // So the autopsy now needs a second opinion, and only when there IS one:
    // null (detector off, or nothing readable) leaves this branch exactly as it
    // shipped. A reading of `nominal` is the encoder saying it is not the
    // problem, and a rate step cannot fix a problem the encoder does not have.
    if (input.pressureLevel !== null && !atLeast(input.pressureLevel, 'fair')) return null
    const next = rungs[index + 1]
    if (next) {
      return {
        rung: next,
        direction: 'down',
        from: 'measured',
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
  if (ratio < RECOVERY_RATIO) return null
  const back = rungs[index - 1]
  if (!back) return null

  // SYMMETRY WITH RULE 7, and it is the fix for the last of the hunting. The
  // delivery ruler reads HEALTHY at a reduced rate almost by definition — the
  // encoder is coping with half the frames — so on its own it climbs back into
  // a load that never went away. Measured: a control take went down at 17.0 s,
  // UP at 24.0 s WHILE STILL LOADED, and down again at 27.0 s.
  //
  // So the reading, when there is one, has a veto: never climb while pressure
  // is at or above `serious`, and not for PRESSURE_CLEAR_MS after it last was.
  // The bar is "below serious", NOT "nominal" — see pressureClearForMs.
  const vetoExpired = input.aboveRecoveryForMs >= VETO_MAX_MS
  if (!vetoExpired) {
    if (input.pressureLevel !== null && atLeast(input.pressureLevel, 'serious')) return null
    if (input.pressureLevel !== null && input.pressureClearForMs < PRESSURE_CLEAR_MS) return null
  }

  // Rule 6's up-path: pressure clear AND delivery healthy climbs sooner than
  // delivery alone. Never pressure alone — a detector that reads clear while
  // frames are being lost would climb straight back into the loss.
  const clear =
    input.pressureLevel !== null && input.aboveRecoveryForMs >= PRESSURE_CLEAR_MS
  if (!clear && input.aboveRecoveryForMs < RECOVERY_MS) return null

  return {
    rung: back,
    direction: 'up',
    from: clear ? 'predicted' : 'measured',
    reason:
      `encoded ${input.deliveredFps.toFixed(1)} of ${demandFps.toFixed(1)} arriving fps ` +
      `(${Math.round(ratio * 100)} % kept) for ${Math.round(input.aboveRecoveryForMs)} ms` +
      (clear
        ? ` and pressure clear for ${Math.round(input.pressureClearForMs)} ms`
        : '') +
      ` → ${back.label}`,
  }
}
