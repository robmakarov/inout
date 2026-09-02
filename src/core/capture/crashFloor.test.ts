import { afterEach, describe, expect, it, vi } from 'vitest'
import { crashFloorEnabled, EARLY_FRAGMENT_S } from './crashFloor'

/**
 * H2b — the switch that holds both floors. The frozen rule wants the shipped
 * path reachable at runtime, and these are the two ways to reach it.
 */
function stub(search: string, sticky?: string) {
  vi.stubGlobal('location', { search })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k === 'inout.capture.crashfloor' ? (sticky ?? null) : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('?crashfloor=', () => {
  it('is on by default — the floors are the shipped behaviour now', () => {
    stub('')
    expect(crashFloorEnabled()).toBe(true)
  })

  it('turns off from the URL, for one load', () => {
    stub('?crashfloor=0')
    expect(crashFloorEnabled()).toBe(false)
  })

  it('turns off stickily, with no console needed twice', () => {
    stub('', '0')
    expect(crashFloorEnabled()).toBe(false)
  })

  it('lets the URL win over the sticky value, both ways', () => {
    stub('?crashfloor=1', '0')
    expect(crashFloorEnabled()).toBe(true)
    stub('?crashfloor=0', '1')
    expect(crashFloorEnabled()).toBe(false)
  })

  it('survives storage being refused', () => {
    vi.stubGlobal('location', { search: '' })
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
    })
    expect(crashFloorEnabled()).toBe(true)
  })

  it('closes the first fragment at the cadence audio already had', () => {
    // Not a free parameter: 1 s is WebM's default minimum cluster duration, so
    // picture and sound come back from the same instant after a crash.
    expect(EARLY_FRAGMENT_S).toBe(1)
  })
})
