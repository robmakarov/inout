import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  markDisplayRequest,
  resetDisplayInflightForTests,
} from '@core/capture/displayInflight'
import { noteSmallest, panelEnabled, panelSupported, whenDisplayDispatched } from './recorderPanel'

function at(search: string): void {
  vi.stubGlobal('location', { search, href: `https://inout.app/${search}` })
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetDisplayInflightForTests()
})

describe('U1 — the panel is a default that can be switched off', () => {
  it('is on unless the URL says otherwise', () => {
    at('')
    expect(panelEnabled()).toBe(true)
    at('?synthetic=1')
    expect(panelEnabled()).toBe(true)
    at('?panel=1')
    expect(panelEnabled()).toBe(true)
  })

  it('is off on ?panel=0 and ?panel=off', () => {
    at('?panel=0')
    expect(panelEnabled()).toBe(false)
    at('?quality=max&panel=off')
    expect(panelEnabled()).toBe(false)
  })
})

describe('U1 — an unsupported browser is exactly today', () => {
  const win = (extra: Record<string, unknown>) => extra as unknown as Window

  it('needs the API', () => {
    expect(panelSupported(win({ isSecureContext: true }))).toBe(false)
    expect(panelSupported(win({ isSecureContext: true, documentPictureInPicture: {} }))).toBe(false)
  })

  /** Safari has no such window at all; every browser has no such window over
   *  http. Neither may be allowed to throw into the record press. */
  it('needs a secure context', () => {
    const api = { documentPictureInPicture: { requestWindow: () => Promise.resolve({}) } }
    expect(panelSupported(win({ ...api, isSecureContext: false }))).toBe(false)
    expect(panelSupported(win({ ...api, isSecureContext: true }))).toBe(true)
  })

  it('survives being asked with no window at all', () => {
    expect(panelSupported(undefined)).toBe(false)
  })
})

describe('U1 — the minimum size is a floor, and only a real drag writes it', () => {
  const size = (outerW: number, outerH: number) => ({
    outerW,
    outerH,
    innerW: outerW,
    innerH: outerH - 34,
  })

  it('keeps the smallest box ever seen, not the last one', () => {
    let floor = noteSmallest(null, size(320, 166))
    floor = noteSmallest(floor, size(240, 120))
    floor = noteSmallest(floor, size(600, 400))
    expect(floor).toEqual(size(240, 120))
  })

  /** Chrome under CDP reports outer 0×0 and ignores the requested size — the
   *  reason this number cannot be measured from automation at all. A zero is
   *  not a window anybody dragged, so it must never become the floor. */
  it('refuses the 0x0 an automated Chrome reports', () => {
    const floor = noteSmallest(null, size(320, 166))
    expect(noteSmallest(floor, { outerW: 0, outerH: 0, innerW: 900, innerH: 666 })).toEqual(
      size(320, 166),
    )
    expect(noteSmallest(null, { outerW: 0, outerH: 0, innerW: 900, innerH: 666 })).toBeNull()
  })
})

describe('U1 — the panel never asks before the screen request has gone out', () => {
  /**
   * THE ONE ORDERING THAT MATTERS. `requestWindow()` consumes the click's
   * transient activation and `getDisplayMedia` does not (measured,
   * scripts/dpip-check.mjs), so a panel asked for first would take the
   * activation the screen needs and kill the take at the press.
   */
  it('waits until acquire has registered its screen request', async () => {
    let released = false
    const wait = whenDisplayDispatched(true, 1000).then(() => (released = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(released).toBe(false)
    markDisplayRequest(new Promise(() => {}))
    await wait
    expect(released).toBe(true)
  })

  /** A take with no screen dispatches nothing, so there is nothing to wait
   *  for — and waiting would only spend the activation window. */
  it('does not wait at all when no screen was asked for', async () => {
    const t0 = Date.now()
    await whenDisplayDispatched(false, 1000)
    expect(Date.now() - t0).toBeLessThan(20)
  })

  /**
   * A request already pending means acquire REFUSES this press ('busy',
   * acquire.ts:1223) and dispatches nothing — so the panel may open at once.
   */
  it('returns immediately when a request is already in flight', async () => {
    markDisplayRequest(new Promise(() => {}))
    const t0 = Date.now()
    await whenDisplayDispatched(true, 1000)
    expect(Date.now() - t0).toBeLessThan(20)
  })

  /** The budget is a safety net: a dispatch that never registers must not hold
   *  the panel forever, and must not throw. */
  it('gives up at its budget rather than waiting on a request that never comes', async () => {
    const t0 = Date.now()
    await whenDisplayDispatched(true, 60)
    const waited = Date.now() - t0
    expect(waited).toBeGreaterThanOrEqual(50)
    expect(waited).toBeLessThan(600)
  })
})
