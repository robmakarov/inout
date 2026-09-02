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
 *
 *     RULE 5 WAS OVERRULED IN ITS SECOND HALF (E2, and it is Robert's ruling of
 *     2026-09-02): "elastic purpose more to go up when possible than down,
 *     going down is compromise that we must try to prevent whenever possible".
 *     Up is now FAST — two clear readings, ~500 ms — and the oscillation rule 5
 *     was written about is answered by a different mechanism instead: a climb
 *     that fails is not repeated at the same speed (CLIMB_BACKOFF below), so
 *     the first recovery is immediate and a machine that is genuinely loaded
 *     stops being asked every half second. Nothing was traded away; the cost
 *     was moved off the take that recovers and onto the take that cannot.
 *
 *  8. THE PICTURE MOVES LAST, AND ONLY AT `critical` (E2, Robert 2026-09-02).
 *     "Down exists only to prevent loss and its trigger is DISTANCE TO LOSS
 *     (queue about to overflow on the next tick), not busy." `serious` means
 *     heading for trouble and it now buys exactly one thing: the unseen work
 *     is shed (core/backgroundWork.ts). The frame rate is the LAST dial and it
 *     may not move until (a) the reading is `critical`, (b) what is critical is
 *     THIS TAKE'S OWN work rather than the machine at large, and (c) the unseen
 *     work has already been shed. Each of the three is checked, none is assumed
 *     from the levels lining up, and each refusal is reported.
 *
 *  9. A WRONG READING MAY NOT PIN A TAKE (E2). Every veto in this file used to
 *     be able to hold a take at half its rate for as long as the reading stayed
 *     bad — an hour of Robert's take, for a detector that only has to be wrong
 *     once. So the ladder PROBES upward on a timer no reading can veto. The
 *     probe costs, at worst, one step pair; being wrong without it costs the
 *     whole take.
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
 * `critical` means strain >= 1.0 — at or past the point where the encoder
 * starts refusing frames — and waiting to confirm THAT is waiting for the thing
 * to happen. Measured on this machine 2026-09-01: three separate idle cells,
 * ~350 samples, and the worst strain a HEALTHY 60 fps take ever produced was
 * 0.303, while the loaded phase of the same rig sat at a median of 2.85. A
 * single critical sample is 3.3x anything a well take has been seen to do, and
 * the collapse it reports is 163 ms from its first lost frame — there is no
 * room in that for a confirmation window.
 *
 * The cost if it is ever wrong is bounded and self-correcting: half the frame
 * rate for one settle plus one recovery, after which the ladder climbs back.
 *
 * E2 NOTE: `PREDICT_SUSTAINED_MS` above is now unreachable from the DOWN path —
 * `serious` no longer moves the picture at all (rule 8), so the only predictive
 * step is the immediate one. It is kept, exported and tested because it is the
 * window the UNSEEN work is shed over, and because M1 inherits the ladder.
 */
export const PREDICT_CRITICAL_MS = 0
/**
 * Rule 6's up-path (E2) — how long pressure must show headroom before climbing.
 *
 * 250 ms is ONE CONFIRMING SAMPLE and not a waiting period: the compositor
 * posts a reading every 250 ms, so the first clear sample starts the clock and
 * the second one climbs. The step therefore lands ~500 ms after the load lifts,
 * which is what E2's gate asks for ("up within 600 ms of headroom") and as
 * close to Robert's "immediately" as a 250 ms instrument can be.
 *
 * WHY NOT ZERO: a single clear reading is one quarter-second, and the same file
 * refuses to act on one bad quarter-second in the other direction unless it is
 * `critical`. Two samples costs 250 ms and rules out the reading that flickers
 * clear between two loaded ones.
 */
export const PRESSURE_CLEAR_MS = 250
/**
 * A CLIMB THAT FAILED IS NOT REPEATED AT THE SAME SPEED.
 *
 * This is what replaces rule 5's slowness. A climb is judged FAILED when the
 * ladder steps down again within this long of stepping up — the headroom the
 * reading showed was not real. Each consecutive failure doubles the clear
 * window (250 → 500 → 1000 → …, capped), so the first recovery is immediate for
 * the take that genuinely recovered, and a machine still under load is not
 * asked twice a second. One good climb resets it.
 */
