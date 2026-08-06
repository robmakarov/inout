import { describe, expect, it } from 'vitest'
import { SourceLiveness, SOURCE_STALL_MS } from './sourceLiveness'

/** Feed a run of samples; collect the edges the detector reports. */
function run(
  det: SourceLiveness,
  samples: { t: number; time: number }[],
): { t: number; ev: string }[] {
  const out: { t: number; ev: string }[] = []
  for (const s of samples) {
    const ev = det.sample(s.t, s.time)
    if (ev) out.push({ t: s.t, ev })
  }
  return out
}

/** 30fps of a live source. */
function live(fromMs: number, count: number, startTime = 0): { t: number; time: number }[] {
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
function frozen(fromMs: number, count: number, at: number): { t: number; time: number }[] {
  return Array.from({ length: count }, (_, i) => ({ t: fromMs + i * 33, time: at }))
}

describe('SourceLiveness', () => {
  it('reports nothing while the source advances', () => {
    expect(run(new SourceLiveness(), live(0, 300))).toEqual([])
  })

  it('tolerates a static screen delivering only 1 keep-alive frame per second', () => {
    // Chrome's capturer emits ~1fps when nothing on screen changes (measured).
    const det = new SourceLiveness()
    const samples: { t: number; time: number }[] = []
    for (let i = 0; i < 600; i++) {
      samples.push({ t: i * 33, time: Math.floor((i * 33) / 1000) })
    }
    expect(run(det, samples)).toEqual([])
    expect(det.stalled).toBe(false)
  })

  it('fires stalled exactly once, at the threshold', () => {
    const det = new SourceLiveness(SOURCE_STALL_MS)
    const events = run(det, [...live(0, 30), ...frozen(990, 300, mediaTime(0, 29))])
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
      ...live(0, 10),
      ...frozen(330, 60, mediaTime(0, 9)), // ~2s frozen -> stalled
      ...live(2310, 10, 0.3), // back -> resumed
      ...frozen(2640, 60, mediaTime(0.3, 9)), // frozen again -> stalled
    ])
    expect(events.map((e) => e.ev)).toEqual(['stalled', 'resumed', 'stalled'])
  })

  it('never stalls on the very first sample (no history yet)', () => {
    const det = new SourceLiveness(1)
    expect(det.sample(0, 0)).toBeNull()
    expect(det.sample(10_000, 0)).toBe('stalled')
  })

  it('measures how long the source has been frozen', () => {
    const det = new SourceLiveness(1000)
    run(det, [...live(0, 10), ...frozen(330, 60, mediaTime(0, 9))])
    expect(det.stalled).toBe(true)
    expect(det.stalledForMs(5297)).toBe(5000)
    det.sample(5330, 0.33)
    expect(det.stalledForMs(5330)).toBe(0)
  })
})
