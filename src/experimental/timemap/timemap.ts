/**
 * EXPERIMENTAL — Monotone time-map algebra (Experiment 7a).
 *
 * Core claim: every time query in INOUT reduces to a piecewise-linear,
 * strictly monotone partial map from OUTPUT time to SOURCE time. The MVP's
 * EditState (one global trim + one keep-window per channel, unit rate) is the
 * single-segment special case. Multi-segment cuts, silence compression, speed
 * ramps and timelapse are all instances of the same structure.
 *
 * This module is pure: no I/O, no DOM, no imports from production code other
 * than the authoritative type contracts. It is validated in two ways:
 *   1. Algebra laws (composition, inversion, duration) — unit tests.
 *   2. Equivalence: compiling an EditState to a TimeMap reproduces
 *      channelSourceTimeAt exactly (property-style test against the
 *      production implementation).
 */

import type { EditState, Recording } from '@core/types'

/**
 * One segment: output [outStartMs, outEndMs) maps linearly to source starting
 * at srcStartMs with slope `rate` (source ms per output ms). rate > 0.
 */
export interface TimeSegment {
  outStartMs: number
  outEndMs: number
  srcStartMs: number
  rate: number
}

/** Segments sorted by outStartMs, non-overlapping in output. Gaps = inactive. */
export interface TimeMap {
  segments: TimeSegment[]
}

const EPS = 1e-9

function assertValid(map: TimeMap): void {
  let prevEnd = -Infinity
  for (const s of map.segments) {
    if (!(s.outEndMs > s.outStartMs)) throw new Error('timemap: empty segment')
    if (!(s.rate > 0)) throw new Error('timemap: non-positive rate')
    if (s.outStartMs < prevEnd - EPS) throw new Error('timemap: overlapping segments')
    prevEnd = s.outEndMs
  }
}

export function makeTimeMap(segments: TimeSegment[]): TimeMap {
  const sorted = [...segments].sort((a, b) => a.outStartMs - b.outStartMs)
  const map = { segments: sorted }
  assertValid(map)
  return map
}

/** Source time at output time t, or null when no segment covers t. */
export function sourceAt(map: TimeMap, outMs: number): number | null {
  // Binary search over segment starts.
  const segs = map.segments
  let lo = 0
  let hi = segs.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segs[mid]
    if (outMs < s.outStartMs) hi = mid - 1
    else if (outMs >= s.outEndMs) lo = mid + 1
    else return s.srcStartMs + (outMs - s.outStartMs) * s.rate
  }
  return null
}

/** Total covered output duration (sum of segment spans). */
export function outputSpanMs(map: TimeMap): number {
  return map.segments.reduce((sum, s) => sum + (s.outEndMs - s.outStartMs), 0)
}

/** End of the output timeline (0 when empty). */
export function outputEndMs(map: TimeMap): number {
  const last = map.segments[map.segments.length - 1]
  return last ? last.outEndMs : 0
}

/**
 * Compose: outer maps output→mid, inner maps mid→source.
 * Result maps output→source. This is how edits stack (e.g. a "tighten" pass
 * on top of a trim) without either renderer knowing about layering.
 */
export function compose(inner: TimeMap, outer: TimeMap): TimeMap {
  const result: TimeSegment[] = []
  for (const o of outer.segments) {
    // The outer segment covers mid-times [o.srcStartMs, midEnd).
    const midEnd = o.srcStartMs + (o.outEndMs - o.outStartMs) * o.rate
    for (const i of inner.segments) {
      const midLo = Math.max(o.srcStartMs, i.outStartMs)
      const midHi = Math.min(midEnd, i.outEndMs)
      if (midHi - midLo <= EPS) continue
      // Map the mid-interval back to the outer's output domain…
      const outLo = o.outStartMs + (midLo - o.srcStartMs) / o.rate
      const outHi = o.outStartMs + (midHi - o.srcStartMs) / o.rate
      // …and forward into the inner's source domain.
      const srcLo = i.srcStartMs + (midLo - i.outStartMs) * i.rate
      result.push({
        outStartMs: outLo,
        outEndMs: outHi,
        srcStartMs: srcLo,
        rate: o.rate * i.rate,
      })
    }
  }
  return makeTimeMap(result)
}

