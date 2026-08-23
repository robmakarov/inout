import { describe, expect, it } from 'vitest'
import {
  CHROMIUM_FLOOR,
  REQUIRED_FEATURES,
  evaluateSupport,
  isBelowFloor,
  parsePlatform,
  type RequiredFeature,
} from './platform'

/**
 * Real strings, not invented ones. The Yandex desktop UAs are the shape that
 * makes every naive parser report "Chrome" — that is the case this module
 * exists for, so it is the case that must be pinned.
 */
const UA = {
  yandexMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36',
  yandexWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 YaBrowser/24.1.0.0 Yowser/2.5 Safari/537.36',
  yandexOld:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 YaBrowser/21.11.0.1996 Yowser/2.5 Safari/537.36',
  yandexAndroid:
    'Mozilla/5.0 (Linux; arm_64; Android 13; RMX3710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.91 YaBrowser/24.1.1.91.00 SA/3 Mobile Safari/537.36',
  yandexIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 YaBrowser/24.4.2.519.10 SA/3 Mobile/15E148 Safari/604.1',
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
  operaWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0',
  firefoxMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:130.0) Gecko/20100101 Firefox/130.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
}

describe('parsePlatform — Yandex Browser is not Chrome', () => {
  it('names Yandex on macOS and reads both versions', () => {
    const p = parsePlatform(UA.yandexMac)
    expect(p.browser).toBe('yandex')
    expect(p.browserVersion).toBe('24.10.0.0')
    expect(p.engine).toBe('chromium')
    expect(p.chromiumMajor).toBe(128)
    expect(p.os).toBe('macos')
  })

  it('names Yandex on Windows despite the Yowser token', () => {
    const p = parsePlatform(UA.yandexWin)
    expect(p.browser).toBe('yandex')
    expect(p.chromiumMajor).toBe(120)
    expect(p.os).toBe('windows')
  })

  it('reads the real Chromium major on Android (no UA reduction there)', () => {
    const p = parsePlatform(UA.yandexAndroid)
    expect(p.browser).toBe('yandex')
    expect(p.chromiumMajor).toBe(120)
    expect(p.os).toBe('android')
    expect(p.osVersion).toBe('13')
  })

  it('classifies Yandex on iOS as WebKit — Apple allows no other engine', () => {
    const p = parsePlatform(UA.yandexIOS)
    expect(p.browser).toBe('yandex')
    expect(p.engine).toBe('webkit')
    expect(p.chromiumMajor).toBeNull()
    expect(p.os).toBe('ios')
  })
})

describe('parsePlatform — the other Chromium forks stay distinguishable', () => {
  it.each([
    ['chromeMac', 'chrome', 'chromium', 139],
    ['edgeWin', 'edge', 'chromium', 139],
    ['operaWin', 'opera', 'chromium', 126],
  ] as const)('%s → %s', (key, browser, engine, chromiumMajor) => {
    const p = parsePlatform(UA[key])
    expect(p.browser).toBe(browser)
    expect(p.engine).toBe(engine)
    expect(p.chromiumMajor).toBe(chromiumMajor)
  })

  it('Firefox is gecko with no Chromium major', () => {
    const p = parsePlatform(UA.firefoxMac)
    expect(p.browser).toBe('firefox')
    expect(p.engine).toBe('gecko')
    expect(p.chromiumMajor).toBeNull()
  })

  it('Safari is webkit and reports its Version token', () => {
    const p = parsePlatform(UA.safariMac)
    expect(p.browser).toBe('safari')
    expect(p.engine).toBe('webkit')
    expect(p.browserVersion).toBe('18.0')
  })

  it('iPadOS masquerading as MacIntel is iOS when it has touch points', () => {
    expect(parsePlatform(UA.safariMac, undefined, 5).os).toBe('ios')
    expect(parsePlatform(UA.safariMac, undefined, 0).os).toBe('macos')
  })

  it('prefers the UA-CH platform hint over the UA string', () => {
    expect(parsePlatform(UA.chromeMac, { platform: 'Windows' }).os).toBe('windows')
  })
})

describe('version floor', () => {
  it('current Yandex builds clear it, a 2021 build does not', () => {
    expect(isBelowFloor(parsePlatform(UA.yandexMac))).toBe(false)
    expect(isBelowFloor(parsePlatform(UA.yandexWin))).toBe(false)
    expect(isBelowFloor(parsePlatform(UA.yandexOld))).toBe(true)
    expect(parsePlatform(UA.yandexOld).chromiumMajor).toBeLessThan(CHROMIUM_FLOOR)
  })

  it('never fires on a browser whose engine version is unreadable', () => {
    expect(isBelowFloor(parsePlatform('Mozilla/5.0 (weird)'))).toBe(false)
  })
})

describe('the required-feature list stays main-thread-observable', () => {
  /**
   * Regression guard for a bug this module shipped with for one test run:
   * createSyncAccessHandle is [Exposed=DedicatedWorker], so probing it from the
   * main thread declared Chrome 151 unsupported and would have shown every user
   * a "switch browsers" banner. Anything worker-only belongs to the version
   * floor, never to this list.
   */
  it('does not probe worker-only APIs', () => {
    for (const f of REQUIRED_FEATURES) {
      expect(f).not.toMatch(/SyncAccessHandle/i)
    }
  })
})

describe('evaluateSupport — the floor explains failures, it never causes them', () => {
  it('an old build that somehow has every API is still supported', () => {
    const v = evaluateSupport(parsePlatform(UA.yandexOld), [])
    expect(v.ok).toBe(true)
    expect(v.message).toBeNull()
    expect(v.belowFloor).toBe(true)
  })

  it('an old Yandex missing the durable store is told to update, by name', () => {
    const missing: RequiredFeature[] = ['OPFS']
    const v = evaluateSupport(parsePlatform(UA.yandexOld), missing)
    expect(v.ok).toBe(false)
    expect(v.action).toBe('update')
    expect(v.message).toContain('Yandex Browser')
    expect(v.message).toContain(String(CHROMIUM_FLOOR))
  })

  it('a current browser missing an API is told to switch, not to update', () => {
    const v = evaluateSupport(parsePlatform(UA.safariMac), ['VideoEncoder'])
    expect(v.action).toBe('switch')
    expect(v.message).toContain('Yandex Browser')
  })
})
