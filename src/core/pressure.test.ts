/**
 * The pressure instrument — the units that pin what the rig measured.
 *
 * Every number in here is from `npm run exp -- pressure` on 2026-09-01, and the
 * two that look like taste are the two the first version of this file got
 * wrong: encode latency normalised against a FRAME (idle read `critical`), and
 * worker lateness scored on the WORST tick (an idle machine produced a 81 ms
 * tick against a 16.7 ms frame).
 */
import { describe, expect, it } from 'vitest'
import {
  CRITICAL_AT,
  FAIR_AT,
  HARDWARE_BLOCKS,
  SERIOUS_AT,
  SIGNAL_BLOCK,
  atLeast,
  readPressure,
  type PressureSignals,
} from './pressure'

/** A healthy 60 fps composite, at the medians the idle cells measured. */
const healthy: PressureSignals = {
  intervalMs: 250,
  frameBudgetMs: 1000 / 60,
  queueMean: 0,
  queueCliff: 6,
  encodeLatencyMs: 11.3,
  workerLateMeanMs: 0.32,
  workerLateMaxMs: 1.55,
  perFrameCostMs: 1.0,
  gpuPerFrameMs: null,
  stale: 0,
  arrivals: 22,
  dropped: 0,
  burst: 0,
  platform: null,
}

/** …and the same take with three 1440p60 encoders beside it. */
const starving: PressureSignals = {
  ...healthy,
  queueMean: 4.5,
  encodeLatencyMs: 285.3,
  workerLateMeanMs: 0.46,
  perFrameCostMs: 3.2,
}

describe('readPressure', () => {
  it('reads an idle 60 fps take as nominal, with room to spare', () => {
    const r = readPressure(healthy)
    expect(r.level).toBe('nominal')
    // The worst strain any of ~350 idle samples produced was 0.303.
    expect(r.strain).toBeLessThan(FAIR_AT)
    expect(r.blind).toBe(false)
  })

  it('reads a starving take as critical and NAMES the signal', () => {
    const r = readPressure(starving)
    expect(r.level).toBe('critical')
    expect(r.strain).toBeGreaterThanOrEqual(CRITICAL_AT)
    expect(r.leader).not.toBeNull()
    expect(r.line).toContain(r.leader!.signal)
  })

  it('does NOT normalise encode latency against one frame — an encoder pipelines', () => {
    // 19.2 ms of residence per 16.7 ms frame is a HEALTHY 60 fps take; the first
    // version of this scored it 1.15 and stepped an idle machine down.
    const r = readPressure({ ...healthy, encodeLatencyMs: 19.2 })
    expect(r.level).toBe('nominal')
    const latency = r.contributions.find((c) => c.signal === 'encode-latency')!
    // …against the pipeline it can actually hold: 6 frames x 16.7 ms.
    expect(latency.strain).toBeCloseTo(19.2 / (6 * (1000 / 60)), 3)
  })

  it('scores the MEAN worker tick, not the worst — the worst is noise at idle', () => {
    const r = readPressure({ ...healthy, workerLateMaxMs: 81 })
    expect(r.level).toBe('nominal')
    expect(r.contributions.some((c) => c.signal === 'worker-lateness' && c.strain > 1)).toBe(false)
  })

  it('lets the WORST signal decide, so one failing dimension cannot be averaged away', () => {
    const r = readPressure({ ...healthy, queueMean: 5.4 })
    expect(r.leader?.signal).toBe('encoder-queue')
    // 5.4 of the 6 that make the encoder start refusing: 0.90, serious.
    expect(r.level).toBe('serious')
    expect(readPressure({ ...healthy, queueMean: 6 }).level).toBe('critical')
  })

  it('reports an unread signal as unmeasured — never as a zero that reads healthy', () => {
    const r = readPressure({ ...healthy, queueMean: null, encodeLatencyMs: null })
    expect(r.unmeasured).toContain('encoder-queue')
    expect(r.unmeasured).toContain('encode-latency')
    expect(r.contributions.some((c) => c.signal === 'encoder-queue')).toBe(false)
  })

  it('is blind, not nominal, when nothing at all could be read', () => {
    const r = readPressure({
      ...healthy,
      queueMean: null,
      encodeLatencyMs: null,
      workerLateMeanMs: null,
      perFrameCostMs: null,
      stale: null,
      arrivals: null,
      dropped: null,
    })
    expect(r.blind).toBe(true)
    expect(r.line).toContain('UNREADABLE')
  })

  it('never says nominal about an interval that already lost frames', () => {
    const r = readPressure({ ...healthy, dropped: 3 })
    expect(r.level).toBe('critical')
    expect(r.line).toContain('already dropped')
  })

  it('a static screen is health, not collapse (P0-ladder-static)', () => {
    // getDisplayMedia emits ON CHANGE: nothing arrived, nothing was submitted,
    // nothing was encoded. Every quotient is null and the reading must not fire.
    const r = readPressure({
      ...healthy,
      queueMean: null,
      encodeLatencyMs: null,
      perFrameCostMs: null,
      stale: null,
      arrivals: null,
      workerLateMeanMs: 0.3,
    })
    expect(r.level).toBe('nominal')
    expect(r.blind).toBe(false)
  })

  it('takes the platform reading when a visible consumer has one', () => {
    const r = readPressure({ ...healthy, platform: 'critical' })
    expect(r.level).toBe('critical')
    expect(r.leader?.signal).toBe('platform')
  })

  it('bands stay ordered', () => {
    expect(FAIR_AT).toBeLessThan(SERIOUS_AT)
    expect(SERIOUS_AT).toBeLessThan(CRITICAL_AT)
    expect(atLeast('serious', 'fair')).toBe(true)
    expect(atLeast('fair', 'serious')).toBe(false)
  })
})

