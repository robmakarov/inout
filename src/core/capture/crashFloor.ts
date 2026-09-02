/**
 * H2b — THE TWO CRASH FLOORS, AND THE ONE SWITCH THAT HOLDS THEM.
 *
 * H2 priced a crash at 2.1 s and then found the floor where that price does not
 * hold: eight single-kill cells at 2-20 s on the deployed build.
 *
 *   · at 2.8 / 3.3 / 4.2 s NOTHING was recoverable — `writePendingManifest`
 *     put the only pointer to the take's blobs in `localStorage`, which Chrome
 *     commits asynchronously, so a `kill -9` inside that window took it;
 *   · at 5.4 s the take salvaged as AUDIO ONLY — audio is on ~1 s WebM clusters
 *     and already had material, while a fragmented-MP4 fragment needs its
 *     minimum duration AND the next keyframe against a 2 s GOP, so no video
 *     fragment had closed.
 *
 * Two fixes, one switch:
 *   (a) the manifest also goes to an IndexedDB store with a REAL transaction
 *       commit (recovery.ts), so the pointer is on disk in milliseconds;
 *   (b) the first video fragment closes at EARLY_FRAGMENT_S rather than at the
 *       GOP (rawVideo.worker.ts), so a young take has decodable picture.
 *
 * Both are additive — each can only turn a lost take into a recovered one —
 * and both are gated here per the frozen rule, so `?crashfloor=0` is byte-for-
 * byte the behaviour H2 measured.
 *
 *   ?crashfloor=1|0                            (this load only)
 *   localStorage['inout.capture.crashfloor']   (sticky)
 */

const FLAG_KEY = 'inout.capture.crashfloor'

/**
 * WHERE THE FIRST VIDEO FRAGMENT CLOSES, in seconds of media time.
 *
 * 1 s and not less, because that is the cadence AUDIO already has (WebM's
 * default minimum cluster duration) — this makes the picture's floor the same
 * as the sound's rather than a new number nobody can predict. It costs one
 * extra keyframe per take: the GOP after it is the same 2 s it always was.
 */
export const EARLY_FRAGMENT_S = 1

function flagFromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('crashfloor')
  return v === '1' ? true : v === '0' ? false : null
}

export function crashFloorEnabled(): boolean {
  const url = flagFromSearch()
  if (url !== null) return url
  try {
    const v = localStorage.getItem(FLAG_KEY)
    if (v === '1') return true
    if (v === '0') return false
  } catch {
    /* storage unavailable — the default stands */
  }
  return true
}
