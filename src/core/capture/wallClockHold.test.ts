import { describe, expect, it } from 'vitest'
import {
  WallClockHold,
  compressInterleaved,
  compressPlanar,
  type WallClockHoldOpts,
} from './wallClockHold'

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
      const pad = hold.correctionFramesFor(step.arrivalMs, timeline, BATCH)
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

/**
 * One hour of quanta at a given audio-clock error against the wall. This is the
 * instrument Robert's report is answered with, so it drives the SHIPPED class the
 * capture paths use, not a copy of its arithmetic.
 */
function hour(ppm: number, opts: Partial<WallClockHoldOpts> = {}) {
  const hold = new WallClockHold({ sampleRate: RATE, ...opts })
  const batchWallMs = BATCH_MS / (1 + ppm / 1e6)
  let timeline = 0
  let padded = 0
  let trimmed = 0
  let wall = 0
  const batches = Math.round(3600_000 / batchWallMs)
  for (let i = 0; i < batches; i++) {
    wall += batchWallMs
    const c = hold.correctionFramesFor(wall, timeline, BATCH)
    if (c > 0) padded += c
    if (c < 0) trimmed += -c
    timeline += c + BATCH
  }
  return {
    driftMs: (timeline / RATE) * 1000 - wall,
    paddedMs: (padded / RATE) * 1000,
    trimmedMs: (trimmed / RATE) * 1000,
  }
}

describe('WallClockHold holds BOTH directions (Robert 2026-08-29)', () => {
  it('a FAST audio clock no longer drifts a second late across an hour', () => {
    // The defect exactly as Robert reported it: +278 ppm ended +1001 ms late with
    // the pad-only class, and nothing in the app could see it.
    const r = hour(278)
    expect(r.trimmedMs).toBeGreaterThan(800)
    expect(Math.abs(r.driftMs)).toBeLessThan(100)
  })

  it('an ordinary +50 ppm clock is held too (it used to end 180 ms late)', () => {
    const r = hour(50)
    expect(Math.abs(r.driftMs)).toBeLessThan(100)
  })

  it('the SLOW direction still pads, exactly as before', () => {
    const r = hour(-278)
    expect(r.paddedMs).toBeGreaterThan(800)
    expect(r.trimmedMs).toBe(0)
    expect(Math.abs(r.driftMs)).toBeLessThan(100)
  })

  it('a perfect clock is still touched by nothing at all', () => {
    const r = hour(0)
    expect(r.paddedMs).toBe(0)
    expect(r.trimmedMs).toBe(0)
  })

  it('the correction never exceeds the rate limit that keeps it inaudible', () => {
    // 5000 ppm — far past anything real — must still be walked back at the cap
    // rather than yanked, or the trim becomes a pitch artefact instead of a fix.
    const hold = new WallClockHold({ sampleRate: RATE })
    let timeline = 0
    let wall = 0
    let worst = 0
    const batchWallMs = BATCH_MS / 1.005
    for (let i = 0; i < 20_000; i++) {
      wall += batchWallMs
      const c = hold.correctionFramesFor(wall, timeline, BATCH)
      if (c < 0) worst = Math.max(worst, -c / BATCH)
      timeline += c + BATCH
    }
    expect(worst).toBeLessThanOrEqual(0.002 + 1e-9)
  })

  it('tracks a drift even when the allowance is under one frame per batch', () => {
    // The carry branch: 0.0002 x 1024 = 0.2 frames of allowance per batch, so
    // without the sub-sample carry every batch would floor to zero and the
    // hold would silently do nothing at all.
    const r = hour(50, { maxTrimRatio: 0.0002 })
    expect(r.trimmedMs).toBeGreaterThan(80)
    expect(Math.abs(r.driftMs)).toBeLessThan(100)
  })

  it('a main-thread stall never trims (the queue drains, nothing is ahead)', () => {
    const hold = new WallClockHold({ sampleRate: RATE })
    const pre = steady(0, 240)
    const lastPre = pre[pre.length - 1]!.arrivalMs
    const burstAt = lastPre + 3000
    const queued = Math.round(3000 / BATCH_MS)
    let timeline = 0
    let trimmed = 0
    const drive = (arrivalMs: number, n = 1) => {
      for (let i = 0; i < n; i++) {
        const c = hold.correctionFramesFor(arrivalMs, timeline, BATCH)
        if (c < 0) trimmed += -c
        timeline += c + BATCH
      }
    }
    for (const s of pre) drive(s.arrivalMs)
    drive(burstAt, queued)
    for (const s of steady(burstAt, 300, 5)) drive(s.arrivalMs)
    expect(trimmed).toBe(0)
  })
})

describe('compressing a batch removes time without a splice', () => {
  it('keeps both endpoints and every channel, interleaved', () => {
    const frames = 1024
    const src = new Float32Array(frames * 2)
    for (let i = 0; i < frames; i++) {
      src[i * 2] = Math.sin((i / frames) * Math.PI * 2)
      src[i * 2 + 1] = -src[i * 2]!
    }
    const out = compressInterleaved(src, 2, frames, 2)
    expect(out.length).toBe((frames - 2) * 2)
    expect(out[0]).toBeCloseTo(src[0]!, 6)
    expect(out[out.length - 2]).toBeCloseTo(src[(frames - 1) * 2]!, 6)
    // No discontinuity: neighbouring samples of a resampled sine stay close.
    let maxStep = 0
    for (let i = 1; i < frames - 2; i++) maxStep = Math.max(maxStep, Math.abs(out[i * 2]! - out[(i - 1) * 2]!))
    expect(maxStep).toBeLessThan(0.02)
    // The second channel is still the inverse of the first.
    for (let i = 0; i < frames - 2; i++) expect(out[i * 2 + 1]).toBeCloseTo(-out[i * 2]!, 6)
  })

  it('keeps both endpoints and every channel, planar', () => {
    const frames = 512
    const src = new Float32Array(frames * 2)
    for (let i = 0; i < frames; i++) {
      src[i] = i / frames
      src[frames + i] = 1 - i / frames
    }
    const out = compressPlanar(src, 2, frames, 1)
    const outFrames = frames - 1
    expect(out.length).toBe(outFrames * 2)
    expect(out[0]).toBeCloseTo(0, 6)
    expect(out[outFrames - 1]).toBeCloseTo(src[frames - 1]!, 6)
    expect(out[outFrames]).toBeCloseTo(1, 6)
    expect(out[out.length - 1]).toBeCloseTo(src[frames * 2 - 1]!, 6)
  })
})
