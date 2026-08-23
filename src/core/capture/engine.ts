/**
 * Which live-composite engine a take uses (task O4 step 2).
 *
 * v1 is the shipped MediaRecorder-on-a-main-thread-canvas path. v2 is the
 * worker/WebCodecs compositor.
 *
 * THE DEFAULT IS v1, AND THAT IS A MEASUREMENT, NOT CAUTION. v2 does what it
 * was built to do — it takes capture off the main thread entirely (144 ms of
 * long tasks during a take becomes 0) and it drains its encoder at stop — but
 * on the TD machine its VideoEncoder delivers ~10 fps at 1080p where
 * MediaRecorder delivers ~29. The bottleneck is isolated and it is not ours:
 * compositing costs 1.1 ms per frame, turning the canvas into a VideoFrame
 * 0.05 ms, and the encode CALL 0.04 ms — the encoder's own throughput is the
 * wall. Shipping v2 by default would trade a working 30 fps composite for a
 * 10 fps one, which is the opposite of the point.
 *
 * So v2 ships dormant, behind this switch, with its evidence harness. Flip the
 * default when a machine (or a Chrome) is measured giving WebCodecs a real
 * hardware encoder: `npm run exp -- o4step2` prints the numbers that decide it.
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
