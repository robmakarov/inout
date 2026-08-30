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
 * NOTHING STEPS DOWN IN MAX, including the rate ladder (Robert: "max must not
 * have ladder"). So max has to not NEED stepping down, which is a load problem
 * and is answered by opening fewer encoders rather than by throttling the take:
 * at native resolution the composite is not recorded at all, because it is a
 * downscaled second copy of a picture the take already has, made by a second
 * hardware encoder. See session.startComposite.
 *
 *   ?quality=max|auto     (this load only)
 *   localStorage['inout.capture.quality']   (sticky)
 */

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
 * DEFAULT IS `auto`, and it has to be: max is the mode where the app stops
 * protecting the machine, and that is a choice a user makes rather than one
 * they are given. A take recorded in auto is exactly the take this product
 * recorded yesterday.
 */
export function captureQualityMode(): CaptureQualityMode {
  return fromSearch() ?? override ?? fromStorage() ?? 'auto'
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
 * MAY THE RATE LADDER STEP WHILE THE TAKE RUNS? NOT IN MAX — Robert's ruling,
 * 2026-08-30: "max must not have ladder".
 *
 * I argued the other way and was overruled, and the argument is kept here
 * because the cost is real and someone will meet it: with nothing allowed to
 * give, the encoders drop whatever they cannot take, and DROPPED FRAMES ARE
 * UNEVEN. That is a slideshow where a lower rate would have been smooth — his
 * own third take, "exported video image has severe lags, both tab and camera,
 * slideshow, sound is fine".
 *
 * His answer is the better one and it is the harder one: if the ladder must not
 * rescue max, then max has to not need rescuing. That is a load problem, not a
 * policy problem, and it is fixed by opening fewer encoders — which is what
 * skipping the composite at native resolution does (session.startComposite).
 * A mode that survives because it was throttled was never max.
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
