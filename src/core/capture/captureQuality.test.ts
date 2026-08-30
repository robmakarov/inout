import { afterEach, describe, expect, it } from 'vitest'
import {
  captureQualityMode,
  qualityDropsAllowed,
  setCaptureQualityMode,
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
afterEach(() => setCaptureQualityMode(null))

describe('the mode', () => {
  it('is auto by default — a take is exactly the take it was', () => {
    expect(captureQualityMode()).toBe('auto')
    expect(qualityDropsAllowed()).toBe(true)
  })

  it('max turns dropping off', () => {
    setCaptureQualityMode('max')
    expect(captureQualityMode()).toBe('max')
    expect(qualityDropsAllowed()).toBe(false)
  })

  it('and back on', () => {
    setCaptureQualityMode('max')
    setCaptureQualityMode('auto')
    expect(qualityDropsAllowed()).toBe(true)
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
