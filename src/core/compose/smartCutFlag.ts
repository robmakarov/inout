/**
 * Is smart cut allowed to take a trim-only export (task O5c)?
 *
 * DEFAULT OFF, AND THE REASON IS THE GATE, NOT THE MEASUREMENT. What smart cut
 * does is measured and good — `npm run exp -- o5cut`, 30 s take, trim-only
 * edit with both boundaries deliberately off the composite's 2 s keyframe
 * grid, five runs:
 *
 *   669-944 ms  against 3718-3780 ms for the full render   (4.3-5.6x)
 *   90-94 % of frames copied; only 44-97 re-encoded of 720
 *   picture matches the render at 37.5 dB, which is the ceiling for two
 *     independent encodes of one frame
 *
 * …and the one thing that looked wrong is NOT ours: the smart-cut file sits
 * one frame ahead of the render, and the CONTROL in the same rig shows the
 * SHIPPED INSTANT PATH sitting one frame ahead of the same render too (41.8
 * and 38.4 dB at +1 frame, with no smart cut anywhere in that comparison).
 * The offset belongs to the composite, which is composed from source frames as
 * they arrive; smart cut inherits it by copying the same file the instant path
 * copies, and adds nothing.
 *
 * What is missing is a GATE, not evidence. Nothing in CI yet exports a CUT
 * take through this path and measures its A/V sync: the oracle's trim case
 * goes through exportRecording directly, so it would pass while never
 * touching smart cut at all. Shipping a new default that the sync band cannot
 * see is exactly what the O4 engine was held back from doing, so this follows
 * the same precedent — merged, exercised by its own harness, off by default,
 * one flag away.
 *
 *   ?smartcut=1   (this load only)
 *   localStorage['inout.compose.smartcut'] = '1'   (sticky)
 * A URL parameter wins, then storage, then the default.
 *
 * TO FLIP IT: route the oracle's non-frame-aligned trim through the editor's
 * export decision so smart cut actually runs under the sync band, confirm
 * 3/3 green, then change the fallback below to `true`.
 */

const STORAGE_KEY = 'inout.compose.smartcut'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('smartcut')
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  return null
}

function fromStorage(): boolean | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === '1' || v === 'true') return true
    if (v === '0' || v === 'false') return false
    return null
  } catch {
    return null
  }
}

export function smartCutEnabled(): boolean {
  return fromSearch() ?? fromStorage() ?? false
}

export function setSmartCutEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}
