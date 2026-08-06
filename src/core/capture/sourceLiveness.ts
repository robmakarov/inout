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
 * The signal is the media clock of the source: a LIVE video track advances
 * `video.currentTime` on every delivered frame — even a perfectly static screen
 * still gets ~1 keep-alive frame per second from the capturer (measured, Chrome
 * 150/macOS 26), so "no advance at all for seconds" means dead, not idle.
 *
 * Pure and DOM-free so it is unit-testable; the caller feeds it samples from a
 * hidden-tab-proof tick (the composite's AudioWorklet, never rAF).
 */

/** No frame at all for this long = the source is frozen, not merely static.
 * 3s is ~3× the capturer's static-content keep-alive cadence. */
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
   */
  sample(nowMs: number, mediaTimeSec: number): LivenessEvent | null {
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
    if (!this.stalledFlag && nowMs - this.lastAdvanceMs >= this.stallMs) {
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