describe('E2 — the reading is also PER HARDWARE BLOCK', () => {
  it('names the block that is under pressure, and leaves the others alone', () => {
    const r = readPressure({ ...healthy, queueMean: 6, encodeLatencyMs: 11.3 })
    expect(r.level).toBe('critical')
    expect(r.blocks.encoder.level).toBe('critical')
    expect(r.blocks.encoder.leader?.signal).toBe('encoder-queue')
    // The CPU signals in `healthy` are idle: unloading the CPU would not help.
    expect(r.blocks.cpu.level).toBe('nominal')
    expect(r.blocks.cpu.measured).toBe(true)
  })

  it('reports an unread block as UNMEASURED, never as nominal (R1)', () => {
    const r = readPressure(healthy)
    // gpuPerFrameMs is null unless the worker was asked to fence, and no disk
    // signal exists at all — saying "fine" about either would be a lie.
    expect(r.blocks.gpu.measured).toBe(false)
    expect(r.blocks.disk.measured).toBe(false)
    expect(r.unmeasured).toContain('gpu-cost')
  })

  it('puts a dropped frame on the ENCODER, which is what refused it', () => {
    const r = readPressure({ ...healthy, dropped: 3 })
    expect(r.blocks.encoder.level).toBe('critical')
    expect(r.blocks.cpu.level).toBe('nominal')
  })

  it('A1s lesson: a machine critical ELSEWHERE is not this take being critical', () => {
    // `platform` is the browser's whole-machine hint. It reds the reading — the
    // unseen work genuinely should be shed for it — but `ownLevel` stays low,
    // and `ownLevel` is what the frame rate answers to (captureLadder rule 8b).
    const r = readPressure({ ...healthy, platform: 'critical' })
    expect(r.level).toBe('critical')
    expect(r.ownLevel).toBe('nominal')
    expect(r.ownLeader?.signal).not.toBe('platform')
  })

  it('…and our OWN encoder at the cliff moves ownLevel too', () => {
    const r = readPressure({ ...healthy, queueMean: 6 })
    expect(r.ownLevel).toBe('critical')
    expect(r.ownLeader?.signal).toBe('encoder-queue')
  })

  it('scores the GPU block when the fence is on', () => {
    const r = readPressure({ ...healthy, gpuPerFrameMs: 20 })
    expect(r.blocks.gpu.measured).toBe(true)
    expect(r.blocks.gpu.level).toBe('critical')
    expect(r.leader?.signal).toBe('gpu-cost')
  })

  it('every signal declares a block — a new one cannot slip in unclassified', () => {
    const r = readPressure({ ...healthy, gpuPerFrameMs: 1, platform: 'nominal' })
    for (const c of r.contributions) {
      expect(SIGNAL_BLOCK[c.signal]).toBeDefined()
      expect(HARDWARE_BLOCKS).toContain(c.block)
    }
  })
})
