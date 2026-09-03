import { afterEach, describe, expect, it } from 'vitest'
import { setQualityStep } from '@core/qualityStep'
import {
  captureQualityMode,
  preemptiveRefusalAllowed,
  rateLadderAllowed,
  setCaptureQualityMode,
  setMaxLadder,
} from './captureQuality'

/**
 * Robert, 2026-08-30: "quality dropping must be one mode, and it will be off
 * for 'max' quality where user will pay for perfect picture, so we need to make
 * it work."
 *
 * Three separate things could take quality away from a take — captureLadder
 * stepping the rate, the arm-time refusal of a rate the encoder measured itself
 * unable to carry, and O15's earned budget. They are one behaviour with one
 * name now, and one switch turns all three off.
 */
afterEach(() => {
  setCaptureQualityMode(null)
  setMaxLadder(null)
})

describe('the mode', () => {
  it('is auto by default — a take is exactly the take it was', () => {
    expect(captureQualityMode()).toBe('auto')
    expect(preemptiveRefusalAllowed()).toBe(true)
  })

  it('max stops the take being refused BEFORE it starts', () => {
    setCaptureQualityMode('max')
    expect(captureQualityMode()).toBe('max')
    expect(preemptiveRefusalAllowed()).toBe(false)
  })

  it('and back on', () => {
    setCaptureQualityMode('max')
    setCaptureQualityMode('auto')
    expect(preemptiveRefusalAllowed()).toBe(true)
  })

  it('THE PICTURE STEP IS OFF IN MAX TODAY — a switch position, not a property of max', () => {
    // Robert, 2026-09-03, correcting this exact comment for the second time:
    // "elastic must work for max, it is just now turned off so we polish max
    // without it" · "until i say so". Elastic is ONE system and max is inside
    // it. While it is off, max is meanwhile made to work by opening FEWER
    // ENCODERS — no composite at native resolution — rather than by throttling
    // the take. The test below pins that it is REACHABLE, which is the half
    // that stops this becoming a deleted branch.
    setCaptureQualityMode('max')
    expect(rateLadderAllowed()).toBe(false)
    setCaptureQualityMode('auto')
    expect(rateLadderAllowed()).toBe(true)
  })

  it('…but it is REACHABLE in max, not deleted — "it must be possible there, but off for now"', () => {
    setCaptureQualityMode('max')
    expect(rateLadderAllowed()).toBe(false)
    setMaxLadder(true)
    expect(rateLadderAllowed()).toBe(true)
    setMaxLadder(false)
    expect(rateLadderAllowed()).toBe(false)
  })

  it('a nonsense value is not a mode', () => {
    setCaptureQualityMode(null)
    try {
      localStorage.setItem('inout.capture.quality', 'perfect')
    } catch {
      /* memory-only environment — the default is what is being asserted */
    }
    expect(captureQualityMode()).toBe('auto')
  })
})

/**
 * THE SLIDER IS THE CHOICE — Robert, 2026-09-03: "fucking max slider must be
 * max", said after B14 found that it was not.
 *
 * `frame.sourceResEnabled()` and `rate.sourceRateEnabled()` have defaulted from
 * the quality step since UI1. This one did not, and nothing outside the test
 * panel ever set it — so dragging the slider to Max bought the max RESOLUTION
 * and the max RATE and none of the max BEHAVIOUR.
 */
describe('the slider decides the mode', () => {
  afterEach(() => {
    setQualityStep(null)
    setCaptureQualityMode(null)
  })

  it('the max STEP is the max MODE', () => {
    setQualityStep('max')
    expect(captureQualityMode()).toBe('max')
    // …which is the whole point: a take at max is not refused before it starts.
    expect(preemptiveRefusalAllowed()).toBe(false)
  })

  it('every step below max is exactly the product it was', () => {
    for (const step of ['540p', '720p', '1080p', '1440p'] as const) {
      setQualityStep(step)
      expect(captureQualityMode()).toBe('auto')
      expect(preemptiveRefusalAllowed()).toBe(true)
      expect(rateLadderAllowed()).toBe(true)
    }
  })

  it('and the flag still overrides the slider, in both directions', () => {
    setQualityStep('max')
    setCaptureQualityMode('auto')
    expect(captureQualityMode()).toBe('auto')
    setQualityStep('1080p')
    setCaptureQualityMode('max')
    expect(captureQualityMode()).toBe('max')
  })

  it('MAX ELASTIC IS STILL OFF, AND STILL REACHABLE — his switch, not this wiring', () => {
    // Wiring the slider must not turn anything ON. "until i say so."
    setQualityStep('max')
    expect(rateLadderAllowed()).toBe(false)
    setMaxLadder(true)
    expect(rateLadderAllowed()).toBe(true)
    setMaxLadder(null)
  })
})
