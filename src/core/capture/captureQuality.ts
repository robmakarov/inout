/**
 * CAPTURE QUALITY MODE — Robert, 2026-08-30: "quality dropping must be one
 * mode, and it will be off for 'max' quality where user will pay for perfect
 * picture, so we need to make it work".
 *
 * Everything this product does to protect a take under load — captureLadder
 * stepping the frame RATE down, the arm-time refusal of a rate this machine
 * measured itself unable to carry, O15's earned encoder budget — is one
 * behaviour with one name, and it is a MODE rather than a law.
 *
 *   auto  (default, and what shipped before this file existed)
 *         The machine is protected from the take. The rate steps down when the
 *         encoder falls behind and climbs back when it eases; a rate the
 *         encoder measured itself unable to sustain is not attempted at all.
 *         Nothing the user chose is silently made smaller — the SIZE never
 *         moves, only the rate, which is Robert's own order of sacrifice ("if
 *         something needs to be dropped it must be fps not resolution").
 *
 *   max   Nothing is refused IN ADVANCE: the source's own resolution and its
 *         own rate are always attempted, whatever this machine measured itself
 *         able to sustain. This is the mode behind "i need 3024x1964/60fps …
 *         we need to make it work".
 *
 * NOTHING STEPS DOWN IN MAX TODAY, and that is a SWITCH POSITION, not a
 * property of max. Robert, 2026-09-03: "elastic must work for max, it is just
 * now turned off so we polish max without it" — and "until i say so". Elastic
 * is one system; max is inside it; the picture step is off there while max is
 * being polished, and only he moves it back. See `rateLadderAllowed` below,
 * which carries the correction in full because it has been misread twice.
 *
 * While it is off, max is meanwhile made to not NEED stepping down — a load
 * problem answered by opening fewer encoders rather than by throttling the
 * take: at native resolution the composite is not recorded at all, because it
 * is a downscaled second copy of a picture the take already has, made by a
 * second hardware encoder. See session.startComposite.
 *
 * WHICH MODE A TAKE IS IN IS THE SLIDER'S ANSWER (2026-09-03: "fucking max
 * slider must be max"). The flags below are the override, not the source.
 *
 *   ?quality=max|auto     (this load only)
 *   localStorage['inout.capture.quality']   (sticky)
 */

import { loadQualityStep } from '@core/qualityStep'

export type CaptureQualityMode = 'auto' | 'max'

const STORAGE_KEY = 'inout.capture.quality'

function isMode(v: string | null): v is CaptureQualityMode {
  return v === 'auto' || v === 'max'
}

function fromSearch(): CaptureQualityMode | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('quality')
  return isMode(v) ? v : null
}

function fromStorage(): CaptureQualityMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isMode(v) ? v : null
  } catch {
    return null
  }
}

let override: CaptureQualityMode | null = null

/**
 * THE SLIDER IS THE CHOICE. Robert, 2026-09-03: "fucking max slider must be
 * max" — said after B14 found that it was not.
 *
 * The default below used to be a flat `'auto'`, and the quality slider wrote
 * only `inout.quality.step`. Nothing outside the test panel ever called
 * `setCaptureQualityMode`, so a user who dragged the slider to Max got the max
 * RESOLUTION and the max RATE — `frame.sourceResEnabled()` and
 * `rate.sourceRateEnabled()` have defaulted from the step since UI1 — and none
 * of the max BEHAVIOUR. The take was still refusable before it started, which
 * is the arm-time refusal B14 is a whole task about, and the picture step was
 * still armed against the one mode Robert had switched it off for.
 *
 * That was an oversight and not a design: two of the three max defaults were
 * already wired to the step and this one was missed. It is the same sentence
 * the other two are built on — Robert, 2026-08-30: "max - maximum resolution,
 * 60 fps, all maximum" — and DECISIONS 2026-09-01 (2) says it as a ruling: "the
 * chosen quality is the recorded quality".
 *
 * `?quality=auto` still refuses it for one load, and the panel switch is
 * sticky, so the mode is still a thing that can be inspected and reverted on
 * its own. What changed is only what it answers when nobody has said.
 */
