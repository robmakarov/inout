/**
 * Capture at the source's own resolution (task O6), opt-in.
 *
 * CAPTURE_MAX_* (1080p30) is the 2026-08-22 freeze fix, and it is blunt: a 4K
 * surface was being paid for four times over on one GPU, so the cap stopped
 * that — and cost every 1440p and 4K user their resolution whether or not their
 * machine could have kept up. O6's answer is to start at native and step DOWN
 * on measured backpressure (resolutionLadder.ts) rather than never start high.
 *
 * IT IS ON BY DEFAULT SINCE 2026-08-29, ON PO'S RULING: "we need native res by
 * default of course, why the fuck not, if freeze will appear i will say."
 *
 * That overrides the caution this file shipped with, and the caution was real:
 * O6's own gate wanted "PO's 4K-game-tab scenario re-verified", and 2026-08-26
 * measured why no rig can stand in for it — a synthetic 4K source is a
 * rAF-painted canvas, so its delivered fps is dominated by the painting, a cost
 * a real 4K display (which the OS composites) does not have. The ladder is
 * tested at its boundaries; the thing it protects still cannot be tested here.
 * What changed is who carries that risk: PO has taken it, explicitly, and is
 * the reporting channel if the freeze returns.
 *
 * WHAT IT ACTUALLY BUYS, so the expectation is right: the export ladder's 1440p
 * step was an UPSCALE of a 1080p capture, spending 14 Mbps on interpolated
 * pixels. With this on, a 1440p or 4K screen is captured at its own size and
 * that step is real detail. The composite stays 1920x1080 (its canvas is fixed,
 * and it is what the DEFAULT 1080p step packet-copies), so the default export
 * is unchanged — this only reaches the steps that re-render.
 *
 * THE LADDER IS THE SAFETY NET, not this flag: resolutionLadder.ts watches
 * delivered fps and steps 4K -> 1440p -> 1080p before delivery collapses,
 * one rung at a time, never back up.
 *
 *   ?nativeres=0   (this load only — back to the 1080p cap)
 *   localStorage['inout.capture.nativeres'] = '0'   (sticky)
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
  return fromSearch() ?? fromStorage() ?? true
}

export function setNativeRes(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}
