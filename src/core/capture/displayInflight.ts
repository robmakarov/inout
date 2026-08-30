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
 * TWO THINGS WERE MISSING FROM THAT, AND ROBERT FOUND BOTH IN ONE SENTENCE
 * (2026-08-30: "i tried to run record from two tabs at same time and wedge
 * happen ... and it happens after that too").
 *
 *   1. CHROME TAKES ONE SCREEN REQUEST AT A TIME. A second one dispatched
 *      while another is still unsettled does not queue politely — it hangs,
 *      which is the wedge, on demand. This module used to refuse only when a
 *      request was STUCK, i.e. when our own budget had already given up on it.
 *      A request that is merely pending — the picker is open, or the user
 *      cancelled the arm and Chrome kept the picker up — did not block
 *      anything, so cancel-then-press-record dispatched a second request into
 *      an occupied queue. That is a wedge this app was manufacturing, with no
 *      second tab required. `displayRequestPending()` is the fix.
 *   2. A REQUEST THAT COMES BACK LATE USED TO LEAK A LIVE SHARE. Our budget
 *      expires at 30 s and the take fails; the raw promise stays pending; and
 *      if Chrome delivers a stream two minutes later, nothing was watching it.
 *      The tracks stayed live with no owner — macOS indicator lit, a capture
 *      session alive for this origin — and every later take collided with it.
 *      "It happens after that too", exactly. Anything that arrives unclaimed
 *      is now stopped, and the arrival is written to the wedge journal, which
 *      is also the first evidence about whether an abandoned request can come
 *      back at all.
 *
 * Per-document by construction — module state dies with the document, which is
 * exactly the lifetime of the stuck request it tracks. Nothing is persisted
 * except the journal line, which is evidence rather than state.
 */
import { appendWedgeJournal } from './wedgeJournal'

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
  /** Dispatch time, so a late arrival can say HOW late it was. */
  at: number
  settled: boolean
  stuck: boolean
  /** Did the take actually take the stream this request delivered? An
   *  unclaimed arrival has no owner, and an unowned screen track is a lit
   *  indicator and a live capture session nobody can see. */
  claimed: boolean
}

const requests: DisplayRequest[] = []

/**
 * How long an arrival may sit unclaimed before it is assumed abandoned. The
 * success path claims within a millisecond of the promise resolving (it is the
 * first thing it does), so this only ever catches a stream that came back to
 * a take that had already given up or been cancelled.
 */
const CLAIM_GRACE_MS = 5_000

function stopAnyTracks(value: unknown): number {
  const stream = value as { getTracks?: () => { stop: () => void }[] } | null
  if (!stream || typeof stream.getTracks !== 'function') return 0
  const tracks = stream.getTracks()
  for (const t of tracks) {
    try {
      t.stop()
    } catch {
      /* already dead */
    }
  }
  return tracks.length
}

/**
 * Register a raw getDisplayMedia promise. Must be the RAW one, not a
 * withTimeout wrapper: the wrapper settles at the deadline while the request
 * behind it stays open, and it is the request this counts. The returned handle
 * is how the deadline says "this one is dead" — call `stuck()` from the
 * timeout path, and if Chrome ever does settle it, that is undone.
 */
export function markDisplayRequest(
  p: Promise<unknown>,
  now: () => number = Date.now,
): { stuck: () => void; claim: () => void } {
  const req: DisplayRequest = { at: now(), settled: false, stuck: false, claimed: false }
  requests.push(req)
  const settled = (): void => {
    req.settled = true
    // A request that came back — even hours late, even to be thrown away — is
    // no longer holding this frame's queue.
    for (let i = requests.length - 1; i >= 0; i--) if (requests[i]?.settled) requests.splice(i, 1)
  }
  p.then(
    (value) => {
      const lateMs = now() - req.at
      settled()
      // NOTHING ARRIVES TO NO OWNER. If the take is still live it claims this
      // within a millisecond; if it gave up, or the user cancelled the arm,
      // the share must not stay live behind their back.
      const sweep = (): void => {
        if (req.claimed) return
        const stopped = stopAnyTracks(value)
        appendWedgeJournal({ kind: 'settle', outcome: 'stream', claimed: false, lateMs, count: stopped })
      }
      if (req.stuck) sweep()
      else setTimeout(sweep, CLAIM_GRACE_MS)
    },
    () => {
      const lateMs = now() - req.at
      // Only worth a line if we had already written this one off: a normal
      // rejection (the user cancelled the picker) is not evidence about
      // anything and must not fill the journal.
      if (req.stuck) appendWedgeJournal({ kind: 'settle', outcome: 'error', claimed: false, lateMs })
      settled()
    },
  )
  return {
    stuck: () => {
      req.stuck = true
    },
    claim: () => {
      req.claimed = true
    },
  }
}

/** True when this document has a screen request it gave up on that Chrome has
 *  still never settled — the frame that cannot ask again. */
export function displayRequestOutstanding(): boolean {
  return requests.some((r) => r.stuck && !r.settled)
}

/**
 * True when ANY screen request from this document is still unsettled — the
 * picker is open, or it was abandoned with the picker still up. Chrome takes
 * one at a time, so dispatching now is the collision that hangs. Unlike
 * `displayRequestOutstanding`, this one is not a diagnosis and must not
 * refresh anything: the request it names can still come back on its own.
 */
export function displayRequestPending(): boolean {
  return requests.some((r) => !r.settled)
}

/** How many are unsettled right now — evidence for the journal. */
export function unsettledDisplayRequests(): number {
  return requests.filter((r) => !r.settled).length
}

/** Test seam — module state outlives test cases. */
export function resetDisplayInflightForTests(): void {
  requests.length = 0
}
