import { describe, expect, it } from 'vitest'
import { contextTimeToPerformanceMs, subtractsInputLatency } from './measuredAudio'

describe('measured audio clock mapping', () => {
  it('maps contextTime through resume calibration linearly', () => {
    const calib = { contextTime: 1.0, performanceTime: 5000 }
    expect(contextTimeToPerformanceMs(1.05, calib)).toBeCloseTo(5050, 5)
    expect(contextTimeToPerformanceMs(0.9, calib)).toBeCloseTo(4900, 5)
  })
})

/**
 * B13. The lever, and the thing that must NEVER change without Robert's yes:
 * the default. A loopback keeps the subtraction until `?looplat=0` says
 * otherwise, and a microphone keeps it whatever the flag says — the flag is
 * about a source with no device buffer, and a mic has one.
 */
describe('B13 loopback input-latency policy', () => {
  const withSearch = (search: string, fn: () => void): void => {
    const original = globalThis.location
    Object.defineProperty(globalThis, 'location', {
      value: { search },
      configurable: true,
      writable: true,
    })
    try {
      fn()
    } finally {
      Object.defineProperty(globalThis, 'location', {
        value: original,
        configurable: true,
        writable: true,
      })
    }
  }

  it('subtracts on every source by default — the shipped behaviour, unmoved', () => {
    withSearch('', () => {
      expect(subtractsInputLatency(true)).toBe(true)
      expect(subtractsInputLatency(false)).toBe(true)
    })
  })

  it('?looplat=0 stops the subtraction on a loopback only', () => {
    withSearch('?looplat=0', () => {
      expect(subtractsInputLatency(true)).toBe(false)
      // A microphone HAS a device buffer; the flag must never reach it.
      expect(subtractsInputLatency(false)).toBe(true)
    })
  })

  it('?looplat=1 is the default said out loud', () => {
    withSearch('?looplat=1', () => {
      expect(subtractsInputLatency(true)).toBe(true)
    })
  })

  it('an unrelated flag on the URL changes nothing', () => {
    withSearch('?synthetic=1&pressure=0', () => {
      expect(subtractsInputLatency(true)).toBe(true)
    })
  })
})
