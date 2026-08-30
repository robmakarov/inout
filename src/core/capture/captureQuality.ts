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
 *   max   The take is protected from the machine. Nothing steps down and
 *         nothing is refused: the source's own resolution and its own rate,
 *         for the whole take, and the cost is the user's to pay. This is the
 *         mode behind "i need 3024x1964/60fps … we need to make it work".
 *
 * WHAT MAX HONESTLY COSTS, because a mode that hides its price is a lie. With
 * nothing allowed to give, a machine that cannot keep up DROPS FRAMES — and a
 * dropped frame is a worse artefact than a lower rate, because it is uneven.
 * So max is not "better quality" unconditionally; it is "the quality you asked
 * for, or a visible failure, and never a quiet substitution". The take must say
 * which it got, which is why the drop counters are reported rather than hidden.
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

/** Nothing may step down, and nothing may be refused for being too much. */
export function qualityDropsAllowed(): boolean {
  return captureQualityMode() !== 'max'
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
