/**
 * THE EMERGENCY FLOOR — task M1, the behavioural half, and it ships OFF.
 *
 * WHAT IT IS FOR. Max is the mode where nothing steps down: "max must not have
 * ladder" (Robert, 2026-08-30), and the answer to a max take that cannot keep
 * up is supposed to be that max needs fewer encoders, not a smaller picture.
 * That holds right up until the machine actually runs out — and then a max take
 * loses frames unevenly, which is the slideshow Robert reported on his own
 * third take. The floor is the thing that catches THAT, and only that: it is
 * armed only in max, only behind its flag, and it does nothing at all until the
 * detector says starvation is COMING.
 *
 * WHAT MAKES IT DIFFERENT FROM THE LADDER, which is why it is a separate file
 * and not a branch in captureLadder.ts: the ladder answers WHEN (and it still
 * does here — the floor asks `ladderDecision` exactly as the composite does, so
 * there is one set of timing rules, one warmup, one settle, one probe). This
 * file answers WHAT GIVES, in an ORDER, and the order is the ruling:
 *
 *   composite (there is none at max) → camera fps → screen fps 60→30 →
 *   resolution LAST.  AUDIO IS NEVER SACRIFICED.
 *
 * WHY THAT ORDER, since an order is a claim: the camera is an inset a fraction
 * of the frame wide, so halving its rate costs a fraction of a fraction of what
 * the take is about; the screen's rate is the one dial Robert has already
 * accepted moving (60⇄30, "not less than 30 fps i guess"); and resolution is
 * last because it is the thing max exists to buy — a max take that quietly
 * became 1440p is not a max take, and the resolution rung also costs a segment
 * seam (O16: 30 ms step, 69 ms seam) that the rate rungs do not.
 *
 * LIKE WATER (DECISIONS robert (12)), and the honest version of it: the smooth
 * dials are spent first and the chunky one last. Rate is quantized by physics —
 * a 60 Hz source samples evenly only at its divisors, and 57 fps is three
 * unevenly dropped frames a second, which reads as judder and looks WORSE than
 * a clean 30 — so "continuous" cannot mean the rate. What it means here is that
 * everything cheaper than the rate goes before it: the unseen work (layer one,
 * core/backgroundWork.ts, which at max had nothing sampling for it until this
 * task lifted the sampler into rawVideo.worker.ts) and the encoder's burst
 * absorber (layer two) both act before this file is ever consulted.
 *
 * RECOVERY IS THE SAME LIST, BACKWARDS. Whatever was given up last is taken
 * back first, one rung per settle, on the ladder's own up-path — so a spike
 * that lifts leaves the take back at max within seconds, and the take says so.
 */
import { evenDown } from '@core/frame'

/**
 * ON — Robert flipped it 2026-09-03, and the words are the reason it is not a
 * mode: "it must be fucking same elastic shit we have for everything else now,
 * it is just turned off for max to test it".
 *
 * So this is not an emergency mode bolted onto max. It is THE elastic system —
 * the same detector, the same sampler, the same ladder rules, the same ledger —
 * finally reaching the one place that had none, because max opens no composite
 * and the composite was where all of it lived. The flag remains as the runtime
 * fallback the frozen rule requires, and as the A/B control any measurement of
 * it needs.
 *
 * WHAT IT COSTS A TAKE THAT NEVER NEEDS IT, measured before the flip (the rig's
 * `calm` lane, 45 s at 2560x1440@60 with it armed): no rung taken, one screen
 * segment, 60 fps throughout, and the only lines in the ledger are the ones
 * every take writes. The instrument itself is a 16 ms ticker in the worker that
 * is already encoding — the same one the compositor has run since E1.
 *
 *   ?floor=0      (this load only — max exactly as it shipped: no sampler at
 *                  all, nothing steps, frames drop where they fall)
 *   localStorage['inout.capture.floor']   (sticky)
 */
