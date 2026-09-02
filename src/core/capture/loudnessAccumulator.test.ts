import { describe, expect, it } from 'vitest'
import { MixLoudnessAccumulator } from './loudnessAccumulator'

const RATE = 48_000
const WINDOW = 4800

/**
 * Reference implementation: the exact statistic compose/audio measureMixLoudness
 * computes, over an already-summed mix. The accumulator has to agree with this
 * while seeing the same samples spread across channels and batches.
 */
function reference(left: Float32Array, right: Float32Array) {
  let peak = 0
  const windowRms: number[] = []
  let winSumSq = 0
  let winCount = 0
  for (let k = 0; k < left.length; k++) {
    const a = Math.abs(left[k]!)
    const b = Math.abs(right[k]!)
    const s = a > b ? a : b
    if (s > peak) peak = s
    const mid = 0.5 * (left[k]! + right[k]!)
    winSumSq += mid * mid
    if (++winCount === WINDOW) {
      windowRms.push(Math.sqrt(winSumSq / winCount))
      winSumSq = 0
      winCount = 0
    }
  }
  if (winCount > 0) windowRms.push(Math.sqrt(winSumSq / winCount))
  windowRms.sort((a, b) => a - b)
  const at = (q: number) =>
    windowRms.length ? windowRms[Math.min(windowRms.length - 1, Math.floor(q * windowRms.length))]! : 0
  return { peak, loudRms: at(0.9), floorRms: at(0.2) }
}

/** Speech-like: loud bursts over a quiet floor, so p90 and p20 differ. */
function makeSignal(frames: number, seed: number): Float32Array {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const t = i / RATE
    const speaking = Math.sin(2 * Math.PI * 0.7 * t + seed) > 0
    const env = speaking ? 0.3 : 0.004
    out[i] = env * Math.sin(2 * Math.PI * (200 + 60 * seed) * t)
  }
  return out
}

function feed(
  acc: MixLoudnessAccumulator,
  id: string,
  left: Float32Array,
  right: Float32Array,
  batch: number,
  offset = 0,
) {
  for (let i = 0; i < left.length; i += batch) {
    const n = Math.min(batch, left.length - i)
    acc.add(id, left.subarray(i, i + n), right.subarray(i, i + n), offset + i)
  }
}

