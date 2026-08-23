/**
 * Which live-composite engine a take uses (task O4 step 2).
 *
 * v2 is the worker/WebCodecs compositor; v1 is the shipped
 * MediaRecorder-on-a-main-thread-canvas path. v2 is preferred wherever the
 * platform supports it, and v1 remains the capability fallback — it is what
 * runs on Apple WebKit and on anything without MediaStreamTrackProcessor, and
 * it is what a take falls back to if v2 cannot even start.
 *
 * The override exists because "which engine made this file" must be
 * answerable during QA and A/B measurement without a rebuild:
 *   ?engine=v1  or  ?engine=v2   (this load only)
 *   localStorage['inout.capture.engine'] = 'v1' | 'v2'   (sticky)
 * A URL parameter wins, then storage, then the capability-based default.
 */

export type CompositeEngine = 'v1' | 'v2'

const STORAGE_KEY = 'inout.capture.engine'

function fromSearch(): CompositeEngine | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('engine')
  return v === 'v1' || v === 'v2' ? v : null
}

function fromStorage(): CompositeEngine | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'v1' || v === 'v2' ? v : null
  } catch {
    return null
  }
}

/** The engine this take should ASK for; capability still has the last word. */
export function preferredCompositeEngine(): CompositeEngine {
  return fromSearch() ?? fromStorage() ?? 'v2'
}

export function setCompositeEngine(engine: CompositeEngine): void {
  try {
    localStorage.setItem(STORAGE_KEY, engine)
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}
