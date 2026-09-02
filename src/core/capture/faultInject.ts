/**
 * H1 HARNESS KNOBS — KILL A COMPONENT, MID-TAKE, ON PURPOSE.
 *
 * H4 shipped `?dead=` and `?die=` for the two ways a DEVICE fails. These are
 * the two ways the machinery UNDER the device fails, and they are the gates H1
 * has to meet. They exist because the failures they stand for cannot be
 * arranged on demand — a hardware encoder does not fall over when you ask it
 * to, and a worker does not run out of memory to a schedule — and "it should
 * work" is not evidence in this repo.
 *
 *   ?killenc=screen:6000      the ENCODER reports failure 6 s after the press.
 *                             Delivered by having the raw-video worker call its
 *                             own `fail()`, which is literally the callback
 *                             `new VideoEncoder({ error })` fires and the same
 *                             one a throwing muxer write lands on. The worker
 *                             lives; the main thread learns through
 *                             `{event:'fatal'}` (measuredVideo.ts's onmessage).
 *                             Audio channels take the same knob through
 *                             measuredAudio's own `fatal()`.
 *
 *   ?killworker=screen:6000   the WORKER dies 6 s after the press. Delivered by
 *                             an uncaught throw inside it, which is the one
 *                             thing that reaches `worker.onerror` on the main
 *                             thread — a different entry point from the line
 *                             above, and the reason the two gates are separate.
 *                             The worker also stops encoding, so the file
 *                             genuinely ends there rather than merely reporting
 *                             that it did. Video kinds only: no audio channel
 *                             has a worker.
 *
 * MILLISECONDS ARE FROM THE RECORD PRESS, exactly as `?die=` measures them, so
 * a kill lands inside the take instead of during arming. That also makes them
 * ONE-SHOT for free: the segment opened to replace the killed one computes its
 * delay against the same deadline, finds it already past, and arms nothing —
 * which is what makes `?killenc=` a test of CONTAINMENT rather than a test of
 * the thrash budget. To exercise the budget instead, name the same kind twice
 * at different instants (`?killenc=screen:6000&killworker=screen:12000`).
 *
 * NOT gated on `?synthetic=1`. The whole value of inducing a fault is being
 * able to do it to a REAL screen share on real hardware, which is where the
 * drain and the reopen actually cost something. A flag nobody types is inert.
 */

import type { ChannelKind } from '../types'

export type FaultKnob = 'killenc' | 'killworker'

const VIDEO_KINDS = new Set<ChannelKind>(['screen', 'camera'])
const ALL_KINDS = new Set<ChannelKind>(['screen', 'camera', 'mic', 'system-audio'])

/** `screen:6000,mic:9000` → Map. Same grammar as `?die=`. */
export function parseFaults(search: string, knob: FaultKnob): Map<ChannelKind, number> {
  const out = new Map<ChannelKind, number>()
  const raw = new URLSearchParams(search).get(knob)
  if (!raw) return out
  const allowed = knob === 'killworker' ? VIDEO_KINDS : ALL_KINDS
  for (const part of raw.split(',')) {
    const [kind, ms] = part.split(':')
    const at = Number(ms)
    if (allowed.has(kind as ChannelKind) && Number.isFinite(at) && at >= 0) {
      out.set(kind as ChannelKind, at)
    }
  }
  return out
}

/**
 * How long from NOW until this kind's fault should fire, or null when there is
 * no knob for it or its instant has already passed. `elapsedMs` is how far the
 * take has run — the caller holds the epoch, this file holds no clock.
 */
export function faultDelayMs(kind: ChannelKind, knob: FaultKnob, elapsedMs: number): number | null {
  if (typeof location === 'undefined') return null
  const at = parseFaults(location.search, knob).get(kind)
  if (at === undefined) return null
  const delay = at - elapsedMs
  return delay > 0 ? delay : null
}
