/**
 * Which live-composite engine a take uses (task O4 step 2).
 *
 * v1 is the shipped MediaRecorder-on-a-main-thread-canvas path. v2 is the
 * worker/WebCodecs compositor.
 *
 * THE DEFAULT IS v1, AND THE REASON CHANGED ON 2026-08-24. The old story —
 * "the encoder's own throughput is the wall, ~10 fps" — is FALSIFIED: those
 * numbers were the rig measuring inside a fresh Chrome process's first-
 * VideoEncoder initialization (multi-second, per LAUNCH), with a watchdog that
 * killed the take mid-init. Warm, v2 meets its throughput gate (28.4 fps at
 * 1080p vs v1's 29.3 in the same run) while costing the main thread nothing
 * (0 ms of long tasks vs v1's 198) and nearly halving the oracle sync offset
 * (33.7 vs 63.4 ms). The init itself is handled: prearm.ts warms a throwaway
 * encoder at mount when this switch prefers v2 (encoderWarm.ts, measured).
 *
 * v2 stays dormant for the REMAINING gates, not for speed: fMP4 tab-kill
 * salvage unverified, the recording preview still decodes sources in <video>,
 * capture-CPU report, and the forced-wedge watchdog case. The list lives in
 * .ai/TASKS under O4; `npm run exp -- o4step2` prints the throughput evidence.
 *
 *   ?engine=v2   (this load only)
 *   localStorage['inout.capture.engine'] = 'v2'   (sticky)
 * A URL parameter wins, then storage, then the default.
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
  return fromSearch() ?? fromStorage() ?? 'v1'
}

export function setCompositeEngine(engine: CompositeEngine): void {
  try {
    localStorage.setItem(STORAGE_KEY, engine)
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}