export function captureQualityMode(): CaptureQualityMode {
  return fromSearch() ?? override ?? fromStorage() ?? (loadQualityStep() === 'max' ? 'max' : 'auto')
}

/**
 * MAY A TAKE BE REFUSED, BEFORE IT STARTS, FOR BEING TOO MUCH? Off in max: the
 * user has said they will pay for the picture rather than be protected from
 * asking for it. This is the arm-time measurement and O15's earned budget.
 */
export function preemptiveRefusalAllowed(): boolean {
  return captureQualityMode() !== 'max'
}

/**
 * MAY THE RATE LADDER STEP WHILE THE TAKE RUNS? NOT IN MAX TODAY — and read the
 * next paragraph before writing a line about why, because two sessions in a row
 * have got it wrong in the same direction and Robert has corrected it twice.
 *
 * ELASTIC IS ONE SYSTEM AND IT COVERS MAX. It is TURNED OFF for max right now,
 * so that max can be polished without it, AND IT STAYS OFF UNTIL HE SAYS SO —
 * 2026-09-03, in his words: "elastic must work for max, it is just now turned
 * off so we polish max without it", "MAX ELASTIC OFF UNTIL I SAY SO", "until i
 * say so". That is a statement about a SWITCH and about WHO MOVES IT. It is not
 * a statement that max is a mode elastic does not reach, and it is not licence
 * to build max as a thing that has no elastic: DECISIONS 2026-09-03 robert (22)
 * already threw that reading out once, and 2026-09-01 (2) says where it ends up
 * — when max and elastic are both perfect they COMBINE, elastic becoming max's
 * emergency floor.
 *
 * So this is a switch and never a deleted branch. `?maxladder=1` turns the
 * picture step back on inside max without leaving max, and M1's floor
 * (`?floor=1`, emergencyFloor.ts) is the same system built for max and likewise
 * waiting on his word.
 *
 * THE COST OF IT BEING OFF IS REAL AND IS KEPT HERE so nobody rediscovers it as
 * a surprise: with nothing allowed to give, the encoders drop whatever they
 * cannot take, and DROPPED FRAMES ARE UNEVEN. That is a slideshow where a lower
 * rate would have been smooth — his own third take, "exported video image has
 * severe lags, both tab and camera, slideshow, sound is fine". Which is why max
 * is meanwhile made to not NEED rescuing, by opening fewer encoders rather than
 * by throttling: at native resolution the composite is not recorded at all
 * (session.startComposite). A mode that survives because it was throttled was
 * never max — but a mode that is never allowed to give anything back is one
 * spike from a slideshow, and that is what the switch above is for.
 */
export function rateLadderAllowed(): boolean {
  if (captureQualityMode() !== 'max') return true
  return maxLadderFromSearch() ?? maxLadderOverride ?? maxLadderFromStorage() ?? false
}

/**
 * THE LADDER IS STILL REACHABLE INSIDE MAX, IT IS JUST OFF — Robert, 2026-08-30:
 * "it must be possible there, but off for now". So this is a switch and not a
 * deleted branch: a machine that cannot be made to carry a take any other way
 * can still be told to trade rate for smoothness, without leaving max and
 * losing the resolution with it.
 *
 *   ?maxladder=1     (this load only)
 *   localStorage['inout.capture.maxladder']   (sticky)
 */
const MAX_LADDER_KEY = 'inout.capture.maxladder'

function maxLadderFromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('maxladder')
  return v === '1' ? true : v === '0' ? false : null
}

function maxLadderFromStorage(): boolean | null {
  try {
    const v = localStorage.getItem(MAX_LADDER_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

let maxLadderOverride: boolean | null = null

export function setMaxLadder(on: boolean | null): void {
  maxLadderOverride = on
  try {
    if (on === null) localStorage.removeItem(MAX_LADDER_KEY)
    else localStorage.setItem(MAX_LADDER_KEY, on ? '1' : '0')
  } catch {
    /* memory-only */
  }
}

export function setCaptureQualityMode(mode: CaptureQualityMode | null): void {
  override = mode
  try {
    if (mode === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* memory-only */
  }
}
