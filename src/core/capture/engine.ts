/**
 * Which live-composite engine a take uses (task O4 step 2).
 *
 * v1 is the shipped MediaRecorder-on-a-main-thread-canvas path. v2 is the
 * worker/WebCodecs compositor.
 *
 * THE DEFAULT IS v2 (flipped 2026-08-24), AND EVERY REASON IS A MEASUREMENT.
 * The old story — "the encoder's own throughput is the wall, ~10 fps" — was
 * the rig measuring inside a fresh Chrome process's first-VideoEncoder
 * initialization (multi-second, per LAUNCH), with a watchdog that killed the
 * take mid-init. With the instrument fixed, v2 beats v1 on every measured
 * axis: throughput 28.4 fps vs 29.3 at 1080p (gate ≥28), main-thread long
 * tasks 0 ms vs 198, whole-browser CPU peak 127 % vs 196, oracle sync
 * 33.7-47.8 ms vs 63, and it drains an encoder it owns at stop. The per-launch
 * encoder init is paid at mount (prearm.ts → encoderWarm.ts, measured to
 * carry across to the worker).
 *
 * v1 remains fully alive as the LADDER UNDER v2, all three rungs measured:
 * capability (no MediaStreamTrackProcessor / AudioEncoder → v1 from the
 * start), start failure (v2 throws while starting → v1 takes the take), and
 * the mid-take watchdog (sustained <12 fps after first output → composite
 * refused, the take renders from the raw channels). `?engine=v1` or
 * localStorage forces the old engine outright.
 *
 *   ?engine=v1   (this load only)
 *   localStorage['inout.capture.engine'] = 'v1'   (sticky)
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
  return fromSearch() ?? fromStorage() ?? 'v2'
}

export function setCompositeEngine(engine: CompositeEngine): void {
  try {
    localStorage.setItem(STORAGE_KEY, engine)
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}
