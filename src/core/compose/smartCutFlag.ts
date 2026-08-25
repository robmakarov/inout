/**
 * Is smart cut allowed to take a trim-only export (task O5c)?
 *
 * DEFAULT ON since 2026-08-25 (task O5-flip), because the gate that refused the
 * flip now passes it.
 *
 * THE REFUSAL WAS RIGHT AND IT WAS NOT SMART CUT'S BUG. O5-flip's gate — the
 * oracle records a live composite like every real take, its non-frame-aligned
 * 1483 ms trim goes through the product's own ladder (compose/choose.ts), and
 * the run bands that file's A/V offset AND asserts which path produced it —
 * read `trimmed export via smartcut: sync mean |150.3| > 90 ms`, and the same
 * run measured the SHIPPED INSTANT path equally out of band on the same take.
 * The cause was the composite's clock: it does not start when the take does,
 * and CompositeRecording had no way to say so, so both copy paths placed video
 * on the composite's timeline against audio mixed on the recording's.
 *
 * FIXED IN P0-instant-sync: CompositeRecording.startOffsetMs, produced by both
 * capture engines and honoured by both copy paths. Measured after, one run each
 * of `npm run oracle --cold=3` (v2) and `--engine=v1 --cold=2`:
 *
 *   v2  inst 59.6 / 48.6 / 75.8 ms   against the same takes' render 64.2 / 50.0 / 54.8
 *   v1  inst 63.4 / 70.5 ms          against 38.2 / 47.1   (v1 read 244.8 ms before)
 *
 * i.e. the packet copy now lands inside the render's own run-to-run spread,
 * which is the only sensible target: it is meant to BE the same file.
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
 * OFF is still one flag away, and it stays that way — the full render remains
 * the fallback for every case smart cut declines, so this is a speed switch,
 * not a correctness one:
 *
 *   ?smartcut=0   (this load only)
 *   localStorage['inout.compose.smartcut'] = '0'   (sticky)
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
  return fromSearch() ?? fromStorage() ?? true
}

export function setSmartCutEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}
