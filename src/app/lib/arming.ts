/**
 * What the arming line should say, derived from the acquisition timeline.
 *
 * Devices acquire CONCURRENTLY (progressive arming), so every step emits its
 * 'start' within a few ms of the others and then finishes whenever it finishes.
 * The old label was set on 'start' alone and never cleared on 'done', so it
 * showed whichever step happened to start LAST and then sat there — reading
 * "Waiting for microphone…" while the microphone was long since live and
 * something else was the holdout, and reading it for the full 130 s settle
 * budget (PO 2026-08-23: "stuck on waiting for microphone again").
 *
 * The fix is to track the OUTSTANDING SET rather than the latest event, so the
 * line always names what is genuinely still missing. Pure and DOM-free so the
 * behaviour is unit-testable without a browser.
 */
import type { ArmingStep, ArmingTimelineEntry } from '@core/capture'

const STEP_NOUN: Record<ArmingStep, string> = {
  display: 'screen',
  camera: 'camera',
  mic: 'microphone',
  'system-audio': 'system audio',
}

/** Steps still outstanding after folding in one timeline entry. Order is the
 *  order they started, so the line does not reshuffle as devices land. */
export function foldWaiting(prev: readonly ArmingStep[], e: ArmingTimelineEntry): ArmingStep[] {
  if (e.status === 'start') return prev.includes(e.step) ? [...prev] : [...prev, e.step]
  // done / failed / timeout / skipped all mean "no longer waiting on this one".
  return prev.filter((s) => s !== e.step)
}

/**
 * The line itself. Null once nothing is outstanding — the caller then shows its
 * own "Starting recorders…", because at that point the wait is ours, not a
 * device's, and saying otherwise would be the same lie in a new place.
 */
export function armingLabel(waiting: readonly ArmingStep[]): string | null {
  if (waiting.length === 0) return null
  const nouns = waiting.map((s) => STEP_NOUN[s])
  if (nouns.length === 1) return `Waiting for ${nouns[0]}…`
  const last = nouns[nouns.length - 1]
  return `Waiting for ${nouns.slice(0, -1).join(', ')} and ${last}…`
}
