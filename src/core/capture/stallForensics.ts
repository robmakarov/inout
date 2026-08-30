/**
 * WHAT WAS HAPPENING AROUND A SCREEN REQUEST THAT NEVER CAME BACK.
 *
 * Robert, 2026-08-30: "keep thinking how to prevent it completly". Prevention
 * needs a cause, and the cause is currently one of three suspects that all
 * look identical from the page — a page cannot see into Chrome's capture
 * service, but it CAN see the two things that leak out of it: focus and time.
 * This module records exactly those around every display request and prints
 * them the moment one stalls, so the NEXT wedge convicts a suspect instead of
 * adding to a count.
 *
 * The three suspects, and the signature each one leaves:
 *
 *  1. OUR REQUEST CONTENTS. Convicted/cleared by the ladder itself — rung 3
 *     sends `{video, audio}` bare, so a stall there is not our object. This
 *     module just records the rung.
 *  2. CHROME'S PICKER/CAPTURE SERVICE (the classic wedge). The picker was on
 *     screen — focus LEFT the page and CAME BACK — and Chrome still never
 *     settled. `focus: lost-and-returned` + no settle is this one.
 *  3. macOS BELOW CHROME — the SCK/replayd path, including the periodic
 *     re-authorisation dialog, which can open BEHIND every window. A stall
 *     where focus NEVER left is this class: no picker was ever interacted
 *     with, the request died before any UI, or the UI is somewhere the user
 *     cannot see. This is also the only suspect that explains a wedge that
 *     SURVIVES a Chrome relaunch, which today's did.
 *
 * Plus the one number that tests the strongest pattern in his reports —
 * "wedges happen on the first record after reopening chrome": how many screen
 * deliveries this tab session had seen before this request. sessionStorage on
 * purpose: it survives the wedge ritual's own reload (still the same Chrome
 * launch, still the same evidence run) and dies with the tab, so a fresh
 * Chrome launch starts at zero — which is exactly the boundary the pattern is
 * about. If the wedge analytics come back clustered on deliveries=0, the
 * first-SCK-touch-after-launch hypothesis is proven and prevention has a
 * target; scattered, and it is disproven for free.
 *
 * Observation only. Nothing here changes a request, a budget, or a message.
 */

const DELIVERIES_KEY = 'inout.screenDeliveries.v1'

/** Focus/visibility transitions, relative to dispatch, capped so a stall on a
 *  busy machine cannot grow an unbounded array. */
const MAX_EVENTS = 40

export interface StallForensics {
  /** ms from dispatch to the report being taken. */
  waitedMs: number
  /** 'never-lost' | 'lost-and-returned' | 'still-lost' — see the suspects. */
  focus: 'never-lost' | 'lost-and-returned' | 'still-lost'
  /** The raw trace, e.g. "blur@812 focus@3204 hidden@…". */
  trace: string
  /** Screen deliveries this tab session BEFORE this request. 0 on the first
   *  take after a Chrome launch — the pattern under test. */
  deliveriesThisSession: number
  /** ms from page load to dispatch — separates "first thing he did" from
   *  "an hour into the session". */
  pageAgeMs: number
}

export function screenDeliveriesThisSession(): number {
  try {
    return Number(sessionStorage.getItem(DELIVERIES_KEY) ?? 0) || 0
  } catch {
    return 0
  }
}

/** Called from the delivery path: a screen track actually arrived. */
export function noteScreenDelivered(): void {
  try {
    sessionStorage.setItem(DELIVERIES_KEY, String(screenDeliveriesThisSession() + 1))
  } catch {
    /* memory-only tab — the count degrades to 0 and the signal is weaker */
  }
}

export interface DisplayForensics {
  /** Stop listening. Call when the request settles either way. */
  settle: () => void
  /** The picture so far — taken at the stall notice and again at the failure. */
  report: (now?: number) => StallForensics
}

/**
 * Start watching the moment the request is dispatched. Pure fold over events
 * so the interpretation is unit-testable without a window; the listeners are
 * the only DOM touch and are skipped where there is no DOM (tests, workers).
 */
export function beginDisplayForensics(
  t0 = performance.now(),
  pageAgeMs = typeof performance !== 'undefined' ? performance.now() : 0,
): DisplayForensics {
  const events: { type: string; at: number }[] = []
  const push = (type: string): void => {
    if (events.length < MAX_EVENTS) events.push({ type, at: performance.now() - t0 })
  }
  const onBlur = (): void => push('blur')
  const onFocus = (): void => push('focus')
  const onVis = (): void => push(document.visibilityState)
  // A WITNESS MUST NEVER BE ABLE TO KILL THE THING IT WATCHES. This runs
  // inside the acquisition path, between the dispatch and the budget — a throw
  // here (a stubbed document without addEventListener was the first) would
  // read as a failed take with no failure recorded. So every DOM touch is
  // guarded, and losing the listeners only weakens the report to 'quiet'.
  let hasDom = false
  try {
    // The page may already be unfocused at dispatch (a click can land with
    // focus elsewhere in edge cases) — record the starting state so the fold
    // does not misread "focus" as a return that had no departure.
    if (typeof document !== 'undefined' && !document.hasFocus()) {
      events.push({ type: 'blur', at: 0 })
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVis)
    hasDom = true
  } catch {
    /* no DOM, or a partial one — observe nothing rather than break the take */
  }
  const deliveries = screenDeliveriesThisSession()
  return {
    settle: () => {
      if (!hasDom) return
      try {
        window.removeEventListener('blur', onBlur)
        window.removeEventListener('focus', onFocus)
        document.removeEventListener('visibilitychange', onVis)
      } catch {
        /* same guard as the install */
      }
    },
    report: (now = performance.now()) => ({
      waitedMs: Math.round(now - t0),
      focus: foldFocus(events),
      trace: events.map((e) => `${e.type}@${Math.round(e.at)}`).join(' ') || 'quiet',
      deliveriesThisSession: deliveries,
      pageAgeMs: Math.round(pageAgeMs),
    }),
  }
}

/** Which of the three focus stories the trace tells. Exported for tests. */
export function foldFocus(events: readonly { type: string }[]): StallForensics['focus'] {
  let lost = false
  let away = false
  for (const e of events) {
    if (e.type === 'blur' || e.type === 'hidden') {
      lost = true
      away = true
    } else if (e.type === 'focus' || e.type === 'visible') {
      away = false
    }
  }
  if (!lost) return 'never-lost'
  return away ? 'still-lost' : 'lost-and-returned'
}

/** One console line a screenshot can carry — the whole point is that Robert's
 *  next report needs no follow-up questions. */
export function describeForensics(f: StallForensics): string {
  const story =
    f.focus === 'never-lost'
      ? 'focus never left this page — no picker was interacted with, so the request died inside Chrome/macOS before any visible UI (or its dialog is hidden behind other windows)'
      : f.focus === 'lost-and-returned'
        ? 'focus left and came back — a picker (or dialog) was answered and Chrome still never delivered'
        : 'focus left and has not returned — something still holds it'
  return (
    `screen request silent for ${(f.waitedMs / 1000).toFixed(1)}s: ${story}. ` +
    `${f.deliveriesThisSession} screen deliveries this session, page ${(f.pageAgeMs / 1000).toFixed(0)}s old. ` +
    `trace: ${f.trace}`
  )
}
