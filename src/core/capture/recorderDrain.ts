/**
 * THE TAIL DRAIN — one implementation, both MediaRecorder paths.
 *
 * MediaRecorder is a black box at stop: whatever it has not encoded when you
 * call stop() is gone. Under load that is seconds of the user's take (task
 * P0-tail measured 2734 ms missing off the end of a 4K composite). The fix, in
 * two halves:
 *
 *   1. CUT THE SOURCE. The backlog can only be drained if it is finite. For the
 *      composite that means stop painting; for a raw channel it means ending the
 *      track (the caller's job — see session.ts / liveComposite.ts).
 *   2. PROBE, DON'T WAIT. requestData() flushes what has been encoded so far, so
 *      an EMPTY answer is real evidence that the queue is empty. Waiting for the
 *      byte flow to go quiet instead looks equivalent and is not: under 4K load
 *      this recorder emits about four chunks in ten seconds, so "no bytes for
 *      200 ms" is true almost immediately and proves nothing. That version was
 *      measured at 150/198/579 ms — better than shipped, and still wrong.
 *
 * A drain that runs out of budget is REPORTED (timedOut), never silently
 * shipped: it means the encoder was still behind when we ran out of patience,
 * i.e. the end of that take is not in the file.
 */

/** The slice of MediaRecorder a drain actually needs — so a test can fake it. */
export interface DrainableRecorder {
  readonly state: RecordingState
  requestData(): void
}

export interface RecorderDrainStats {
  /** How long the drain waited. */
  drainMs: number
  /** Bytes that arrived during it — the tail the drain bought back. */
  drainedBytes: number
  /** True when the encoder was STILL emitting when the budget ran out. */
  timedOut: boolean
}

export interface RecorderDrainOptions {
  /** Never wait longer than this, however far behind the encoder is. */
  budgetMs?: number
  /** Gap between probes. */
  pollMs?: number
  /** Consecutive empty probes that count as caught up. */
  idleProbes?: number
  /** Injected so unit tests do not spend real seconds. */
  sleep?: (ms: number) => Promise<void>
}

export const DRAIN_POLL_MS = 120
export const DRAIN_IDLE_PROBES = 2
export const DRAIN_BUDGET_MS = 2000

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Probe `recorder` until it answers empty (or the budget runs out).
 *
 * `emittedBytes` must count bytes the recorder has HANDED OVER, synchronously,
 * in ondataavailable — not bytes whose durable write has resolved. A counter
 * that only moves once the disk acknowledges is too late to steer the drain by,
 * and would read as "still busy" long after the encoder went quiet.
 */
export async function drainRecorder(
  recorder: DrainableRecorder,
  emittedBytes: () => number,
  opts: RecorderDrainOptions = {},
): Promise<RecorderDrainStats> {
  const budgetMs = opts.budgetMs ?? DRAIN_BUDGET_MS
  const pollMs = opts.pollMs ?? DRAIN_POLL_MS
  const idleProbes = opts.idleProbes ?? DRAIN_IDLE_PROBES
  const sleep = opts.sleep ?? realSleep
  const t0 = performance.now()
  const bytesAtStart = emittedBytes()
  if (recorder.state !== 'recording') {
    return { drainMs: 0, drainedBytes: 0, timedOut: false }
  }
  let idle = 0
  let selfStopped = false
  while (performance.now() - t0 < budgetMs) {
    const before = emittedBytes()
    try {
      recorder.requestData()
    } catch {
      // Already inactive — the recorder stopped itself, which an ended stream
      // makes it do. A self-stop FLUSHES, so this is a finished drain and not a
      // timeout; saying otherwise would mark healthy takes tailIncomplete.
      selfStopped = true
      break
    }
    await sleep(pollMs)
    if (emittedBytes() === before) {
      if (++idle >= idleProbes) break
    } else {
      idle = 0
    }
  }
  return {
    drainMs: Math.round(performance.now() - t0),
    drainedBytes: emittedBytes() - bytesAtStart,
    timedOut: !selfStopped && idle < idleProbes,
  }
}
