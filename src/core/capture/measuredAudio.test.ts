import { describe, expect, it } from 'vitest'
import { contextTimeToPerformanceMs } from './measuredAudio'

describe('measured audio clock mapping', () => {
  it('maps contextTime through resume calibration linearly', () => {
    const calib = { contextTime: 1.0, performanceTime: 5000 }
    expect(contextTimeToPerformanceMs(1.05, calib)).toBeCloseTo(5050, 5)
    expect(contextTimeToPerformanceMs(0.9, calib)).toBeCloseTo(4900, 5)
  })
})