/**
 * Invert: swap output and source domains. Only valid because segments are
 * strictly monotone (rate > 0). Source-domain overlaps would make the inverse
 * multi-valued; we require the map to be injective in source (true for all
 * maps derived from cuts/ramps of a single source).
 */
export function invert(map: TimeMap): TimeMap {
  const inv = map.segments.map((s) => ({
    outStartMs: s.srcStartMs,
    outEndMs: s.srcStartMs + (s.outEndMs - s.outStartMs) * s.rate,
    srcStartMs: s.outStartMs,
    rate: 1 / s.rate,
  }))
  return makeTimeMap(inv)
}

/**
 * Re-pack segments so output time is contiguous from 0 (removes gaps).
 * This is the "cut list → playable timeline" step: after deleting ranges you
 * ripple the remaining material together.
 */
export function ripple(map: TimeMap): TimeMap {
  let cursor = 0
  const packed = map.segments.map((s) => {
    const span = s.outEndMs - s.outStartMs
    const seg = { outStartMs: cursor, outEndMs: cursor + span, srcStartMs: s.srcStartMs, rate: s.rate }
    cursor += span
    return seg
  })
  return makeTimeMap(packed)
}

/**
 * Delete source ranges from an identity-like map. `cuts` are [startMs, endMs)
 * in the map's OUTPUT domain; returns a rippled map. This is the primitive
 * behind multi-segment trims and "tighten" (silence removal).
 */
export function cutRanges(map: TimeMap, cuts: { startMs: number; endMs: number }[]): TimeMap {
  let out = map.segments
  for (const cut of [...cuts].sort((a, b) => a.startMs - b.startMs)) {
    const next: TimeSegment[] = []
    for (const s of out) {
      const lo = Math.max(s.outStartMs, cut.startMs)
      const hi = Math.min(s.outEndMs, cut.endMs)
      if (hi - lo <= EPS) {
        next.push(s)
        continue
      }
      if (lo - s.outStartMs > EPS) {
        next.push({ ...s, outEndMs: lo })
      }
      if (s.outEndMs - hi > EPS) {
        next.push({
          outStartMs: hi,
          outEndMs: s.outEndMs,
          srcStartMs: s.srcStartMs + (hi - s.outStartMs) * s.rate,
          rate: s.rate,
        })
      }
    }
    out = next
  }
  return ripple(makeTimeMap(out))
}

// ---------------------------------------------------------------------------
// Bridge from the production EditState model (proof of subset claim)
// ---------------------------------------------------------------------------

/**
 * Compile the production (Recording, EditState, channelId) triple into a
 * TimeMap from OUTPUT time to CHANNEL-LOCAL time. Mirrors the containment
 * rules documented in src/core/types.ts. The equivalence with
 * channelSourceTimeAt is asserted by tests, making the "EditState is the
 * single-segment special case" claim checkable instead of rhetorical.
 */
export function channelTimeMap(r: Recording, e: EditState, channelId: string): TimeMap {
  const channel = r.channels.find((c) => c.id === channelId)
  if (!channel) return makeTimeMap([])
  const edit = e.channels.find((ce) => ce.channelId === channelId)
  const enabled = edit ? edit.enabled : true
  const trimStartMs = edit ? edit.trimStartMs : 0
  const trimEndMs = edit ? edit.trimEndMs : channel.durationMs
  if (!enabled) return makeTimeMap([])

  // Channel's kept window on the recording timeline.
  const recLo = channel.startOffsetMs + Math.max(0, trimStartMs)
  const recHi = channel.startOffsetMs + Math.min(channel.durationMs, trimEndMs)
  // Intersect with the global output window.
  const lo = Math.max(recLo, e.globalTrimStartMs)
  const hi = Math.min(recHi, e.globalTrimEndMs)
  if (hi <= lo) return makeTimeMap([])

  return makeTimeMap([
    {
      outStartMs: lo - e.globalTrimStartMs,
      outEndMs: hi - e.globalTrimStartMs,
      srcStartMs: lo - channel.startOffsetMs,
      rate: 1,
    },
  ])
}
