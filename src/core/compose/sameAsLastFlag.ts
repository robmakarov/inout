/**
 * J13's switch — "same as last frame", ON by default.
 *
 * IT CHANGES THE FILE'S BYTES, not what the file shows: a slot whose picture is
 * identical to the one before it is written as the format's own "identical to
 * the previous picture" instead of being encoded again. The pixels, the
 * duration, the timestamps and the frame count are the same either way.
 *
 * ON IS ROBERT'S RULING, twice: "ship it — exactness is to the SOURCE"
 * (2026-09-08), and again on 2026-09-08 when the default was put back to him
 * because the session that shipped it was not the session that heard him. What
 * the measurement says is that this file is the FAITHFUL one — at the slots it
 * copies, the source did not change, and today's render moves by up to 58
 * levels there while this moves by none.
 *
 * AND IT HAS A ROW, which is the second half of the same ruling: "raise the
 * ceiling to 50". A knob he might press is a row in `/?test` (CLAUDE.md), and
 * an engine that changes every rendered export with no way back is not
 * capability-gated, it is imposed. `SWITCH_CEILING` moved 49 -> 50 for this and
 * `scripts/switch-gate.mjs` now lets a raise through only when the commit that
 * makes it carries his word.
 *
 *   ?sameaslast=on | off       this load only
 *   localStorage['inout.compose.sameaslast']   (sticky, the /?test row)
 *
 * A URL parameter wins, then the override, then storage, then the default.
 * Read on the MAIN thread and forwarded (pipeline.ts → export.worker.ts): the
 * render worker has no `localStorage` and a `location` of its own script URL —
 * the trap that left `?cq=`, `?loudness=` and `?sourceframe=` dead on the
 * shipped path for weeks.
 */

const STORAGE_KEY = 'inout.compose.sameaslast'

function parse(v: string | null): boolean | null {
  if (v === 'on' || v === '1' || v === 'true') return true
  if (v === 'off' || v === '0' || v === 'false') return false
  return null
}

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  return parse(new URLSearchParams(location.search).get('sameaslast'))
}

function fromStorage(): boolean | null {
  try {
    return parse(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

export function sameAsLastEnabled(): boolean {
  return fromSearch() ?? fromStorage() ?? true
}

export function setSameAsLast(on: boolean | null): void {
  try {
    if (on === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}

/** The worker has neither location nor storage: it is TOLD. */
let override: boolean | null = null
export function setSameAsLastOverride(value: boolean | null): void {
  override = value
}

export function sameAsLastActive(): boolean {
  return fromSearch() ?? override ?? fromStorage() ?? true
}
