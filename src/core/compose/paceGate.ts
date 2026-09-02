/**
 * THE THROTTLE A BACKGROUND RENDER ACTUALLY OBEYS — task F16b.
 *
 * `core/backgroundWork.ts` decides WHAT a background job may spend; this is
 * the thing the render loop awaits to spend it. It is deliberately a tiny,
 * pure-ish mechanism with no opinion of its own, because it runs in two places
 * that cannot share module state — the export worker (which is told the pace by
 * message) and the in-thread fallback render (which reads the broker directly).
 * One mechanism, two sources, so the two can never drift.
 *
 * HOW IT PACES. The render calls `wait()` at every chunk boundary. At `full`
 * that is a synchronous no-op and costs nothing — this is the same call a
 * user-visible export makes, so it must be free. Below full, the gate lets the
 * job WORK for a slice and then SLEEPS for as long as the duty cycle says,
 * which is what "paces itself in chunks" means: the machine gets the gaps, not
 * a slower render. At `paused` it sleeps until the pace changes.
 *
 * WHY IT GIVES UP EVENTUALLY. A paused render is not free: it holds its
 * decoders, its encoder queue and its scratch open, and this machine has 8 GB.
 * A job shed without a break for PAUSE_BUDGET_MS while a take runs is worth less
 * than the memory it is sitting on — so it aborts, and the export falls
 * through to rendering on demand, which is F16's permanent contract (a
 * pre-render may only ever SAVE time). It says so on the console.
 */
import type { PaceSource, WorkPace } from '@core/types'
import { PACE_DUTY } from '@core/backgroundWork'

/** How long the job works before the gate makes it rest, ms. Short enough that
 *  a take never waits a whole chunk for the machine, long enough that the
 *  sleep/wake overhead is noise against it. */
export const WORK_SLICE_MS = 100

/** Unbroken pause after which a shed job stops existing (see above). */
export const PAUSE_BUDGET_MS = 120_000

/** Thrown when the pause budget runs out. Named AbortError on purpose: every
 *  caller already treats an abort as "this render is not coming", and this is
 *  exactly that. */
export function pauseBudgetAbort(): DOMException {
  return new DOMException('background render gave up its pause budget', 'AbortError')
}

export interface PaceGate {
  /** Awaited by the render at every chunk boundary. */
  wait(): Promise<void> | void
  /** Wall clock this gate has spent asleep, ms — evidence, not bookkeeping. */
  restedMs(): number
  /** How long it has been continuously paused, ms; 0 when it is not. */
  pausedForMs(): number
  /** Release the subscription. */
  dispose(): void
}

export interface PaceGateOptions {
  /** The render's own abort. A gate that could not see it would keep a
   *  cancelled job asleep inside its own nap — the cancel-reaches-nothing
   *  defect this project has already paid for once (F16's join). */
  signal?: AbortSignal
  /** Called once, if the pause budget runs out, before `wait()` throws. */
  onGiveUp?: (pausedMs: number) => void
  /** Override for PAUSE_BUDGET_MS. A test (and a rig) has to be able to reach
   *  the give-up path without sitting through two minutes of it. */
  pauseBudgetMs?: number
}

/** Build a gate over a pace source. */
export function createPaceGate(source: PaceSource, opts: PaceGateOptions = {}): PaceGate {
  const { signal, onGiveUp } = opts
  const budgetMs = opts.pauseBudgetMs ?? PAUSE_BUDGET_MS
  let level: WorkPace = source.level()
  let wake: (() => void) | null = null
  const unsubscribe = source.subscribe((next) => {
    level = next
    // A pace CHANGE wakes a sleeping job immediately — a paused render that
    // waited out its own timer would ramp back a quarter second late for no
    // reason, and the ramp back is half of what elastic means.
    wake?.()
  })
  const onAbort = (): void => wake?.()
  signal?.addEventListener('abort', onAbort)

  let workedSinceRestMs = 0
  let lastWaitAt = now()
  let restedMs = 0
  let pausedSince: number | null = null
  let gaveUp = false

  function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now()
  }

  /** Sleep, but wake early when the pace changes. */
  async function nap(ms: number): Promise<void> {
    const t0 = now()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, ms)
      wake = finish
      function finish(): void {
        clearTimeout(timer)
        wake = null
        resolve()
      }
    })
    restedMs += now() - t0
  }

  return {
    wait(): Promise<void> | void {
      const t = now()
      workedSinceRestMs += t - lastWaitAt
      lastWaitAt = t
      if (level === 'full') {
        pausedSince = null
        workedSinceRestMs = 0
        return
      }
      return (async () => {
        while (level === 'paused' && !signal?.aborted) {
          pausedSince = pausedSince ?? now()
          if (now() - pausedSince >= budgetMs) {
            if (!gaveUp) {
              gaveUp = true
              onGiveUp?.(Math.round(now() - pausedSince))
            }
            throw pauseBudgetAbort()
          }
          // 250 ms is the pressure tick: waking faster than the instrument
          // updates would be polling for its own sake. A real change wakes
          // this early through `wake`.
          await nap(250)
        }
        pausedSince = null
        if (signal?.aborted) return
        const duty = PACE_DUTY[level]
        if (duty >= 1 || workedSinceRestMs < WORK_SLICE_MS) {
          lastWaitAt = now()
          return
        }
        // Worked one slice; rest for what the duty cycle owes.
        const rest = Math.round(workedSinceRestMs * (1 / duty - 1))
        workedSinceRestMs = 0
        await nap(rest)
        lastWaitAt = now()
      })()
    },
    restedMs: () => Math.round(restedMs),
    pausedForMs: () => (pausedSince === null ? 0 : Math.round(now() - pausedSince)),
    dispose: () => {
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
      wake?.()
    },
  }
}
