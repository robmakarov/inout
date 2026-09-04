/**
 * MAY THE EXPORT BE MADE WHILE HE EDITS? — task J5's switch.
 *
 * ON by default, and the switch is on the thing being REPLACED: `?bgrender=0`
 * is exactly J3's state — nothing renders because of an edit — which is what
 * this replaces on Robert's ruling of 2026-09-04 (DECISIONS robert (27), "kill
 * the glued copy encoding and do background render while editing").
 *
 * WHY IT SHIPS ON. CLAUDE.md, 2026-09-03: "A DEFECT FIX SHIPS ON ... the thing
 * being replaced is what carries the switch". Landing this behind an off switch
 * would leave every take's export un-made, which is the state the ruling
 * removes — and the ruling's own order (J5 before J6) only means anything if
 * J5 is actually running when J6 takes the composite's encoder out.
 *
 * WHY IT IS SAFE TO DEFAULT ON, in one line each:
 *  · it changes no output — the file is the same render, started earlier, and
 *    that is pinned byte-for-byte by the j5 rig's `identical` field;
 *  · every miss falls through to rendering on demand (F16's contract);
 *  · it is braked by the same instrument the at-stop job obeys (`?bgpace=`),
 *    which already steps a background render down to a trickle while a hand is
 *    on the editor and pauses it outright beside a live take;
 *  · and since J1 an edit that supersedes a running job costs only the chunk it
 *    was in the middle of, which is the "back and forth" Robert refused in
 *    robert (23) — measured then at a whole discarded render, bounded now by
 *    one 2.5 s chunk.
 *
 *   ?bgrender=0   (this load only — J3's behaviour exactly)
 *   localStorage['inout.compose.bgrender'] = '0'   (sticky)
 * A URL parameter wins, then storage, then the default. There is a row in
 * `/?test`, which is where a switch belongs.
 *
 * `?prerender=0` still turns the WHOLE pre-render off, at-stop job included;
 * this one is only the edit-triggered half.
 */
const STORAGE_KEY = 'inout.compose.bgrender'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('bgrender')
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

let override: boolean | null = null

export function editRenderEnabled(): boolean {
  return override ?? fromSearch() ?? fromStorage() ?? true
}

export function setEditRenderEnabled(on: boolean | null): void {
  override = null
  try {
    if (on === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* memory-only: the URL parameter still works */
    override = on
  }
}

/** Test and rig seam — a switch a test flips must not outlive the test. */
export function setEditRenderOverrideForTests(value: boolean | null): void {
  override = value
}
