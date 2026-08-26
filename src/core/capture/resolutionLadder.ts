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
 */

export interface LadderRung {
  label: string
  width: number
  height: number
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

/** Below this share of the requested rate, delivery is failing rather than varying. */
export const DELIVERY_FLOOR_RATIO = 0.6
/** Rule 2: nothing is judged until the encoder has produced output for this long. */
export const WARMUP_MS = 4_000
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
  /** How long delivery has been continuously under the floor, ms. */
  underFloorForMs: number
  /** Frames per second delivered recently. */
  deliveredFps: number
  /** Frames per second the take asked for. */
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
  if (input.stepsTaken >= DEGRADE_RUNGS.length) return null
  // Rule 2: an encoder that has not produced yet is initialising, not failing.
  if (input.firstOutputAtMs === null) return null
  if (input.nowMs - input.firstOutputAtMs < WARMUP_MS) return null
  // Rule 3: let a step settle before judging its result.
  if (input.lastStepAtMs !== null && input.nowMs - input.lastStepAtMs < SETTLE_MS) return null
  if (input.underFloorForMs < SUSTAINED_MS) return null
  if (!(input.requestedFps > 0)) return null
  const ratio = input.deliveredFps / input.requestedFps
  if (ratio >= DELIVERY_FLOOR_RATIO) return null
  const rung = DEGRADE_RUNGS[input.stepsTaken]!
  return {
    rung,
    reason:
      `delivered ${input.deliveredFps.toFixed(1)} of ${input.requestedFps} fps ` +
      `(${Math.round(ratio * 100)} % of requested) for ${Math.round(input.underFloorForMs)} ms → ${rung.label}`,
  }
}