export const FAILED_CLIMB_MS = 5_000
export const CLIMB_BACKOFF_MAX_MS = 8_000

export function clearWindowMs(failedClimbs: number): number {
  return Math.min(CLIMB_BACKOFF_MAX_MS, PRESSURE_CLEAR_MS * 2 ** Math.max(0, failedClimbs))
}
/**
 * RULE 9 — THE PROBE. No reading may hold a take down for longer than this.
 *
 * Every up-path condition in this file is a veto that a wrong reading can hold
 * shut. This is the one that cannot be held: this long after the last step,
 * with the take below the rate it asked for, the ladder climbs regardless of
 * what anything says. If the machine really is loaded, the next `critical`
 * sample steps it straight back and the cost is one step pair per probe; if the
 * detector was wrong, the take gets its rate back instead of spending an hour
 * at half of it.
 *
 * 15 s and not 20: E2's gate is "a wrong reading cannot hold a take down > 20
 * s", and a probe at 15 s plus this file's 3 s settle is 18 s worst case.
 */
export const PROBE_UP_AFTER_MS = 15_000

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
  /**
   * E2 — the same reading restricted to THIS TAKE'S OWN work (pressure.ts's
   * `ownLevel`). Rule 8(b): the frame rate answers to this and not to
   * `pressureLevel`, because halving it cannot relieve a machine that is
   * critical because of another window. Null when there is no reading.
   */
  pressureOwnLevel: PressureLevel | null
  /**
   * E2, rule 8(c) — has the unseen work already been given up?
   *
   * TRUE also when there is nothing to shed (the background brake is off, or no
   * background job exists), because "shed what is free first" cannot mean "and
   * if there is nothing free, never protect the take". What it forbids is the
   * ordering being wrong, not the layer being empty.
   */
  unseenWorkShed: boolean
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
  /** The hardware block the leading signal was about, for the certification. */
  pressureBlock: string | null
  /**
   * E2, rule 5's replacement — how many climbs in a row have been undone by a
   * step down within FAILED_CLIMB_MS. Widens the clear window; one climb that
   * holds resets it to zero.
   */
  failedClimbs: number
}

export interface LadderVerdict {
  rung: LadderRung
  direction: 'down' | 'up'
  reason: string
  /**
   * Which half of rule 6 produced this. 'predicted' = the leading signals moved
   * it before any frame was lost; 'measured' = the delivery floor, i.e. the
   * autopsy backstop; 'probe' = rule 9, the climb no reading may veto. Carried
   * so a handoff can say which one actually fires on a real machine instead of
   * assuming the new path did.
   */
  from: 'predicted' | 'measured' | 'probe'
  /** E2 — the hardware block whose strain decided a DOWN step, when the reading
   *  named one. Null on the autopsy path and on every climb. */
  block?: string
}

/**
 * WHY THE PICTURE WAS NOT MOVED, when something was heading for trouble but one
 * of rule 8's three conditions was not met. Returned to the caller so a refusal
 * can be certified: "the ladder held at 60 because the unseen work had not been
 * shed yet" is a fact about the ordering, and a silent null is not.
 */
export type LadderHold =
  | 'not-serious'
  | 'serious-but-not-critical'
  | 'not-our-work'
  | 'unseen-work-still-running'
  | 'at-the-floor'

/** The verdict AND, when there is none, why the picture was held still. */
export interface LadderDecision {
  verdict: LadderVerdict | null
  hold: LadderHold | null
}

/**
 * Should this take change rate, and to what? null = stay where you are, which
 * is the answer in every case the ladder is not certain about.
 *
 * `ladderDecision` is the same answer with the REFUSAL attached — E2 needs it,
 * because "the ladder did not step because the unseen work was still running"
 * is the ordering ruling being obeyed, and a silent null cannot be certified.
 */
export function ladderVerdict(input: LadderInput): LadderVerdict | null {
  return ladderDecision(input).verdict
}

