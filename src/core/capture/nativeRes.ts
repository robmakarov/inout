/**
 * Capture at the source's own resolution (task O6), opt-in.
 *
 * CAPTURE_MAX_* (1080p30) is the 2026-08-22 freeze fix, and it is blunt: a 4K
 * surface was being paid for four times over on one GPU, so the cap stopped
 * that — and cost every 1440p and 4K user their resolution whether or not their
 * machine could have kept up. O6's answer is to start at native and step DOWN
 * on measured backpressure (captureLadder.ts) rather than never start high.
 *
 * IT WAS ON BY DEFAULT FOR ONE DAY, 2026-08-29, ON ROBERT'S RULING: "we need native
 * res by default of course, why the fuck not, IF FREEZE WILL APPEAR I WILL SAY."
 *
 * THE FREEZE APPEARED AND HE SAID, the same day: a 60 fps game in another tab,
 * "some movement on record but after a while freezes and whole screen, not just
 * this tab". It went off by default for an hour — and he ruled on that too:
 * "i need native resolution and 60 fps work, and not freezing, no turning it
 * off." So it is ON, and the cost was taken out of the capture instead: native
 * resolution now means EVERYTHING THE PRODUCT CAN EXPORT (2560 long edge, the
 * largest quality step) rather than the monitor's own size. His 3024x1964
 * screen was 5.9 Mpx of which 4.25 could ever reach a file; the rest was
 * encoded, written and discarded. See CAPTURE_MAX_LONG_EDGE in acquire.ts.
 *
 * WHAT HIS OWN CONSOLE SHOWED, and it is why the cap is the right answer rather
 * than another guard: the screen was captured at 3024x1964 (5.9 Mpx) while
 * THREE hardware AVC encoders ran at once — the raw screen channel at level
 * 5.1, the raw camera channel, and the composite — with a game rendering on the
 * same GPU. The source delivered 15-21 fps of the 30 it was asked for, and the
 * degradation ladder stepped the TRACK to 1440p without helping, because the
 * raw channel's encoder is configured at start and cannot follow: his log reads
 * `screen channel recorded 3024x1964 (the track said 2217x1440)`, i.e. after
 * the step Chrome was UPSCALING every frame back to 3024x1964. The step bought
 * nothing and added work. That is filed; the cap is what stops the collapse
 * happening in the first place.
 *
 * That overrides the caution this file shipped with, and the caution was real:
 * O6's own gate wanted "Robert's 4K-game-tab scenario re-verified", and 2026-08-26
 * measured why no rig can stand in for it — a synthetic 4K source is a
 * rAF-painted canvas, so its delivered fps is dominated by the painting, a cost
 * a real 4K display (which the OS composites) does not have. The ladder is
 * tested at its boundaries; the thing it protects still cannot be tested here.
 * What changed is who carries that risk: Robert has taken it, explicitly, and is
 * the reporting channel if the freeze returns.
 *
 * WHAT IT ACTUALLY BUYS, so the expectation is right: the export ladder's 1440p
 * step was an UPSCALE of a 1080p capture, spending 14 Mbps on interpolated
 * pixels. With this on, a 1440p or 4K screen is captured at its own size and
 * that step is real detail. The composite stays 1920x1080 (its canvas is fixed,
 * and it is what the DEFAULT 1080p step packet-copies), so the default export
 * is unchanged — this only reaches the steps that re-render.
 *
 * THE LADDER IS THE SAFETY NET, not this flag: captureLadder.ts watches
 * delivered fps and steps 4K -> 1440p -> 1080p before delivery collapses,
 * one rung at a time, never back up.
 *
 *   ?nativeres=1   (this load only — the source's own resolution)
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
  return fromSearch() ?? fromStorage() ?? true
}

export function setNativeRes(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}
