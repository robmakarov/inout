/**
 * Is the export allowed to REMEMBER what it already rendered (task J1)?
 *
 * DEFAULT ON, and the switch is on the thing being REPLACED. CLAUDE.md,
 * 2026-09-03: "A DEFECT FIX SHIPS ON: the frozen rule protects behaviour the
 * USER CHOSE, it is not a licence to land a fix disabled — the thing being
 * replaced is what carries the switch" ("you did fix and turned it off so you
 * fucking did nothing?"). The defect here is named in the task: the at-stop
 * pre-render renders the whole take and every edit throws it away. Landing the
 * cure switched off would be doing nothing.
 *
 * WHAT IT COSTS AND WHAT IT BUYS, measured 2026-09-03 through the production
 * export worker (`exp nativerender --query=chunked=`, n=3 a side, the on-arm
 * verified to have actually chunked):
 *
 *   cold export       9,501 → 10,232 ms   1.08x SLOWER, once
 *   the same export again           474 ms against 165,983 ms   (0.003x)
 *   an edit in one span   2 of 180 chunks, 2.2 s against 165,983 ms
 *   a killed tab      resumes at the last complete chunk instead of restarting
 *   the file itself   byte-identical: same packets, keyframes, timestamps, size
 *
 * So the first press pays 8 % and every press after it, and every edit, and
 * every crash, is paid back many times over. The unbroken render remains the
 * runtime fallback for everything this path declines (no video to chunk, a
 * chunk cache that will not open, an avcC that disagrees between chunks).
 *
 *   ?chunked=0   (this load only — the unbroken render, exactly as before)
 *   localStorage['inout.compose.chunked'] = '0'   (sticky)
 * A URL parameter wins, then storage, then the default. There is also a row in
 * `/?test`, which is where a switch belongs.
 *
 * The render runs in a worker with no `localStorage` and a `location` of its
 * own script URL, so this is READ ON THE MAIN THREAD and forwarded — the same
 * trap that left `?cq=`, `?loudness=` and `?sourceframe=` dead on the shipped
 * path from O5a until 2026-08-30 (pipeline.ts).
 */
const STORAGE_KEY = 'inout.compose.chunked'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('chunked')
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

export function chunkedRenderEnabled(): boolean {
  return fromSearch() ?? fromStorage() ?? true
}

export function setChunkedRenderEnabled(on: boolean | null): void {
  try {
    if (on === null) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}

/** The worker has neither location nor storage: it is TOLD. */
let override: boolean | null = null
export function setChunkedRenderOverride(value: boolean | null): void {
  override = value
}
export function chunkedRenderActive(): boolean {
  return override ?? chunkedRenderEnabled()
}
