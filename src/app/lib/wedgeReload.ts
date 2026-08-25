/**
 * THE RECOVERY RITUAL FOR A WEDGED SCREEN SHARE (PO 2026-08-25: "if it
 * happens make it fixed by refresh of app page"). When Chrome takes the share
 * and never delivers it, the take has already failed and every device is
 * released — so the app refreshes ITSELF, once, and comes back saying "press
 * record to try again": a fresh renderer with fresh pipes to Chrome's capture
 * service, at the cost of reloading a screen that holds no state. A wedge
 * that recurs right after that refresh gets no second reload — at that point
 * the stuck claim is in Chrome's browser process and only ⌘Q clears it, so
 * the session's own error text (which says exactly that) is shown instead.
 *
 * sessionStorage on purpose: the ritual's memory should die with the tab —
 * a fresh tab deserves a fresh first refresh.
 */

const KEY = 'inout.wedgeReload.v1'
/** A second wedge inside this window means the refresh did not cure it. */
export const WEDGE_RELOAD_WINDOW_MS = 2 * 60_000
/** How fresh the stamp must be for the boot notice to show. */
export const WEDGE_NOTICE_WINDOW_MS = 15_000

function readStamp(): number {
  try {
    return Number(sessionStorage.getItem(KEY) ?? 0) || 0
  } catch {
    return 0
  }
}

/** May the app auto-refresh for this wedge? False = show the ⌘Q text instead. */
export function shouldReloadForWedge(now = Date.now()): boolean {
  const at = readStamp()
  return !(at && now - at < WEDGE_RELOAD_WINDOW_MS)
}

export function noteWedgeReload(now = Date.now()): void {
  try {
    sessionStorage.setItem(KEY, String(now))
  } catch {
    /* storage refused — the ritual degrades to showing the error text */
  }
}

/** At boot: did this page just reload itself over a wedge? Show the notice. */
export function wedgeReloadNoticeDue(now = Date.now()): boolean {
  const at = readStamp()
  return !!at && now - at < WEDGE_NOTICE_WINDOW_MS
}
