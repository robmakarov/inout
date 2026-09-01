/**
 * Frozen-source detection.
 *
 * A capture source can stop delivering frames while the take keeps running:
 * the shared window moves to another macOS Space or gets minimised, a
 * full-screen app takes over the shared surface, or the track ends outright
 * (browser "Stop sharing"). MediaRecorder does NOT fail in that case — it holds
 * the last frame, so the take ends as a long still image with no warning
 * anywhere (Robert 2026-08-06: "switched to other tab with game, nothing was
 * recorded, just frozen frame").
 *
 * FRAME SILENCE ALONE IS NOT A VERDICT (Robert 2026-08-25: "message about frozen
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

/**
 * H4 — HOW LONG A SOURCE MAY DELIVER *NOTHING AT ALL* BEFORE IT IS CALLED DEAD.
 *
 * The static-screen ambiguity above does not reach this case, and that is the
 * whole point. A static screen delivers its FIRST frame and then goes quiet —
 * it has to, or the composite would have no picture of it to paint and every
 * take of a still page would be blank. Zero frames EVER is a different animal:
 * B4's camera, live and unmuted and reporting 1920x1080@30 with the lid shut,
 * which wrote a 28-byte file for the whole take. `muted` cannot disambiguate
 * that one — Chrome leaves it false — so nothing did, and the take was silent
 * about it in every surface it had.
 *
 * Five seconds rather than three: this only ever fires once, at the very start
 * of a take, where the encoder and the compositor are both still coming up,
 * and a cold first frame that takes four seconds is a slow machine and not a
 * dead camera.
 */
export const SOURCE_NEVER_DELIVERED_MS = 5000

export type LivenessEvent = 'stalled' | 'resumed' | 'dead'

export class SourceLiveness {
  private lastMediaTime = -1
  private lastAdvanceMs = -1
  private firstSampleMs = -1
  private stalledFlag = false
  private deadCalled = false

  constructor(
    private readonly stallMs: number = SOURCE_STALL_MS,
    private readonly deadMs: number = SOURCE_NEVER_DELIVERED_MS,
  ) {}

  /**
   * Feed one observation. Returns an EDGE only — 'stalled' the first tick the
   * source is judged dead, 'resumed' the first tick it comes back, else null.
   * `sourceLive` is the browser's word (`readyState === 'live' && !muted`);
   * its default means a caller with no track evidence can never raise a false
   * banner, only miss one.
   */
  sample(
    nowMs: number,
    mediaTimeSec: number,
    sourceLive = true,
    deliveredEver = true,
  ): LivenessEvent | null {
    if (this.lastAdvanceMs < 0) {
      this.lastAdvanceMs = nowMs
      this.firstSampleMs = nowMs
      this.lastMediaTime = mediaTimeSec
      return null
    }
    // H4: never one frame. Not ambiguous, so `sourceLive` gets no vote — the
    // browser calling a sensor-off camera healthy is exactly the report this
    // rule exists to overrule. Same default as `sourceLive`: a caller with no
    // frame count can never raise this, only miss it.
    if (!deliveredEver && !this.deadCalled && nowMs - this.firstSampleMs >= this.deadMs) {
      this.deadCalled = true
      return 'dead'
    }
    if (mediaTimeSec !== this.lastMediaTime) {
      this.lastMediaTime = mediaTimeSec
      this.lastAdvanceMs = nowMs
      if (this.stalledFlag || this.deadCalled) {
        this.stalledFlag = false
        this.deadCalled = false
        return 'resumed'
      }
      return null
    }
    // DEAD IS NOT HEALED BY THE BROWSER'S WORD, only by a frame. The browser
    // already calls this source healthy — that report is what 'dead' overruled
    // — so letting it clear the flag would un-say the warning on the very next
    // tick and leave the chip flickering for the rest of the take.
    if (this.deadCalled) return null
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
    return this.stalledFlag || this.deadCalled
  }

  /** How long the source has been frozen, 0 when live. */
  stalledForMs(nowMs: number): number {
    return this.stalledFlag ? nowMs - this.lastAdvanceMs : 0
  }
}