describe('MixLoudnessAccumulator', () => {
  it('matches the probe statistic for a single channel fed in worklet-sized batches', () => {
    const frames = RATE * 4
    const l = makeSignal(frames, 1)
    const r = makeSignal(frames, 2)
    const acc = new MixLoudnessAccumulator({ sampleRate: RATE })
    acc.register('a')
    feed(acc, 'a', l, r, 1024)
    const got = acc.finish()
    const want = reference(l, r)
    expect(got.frames).toBe(frames)
    expect(got.degraded).toBe(false)
    expect(got.peak).toBeCloseTo(want.peak, 6)
    expect(got.loudRms).toBeCloseTo(want.loudRms, 6)
    expect(got.floorRms).toBeCloseTo(want.floorRms, 6)
  })

  it('sums two channels at unity, matching the probe over their mix', () => {
    const frames = RATE * 4
    const a = { l: makeSignal(frames, 1), r: makeSignal(frames, 2) }
    const b = { l: makeSignal(frames, 3), r: makeSignal(frames, 4) }
    const acc = new MixLoudnessAccumulator({ sampleRate: RATE })
    acc.register('a')
    acc.register('b')
    // Interleave the two channels' batches the way two live worklets would.
    const batch = 1024
    for (let i = 0; i < frames; i += batch) {
      const n = Math.min(batch, frames - i)
      acc.add('a', a.l.subarray(i, i + n), a.r.subarray(i, i + n), i)
      acc.add('b', b.l.subarray(i, i + n), b.r.subarray(i, i + n), i)
    }
    const got = acc.finish()
    const sumL = new Float32Array(frames)
    const sumR = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      sumL[i] = a.l[i]! + b.l[i]!
      sumR[i] = a.r[i]! + b.r[i]!
    }
    const want = reference(sumL, sumR)
    expect(got.channelIds.sort()).toEqual(['a', 'b'])
    expect(got.peak).toBeCloseTo(want.peak, 5)
    expect(got.loudRms).toBeCloseTo(want.loudRms, 5)
    expect(got.floorRms).toBeCloseTo(want.floorRms, 5)
  })

  it('holds the fold until every registered channel has passed a frame', () => {
    const frames = RATE * 2
    const a = makeSignal(frames, 1)
    const b = makeSignal(frames, 3)
    const acc = new MixLoudnessAccumulator({ sampleRate: RATE })
    acc.register('a')
    acc.register('b')
    // Channel a runs a quarter-second ahead the whole time — inside the ring.
    feed(acc, 'a', a, a, 1024)
    feed(acc, 'b', b, b, 1024)
    const got = acc.finish()
    const sum = new Float32Array(frames)
    for (let i = 0; i < frames; i++) sum[i] = a[i]! + b[i]!
    const want = reference(sum, sum)
    expect(got.degraded).toBe(false)
    expect(got.loudRms).toBeCloseTo(want.loudRms, 5)
  })

  it('offsets a late-starting channel onto the session timeline', () => {
    const frames = RATE
    const a = makeSignal(frames, 1)
    const acc = new MixLoudnessAccumulator({ sampleRate: RATE })
    acc.register('a')
    acc.register('b')
    feed(acc, 'a', a, a, 1024)
    // b starts 100 ms late and is silent; the mix is a shifted into a longer span.
    const silence = new Float32Array(frames)
    feed(acc, 'b', silence, silence, 1024, 4800)
    const got = acc.finish()
    expect(got.frames).toBe(frames + 4800)
    expect(got.peak).toBeCloseTo(reference(a, a).peak, 6)
  })

  it('degrades instead of stalling when a channel dies mid-take', () => {
    const frames = RATE * 6
    const a = makeSignal(frames, 1)
    const acc = new MixLoudnessAccumulator({ sampleRate: RATE, capacitySec: 1 })
    acc.register('a')
    acc.register('dead')
    feed(acc, 'a', a, a, 1024)
    const got = acc.finish()
    expect(got.degraded).toBe(true)
    expect(got.channelIds).toEqual(['a'])
    // The surviving channel's whole signal still made it into the statistic.
    expect(got.frames).toBe(frames)
    expect(got.peak).toBeCloseTo(reference(a, a).peak, 6)
  })

  it('keeps the envelope IN TIME ORDER, and its percentiles are that series sorted (X1)', () => {
    // Loud first, quiet second: if the returned series were the sorted one, it
    // would rise rather than fall, so the order is actually under test.
    const frames = RATE * 6
    const l = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      const loud = i < frames / 2
      l[i] = (loud ? 0.3 : 0.01) * Math.sin((2 * Math.PI * 220 * i) / RATE)
    }
    const acc = new MixLoudnessAccumulator({ sampleRate: RATE })
    acc.register('a')
    feed(acc, 'a', l, l, 1024)
    const got = acc.finish()

    expect(got.windowRms.length).toBe(frames / WINDOW)
    expect(got.windowPeak.length).toBe(got.windowRms.length)
    expect(got.windowMs).toBeCloseTo(100, 9)
    expect(got.windowRms[0]!).toBeGreaterThan(got.windowRms[got.windowRms.length - 1]!)

    // The scalars are the same series, sorted — same numbers, one order apart.
    const sorted = [...got.windowRms].sort((a, b) => a - b)
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
    expect(got.loudRms).toBeCloseTo(at(0.9), 6)
    expect(got.floorRms).toBeCloseTo(at(0.2), 6)
    const sortedPeak = [...got.windowPeak].sort((a, b) => a - b)
    expect(got.peakRobust).toBeCloseTo(
      sortedPeak[Math.min(sortedPeak.length - 1, Math.floor(0.99 * sortedPeak.length))]!,
      6,
    )
  })

  it('reports the grid ORIGIN, so a late-starting mix can be placed on the timeline', () => {
    const frames = RATE * 2
    const a = makeSignal(frames, 1)
    const acc = new MixLoudnessAccumulator({ sampleRate: RATE })
    acc.register('a')
    // Audio that began 1.5 s into the session.
    feed(acc, 'a', a, a, 1024, Math.round(1.5 * RATE))
    const got = acc.finish()
    expect(got.originFrame).toBe(Math.round(1.5 * RATE))
    expect(got.sampleRate).toBe(RATE)
    expect(got.windowRms.length).toBe(frames / WINDOW)
  })

  /**
   * H1 — A CONTAINED AUDIO SEGMENT IS FINISHED, NOT SLOW.
   *
   * Without `retire`, the closed segment stays a registered contributor at its
   * last sample and the fold cannot advance past it: the ring fills with the
   * successor's audio, overflows, and the whole take's loudness is marked
   * degraded by a channel that did exactly what it was told.
   */
  it('a retired segment stops holding the fold and keeps its contribution', () => {
    const frames = RATE * 6
    const a = makeSignal(frames, 1)
    const acc = new MixLoudnessAccumulator({ sampleRate: RATE, capacitySec: 1 })
    acc.register('seg1')
    // Segment 1 delivers half a second, then its encoder dies and it is closed.
    feed(acc, 'seg1', a.subarray(0, RATE / 2), a.subarray(0, RATE / 2), 1024)
    acc.retire('seg1')
    // Segment 2 opens on the same device and runs the rest of the take.
    feed(acc, 'seg2', a.subarray(RATE / 2), a.subarray(RATE / 2), 1024, RATE / 2)
    const got = acc.finish()
    expect(got.degraded).toBe(false)
    // Both segments are still named as contributors — the sum covers both.
    expect(got.channelIds.sort()).toEqual(['seg1', 'seg2'])
    expect(got.frames).toBe(frames)
    expect(got.peak).toBeCloseTo(reference(a, a).peak, 6)
  })

  it('retiring an unknown id is a no-op', () => {
    const acc = new MixLoudnessAccumulator({ sampleRate: RATE })
    acc.retire('never-existed')
    expect(acc.channelIds).toEqual([])
  })

  it('reports zeros for a take that never delivered PCM', () => {
    const acc = new MixLoudnessAccumulator({ sampleRate: RATE })
    acc.register('a')
    const got = acc.finish()
    expect(got.frames).toBe(0)
    expect(got.loudRms).toBe(0)
    expect(got.channelIds).toEqual([])
  })
})
