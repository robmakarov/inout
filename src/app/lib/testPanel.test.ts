import { afterEach, describe, expect, it, vi } from 'vitest'
import { testPanelEnabled, urlWithoutTestParam } from './testPanel'

function at(search: string, href = `https://inout.app/${search}`): void {
  vi.stubGlobal('location', { search, href })
}

// The switch must not read storage at all any more. A refusing localStorage is
// what a private window looks like, and test mode has to behave identically
// there — if any of these tests can tell the difference, the switch is reading
// something it should not.
vi.stubGlobal('localStorage', {
  getItem: () => {
    throw new Error('localStorage must not be consulted by the test-mode switch')
  },
  setItem: () => {
    throw new Error('localStorage must not be written by the test-mode switch')
  },
  removeItem: () => undefined,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('test mode lives in the URL and nowhere else', () => {
  /**
   * ROBERT'S RULING, 2026-08-30: "it must be only in /?test". It had been
   * sticky, which meant a link opened once put a test surface on screens he
   * was not testing on, weeks later, with no way to tell why. An off button
   * was tried first and was not enough — it only helps someone who already
   * knows they need to press it.
   */
  it('is on for the load that asked for it', () => {
    at('?test')
    expect(testPanelEnabled()).toBe(true)
    at('?text')
    expect(testPanelEnabled()).toBe(true)
    at('?test=1&quality=max')
    expect(testPanelEnabled()).toBe(true)
  })

  it('IS OFF ON A PLAIN VISIT — the whole ruling, in one assertion', () => {
    at('')
    expect(testPanelEnabled()).toBe(false)
    at('?synthetic=1&quality=max')
    expect(testPanelEnabled()).toBe(false)
  })

  it('does not carry over from the load that had the link', () => {
    at('?test')
    expect(testPanelEnabled()).toBe(true)
    at('')
    expect(testPanelEnabled()).toBe(false)
  })

  it('?test=0 reads as off, so an old link with it in does not switch it on', () => {
    at('?test=0')
    expect(testPanelEnabled()).toBe(false)
  })

  it('the exit URL drops test/text and keeps everything else', () => {
    at('?test&quality=max', 'https://inout.app/?test&quality=max')
    expect(urlWithoutTestParam()).toBe('/?quality=max')
    at('?text=1', 'https://inout.app/?text=1')
    expect(urlWithoutTestParam()).toBe('/')
  })
})
