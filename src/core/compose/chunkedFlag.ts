/**
 * Is the export allowed to REMEMBER what it already rendered (task J1)?
 *
 * DEFAULT OFF, and that is the frozen rule rather than a doubt about the code:
 * "every new engine ships capability-gated with the current path as runtime
 * fallback; defaults move only on Robert's yes" (TASKS, Robert 2026-07-21). The
 * unbroken render is what ships until he flips this, and it remains the
 * fallback for every case the chunked path declines afterwards — so this is a
 * speed switch, never a correctness one.
 *
 *   ?chunked=1   (this load only)
 *   localStorage['inout.compose.chunked'] = '1'   (sticky)
 * A URL parameter wins, then storage, then the default.
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
  return fromSearch() ?? fromStorage() ?? false
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
