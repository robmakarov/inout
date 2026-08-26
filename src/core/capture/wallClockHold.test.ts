import { describe, expect, it } from 'vitest'
import { WallClockHold } from './wallClockHold'

const RATE = 48_000
const BATCH = 1024 // ~21.3 ms, the worklet's own batch size
const BATCH_MS = (BATCH / RATE) * 1000

/** Drive the hold with a scripted arrival sequence; returns total padded ms. */
function run(
  hold: WallClockHold,
  script: { arrivalMs: number; batches?: number }[],
): { totalPadMs: number; pads: { atMs: number; padMs: number }[] } {
  let timeline = 0
  let totalPad = 0
  const pads: { atMs: number; padMs: number }[] = []
  for (const step of script) {
    for (let i = 0; i < (step.batches ?? 1); i++) {
      const pad = hold.padFramesFor(step.arrivalMs, timeline, BATCH)
      if (pad > 0) {
        totalPad += (pad / RATE) * 1000
        pads.push({ atMs: step.arrivalMs, padMs: (pad / RATE) * 1000 })
      }
      timeline += pad + BATCH
    }
  }
  return { totalPadMs: totalPad, pads }
}

/** Steady real-time batches from t0 for `count` batches, small fixed latency. */
function steady(t0: number, count: number, latencyMs = 5): { arrivalMs: number }[] {
  const out: { arrivalMs: number }[] = []
  for (let i = 0; i < count; i++) out.push({ arrivalMs: t0 + (i + 1) * BATCH_MS + latencyMs })
  return out
}

describe('WallClockHold', () => {
  it('pads nothing on a healthy take', () => {
    const hold = new WallClockHold({ sampleRate: RATE })
    const { totalPadMs } = run(hold, steady(0, 600)) // ~12.8 s of clean cadence
    expect(totalPadMs).toBe(0)
  })

  it('REGRESSION (measuredAudio ordering bug): steady cadence must set the origin, so a real loss pads', () => {
    // The shipped inline copy compared the arrival stamp against itself, so
    // steady was never true, the origin stayed Infinity and NOTHING ever
    // padded. This is the take that behavior lost: clean start, then the
    // context stops rendering for 600 ms (batches simply do not exist for
    // that stretch), then clean cadence resumes with the deficit standing.
    const hold = new WallClockHold({ sampleRate: RATE })
    const pre = steady(0, 240) // ~5.1 s
    const lastPre = pre[pre.length - 1]!.arrivalMs
    const post = steady(lastPre + 600, 240, 5)
    const { totalPadMs } = run(hold, [...pre, ...post])
    expect(totalPadMs).toBeGreaterThan(450)
    expect(totalPadMs).toBeLessThan(750)
  })

  it('REGRESSION (instantaneous pad): a main-thread stall whose queue drains pads NOTHING', () => {
    // 900 ms main-thread stall: no batches delivered, then the whole backlog
    // drains in one wake (same arrival stamp), timeline catching up as it
    // drains. Every sample exists — the old inline logic padded ~900 ms of
    // silence into it anyway.
    const hold = new WallClockHold({ sampleRate: RATE })
    const pre = steady(0, 240)
    const lastPre = pre[pre.length - 1]!.arrivalMs
    const burstAt = lastPre + 900
    const queued = Math.round(900 / BATCH_MS)
    const post = steady(burstAt, 240, 5)
    const { totalPadMs } = run(hold, [...pre, { arrivalMs: burstAt, batches: queued }, ...post])
    expect(totalPadMs).toBe(0)
  })

  it('a stall longer than the settle window still pads nothing when the queue drains', () => {
    const hold = new WallClockHold({ sampleRate: RATE })
    const pre = steady(0, 240)
    const lastPre = pre[pre.length - 1]!.arrivalMs
    const burstAt = lastPre + 3000
    const queued = Math.round(3000 / BATCH_MS)
    const post = steady(burstAt, 300, 5)
    const { totalPadMs } = run(hold, [...pre, { arrivalMs: burstAt, batches: queued }, ...post])
    expect(totalPadMs).toBe(0)
  })

  it('a real context stall DURING a delivery burst pads only the lost part', () => {
    // 1 s of wall time passes; only 400 ms of it was ever rendered (the rest
    // is a true loss), and the rendered part arrives as one burst.
    const hold = new WallClockHold({ sampleRate: RATE })
    const pre = steady(0, 240)
    const lastPre = pre[pre.length - 1]!.arrivalMs
    const burstAt = lastPre + 1000
    const rendered = Math.round(400 / BATCH_MS)
    const post = steady(burstAt, 300, 5)
    const { totalPadMs } = run(hold, [...pre, { arrivalMs: burstAt, batches: rendered }, ...post])
    expect(totalPadMs).toBeGreaterThan(400)
    expect(totalPadMs).toBeLessThan(800)
  })

  it('slow starvation (context renders ~95% of wall time) is padded back to the wall', () => {
    const hold = new WallClockHold({ sampleRate: RATE })
    // Each batch arrives 5% late relative to the audio it carries: after the
    // origin window, the timeline falls steadily behind the wall.
    const script: { arrivalMs: number }[] = []
    for (let i = 0; i < 1400; i++) script.push({ arrivalMs: (i + 1) * BATCH_MS * 1.05 + 5 })
    const { totalPadMs } = run(hold, script)
    const wall = 1400 * BATCH_MS * 1.05
    const lost = wall - 1400 * BATCH_MS
    // Some tail deficit is still settling when the script ends; the rest must
    // have been padded.
    expect(totalPadMs).toBeGreaterThan(lost * 0.6)
    expect(totalPadMs).toBeLessThan(lost * 1.1)
  })

  it('one batch may not conjure more than padMaxMs of silence', () => {
    const hold = new WallClockHold({ sampleRate: RATE, padMaxMs: 1000 })
    const pre = steady(0, 240)
    const lastPre = pre[pre.length - 1]!.arrivalMs
    const post = steady(lastPre + 5000, 400, 5)
    const { pads } = run(hold, [...pre, ...post])
    expect(pads.length).toBeGreaterThan(0)
    for (const p of pads) expect(p.padMs).toBeLessThanOrEqual(1000 + 1)
  })

  it('a startup catch-up burst does not date the origin early (no pad for time never lost)', () => {
    const hold = new WallClockHold({ sampleRate: RATE })
    // 500 ms of quanta delivered back-to-back at t=500 (context started late
    // and caught up), then steady cadence. Nothing was lost.
    const queued = Math.round(500 / BATCH_MS)
    const post = steady(500, 600, 5)
    const { totalPadMs } = run(hold, [{ arrivalMs: 500, batches: queued }, ...post])
    expect(totalPadMs).toBe(0)
  })

  it('the origin stops moving after its window (a lucky late batch cannot ratchet it)', () => {
    const hold = new WallClockHold({ sampleRate: RATE })
    // Steady cadence at 30 ms latency for the whole origin window, then the
    // latency drops to 1 ms (a "luckier" delivery path appears late in the
    // take). A still-open min-filter would ratchet the origin down 29 ms and
    // read every subsequent batch as behind; the closed window must not.
    const pre = steady(0, 240, 30)
    const lastPre = pre[pre.length - 1]!.arrivalMs
    const post = steady(lastPre, 600, 1)
    const { totalPadMs } = run(hold, [...pre, ...post])
    expect(totalPadMs).toBe(0)
  })
})
