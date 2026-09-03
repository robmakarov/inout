/**
 * THE FLOOR'S BOOKKEEPING — task M1, and it is deliberately thin.
 *
 * Everything about WHEN a take should give something up already exists and is
 * measured: captureLadder.ts's warmup, settle, sustain, climb-backoff and probe
 * rules, and core/pressure.ts's reading. This class does not re-decide any of
 * it. It holds the running state those rules need (how long delivery has been
 * under the floor, how long pressure has been clear, when the last step was),
 * feeds `ladderDecision` exactly what liveCompositeV2 feeds it, and turns the
 * DIRECTION of the answer into a RUNG through emergencyFloor.ts's order.
 *
 * WHY IT EXISTS AT ALL, given the composite already runs a ladder: max opens no
 * composite. There is no compositor worker at max — two raw encoders and
 * nothing else — so the thread that owns the readings is rawVideo.worker.ts and
 * the loop that consumes them cannot be inside a file that only runs when there
 * is a composite. The DECISION is shared (one `ladderDecision`, one
 * `readPressure`, one sampler); the plumbing is not, because the two engines
 * are shaped differently.
 *
 * IT ALSO GIVES MAX ITS LAYER ONE. E2's order of defence sheds the unseen work
 * first, and the broker that does it is driven by `noteTakePressure` — which,
 * at max, nothing was calling, because the only caller was the compositor. So a
 * max take under load never shed a background render before losing frames. With
 * the floor armed it does, and that happens here, BEFORE any picture rung is
 * considered.
 */
import {
  DELIVERY_FLOOR_RATIO,
  FAILED_CLIMB_MS,
  RECOVERY_RATIO,
  ladderDecision,
  type LadderHold,
  type LadderStepMeta,
} from './captureLadder'
import { noteTakePressure, backgroundPaceEnabled, currentPace } from '../backgroundWork'
import { readPressure, type HardwareBlock, type PressureLevel, type PressureSignals } from '../pressure'
import { FLOOR_FPS, nextRestore, nextSacrifice, type FloorRung, type FloorState } from './emergencyFloor'

export interface FloorAction {
  rung: FloorRung
  direction: 'down' | 'up'
  reason: string
  /** Everything the door's line needs, in the ladder's own vocabulary. */
  step: LadderStepMeta
}

export interface FloorTick {
  action: FloorAction | null
  /** Why the picture was NOT moved, when something was heading for trouble.
   *  `nothing-left` is this class's own: the ladder said step and the order had
   *  no rung to give. */
  hold: LadderHold | 'nothing-left' | null
  level: PressureLevel | null
  ownLevel: PressureLevel | null
}

export class FloorController {
  private readonly startedAtMs: number
  private readonly requestedFps: number
  private firstOutputAtMs: number | null = null
  private lastStepAtMs: number | null = null
  private lastUpAtMs: number | null = null
  private failedClimbs = 0
  private underFloorSince: number | null = null
  private aboveRecoverySince: number | null = null
  private seriousSince: number | null = null
  private clearSince: number | null = null
  private lastDeliveredFps = 0
  private lastArrivedFps = 0
  private level: PressureLevel | null = null
  private ownLevel: PressureLevel | null = null
  private why: string | null = null
  private block: HardwareBlock | null = null

  constructor(opts: { startedAtMs: number; requestedFps: number }) {
    this.startedAtMs = opts.startedAtMs
    this.requestedFps = opts.requestedFps
  }

