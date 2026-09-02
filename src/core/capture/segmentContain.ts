/**
 * H1 — A COMPONENT DEATH IS A SEAM, NOT A DEAD TAKE.
 *
 * Until this module a raw channel whose encoder or worker died mid-take was
 * over: `onFatal` emitted one `channel-error` toast — "video saved up to this
 * point only" — and the channel's file simply stopped while the take went on
 * pretending to record it. Nothing reopened it, nothing wrote down when it
 * happened, and the report card graded the resulting stump as a full channel.
 *
 * THE MOVE ITSELF IS NOT NEW AND THAT IS THE WHOLE POINT. F6 built it for
 * pause/resume (close the segment, keep the device, open segment N+1 on the
 * same track) and O16 reused it verbatim for a resolution step. A component
 * death is that same move with a different trigger, so containment is a
 * DECISION module — this file — plus one generalised `containSegment` in
 * session.ts, and no new file surgery anywhere.
 *
 * WHAT THIS FILE DECIDES, and it is only ever "again, or not". The failure
 * modes it exists to refuse are the two that turn one dead encoder into a take
 * made of rubble:
 *
 *   · THE SPIN. An encoder that dies the instant it is configured (a codec the
 *     machine has just lost, a GPU reset in progress) would otherwise be
 *     reopened, die, be reopened... at whatever rate the reopen costs, forever.
 *     COOLDOWN_MS is the floor between two contains of one channel.
 *   · THE RUBBLE. Even at one contain per cooldown, an hour-long take against a
 *     permanently sick encoder is hundreds of files that each hold a second.
 *     MAX_PER_CHANNEL bounds it: past the budget the channel is CERTIFIED LOST
 *     (H4's ledger, the same sentence a dead device gets) and the take runs on
 *     with everything else — which is still the containment promise, just with
 *     the losing channel named instead of endlessly resurrected.
 *
 * Deliberately per-CHANNEL, not per-take: a sick camera must not spend the
 * screen's budget. And deliberately pure — no clock, no session, no DOM — so
 * the thrash rules are tested without recording anything, exactly as O16's
 * `stepVerdict` is.
 */

import type { ChannelKind } from '../types'

/**
 * Why a segment was closed early. Each one is a distinct entry point in the
 * code, which is what makes them worth telling apart in the certification:
 *
 *   'encoder-error'  the encoder itself reported failure — VideoEncoder's
 *                    `error` callback, or a muxer write that threw. The worker
 *                    is alive and posts `{event:'fatal'}` (measuredVideo.ts).
 *   'worker-death'   the WORKER died — `worker.onerror` on the main thread.
 *                    Nothing inside it can report anything ever again.
 *   'recorder-error' the MediaRecorder fallback lane fired its `error` event.
 */
export type ContainCause = 'encoder-error' | 'worker-death' | 'recorder-error'

/**
 * The floor between two contains of ONE channel. 1.5 s is not a comfort
 * margin — it is longer than a reopen costs (O16 measured the same move at
 * 30 ms, and its seam at 69 ms), so a channel that dies immediately on every
 * open burns its whole budget in ~6 s instead of in one frame, and the take
 * spends the rest of its length recording everything else.
 */
export const COOLDOWN_MS = 1500

/**
 * How many times ONE channel may be reopened in a take. Four, for the same
 * reason O16 stopped at eight steps: a bounded number of files is a take an
 * editor can open, and a channel that has died four times is not going to
 * start working. Past it the channel is certified lost rather than retried.
 */
export const MAX_PER_CHANNEL = 4

export interface ContainInput {
  kind: ChannelKind
  cause: ContainCause
  /** performance.now() at the failure. */
  nowMs: number
  /** When this channel was last contained, or null if never. */
  lastContainAtMs: number | null
  /** How many times this channel has already been contained in this take. */
  containsTaken: number
}

export interface ContainVerdict {
  /** One line for the console and the seam ledger. */
  why: string
}

/**
 * Should this channel be reopened? `null` = no, and the caller then treats the
 * channel as lost for the rest of the take (H4's ledger says so on screen and
 * in the report card).
 */
export function containVerdict(input: ContainInput): ContainVerdict | null {
  const { kind, cause, nowMs, lastContainAtMs, containsTaken } = input
  if (containsTaken >= MAX_PER_CHANNEL) return null
  if (lastContainAtMs !== null && nowMs - lastContainAtMs < COOLDOWN_MS) return null
  return {
    why: `${kind} ${cause} — segment ${containsTaken + 1} closed, opening segment ${containsTaken + 2}`,
  }
}

/** The sentence for a channel whose containment budget is spent. */
export function exhaustedWhy(kind: ChannelKind, cause: ContainCause): string {
  return (
    `${kind} ${cause} again after ${MAX_PER_CHANNEL} contained segments — ` +
    `not reopening it; the channel is certified lost and the take continues`
  )
}
