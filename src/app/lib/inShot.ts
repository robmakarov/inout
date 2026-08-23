/**
 * "You are looking at INOUT while INOUT is recording" — what to say about it.
 *
 * WHY THIS EXISTS (PO 2026-08-23): pressing HIDE on the browser's own screen-
 * sharing bar activates the capturing window, so the user is thrown out of
 * whatever they were recording and into this app. That bar is browser security
 * UI: a page cannot style it, dismiss it, or intercept its buttons, and no web
 * API can move OS focus back to another app. So the switch itself is not
 * fixable from here — what IS fixable is what the user lands on:
 *
 *   · a whole-screen take puts THIS window inside the recorded frame, and the
 *     live preview then films itself (the mirror tunnel). Blank it and say why.
 *   · a window/tab take does not film us, but the shared surface is now BEHIND
 *     this window — which is exactly how a take ends up a still frame.
 *
 * Pure so it can be unit-tested: the screen only supplies surface + focus.
 */
import type { DisplaySurfaceKind } from '@core/types'

export interface InShotNotice {
  /** 'in-shot' = we are inside the recorded frame; 'covering' = we are on top of it. */
  kind: 'in-shot' | 'covering'
  title: string
  body: string
  /** Why the user is suddenly here at all. Small print, never the headline. */
  foot?: string
}

/**
 * @param surface what the picker returned (null = no screen channel in the take)
 * @param inFront this document is visible AND focused, i.e. the user is here
 */
export function inShotNotice(
  surface: DisplaySurfaceKind | null | undefined,
  inFront: boolean,
): InShotNotice | null {
  if (!inFront || !surface) return null
  if (surface === 'monitor') {
    return {
      kind: 'in-shot',
      title: "You're in the shot",
      body: 'INOUT is on the screen being recorded. Switch back to what you were recording — the take keeps running.',
      foot: "Your browser's sharing bar brings you here when you hide it. That's the browser, not INOUT.",
    }
  }
  const what = surface === 'browser' ? 'tab' : 'window'
  return {
    kind: 'covering',
    title: `Your shared ${what} is behind this one`,
    body: `Only that ${what} is recorded. Bring it back in front — while it is hidden the take can record a still frame.`,
  }
}

/**
 * The live preview films itself when the whole screen is shared and this window
 * is in front. Nothing is lost by blanking it — the same frame is on the screen
 * behind it — and the user gets one clear message instead of a tunnel.
 */
export function previewWouldMirror(
  surface: DisplaySurfaceKind | null | undefined,
  inFront: boolean,
): boolean {
  return inFront && surface === 'monitor'
}