export function ladderDecision(input: LadderInput): LadderDecision {
  const none = (hold: LadderHold | null = null): LadderDecision => ({ verdict: null, hold })
  const rungs = rungsFor(input.requestedFps)
  const at = rungs.findIndex((r) => r.fps === input.currentFps)
  const index = at >= 0 ? at : 0
  // Rule 3: let a step settle before judging its result, in either direction.
  if (input.lastStepAtMs !== null && input.nowMs - input.lastStepAtMs < SETTLE_MS) return none()

  // Rule 2: an encoder that has not produced yet is initialising, not failing —
  // until it has been silent longer than any initialisation takes, at which
  // point it is failing in the loudest way available.
  const firstOutputAtMs = input.firstOutputAtMs
  const silent = firstOutputAtMs === null
  if (firstOutputAtMs === null) {
    if (input.nowMs - input.startedAtMs < DEAD_ENCODER_MS) return none()
  } else if (input.nowMs - firstOutputAtMs < WARMUP_MS) return none()

  // Rule 4: demand is what arrived, capped at what is currently being asked for
  // (the cadence gate drops the excess on purpose — that is not failure). Zero
  // demand means the source sent nothing, and a source that sent nothing
  // because nothing changed has not failed.
  const demandFps = Math.min(input.arrivedFps, input.currentFps)
  if (!(demandFps > 0)) return none()
  const ratio = input.deliveredFps / demandFps
  const down = rungs[index + 1]
  const back = rungs[index - 1]

  // ---- DOWN (rule 6 first, then rule 4's autopsy) ---------------------------
  // The prediction goes FIRST because that is the whole of E1: if the leading
  // signals are already certain, waiting for the delivery floor is waiting for
  // the loss this step exists to prevent.
  //
  // E2's RULE 8 IS ENFORCED HERE, AS THREE SEPARATE CONDITIONS, because the
  // ordering has to be a mechanism and not an emergent property of where the
  // bands happen to sit. A refusal FALLS THROUGH rather than returning: rule 9's
  // probe lives at the bottom of this function and a reading stuck at `serious`
  // must not be able to skip it. That was the shape of the bug this task was
  // written to remove.
  let hold: LadderHold | null = null
  if (input.pressureLevel !== null && atLeast(input.pressureLevel, 'serious')) {
    if (!down) {
      // At the floor already: there is no rung left to give, and saying so is
      // more useful than silently returning null forever.
      hold = 'at-the-floor'
    } else if (input.pressureLevel !== 'critical') {
      // (a) `critical` ONLY. `serious` buys the unseen shed and nothing else.
      hold = 'serious-but-not-critical'
    } else if (input.pressureOwnLevel !== null && input.pressureOwnLevel !== 'critical') {
      // (b) …and critical about OUR OWN WORK. A machine that is critical
      //     because of another window is not answered by halving the take.
      hold = 'not-our-work'
    } else if (!input.unseenWorkShed) {
      // (c) …and only after the free things have already gone.
      hold = 'unseen-work-still-running'
    } else if (input.pressureSeriousForMs >= PREDICT_CRITICAL_MS) {
      return {
        hold: null,
        verdict: {
          rung: down,
          direction: 'down',
          from: 'predicted',
          ...(input.pressureBlock ? { block: input.pressureBlock } : null),
          reason:
            `pressure critical (${input.pressureWhy ?? 'no leader'}) with the unseen work ` +
            `already shed — stepping BEFORE frames are lost → ${down.label}`,
        },
      }
    }
  } else if (input.pressureLevel !== null) {
    hold = 'not-serious'
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
    //
    // E2 RAISED THAT SECOND OPINION FROM `fair` TO `serious`, and it is the same
    // ruling as rule 8: "going down is compromise that we must try to prevent
    // whenever possible", and `fair` is this machine's STEADY STATE with three
    // encoders open — it is not evidence of anything. A take that is genuinely
    // losing 40 % of its frames for two seconds shows it in the encoder: a
    // dropped frame forces `critical` by itself (pressure.ts's loss floor), and
    // a full queue, a long encode or stale arrivals each reach `serious` well
    // before that. A delivery collapse the detector reads as merely `fair` is
    // E1's measured false positive — encoder queue 0.00 of 6, latency 15.9 ms
    // of a 100 ms pipeline, ZERO frames dropped — and stepping for it cost that
    // take half its rate for nothing. With `?pressure=0` there is no second
    // opinion to raise and this branch is byte-for-byte the ladder that shipped
    // (rule 9's probe is the one thing that is new in both modes, and all it can
    // ever do is give a rate BACK).
    if (input.pressureLevel !== null && !atLeast(input.pressureLevel, 'serious')) {
      hold = hold ?? 'not-serious'
    } else if (down) {
      return {
        hold: null,
        verdict: {
          rung: down,
          direction: 'down',
          from: 'measured',
          reason: silent
            ? `the encoder has produced NOTHING in ${Math.round(input.nowMs - input.startedAtMs)} ms ` +
              `while ${demandFps.toFixed(1)} fps arrived → ${down.label}`
            : `encoded ${input.deliveredFps.toFixed(1)} of ${demandFps.toFixed(1)} arriving fps ` +
              `(${Math.round(ratio * 100)} % kept) for ${Math.round(input.underFloorForMs)} ms → ${down.label}`,
        },
      }
    } else {
      hold = 'at-the-floor'
    }
  }

  // ---- UP ------------------------------------------------------------------
  // Never from silence: an encoder that has produced nothing has proved
  // nothing, and climbing on that would be climbing on no evidence at all.
  if (silent || !back) return none(hold)

  // RULE 9 — THE PROBE, FIRST, AND NO READING MAY VETO IT.
  //
  // It is deliberately above every condition below, because every condition
  // below is a veto. The one thing it will not climb into is MEASURED, ONGOING
  // loss: `underFloorForMs` is the delivery ruler saying frames are being lost
  // right now, which is not a reading that might be wrong. Everything else —
  // a level stuck at `serious`, a `fair` that never clears, a detector with a
  // hole in it — is exactly what this exists to escape.
  //
  // It probes only what THIS LADDER lowered (`lastStepAtMs`): a take sitting
  // below its requested rate for any other reason was not put there by a
  // reading, so there is no wrong reading to escape.
  const sinceStepMs = input.nowMs - (input.lastStepAtMs ?? input.nowMs)
  if (input.lastStepAtMs !== null && sinceStepMs >= PROBE_UP_AFTER_MS && input.underFloorForMs === 0) {
    return {
      hold: null,
      verdict: {
        rung: back,
        direction: 'up',
        from: 'probe',
        reason:
          `${Math.round(sinceStepMs / 1000)} s below the requested rate — probing back up. ` +
          `A reading may not hold a take down (pressure ${input.pressureLevel ?? 'unread'}) → ${back.label}`,
      },
    }
  }

  if (ratio < RECOVERY_RATIO) return none(hold)

  // SYMMETRY WITH RULE 7. The delivery ruler reads HEALTHY at a reduced rate
  // almost by definition — the encoder is coping with half the frames — so on
  // its own it climbs back into a load that never went away. Measured: a
  // control take went down at 17.0 s, UP at 24.0 s WHILE STILL LOADED, and down
  // again at 27.0 s. So the reading, when there is one, still has a veto:
  // never climb while pressure is at or above `serious`.
  if (input.pressureLevel !== null && atLeast(input.pressureLevel, 'serious')) return none(hold)

  // E2's up-path: as soon as the tick shows headroom, ADDITIVELY, one rung.
  // The window is one confirming sample wide and widens only for a take whose
  // last climbs were undone (clearWindowMs) — rule 5's slowness, spent on the
  // take that cannot recover instead of the one that can.
  const window = clearWindowMs(input.failedClimbs)
  const clear = input.pressureLevel !== null && input.pressureClearForMs >= window
  if (!clear && input.aboveRecoveryForMs < RECOVERY_MS) return none(hold)

  return {
    hold: null,
    verdict: {
      rung: back,
      direction: 'up',
      from: clear ? 'predicted' : 'measured',
      reason: clear
        ? `pressure clear for ${Math.round(input.pressureClearForMs)} ms (needed ${window}) ` +
          `and ${Math.round(ratio * 100)} % of ${demandFps.toFixed(1)} fps kept → ${back.label}`
        : `encoded ${input.deliveredFps.toFixed(1)} of ${demandFps.toFixed(1)} arriving fps ` +
          `(${Math.round(ratio * 100)} % kept) for ${Math.round(input.aboveRecoveryForMs)} ms → ${back.label}`,
    },
  }
}
