/**
 * G7's CLOCK. It lives here and not on the main thread for one measured reason.
 *
 * A TAKE RUNS WITH THE DOCUMENT HIDDEN — Robert presses record and switches to
 * the thing he is recording, so INOUT's tab is in the background for
 * essentially the whole take — and Chrome clamps a hidden page's timers to
 * about 1 Hz. E1 measured both halves of that in one window (core/pressure.ts):
 * a 16 ms `setInterval` on the hidden main thread read 984 ms late AT IDLE and
 * 3568 ms during a deliberate 3 s burn, while the SAME page's worker ticker ran
 * 59 Hz with a worst tick of 27 ms. A main-thread timer therefore cannot be the
 * clock: it reports the throttle as a stall on every take ever recorded.
 *
 * So the schedule lives out here, where nothing throttles it, and the main
 * thread only STAMPS ARRIVALS. Lateness is `arrival − due` with both sides
 * converted to absolute time through `performance.timeOrigin`, which is the one
 * quantity the two threads agree on.
 *
 * This worker sends and receives nothing else. It holds no state a take needs,
 * it never touches media, and if it dies the sampler falls back to a main-thread
 * timer that says so (`source: 'timer'`).
 */
export interface BeatStart {
  type: 'start'
  /** Schedule period, ms. */
  periodMs: number
}
export interface BeatStop {
  type: 'stop'
}
/** One beat: when it was DUE, absolute (timeOrigin + schedule), and how late
 *  the worker's own timer was serving it — subtracted by the main thread, so a
 *  starved worker is never charged to the main thread. */
export interface Beat {
  due: number
  workerLateMs: number
  seq: number
}

const ORIGIN = performance.timeOrigin

let timer: ReturnType<typeof setTimeout> | null = null
let seq = 0
let start = 0
let period = 16

function tick(): void {
  const now = performance.now()
  seq++
  const due = start + seq * period
  const beat: Beat = { due: ORIGIN + due, workerLateMs: Math.max(0, now - due), seq }
  ;(self as unknown as Worker).postMessage(beat)
  // ABSOLUTE SCHEDULE, NOT A REPEATING DELAY: after a stall the schedule is
  // where it always was, so the next beat is due immediately and the lateness
  // it reports is the real one. A `setInterval` here would quietly absorb the
  // stall into its own cadence, which is the bug this instrument exists to see.
  let next = start + (seq + 1) * period
  if (next <= now) {
    // The schedule is behind by more than a period (the worker itself was
    // starved, or the machine slept). Catching up would fire a burst of beats
    // the main thread never owed anyone, so re-anchor and count the loss: the
    // main thread's `missed` reads it off the sequence numbers.
    seq = Math.ceil((now - start) / period)
    next = start + (seq + 1) * period
  }
  timer = setTimeout(tick, next - now)
}

self.onmessage = (ev: MessageEvent<BeatStart | BeatStop>) => {
  const msg = ev.data
  if (msg.type === 'start') {
    period = Math.max(4, msg.periodMs)
    start = performance.now()
    seq = 0
    timer = setTimeout(tick, period)
  } else if (msg.type === 'stop') {
    if (timer !== null) clearTimeout(timer)
    timer = null
    self.close()
  }
}