const FLAG_KEY = 'inout.capture.floor'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('floor')
  return v === '1' ? true : v === '0' ? false : null
}

function fromStorage(): boolean | null {
  try {
    const v = localStorage.getItem(FLAG_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

let override: boolean | null = null

export function emergencyFloorEnabled(): boolean {
  return fromSearch() ?? override ?? fromStorage() ?? true
}

export function setEmergencyFloor(on: boolean | null): void {
  override = on
  try {
    if (on === null) localStorage.removeItem(FLAG_KEY)
    else localStorage.setItem(FLAG_KEY, on ? '1' : '0')
  } catch {
    /* memory-only */
  }
}

/**
 * MAY THE FLOOR SPEND THE SIZE? `?floorres=1`, OFF EVEN NOW THAT THE FLOOR IS
 * ON, and there are now two reasons rather than one.
 *
 * THE RULING (Robert 2026-09-03, flipping the floor on): "it must be fucking
 * same elastic shit we have for everything else now". Everywhere else the
 * elastic system moves the RATE and never the size — captureLadder's rule 1,
 * from his own 2026-08-29 words: "if something needs to be dropped it must be
 * fps not resolution", "no screen proportion changes". Same system means the
 * same dial, so the size rung is not part of what was turned on.
 *
 * AND THE MEASUREMENT, which said the same thing first.
 *
 * The rate rungs cost nothing but rate: the file keeps one geometry and the
 * encoder keeps its configuration. The resolution rung cannot — a raw encoder
 * is configured once and a frame size cannot change mid-file, so the size moves
 * by CLOSING the segment and opening the next (O16), and closing a segment
 * means draining an encoder that is, by definition, behind.
 *
 * MEASURED ON THE M1 RIG, 2026-09-03, 2560x1440@60 with an encoder load:
 *   · the step down, taken while the machine was critical — a 5,047 ms seam.
 *     Five seconds of screen that is not in the file.
 *   · the step back up, taken once the load had lifted — a 30 ms seam, exactly
 *     O16's own band (30 ms step, 69 ms seam), on the same take.
 * So the seam is not the mechanism's cost, it is the LOAD's cost, and it lands
 * on the one take that could least afford it. The rung stays built, tested and
 * in the order — resolution is still LAST and still what a machine that cannot
 * hold its plan gives up — but until the drain is fixed it is not something to
 * turn on by default underneath another default-off flag.
 *
 * The same run also failed to show it EARNING that seam: the size step landed
 * at 19.0 s and the load lifted at 24.0 s, so what recovered the take cannot be
 * told apart from the spike ending. A rung that costs five seconds needs its
 * own evidence before it is spent.
 */
const RES_FLAG_KEY = 'inout.capture.floorres'

function resFromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('floorres')
  return v === '1' ? true : v === '0' ? false : null
}

function resFromStorage(): boolean | null {
  try {
    const v = localStorage.getItem(RES_FLAG_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

let resOverride: boolean | null = null

export function floorResolutionRungEnabled(): boolean {
  return resFromSearch() ?? resOverride ?? resFromStorage() ?? false
}

export function setFloorResolutionRung(on: boolean | null): void {
  resOverride = on
  try {
    if (on === null) localStorage.removeItem(RES_FLAG_KEY)
    else localStorage.setItem(RES_FLAG_KEY, on ? '1' : '0')
  } catch {
    /* memory-only */
  }
}

/** The dials, in the order they are given up. Audio is not on this list and
 *  there is no code path that could put it there. */
export type FloorRung = 'camera-fps' | 'screen-fps' | 'resolution'

export const SACRIFICE_ORDER: readonly FloorRung[] = ['camera-fps', 'screen-fps', 'resolution']

/**
 * THE RATE FLOOR IS 30, AND IT IS ROBERT'S ("but not less than 30 fps i
 * guess"). Both rate rungs are 60 → 30 for the same reason the ladder's are:
 * two rungs is not a small ladder, it is the whole range between this product's
 * floor and its ceiling.
 */
export const FLOOR_FPS = 30

/**
 * ONE RESOLUTION STEP, AND ONLY ONE (enforced in `nextSacrifice`, not merely
 * intended). Three quarters of the long edge is 56 % of
 * the pixels — enough to matter to an encoder that is drowning, small enough
 * that a take does not come back unrecognisable — and it never goes below
 * 1280, because under that the take has stopped being worth protecting.
 *
 * A step is even on both sides: AVC subsamples chroma by two and REFUSES an odd
 * side rather than rounding (acquire.ts's scar).
 */
export const RESOLUTION_STEP = 0.75
export const RESOLUTION_FLOOR_LONG_EDGE = 1280

export function floorLongEdge(current: number): number | null {
  const next = evenDown(Math.round(current * RESOLUTION_STEP))
  if (next < RESOLUTION_FLOOR_LONG_EDGE || next >= current) return null
  return next
}

export interface FloorState {
  /** The camera's current rate, and what it started at. Null with no camera. */
  cameraFps: number | null
  cameraRequestedFps: number | null
  /** The screen's current rate, and what the take asked for. */
  screenFps: number
  screenRequestedFps: number
  /** The screen's current long edge, and the take's own. */
  screenLongEdge: number | null
  screenRequestedLongEdge: number | null
}

/**
 * WHAT GIVES NEXT, or null when there is nothing left to give.
 *
 * Null is a real answer and is reported rather than swallowed: a take at 30 fps
 * on both channels and one resolution step down has nothing this file can do
 * for it, and saying so is how the report card can tell "the floor held" apart
 * from "the floor never engaged".
 */
export function nextSacrifice(s: FloorState): FloorRung | null {
  if (s.cameraFps !== null && s.cameraFps > FLOOR_FPS) return 'camera-fps'
  if (s.screenFps > FLOOR_FPS) return 'screen-fps'
  // ONE RESOLUTION STEP PER TAKE, and the state itself is what says whether it
  // has been taken: a take already below the size it was recorded at has spent
  // this rung. A second step would be a second segment seam (O16: 69 ms of
  // screen that is not in the file) for a take that has already proved it
  // cannot carry its plan — and it is the rung max exists to buy, so the floor
  // spends it once and then honestly has nothing left.
  const stepped =
    s.screenLongEdge !== null &&
    s.screenRequestedLongEdge !== null &&
    s.screenLongEdge < s.screenRequestedLongEdge
  if (
    floorResolutionRungEnabled() &&
    !stepped &&
    s.screenLongEdge !== null &&
    floorLongEdge(s.screenLongEdge) !== null
  ) {
    return 'resolution'
  }
  return null
}

/**
 * WHAT COMES BACK NEXT — the same list, backwards, so the last thing given up
 * is the first thing returned. A take that lost its resolution to a spike gets
 * its resolution back before its camera's smoothness, because that is the order
 * they were worth.
 */
export function nextRestore(s: FloorState): FloorRung | null {
  // NOTE THE ASYMMETRY, AND IT IS DELIBERATE: `floorResolutionRungEnabled()` is
  // not consulted here. A size that was given up is always taken back, whatever
  // the flag says now — "capacity knowledge may shape a take UP, never down".
  // A flag flipped mid-take could otherwise strand a take at three quarters of
  // the picture the user asked for.
  if (
    s.screenLongEdge !== null &&
    s.screenRequestedLongEdge !== null &&
    s.screenLongEdge < s.screenRequestedLongEdge
  ) {
    return 'resolution'
  }
  if (s.screenFps < s.screenRequestedFps) return 'screen-fps'
  if (s.cameraFps !== null && s.cameraRequestedFps !== null && s.cameraFps < s.cameraRequestedFps) {
    return 'camera-fps'
  }
  return null
}

/** True when this take is at its full plan — nothing is currently given up. */
export function atFullPlan(s: FloorState): boolean {
  return nextRestore(s) === null
}
