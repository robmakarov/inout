/**
 * THE OFFSET BETWEEN TWO REALMS' `performance.now()`, MEASURED — never computed
 * from `performance.timeOrigin`.
 *
 * WHY (Robert's take rec_cff9nmm7trmh, 2026-09-06, and it is the whole reason
 * this file exists): screen + tab audio, 46.1 min recorded, and the editor
 * opened it as **553.6 minutes** with the sound 8 h 27 min after the picture.
 * The take's own row says it in one line —
 *
 *     screen/video        off=0            dur=2768642   (46.1 min)
 *     system-audio/audio  off=30445691     dur=2768680   (46.1 min)
 *     recording.durationMs = 33214371 = 553.6 min
 *
 * — and the audio channel's diagnostics name the culprit exactly:
 * `tapHandoffMs: -30445750.4`, i.e. the audio tap worker's arrival stamps were
 * 30,445,750 ms AHEAD of the main thread's own `performance.now()` in the same
 * page at the same instant. `pmset -g log` on that machine: the tab was open
 * across a night of sleep, and the sleep totalled the same 8 h 27 min.
 *
 * THE PREMISE THAT BROKE. Three places in this engine carried the same comment
 * — "`timeOrigin` is the absolute instant each context's zero sits at, so the
 * sum is the one quantity both threads agree on". It is not:
 *
 *   · `performance.now()` is MONOTONIC. On macOS it stops while the machine
 *     sleeps (mach_absolute_time, not mach_continuous_time).
 *   · `performance.timeOrigin` is WALL CLOCK, captured when that realm was
 *     created. Sleep does not stop the wall clock.
 *
 * So a document loaded before a sleep and a worker created after it disagree,
 * by exactly the sleep, forever. The audio tap worker is built at the record
 * press; the page had been open since the evening before. `timeOrigin + now()`
 * is a shared clock only in a page younger than its machine's last sleep.
 *
 * THE REPLACEMENT. Two realms' `performance.now()` are the same monotonic
 * ticks read against two different zeros, so their difference is a CONSTANT —
 * it survives sleep, throttling and hours. Measure it once from the messages
 * that already cross, and never convert through wall clock again.
 *
 * THE ESTIMATOR IS A MAX, and the direction is not a detail. A sample is taken
 * on RECEIPT of a message the other realm stamped as it sent: delivery can only
 * make the receiver's reading LATE, so `theirStamp − myNow` is the true offset
 * MINUS a non-negative delay. The maximum over samples is therefore the
 * estimate, and it improves monotonically as the cheapest delivery lands.
 * (rawVideo.worker.ts has run this filter, spelled as a min of the negation,
 * since X6 — this is that code lifted, not a second implementation.)
 */

export class RealmOffset {
  /** max over samples of (their now − my now). NaN until the first sample. */
  private best = Number.NaN
  private count = 0

  /**
   * Call on receipt of a message the OTHER realm stamped with its own
   * `performance.now()`. `myNowMs` defaults to this realm's reading now, which
   * is what every caller wants — pass it only when the receipt instant was
   * taken earlier than the call.
   */
  note(theirNowMs: number, myNowMs: number = performance.now()): void {
    if (!Number.isFinite(theirNowMs)) return
    const delta = theirNowMs - myNowMs
    if (this.count === 0 || delta > this.best) this.best = delta
    this.count++
  }

  /** How many samples the estimate rests on. Zero = every conversion is a no-op. */
  get samples(): number {
    return this.count
  }

  /** The measured offset (their now − my now), or 0 before the first sample. */
  get offsetMs(): number {
    return this.count === 0 ? 0 : this.best
  }

  /** A reading the OTHER realm took, expressed on THIS realm's clock. */
  toLocal(theirNowMs: number): number {
    return theirNowMs - this.offsetMs
  }

  /** This realm's reading, expressed on the OTHER realm's clock. */
  fromLocal(myNowMs: number = performance.now()): number {
    return myNowMs + this.offsetMs
  }
}
