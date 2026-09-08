import { describe, expect, it } from 'vitest'
import {
  LIVENESS_SAMPLE_MS,
  SOURCE_NEVER_DELIVERED_MS,
  SOURCE_STALL_MS,
  SourceLiveness,
} from './sourceLiveness'

/**
 * THE COMPOSITE ASKS THE FROZEN-SCREEN DETECTOR LESS OFTEN NOW (2026-09-08), and
 * this holds the only thing that was ever at stake in that: a person must see
 * the frozen warning, and its clearing, at the same moment as before.
 *
 * The old cadence was the audio tap's — 62.5 Hz with no audio connected, ~47 Hz
 * with it — and it cost 1.44-2.32 ms/s of main thread on the default take. The
 * new one is the detector's own. These drive the SAME detector down both
 * cadences over the same scenario and compare the verdicts.
 */

/** Run one scenario at a fixed sample interval; returns [timeMs, event] pairs. */
function run(
  intervalMs: number,
  durationMs: number,
  source: (tMs: number) => { mediaSec: number; live: boolean; delivered: boolean },
): [number, string][] {
  const det = new SourceLiveness()
  const events: [number, string][] = []
  for (let t = 0; t <= durationMs; t += intervalMs) {
    const s = source(t)
    const ev = det.sample(t, s.mediaSec, s.live, s.delivered)
    if (ev) events.push([t, ev])
  }
  return events
}

/** The old rate, for the comparison to mean anything: 6 render quanta at 48 kHz. */
const OLD_TICK_MS = (128 * 6) / 48
const OLD_BATCH_MS = 1024 / 48

describe('the frozen-screen detector at the cadence the composite now uses', () => {
  it('leaves enough samples inside the shortest decision it can make', () => {
    // Thirty of them. The margin is the claim; if either number ever moves, this
    // is the test that says whether the other one still works.
    expect(SOURCE_STALL_MS / LIVENESS_SAMPLE_MS).toBeGreaterThanOrEqual(20)
    expect(SOURCE_NEVER_DELIVERED_MS / LIVENESS_SAMPLE_MS).toBeGreaterThanOrEqual(20)
  })

  it('calls a screen that freezes at the same moment the old rate did', () => {
    // Frames advance until 2 s, then stop; the browser calls the track sick.
    const source = (t: number) => ({
      mediaSec: t < 2000 ? t / 1000 : 2,
      live: t < 2000,
      delivered: true,
    })
    const fast = run(OLD_TICK_MS, 12_000, source)
    const now = run(LIVENESS_SAMPLE_MS, 12_000, source)
    expect(now.map((e) => e[1])).toEqual(fast.map((e) => e[1]))
    expect(now[0]![1]).toBe('stalled')
    // WITHIN ONE SAMPLE, IN EITHER DIRECTION — and the direction is not always
    // the obvious one. Here the new rate fires 8 ms EARLIER (5000 ms against
    // 5008), because 3000 ms after the freeze falls between two 16 ms ticks and
    // the old grid had to wait for the next one. Both are the same moment to a
    // person; what would matter is a difference on the scale of the warning.
    expect(Math.abs(now[0]![0] - fast[0]![0])).toBeLessThanOrEqual(LIVENESS_SAMPLE_MS)
  })

  it('clears the warning within a tenth of a second of the source coming back', () => {
    const source = (t: number) => ({
      mediaSec: t < 2000 ? t / 1000 : t < 8000 ? 2 : (t - 6000) / 1000,
      live: t < 2000 || t >= 8000,
      delivered: true,
    })
    const fast = run(OLD_TICK_MS, 14_000, source)
    const now = run(LIVENESS_SAMPLE_MS, 14_000, source)
    expect(now.map((e) => e[1])).toEqual(['stalled', 'resumed'])
    expect(fast.map((e) => e[1])).toEqual(['stalled', 'resumed'])
    expect(Math.abs(now[1]![0] - fast[1]![0])).toBeLessThanOrEqual(LIVENESS_SAMPLE_MS)
  })

  it('still calls a camera that never delivers a frame dead, on time', () => {
    // H4's case: live, unmuted, and never one picture.
    const source = () => ({ mediaSec: 0, live: true, delivered: false })
    const fast = run(OLD_TICK_MS, 9000, source)
    const now = run(LIVENESS_SAMPLE_MS, 9000, source)
    expect(now.map((e) => e[1])).toEqual(['dead'])
    expect(fast.map((e) => e[1])).toEqual(['dead'])
    expect(now[0]![0]).toBeGreaterThanOrEqual(SOURCE_NEVER_DELIVERED_MS)
    expect(Math.abs(now[0]![0] - fast[0]![0])).toBeLessThanOrEqual(LIVENESS_SAMPLE_MS)
  })

  it('reaches the same verdicts from the audio-connected cadence too', () => {
    // With audio connected the tap posts every 1024 frames; the gate in
    // liveCompositeV2 thins those to LIVENESS_SAMPLE_MS. Both must agree.
    const source = (t: number) => ({
      mediaSec: t < 3000 ? t / 1000 : 3,
      live: t < 3000,
      delivered: true,
    })
    const batch = run(OLD_BATCH_MS, 12_000, source)
    const now = run(LIVENESS_SAMPLE_MS, 12_000, source)
    expect(now.map((e) => e[1])).toEqual(batch.map((e) => e[1]))
    expect(Math.abs(now[0]![0] - batch[0]![0])).toBeLessThanOrEqual(LIVENESS_SAMPLE_MS)
  })

  it('is a real thinning — the new rate asks far fewer times per take', () => {
    const perSecondOld = 1000 / OLD_TICK_MS
    const perSecondNow = 1000 / LIVENESS_SAMPLE_MS
    expect(perSecondOld / perSecondNow).toBeGreaterThanOrEqual(5)
  })
})
