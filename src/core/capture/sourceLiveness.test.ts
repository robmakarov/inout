import { describe, expect, it } from 'vitest'
import { SourceLiveness, SOURCE_STALL_MS } from './sourceLiveness'

/**
 * The contract after 2026-08-25 (PO: "message about frozen screen is
 * bullshit"): frame silence alone NEVER fires the banner — a static screen on
 * the frame-driven v2 path legitimately delivers nothing. Frozen requires the
 * browser's own verdict (`track.muted` / not live) AND the silence. Both edges
 * follow the same authority.
 */

/** Feed a run of samples; collect the edges the detector reports.
 * `live` per sample = the browser's word on the SOURCE (default healthy). */
function run(
  det: SourceLiveness,
  samples: { t: number; time: number; live?: boolean }[],
): { t: number; ev: string }[] {
  const out: { t: number; ev: string }[] = []
  for (const s of samples) {
    const ev = det.sample(s.t, s.time, s.live ?? true)
    if (ev) out.push({ t: s.t, ev })
  }
  return out
}

/** 30fps of a live source. */
function playing(fromMs: number, count: number, startTime = 0): { t: number; time: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    t: fromMs + i * 33,
    time: mediaTime(startTime, i),
  }))
}

/** Media clock of the i-th frame — shared so a freeze holds the EXACT last
 * value (0.297 !== 9 * 0.033 in binary floating point). */
function mediaTime(startTime: number, i: number): number {
  return startTime + i * 0.033
}

/** Ticks that keep arriving while the media clock is frozen. */
function silent(
  fromMs: number,
  count: number,
  at: number,
  live: boolean,
): { t: number; time: number; live: boolean }[] {
  return Array.from({ length: count }, (_, i) => ({ t: fromMs + i * 33, time: at, live }))
}

describe('SourceLiveness', () => {
  it('reports nothing while the source advances', () => {
    expect(run(new SourceLiveness(), playing(0, 300))).toEqual([])
  })

  it('a static screen — frame silence from a HEALTHY source — is never frozen', () => {
    // The exact false positive PO hit on real takes: v2 is frame-driven, a
    // still screen delivers nothing, and the track stays unmuted throughout.
    const det = new SourceLiveness()
    const events = run(det, [
      ...playing(0, 30),
      ...silent(990, 900, mediaTime(0, 29), true), // ~30s of stillness, healthy
    ])
    expect(events).toEqual([])
    expect(det.stalled).toBe(false)
  })

  it('fires stalled exactly once, at the threshold, when the browser says the source is sick', () => {
    const det = new SourceLiveness(SOURCE_STALL_MS)
    const events = run(det, [
      ...playing(0, 30),
      ...silent(990, 300, mediaTime(0, 29), false), // muted: minimised window
    ])
    expect(events).toHaveLength(1)
    expect(events[0]!.ev).toBe('stalled')
    // last advance was the final live sample at t=957; +3000ms
    expect(events[0]!.t).toBeGreaterThanOrEqual(957 + SOURCE_STALL_MS)
    expect(events[0]!.t).toBeLessThan(957 + SOURCE_STALL_MS + 40)
    expect(det.stalled).toBe(true)
  })

  it('fires resumed once when frames come back, and can stall again', () => {
    const det = new SourceLiveness(1000)
    const events = run(det, [
      ...playing(0, 10),
      ...silent(330, 60, mediaTime(0, 9), false), // ~2s muted -> stalled
      ...playing(2310, 10, 0.3), // back -> resumed
      ...silent(2640, 60, mediaTime(0.3, 9), false), // muted again -> stalled
    ])
    expect(events.map((e) => e.ev)).toEqual(['stalled', 'resumed', 'stalled'])
  })

  it('resumes when the browser heals the source, even before any content changes', () => {
    const det = new SourceLiveness(1000)
    const events = run(det, [
      ...playing(0, 10),
      ...silent(330, 60, mediaTime(0, 9), false), // muted -> stalled
      ...silent(2310, 10, mediaTime(0, 9), true), // unmuted, still static -> resumed
    ])
    expect(events.map((e) => e.ev)).toEqual(['stalled', 'resumed'])
    expect(det.stalled).toBe(false)
  })

  it('a brief mute inside the threshold never fires — window drags flicker the flag', () => {
    const det = new SourceLiveness(SOURCE_STALL_MS)
    const events = run(det, [
      ...playing(0, 10),
      ...silent(330, 30, mediaTime(0, 9), false), // ~1s muted, under threshold
      ...playing(1320, 30, 0.3),
    ])
    expect(events).toEqual([])
  })

  it('never stalls on the very first sample (no history yet)', () => {
    const det = new SourceLiveness(1)
    expect(det.sample(0, 0, false)).toBeNull()
    expect(det.sample(10_000, 0, false)).toBe('stalled')
  })

  it('measures how long the source has been frozen', () => {
    const det = new SourceLiveness(1000)
    run(det, [...playing(0, 10), ...silent(330, 60, mediaTime(0, 9), false)])
    expect(det.stalled).toBe(true)
    expect(det.stalledForMs(5297)).toBe(5000)
    det.sample(5330, 0.33)
    expect(det.stalledForMs(5330)).toBe(0)
  })
})
