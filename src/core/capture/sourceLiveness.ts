/**
 * Frozen-source detection.
 *
 * A capture source can stop delivering frames while the take keeps running:
 * the shared window moves to another macOS Space or gets minimised, a
 * full-screen app takes over the shared surface, or the track ends outright
 * (browser "Stop sharing"). MediaRecorder does NOT fail in that case — it holds
 * the last frame, so the take ends as a long still image with no warning
 * anywhere (PO 2026-08-06: "switched to other tab with game, nothing was
 * recorded, just frozen frame").
 *
 * FRAME SILENCE ALONE IS NOT A VERDICT (PO 2026-08-25: "message about frozen
 * screen is bullshit"). The original rule — "no frame for 3 s = dead, because
 * even a static screen gets ~1 keep-alive frame/s" — was measured on the v1
 * <video> path (Chrome 150/macOS 26) and its premise did not survive the v2
 * engine flip: MediaStreamTrackProcessor is frame-driven, a genuinely static
 * screen legitimately delivers NOTHING, and the banner fired on takes that
 * were recording perfectly. So silence is now merely AMBIGUOUS, and the
 * browser's own signal disambiguates it: Chrome sets `track.muted` exactly
 * when a capture source stops producing (minimised window, hidden Space,
 * occluded surface) and leaves it false for a static-but-live one. Frozen =
 * frame silence AND the browser says the source is sick. Both edges obey the
 * same authority: a source the browser declares healthy again is 'resumed'
 * even before content changes — a still image from a healthy source is
 * exactly what the user is looking at.
 *
 * Pure and DOM-free so it is unit-testable; the caller feeds it samples from a
 * hidden-tab-proof tick (the composite's AudioWorklet, never rAF) plus the
 * track's own health (`readyState === 'live' && !muted`).
 */

/** Frame silence must last this long before a sick source is called frozen —
 * mute alone flickers during window drags; silence alone is a static screen. */
export const SOURCE_STALL_MS = 3000

export type LivenessEvent = 'stalled' | 'resumed'

export class SourceLiveness {
  private lastMediaTime = -1
  private lastAdvanceMs = -1
  private stalledFlag = false

  constructor(private readonly stallMs: number = SOURCE_STALL_MS) {}

  /**
   * Feed one observation. Returns an EDGE only — 'stalled' the first tick the
   * source is judged dead, 'resumed' the first tick it comes back, else null.
   * `sourceLive` is the browser's word (`readyState === 'live' && !muted`);
   * its default means a caller with no track evidence can never raise a false
   * banner, only miss one.
   */
  sample(nowMs: number, mediaTimeSec: number, sourceLive = true): LivenessEvent | null {
    if (this.lastAdvanceMs < 0) {
      this.lastAdvanceMs = nowMs
      this.lastMediaTime = mediaTimeSec
      return null
    }
    if (mediaTimeSec !== this.lastMediaTime) {
      this.lastMediaTime = mediaTimeSec
      this.lastAdvanceMs = nowMs
      if (this.stalledFlag) {
        this.stalledFlag = false
        return 'resumed'
      }
      return null
    }
    if (this.stalledFlag && sourceLive) {
      // The browser healed the source; content is merely static now.
      this.stalledFlag = false
      return 'resumed'
    }
    if (!this.stalledFlag && !sourceLive && nowMs - this.lastAdvanceMs >= this.stallMs) {
      this.stalledFlag = true
      return 'stalled'
    }
    return null
  }

  get stalled(): boolean {
    return this.stalledFlag
  }

  /** How long the source has been frozen, 0 when live. */
  stalledForMs(nowMs: number): number {
    return this.stalledFlag ? nowMs - this.lastAdvanceMs : 0
  }
}
