import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTestPanelEnabled, testPanelEnabled, urlWithoutTestParam } from './testPanel'

// Same idiom as wedgeReload.test.ts: the test environment has no DOM storage,
// and the module treats a missing one as "off".
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, String(v))
  },
  removeItem: (k: string) => {
    store.delete(k)
  },
  clear: () => store.clear(),
})

function at(search: string, href = `https://inout.app/${search}`): void {
  vi.stubGlobal('location', { search, href })
}

afterEach(() => {
  store.clear()
  vi.unstubAllGlobals()
})

describe('test mode has a way out', () => {
  /**
   * THE DEFECT THIS FILE EXISTS FOR — Robert, 2026-08-30, sent a screenshot of
   * `Settings: auto · native-res OFF` on his editing screen: "test setting
   * shown in not test mode now, what the fuck?". He was in test mode, from a
   * `?test` link opened earlier, and could not tell: the switch was sticky
   * with no off.
   */
  it('stays on after the link that set it is gone — which is the trap', () => {
    at('?test')
    expect(testPanelEnabled()).toBe(true)
    at('')
    expect(testPanelEnabled()).toBe(true)
  })

  it('turns off and STAYS off across a plain load', () => {
    at('?test')
    expect(testPanelEnabled()).toBe(true)
    setTestPanelEnabled(false)
    at('')
    expect(testPanelEnabled()).toBe(false)
  })

  /**
   * The off button strips the parameter as well as writing storage. Without
   * this the URL would win on the next load and turn test mode straight back
   * on — the button would look broken once and be disbelieved after that.
   */
  it('the exit URL drops test/text and keeps everything else', () => {
    at('?test&quality=max', 'https://inout.app/?test&quality=max')
    expect(urlWithoutTestParam()).toBe('/?quality=max')
    at('?text=1', 'https://inout.app/?text=1')
    expect(urlWithoutTestParam()).toBe('/')
  })

  it('a fresh ?test link brings it back after an exit', () => {
    at('?test')
    setTestPanelEnabled(false)
    at('?test')
    expect(testPanelEnabled()).toBe(true)
  })

  it('?test=0 still works, because a link is still a switch', () => {
    at('?test')
    expect(testPanelEnabled()).toBe(true)
    at('?test=0')
    expect(testPanelEnabled()).toBe(false)
    at('')
    expect(testPanelEnabled()).toBe(false)
  })
})
