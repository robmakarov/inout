/**
 * Is smart cut allowed to take a trim-only export (task O5c)?
 *
 * STILL DEFAULT OFF — and now for a MEASURED reason rather than a missing gate.
 *
 * O5-flip built the gate this flag was waiting for: the oracle's rig records a
 * live composite like every real take, its non-frame-aligned 1483 ms trim goes
 * through the product's own export ladder (compose/choose.ts), and the gate
 * bands that file's A/V offset AND asserts which path produced it. Then the
 * gate refused the flip, which is exactly what it was built to be able to do:
 *
 *   trimmed export via smartcut: sync mean |150.3| > 90 ms  (1 of 3 runs)
 *   the other two runs could not match flash/click pairs at all
 *
 * IT IS NOT SMART CUT'S BUG. The same oracle run measures the SHIPPED INSTANT
 * path on the same take and it is equally unmatchable, and the composite's own
 * clock says why: its first video packet sits at 300 ms, while
 * CompositeRecording carries no offset field — so both packet-copying paths
 * assume composite time IS recording time, and nothing anywhere can express
 * anything else. Audio is mixed from the raw channels on the recording
 * timeline; video is copied on the composite's. That is a defect in the
 * INSTANT path too — the one every unedited export takes — and it is now a
 * named, measured item rather than a suspicion.
 *
 * TO FLIP: fix the composite time base (give CompositeRecording a real offset,
 * or make the compositor stamp on the recording timeline), then re-run
 * `npm run oracle --cold=3` and check `inst=` and `trim=` both land inside the
 * band. The instrument is ready and waiting.
 *
 * What smart cut does was already measured — `npm run exp -- o5cut`, 30 s take,
 * trim-only edit with both boundaries deliberately off the composite's 2 s
 * keyframe grid, five runs:
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
 *   ?smartcut=1   (this load only)
 *   localStorage['inout.compose.smartcut'] = '1'   (sticky)
 * A URL parameter wins, then storage, then the default.
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