  /**
   * One reading from the raw encoder's worker. Returns what should move, or
   * null — which is the answer in every case the rules are not certain about.
   */
  tick(nowMs: number, signals: PressureSignals, state: FloorState): FloorTick {
    const reading = readPressure(signals)
    // LAYER ONE FIRST, ALWAYS, and it is not conditional on anything below: the
    // unseen work is shed by the broker on this reading, and the picture rungs
    // underneath refuse to move until it has been (rule 8(c)).
    noteTakePressure(reading)

    // Delivery, from the same window the signals describe. `arrivals` is null
    // when nothing arrived at all — a static screen — and that is health, not
    // collapse (captureLadder rule 4), so the ladder is given a zero demand and
    // leaves the take alone.
    const arrivals = signals.arrivals ?? 0
    const delivered = Math.max(0, arrivals - (signals.dropped ?? 0))
    const perSecond = 1000 / Math.max(1, signals.intervalMs)
    this.lastArrivedFps = arrivals * perSecond
    this.lastDeliveredFps = delivered * perSecond
    if (this.firstOutputAtMs === null && delivered > 0) this.firstOutputAtMs = nowMs

    const demand = Math.min(this.lastArrivedFps, state.screenFps)
    const ratio = demand > 0 ? this.lastDeliveredFps / demand : 1
    if (demand > 0 && ratio < DELIVERY_FLOOR_RATIO) this.underFloorSince ??= nowMs
    else this.underFloorSince = null
    if (demand > 0 && ratio >= RECOVERY_RATIO) this.aboveRecoverySince ??= nowMs
    else this.aboveRecoverySince = null

    if (reading.blind) {
      this.level = null
      this.ownLevel = null
      this.block = null
      this.seriousSince = null
      this.clearSince = null
    } else {
      this.level = reading.level
      this.ownLevel = reading.ownLevel
      this.block = reading.leader?.block ?? null
      /**
       * THE REASON HAS TO NAME WHAT ACTUALLY FIRED. `leader` is the worst
       * SIGNAL, and pressure.ts has a second way to reach `critical`: the loss
       * floor, where a frame was already dropped this interval. Measured on the
       * M1 rig 2026-09-03, a screen rate step reported "worker-lateness:
       * 0.47 ms mean tick against a 16.7 ms frame" — a healthy-looking number —
       * when what had actually forced the level was 4 dropped frames. A ledger
       * line that names the wrong cause is worse than a quiet one.
       */
      const dropped = signals.dropped ?? 0
      this.why =
        dropped > 0 && (reading.leader?.strain ?? 0) < 1
          ? `${dropped} frame(s) already dropped this interval`
          : reading.leader
            ? `${reading.leader.signal}: ${reading.leader.detail}`
            : null
      if (reading.level === 'serious' || reading.level === 'critical') {
        this.seriousSince ??= nowMs
        this.clearSince = null
      } else {
        this.seriousSince = null
        this.clearSince ??= nowMs
      }
    }

    const base = {
      nowMs,
      startedAtMs: this.startedAtMs,
      firstOutputAtMs: this.firstOutputAtMs,
      lastStepAtMs: this.lastStepAtMs,
      underFloorForMs: this.underFloorSince === null ? 0 : nowMs - this.underFloorSince,
      aboveRecoveryForMs: this.aboveRecoverySince === null ? 0 : nowMs - this.aboveRecoverySince,
      deliveredFps: this.lastDeliveredFps,
      arrivedFps: this.lastArrivedFps,
      requestedFps: this.requestedFps,
      currentFps: state.screenFps,
      pressureLevel: this.level,
      pressureOwnLevel: this.ownLevel,
      // E2 rule 8(c): TRUE when there is nothing to shed, because "shed what is
      // free first" cannot mean "and if there is nothing free, never protect
      // the take".
      unseenWorkShed: !backgroundPaceEnabled() || currentPace() !== 'full',
      pressureSeriousForMs: this.seriousSince === null ? 0 : nowMs - this.seriousSince,
      pressureClearForMs: this.clearSince === null ? 0 : nowMs - this.clearSince,
      pressureWhy: this.why,
      pressureBlock: this.block,
      failedClimbs: this.failedClimbs,
    }
    let { verdict, hold } = ladderDecision(base)

    /**
     * THE SAME POLICY, ASKED ABOUT A LADDER THAT IS WIDER THAN IT KNOWS.
     *
     * `ladderDecision` reasons about ONE dial — the screen's rate, 60 ⇄ 30 —
     * because that is the only dial the composite has. The floor's ladder has
     * the camera above it and the size below it, so the two ends of the rate
     * ladder are not the ends of this one: `at-the-floor` means "the RATE has
     * nothing left", and a take whose rate is already home may still have a
     * size to give back.
     *
     * Rather than re-implement rule 8 (critical · our own work · unseen work
     * already shed) or the climb windows out here — which is how a second
     * elastic system gets born — the same function is asked again with the rate
     * moved to the end that leaves room in the direction being considered. Only
     * the DIRECTION of its answer is used; the rung comes from the order.
     */
    if (!verdict && hold === 'at-the-floor') {
      // The RATE has nothing left. That is not the same as the take having
      // nothing left — the size is still below it.
      if (!nextSacrifice(state)) {
        return { action: null, hold: 'nothing-left', level: this.level, ownLevel: this.ownLevel }
      }
      ;({ verdict, hold } = ladderDecision({ ...base, currentFps: base.requestedFps }))
    } else if (!verdict && state.screenFps >= state.screenRequestedFps && nextRestore(state)) {
      // The rate is home and something else is still spent (the size, or the
      // camera — neither of which the rate ladder can see). The `hold` from the
      // real ask is discarded on purpose: it is a statement about the DOWN
      // path, and this ask is about the up one.
      ;({ verdict, hold } = ladderDecision({ ...base, currentFps: FLOOR_FPS }))
    }

    if (!verdict) return { action: null, hold, level: this.level, ownLevel: this.ownLevel }

    const rung =
      verdict.direction === 'down' ? nextSacrifice(state) : nextRestore(state)
    if (!rung) {
      // The ladder says move and the order has nothing left. Reported, not
      // swallowed: "the floor was at the bottom" and "the floor never engaged"
      // are different takes and they used to look identical.
      return { action: null, hold: 'nothing-left', level: this.level, ownLevel: this.ownLevel }
    }

    const previousFps =
      rung === 'camera-fps' ? (state.cameraFps ?? 0) : rung === 'screen-fps' ? state.screenFps : 0
    return {
      action: {
        rung,
        direction: verdict.direction,
        reason: verdict.reason,
        step: {
          direction: verdict.direction,
          previousFps,
          block: (verdict.block as HardwareBlock | undefined) ?? this.block,
          level: this.level,
        },
      },
      hold: null,
      level: this.level,
      ownLevel: this.ownLevel,
    }
  }

  /**
   * A rung actually moved. Kept here because the climb-backoff rule (E2's
   * replacement for rule 5's slowness) is about the interval between a climb
   * and the step that undid it, and that interval ends at the ACT.
   */
  noteApplied(nowMs: number, direction: 'down' | 'up'): void {
    if (direction === 'down') {
      if (this.lastUpAtMs !== null && nowMs - this.lastUpAtMs < FAILED_CLIMB_MS) this.failedClimbs++
    } else {
      if (this.lastUpAtMs !== null && nowMs - this.lastUpAtMs >= FAILED_CLIMB_MS) this.failedClimbs = 0
      this.lastUpAtMs = nowMs
    }
    this.lastStepAtMs = nowMs
    this.underFloorSince = null
    this.aboveRecoverySince = null
    this.seriousSince = null
    this.clearSince = null
  }
}
