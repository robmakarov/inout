/**
 * THE RECOVERY RITUAL FOR A WEDGED SCREEN SHARE (Robert 2026-08-25: "if it
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
/**
 * The notice is OWED, not merely recent (Robert 2026-08-25: after a wedge with a
 * 4K game running, "no message about that i need to reload chrome"). It used to
 * be due only within 15 s of the stamp — but the wedge happens when the machine
 * is saturated, which is exactly when the reload it triggers takes longest to
 * boot. A boot slower than the window dropped the message silently, so the one
 * case that most needs explaining was the one case that never got it. Now the
 * flag is consumed rather than timed: shown exactly once, however slow the boot.
 */
const NOTICE_KEY = 'inout.wedgeReload.notice.v1'
/** A second wedge inside this window means the refresh did not cure it. It also
 *  bounds the owed notice — a reload that never commits must not surprise the
 *  user with "the app refreshed itself" ten minutes later. */
export const WEDGE_RELOAD_WINDOW_MS = 2 * 60_000

function readStamp(key: string = KEY): number {
  try {
    return Number(sessionStorage.getItem(key) ?? 0) || 0
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
    sessionStorage.setItem(NOTICE_KEY, String(now))
  } catch {
    /* storage refused — the ritual degrades to showing the error text */
  }
}

/**
 * At boot: did this page reload itself over a wedge? Returns true ONCE and
 * clears the debt, so a remount cannot repeat it and a slow boot cannot lose
 * it. The reload stamp itself is deliberately left alone — it is what makes the
 * NEXT wedge show the ⌘Q text instead of reloading again.
 */
export function takeWedgeReloadNotice(now = Date.now()): boolean {
  const at = readStamp(NOTICE_KEY)
  if (!at) return false
  try {
    sessionStorage.removeItem(NOTICE_KEY)
  } catch {
    /* cannot clear — the bound below still stops it repeating forever */
  }
  return now - at < WEDGE_RELOAD_WINDOW_MS
}
