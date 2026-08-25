/**
 * SERIALIZE SCREEN-SHARE REQUESTS AGAINST THE PREVIOUS SHARE'S RELEASE.
 *
 * PO 2026-08-25, the stress test that reproduced the wedge at will: "connect
 * screen, 2 seconds recording, back and again 10 times — it happens again."
 * Rapid record/stop cycles are exactly the case where a NEW getDisplayMedia
 * can go out while Chrome's browser process is still tearing down the LAST
 * share — our own stop path deliberately keeps the display track alive while
 * it starves and drains the recorder (P0-tail-raw), so a fast re-record races
 * that teardown. The wedge itself lives in Chrome and cannot be fixed here;
 * this removes the one overlap the page actually controls and spaces the
 * requests Chrome sees.
 *
 * Every delivered display track is registered; before the next share request
 * is dispatched, the caller waits — bounded — until no registered track is
 * live and a grace gap has passed since the last one ended. On a first take,
 * or a normal-paced retake, the check is a synchronous no-op and the request
 * still fires in the same tick as the click.
 */

/** Breathing room between the last share's release and the next request.
 * Not measured against Chrome's internals (they are not observable); sized to
 * be invisible in a normal retake — stop → editor → back → record is already
 * seconds — and only ever felt in a deliberate rapid-fire cycle. */
export const DISPLAY_RELEASE_GRACE_MS = 800
/** Never hold a click hostage: if the previous share has not released by this
 * deadline, dispatch anyway — a possibly-wedged request beats a dead button. */
export const DISPLAY_RELEASE_BUDGET_MS = 3_000
/** How fast a manual track.stop() is noticed ('ended' never fires for it). */
const PRUNE_INTERVAL_MS = 250

const live = new Set<MediaStreamTrack>()
/** performance.now() when the registry last became empty. 0 = never held one. */
let lastEndedAt = 0
let poller: ReturnType<typeof setInterval> | null = null

function prune(now: number): void {
  for (const t of live) if (t.readyState === 'ended') live.delete(t)
  if (live.size === 0 && poller) {
    clearInterval(poller)
    poller = null
    lastEndedAt = now
  }
}

export function trackDisplayCapture(track: MediaStreamTrack): void {
  if (track.readyState === 'ended') return
  live.add(track)
  // 'ended' does not fire for the page's own stop() calls (per spec), so the
  // registry polls itself while it holds anything. Self-terminating.
  poller ??= setInterval(() => prune(performance.now()), PRUNE_INTERVAL_MS)
}

/** True when a new share request can be dispatched untouched — the common
 * case, and the synchronous fast path that keeps the same-tick dispatch. */
export function displayCaptureClear(now = performance.now()): boolean {
  prune(now)
  if (live.size > 0) return false
  return lastEndedAt === 0 || now - lastEndedAt >= DISPLAY_RELEASE_GRACE_MS
}

/** Resolves true once clear, false when the budget ran out (dispatch anyway). */
export async function awaitDisplayCaptureClear(
  budgetMs = DISPLAY_RELEASE_BUDGET_MS,
): Promise<boolean> {
  const t0 = performance.now()
  if (displayCaptureClear(t0)) return true
  for (;;) {
    await new Promise((r) => setTimeout(r, 100))
    const now = performance.now()
    if (displayCaptureClear(now)) return true
    if (now - t0 >= budgetMs) return false
  }
}

/** Test seam. */
export function resetDisplayReleaseForTests(): void {
  live.clear()
  if (poller) clearInterval(poller)
  poller = null
  lastEndedAt = 0
}
