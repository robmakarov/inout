/**
 * O4 — the v2 engine's throughput watchdog, pure so it can be tested.
 *
 * The first version measured cumulative fps SINCE START and degraded at 5 s.
 * That turned the encoder's one-time initialization into a permanent kill:
 * on a fresh Chrome profile the first VideoEncoder of the process takes
 * seconds to produce its first frame (measured 2026-08-24: the same take that
 * reads 0.6-5 fps cold reads 28 fps after one discarded warm-up take, 13 ms
 * encoder latency, zero drops), so the deadline routinely expired while the
 * encoder was still setting up — and a degrade stops the pumps, so nothing
 * could ever recover.
 *
 * The clock therefore starts at the FIRST REAL OUTPUT: initialization is
 * excluded, sustained slowness after it still degrades at the same threshold,
 * and an encoder that never returns anything at all is a wedge with its own,
 * longer deadline. A degrade costs the take its composite (the raw channels
 * keep recording and the export renders from them), so patience here is
 * cheaper than a false kill.
 */

export const WATCHDOG_AFTER_MS = 5000
export const WATCHDOG_MIN_FPS = 12
/** No real output at all by this deadline, with real frames offered = wedged. */
export const WATCHDOG_NO_OUTPUT_MS = 15_000

export interface WatchdogSample {
  nowMs: number
  startedAtMs: number
  /** When the first non-keep-alive frame came back from the encoder. */
  firstOutputAtMs: number | null
  /** framesEncoded - keepAliveFrames. */
  realFramesEncoded: number
  framesDropped: number
}

/** Non-null = the reason to degrade. */
export function watchdogVerdict(s: WatchdogSample): string | null {
  // A composition nobody is changing legitimately encodes ~1 keep-alive frame
  // per second and never drops; a silent drop counter means nothing was asked
  // of the encoder, not that it kept up.
  if (s.framesDropped === 0) return null
  if (s.firstOutputAtMs === null) {
    if (s.nowMs - s.startedAtMs >= WATCHDOG_NO_OUTPUT_MS) {
      return `no encoded frame in ${Math.round((s.nowMs - s.startedAtMs) / 1000)} s (${s.framesDropped} frames dropped)`
    }
    return null
  }
  const elapsedSec = (s.nowMs - s.firstOutputAtMs) / 1000
  if (elapsedSec * 1000 < WATCHDOG_AFTER_MS) return null
  const fps = s.realFramesEncoded / elapsedSec
  if (fps < WATCHDOG_MIN_FPS) {
    return `only ${fps.toFixed(1)} fps reached the file (${s.framesDropped} frames dropped)`
  }
  return null
}
