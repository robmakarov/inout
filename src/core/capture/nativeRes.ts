/**
 * Capture at the source's own resolution (task O6), opt-in.
 *
 * CAPTURE_MAX_* (1080p30) is the 2026-08-22 freeze fix, and it is blunt: a 4K
 * surface was being paid for four times over on one GPU, so the cap stopped
 * that — and cost every 1440p and 4K user their resolution whether or not their
 * machine could have kept up. O6's answer is to start at native and step DOWN
 * on measured backpressure (resolutionLadder.ts) rather than never start high.
 *
 * IT IS OFF BY DEFAULT, and this is the one place in the session where that is
 * not merely the frozen rule's caution. O6's OWN GATE says "PO's real
 * 4K-game-tab scenario re-verified", and 2026-08-26 measured why no rig can
 * stand in for that: a synthetic 4K source is a rAF-painted canvas, so its
 * delivered fps is dominated by the painting — a cost a real 4K display, which
 * the OS composites, does not have. The ladder is tested at its boundaries; the
 * thing it protects cannot be tested here.
 *
 *   ?nativeres=1   (this load only)
 *   localStorage['inout.capture.nativeres'] = '1'   (sticky)
 */

const STORAGE_KEY = 'inout.capture.nativeres'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('nativeres')
  return v === '1' ? true : v === '0' ? false : null
}

function fromStorage(): boolean | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/** True when this take should ask for the source's own resolution. */
export function nativeResEnabled(): boolean {
  return fromSearch() ?? fromStorage() ?? false
}

export function setNativeRes(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}
