import { afterEach, describe, expect, it } from 'vitest'
import { estimateFromCalibration, type Calibration } from './sizeProbe'
import { SKIP_PICTURE_MAX_BYTES } from './sameAsLast'
import { setSameAsLastOverride } from './sameAsLastFlag'
import { tierById } from './quality'

import type { Recording } from '@core/types'

/**
 * THE SIZE PROMISE HAS TO KNOW ABOUT J13, and this is the test that says so.
 *
 * The estimate prices a file as keyframes plus deltas. J13 made a large share
 * of those deltas cost twenty bytes instead of a delta each, so an estimate
 * that does not know about it promises a file about a third bigger than the one
 * the export makes — wrong in the direction that turns a size promise into a
 * lie. These pin both halves: that it is applied when the engine is armed, and
 * that it is NOT applied when it is off.
 */
/** A take whose own rate matches the step's, so `counted` is the whole story. */
const recording = {
  id: 'r',
  createdAt: 0,
  durationMs: 60_000,
  channels: [{ id: 'c', kind: 'screen', media: 'video', fps: tierFps(), durationMs: 60_000 }],
} as unknown as Recording
const tier = tierById('1080p')
function tierFps(): number {
  return tierById('1080p').fps
}

/** 5,000-byte deltas, 200,000-byte keyframes — screen-content proportions. */
function calibration(duplicateFraction: number): Calibration {
  const step = {
    tierId: tier.id,
    meanKeyframeBytes: 200_000,
    meanDeltaBytes: 5_000,
    samples: 2,
    firstKeyframeBytes: 200_000,
    firstDeltaBytes: 5_000,
    laterKeyframeBytes: 200_000,
    laterDeltaBytes: 5_000,
  }
  return {
    steps: { [tier.id]: step },
    sampledAtSec: [0],
    wallMs: 0,
    composeMs: 0,
    encodeMs: 0,
    activity: 1,
    chosenBy: 'middle',
    activityMs: 0,
    duplicateFraction,
  } as unknown as Calibration
}

afterEach(() => setSameAsLastOverride(null))

describe('the size estimate prices what the render actually writes', () => {
  it('is smaller when slots repeat, and exactly in proportion to how many', () => {
    setSameAsLastOverride(true)
    const none = estimateFromCalibration(recording, tier, 60_000, calibration(0))!
    const half = estimateFromCalibration(recording, tier, 60_000, calibration(0.5))!
    const all = estimateFromCalibration(recording, tier, 60_000, calibration(1))!
    expect(half.bytes).toBeLessThan(none.bytes)
    // Not free: the written pictures still cost their bound, so the keyframes
    // and the twenty-byte pictures keep the file well above nothing.
    expect(half.bytes).toBeGreaterThan(none.bytes / 2)
    // LINEAR IN THE FRACTION, which is the property worth pinning rather than a
    // ratio fitted to one set of numbers: half the duplicates saves half of
    // what all of them save. Within a byte of rounding.
    expect(none.bytes - half.bytes).toBeCloseTo((none.bytes - all.bytes) / 2, -1)
  })

  it('counts the slots a faster output invents, not just the ones the take omitted', () => {
    setSameAsLastOverride(true)
    // The SAME take at a step that runs twice its rate: every other slot is a
    // repeat before a single omitted tick has been counted. (The take's rate
    // cannot be halved instead — `normalizeRate` floors it at 30.)
    const fast = { ...tier, fps: tier.fps * 2 }
    const atTakeRate = estimateFromCalibration(recording, tier, 60_000, calibration(0))!
    const twiceAsFast = estimateFromCalibration(recording, fast, 60_000, calibration(0))!
    // Twice the slots, but the extra ones are twenty bytes each rather than
    // deltas, so the file barely grows — where without this it would double.
    expect(twiceAsFast.bytes).toBeLessThan(atTakeRate.bytes * 1.1)
    // And with the engine off it really does roughly double.
    setSameAsLastOverride(false)
    const offFast = estimateFromCalibration(recording, fast, 60_000, calibration(0))!
    expect(offFast.bytes).toBeGreaterThan(atTakeRate.bytes * 1.5)
  })

  it('ignores the fraction entirely when the engine is off — the pre-J13 answer', () => {
    setSameAsLastOverride(false)
    const none = estimateFromCalibration(recording, tier, 60_000, calibration(0))!
    const half = estimateFromCalibration(recording, tier, 60_000, calibration(0.5))!
    expect(half.bytes).toBe(none.bytes)
  })

  it('prices a written picture at its bound rather than at zero', () => {
    setSameAsLastOverride(true)
    const all = estimateFromCalibration(recording, tier, 60_000, calibration(1))!
    const frames = 60 * tier.fps
    // Every delta written, so the video is keyframes plus twenty bytes a frame.
    expect(all.bytes).toBeGreaterThan(frames * SKIP_PICTURE_MAX_BYTES * 0.5)
  })

  it('is unmoved by a fraction outside 0..1 — a bad count cannot inflate a promise', () => {
    setSameAsLastOverride(true)
    const sane = estimateFromCalibration(recording, tier, 60_000, calibration(1))!
    const mad = estimateFromCalibration(recording, tier, 60_000, calibration(9))!
    expect(mad.bytes).toBe(sane.bytes)
    const negative = estimateFromCalibration(recording, tier, 60_000, calibration(-3))!
    expect(negative.bytes).toBe(estimateFromCalibration(recording, tier, 60_000, calibration(0))!.bytes)
  })
})
