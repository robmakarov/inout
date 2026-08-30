import { afterEach, describe, expect, it } from 'vitest'
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

  it('MAX HAS NO LADDER — Robert: "max must have perfect picture all the time"', () => {
    // I argued for keeping it (dropped frames are a slideshow where a lower
    // rate is smooth) and was overruled. The right consequence is not policy
    // but load: max is made to work by opening FEWER ENCODERS — no composite at
    // native resolution — rather than by throttling the take. A mode that
    // survives because it was throttled was never max.
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
