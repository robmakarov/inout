/**
 * ONE OUTSTANDING SCREEN REQUEST PER DOCUMENT — the hole under every "it wedged
 * again, and again, and again".
 *
 * A wedged getDisplayMedia never resolves AND never rejects. Our budgets give
 * up on it (30 s), release every device and fail the take — but the PROMISE is
 * still pending, and so is the request behind it: Chrome's browser process
 * still has an open device request booked against THIS RenderFrame, and the
 * page has no way to cancel it. There is no abort signal on getDisplayMedia.
 *
 * So the next press used to dispatch a SECOND request into a frame that
 * already had a stuck one. That is the shape of Robert's evening, 2026-08-30 —
 * four presses, four stalls, "waiting for screen", once "waiting for screen and
 * microphone", ⌘Q in between and no change. The mic in that second one is the
 * same defect seen from the side: a stuck screen request holds up the frame's
 * other device requests, and our own mic clock does not even start until the
 * display promise settles.
 *
 * WHAT THIS MODULE DOES IS REFUSE TO MAKE THAT CALL. A document that already
 * has a screen request outstanding cannot make a working one — the only reset
 * available to a page is to stop being that document, i.e. reload. So the
 * press fails INSTANTLY with its own reason ('stale'), the app refreshes, and
 * the retry runs in a frame with nothing stuck in it. Instant beats 30 s of
 * "Waiting for screen…" that could not have worked.
 *
 * This is not the fail-fast dodge (Robert's ruling: devices must connect, not
 * fail faster). Nothing that could have connected is given up: the call this
 * removes is the one that was provably going to stall. What replaces it is the
 * one action that restores a frame able to connect.
 *
 * Per-document by construction — module state dies with the document, which is
 * exactly the lifetime of the stuck request it tracks. Nothing is persisted.
 */

/**
 * OUTSTANDING IS NOT THE SAME AS STUCK, and only stuck is poison. A picker the
 * user is still reading is outstanding; so is one they abandoned when they
 * cancelled the arm, and that request rejects the moment Chrome closes it. If
 * mere outstanding-ness blocked the next press, cancel-then-record — an
 * ordinary thing to do — would refresh the app for no reason. Only a request
 * that OUR OWN BUDGET has already given up on, and which Chrome still has not
 * settled, is the one that can never come back.
 */
interface DisplayRequest {
  settled: boolean
  stuck: boolean
}

const requests: DisplayRequest[] = []

/**
 * Register a raw getDisplayMedia promise. Must be the RAW one, not a
 * withTimeout wrapper: the wrapper settles at the deadline while the request
 * behind it stays open, and it is the request this counts. The returned handle
 * is how the deadline says "this one is dead" — call `stuck()` from the
 * timeout path, and if Chrome ever does settle it, that is undone.
 */
export function markDisplayRequest(p: Promise<unknown>): { stuck: () => void } {
  const req: DisplayRequest = { settled: false, stuck: false }
  requests.push(req)
  const settled = (): void => {
    req.settled = true
    // A request that came back — even hours late, even to be thrown away — is
    // no longer holding this frame's queue.
    for (let i = requests.length - 1; i >= 0; i--) if (requests[i]?.settled) requests.splice(i, 1)
  }
  p.then(settled, settled)
  return {
    stuck: () => {
      req.stuck = true
    },
  }
}

/** True when this document has a screen request it gave up on that Chrome has
 *  still never settled — the frame that cannot ask again. */
export function displayRequestOutstanding(): boolean {
  return requests.some((r) => r.stuck && !r.settled)
}

/** Test seam — module state outlives test cases. */
export function resetDisplayInflightForTests(): void {
  requests.length = 0
}
