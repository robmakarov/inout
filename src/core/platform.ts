/**
 * WHICH browser and build is this, and does it clear the floor INOUT needs?
 *
 * capabilities.ts answers "can this browser do X" (probe-first, and that stays
 * the only thing the capture engine and the channel UI consult). This module
 * answers the two questions capabilities.ts deliberately does not:
 *
 *   1. WHAT is this — Yandex Browser is Chromium wearing a Chrome UA token, so
 *      every naive parser calls it Chrome and the QA matrix cannot tell the two
 *      apart. `YaBrowser` must be matched BEFORE `Chrome`, and so must Edg/OPR.
 *   2. Is it TOO OLD — a below-floor build fails in ways no feature probe can
 *      explain to a user ("nothing happened"), because the bundle itself is
 *      compiled to a syntax baseline. That deserves an honest "update" line
 *      instead of a generic error.
 *
 * The floor is a REPORT, never a gate: nothing here is allowed to refuse work a
 * browser can actually do. Feature probes decide; the version only supplies the
 * wording when a probe has already failed.
 */

export type BrowserEngine = 'chromium' | 'gecko' | 'webkit' | 'unknown'

export type BrowserName =
  | 'chrome'
  | 'edge'
  | 'yandex'
  | 'opera'
  | 'samsung'
  | 'firefox'
  | 'safari'
  | 'other'

export type OSName = 'macos' | 'windows' | 'linux' | 'android' | 'ios' | 'other'

export interface PlatformInfo {
  engine: BrowserEngine
  browser: BrowserName
  /** The browser's own version (YaBrowser/25.2.6.722 → '25.2.6.722'). */
  browserVersion: string | null
  /**
   * Chromium base major, read from the Chrome/NNN token. Chromium's UA
   * reduction freezes the minor parts to 0.0.0, so only the major is real —
   * which is all a floor needs. Null on Gecko/WebKit.
   */
  chromiumMajor: number | null
  os: OSName
  osVersion: string | null
  /** Kept verbatim so a QA report can be re-parsed later without the browser. */
  userAgent: string
}

/**
 * Chromium 107 = the syntax baseline this bundle is compiled to (Vite 7's
 * default `baseline-widely-available` target: chrome107 / edge107 / firefox104
 * / safari16). Below it the modules may not even parse, so no feature probe
 * ever gets to run. Raise this ONLY together with vite build.target.
 *
 * Every runtime feature we need landed earlier than that — WebCodecs in 94,
 * OPFS createSyncAccessHandle in 102 — so 107 is the binding constraint and
 * "clears the floor" implies "has the APIs" on a real Chromium build.
 */
export const CHROMIUM_FLOOR = 107
export const FIREFOX_FLOOR = 104
export const SAFARI_FLOOR = 16

/** Minimal shape of the UA-Client-Hints surface; not in TS's DOM lib. */
interface UADataLike {
  platform?: string
  brands?: { brand: string; version: string }[]
}

function versionFrom(ua: string, token: string): string | null {
  const m = new RegExp(`${token}/([0-9._]+)`).exec(ua)
  return m ? m[1] : null
}

function majorOf(version: string | null): number | null {
  if (!version) return null
  const n = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isFinite(n) ? n : null
}

function detectOS(ua: string, uaData: UADataLike | undefined, maxTouchPoints: number): OSName {
  // iPadOS 13+ reports MacIntel with touch points — check that before macOS.
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  const hinted = uaData?.platform
  if (hinted) {
    const p = hinted.toLowerCase()
    if (p.includes('android')) return 'android'
    if (p.includes('mac')) return maxTouchPoints > 1 ? 'ios' : 'macos'
    if (p.includes('win')) return 'windows'
    if (p.includes('linux') || p.includes('chrome os')) return 'linux'
  }
  if (/Android/.test(ua)) return 'android'
  if (/Windows/.test(ua)) return 'windows'
  if (/Mac OS X|Macintosh/.test(ua)) return maxTouchPoints > 1 ? 'ios' : 'macos'
  if (/Linux|X11|CrOS/.test(ua)) return 'linux'
  return 'other'
}

function detectOSVersion(ua: string, os: OSName): string | null {
  switch (os) {
    case 'macos': {
      const m = /Mac OS X ([0-9_]+)/.exec(ua)
      return m ? m[1].replace(/_/g, '.') : null
    }
    case 'ios': {
      const m = /(?:iPhone )?OS ([0-9_]+) like Mac OS X/.exec(ua)
      return m ? m[1].replace(/_/g, '.') : null
    }
    case 'windows': {
      const m = /Windows NT ([0-9.]+)/.exec(ua)
      return m ? m[1] : null
    }
    case 'android': {
      const m = /Android ([0-9.]+)/.exec(ua)
      return m ? m[1] : null
    }
    default:
      return null
  }
}

/**
 * Order is the whole trick: every Chromium fork keeps a `Chrome/NNN` token, so
 * the fork's own token has to win. Yandex additionally ships an iOS build that
 * is WebKit underneath (Apple allows no other engine), and that one carries NO
 * Chrome token — so engine is decided by the platform, not by the brand.
 */
export function parsePlatform(
  ua: string,
  uaData?: UADataLike,
  maxTouchPoints = 0,
): PlatformInfo {
  const os = detectOS(ua, uaData, maxTouchPoints)
  const osVersion = detectOSVersion(ua, os)
  const chromeToken = versionFrom(ua, 'Chrome') ?? versionFrom(ua, 'CriOS')
  // On iOS every browser is WebKit; the brand token is just a skin.
  const iosSkin = os === 'ios'

  let browser: BrowserName = 'other'
  let browserVersion: string | null = null

  if (/YaBrowser|YaSearchBrowser/.test(ua)) {
    browser = 'yandex'
    browserVersion = versionFrom(ua, 'YaBrowser') ?? versionFrom(ua, 'YaSearchBrowser')
  } else if (/Edg(?:iOS|A|)\//.test(ua)) {
    browser = 'edge'
    browserVersion = versionFrom(ua, 'Edg') ?? versionFrom(ua, 'EdgiOS') ?? versionFrom(ua, 'EdgA')
  } else if (/OPR|OPiOS/.test(ua)) {
    browser = 'opera'
    browserVersion = versionFrom(ua, 'OPR') ?? versionFrom(ua, 'OPiOS')
  } else if (/SamsungBrowser/.test(ua)) {
    browser = 'samsung'
    browserVersion = versionFrom(ua, 'SamsungBrowser')
  } else if (/Firefox|FxiOS/.test(ua)) {
    browser = 'firefox'
    browserVersion = versionFrom(ua, 'Firefox') ?? versionFrom(ua, 'FxiOS')
  } else if (chromeToken) {
    browser = 'chrome'
    browserVersion = chromeToken
  } else if (/AppleWebKit/.test(ua)) {
    browser = 'safari'
    browserVersion = versionFrom(ua, 'Version')
  }

  let engine: BrowserEngine
  if (iosSkin) engine = 'webkit'
  else if (browser === 'firefox') engine = 'gecko'
  else if (chromeToken) engine = 'chromium'
  else if (browser === 'safari') engine = 'webkit'
  else engine = 'unknown'

  return {
    engine,
    browser,
    browserVersion,
    chromiumMajor: engine === 'chromium' ? majorOf(chromeToken) : null,
    os,
    osVersion,
    userAgent: ua,
  }
}

export function detectPlatform(): PlatformInfo {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  if (!nav) return parsePlatform('')
  const uaData = (nav as Navigator & { userAgentData?: UADataLike }).userAgentData
  return parsePlatform(nav.userAgent || '', uaData, nav.maxTouchPoints ?? 0)
}

/**
 * The APIs without which nothing works ANYWHERE — screen capture is not one of
 * them (Apple has never offered it in a browser, and channels.ts already says
 * so honestly). These are the store and the export.
 *
 * NOT in this list, and it must never be re-added: FileSystemSyncAccessHandle,
 * which the durable writer depends on. It is `[Exposed=DedicatedWorker]`, so
 * `FileSystemFileHandle.prototype.createSyncAccessHandle` is undefined on the
 * MAIN THREAD even on a Chromium that fully supports it — probing it here made
 * Chrome 151 report itself unsupported (caught by scripts/browser-check.mjs
 * before it ever shipped). Its availability rides on the version floor
 * instead: it landed in Chromium 102, below the 107 syntax floor.
 */
export const REQUIRED_FEATURES = [
  'getUserMedia',
  'MediaRecorder',
  'OPFS',
  'OffscreenCanvas',
  'VideoEncoder',
  'AudioEncoder',
] as const

export type RequiredFeature = (typeof REQUIRED_FEATURES)[number]

export function probeMissingFeatures(): RequiredFeature[] {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const missing: RequiredFeature[] = []
  if (!nav?.mediaDevices?.getUserMedia) missing.push('getUserMedia')
  if (typeof MediaRecorder === 'undefined') missing.push('MediaRecorder')
  if (!nav?.storage?.getDirectory || typeof FileSystemFileHandle === 'undefined')
    missing.push('OPFS')
  if (typeof OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas')
  if (typeof VideoEncoder === 'undefined') missing.push('VideoEncoder')
  if (typeof AudioEncoder === 'undefined') missing.push('AudioEncoder')
  return missing
}

export interface SupportVerdict {
  ok: boolean
  missing: RequiredFeature[]
  /** Older than the syntax baseline the bundle is compiled to. */
  belowFloor: boolean
  /** What to tell the user. Null whenever ok — silence is the default. */
  message: string | null
  action: 'none' | 'update' | 'switch'
}

const BROWSER_LABEL: Record<BrowserName, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  yandex: 'Yandex Browser',
  opera: 'Opera',
  samsung: 'Samsung Internet',
  firefox: 'Firefox',
  safari: 'Safari',
  other: 'This browser',
}

export function isBelowFloor(p: PlatformInfo): boolean {
  if (p.engine === 'chromium') return p.chromiumMajor !== null && p.chromiumMajor < CHROMIUM_FLOOR
  if (p.engine === 'gecko') {
    const major = majorOf(p.browserVersion)
    return major !== null && major < FIREFOX_FLOOR
  }
  if (p.engine === 'webkit' && p.browser === 'safari') {
    const major = majorOf(p.browserVersion)
    return major !== null && major < SAFARI_FLOOR
  }
  return false
}

/**
 * The verdict a user should ever see. A browser that PASSES every probe is
 * supported no matter what its version string says — the floor only gets to
 * explain a failure, never to cause one.
 */
export function evaluateSupport(
  p: PlatformInfo = detectPlatform(),
  missing: RequiredFeature[] = probeMissingFeatures(),
): SupportVerdict {
  const belowFloor = isBelowFloor(p)
  if (missing.length === 0) return { ok: true, missing, belowFloor, message: null, action: 'none' }

  const name = BROWSER_LABEL[p.browser]
  if (belowFloor && p.engine === 'chromium') {
    return {
      ok: false,
      missing,
      belowFloor,
      message: `${name} is out of date — INOUT needs Chromium ${CHROMIUM_FLOOR} or newer, and this build is ${p.chromiumMajor}. Updating it should fix this.`,
      action: 'update',
    }
  }
  if (belowFloor) {
    return {
      ok: false,
      missing,
      belowFloor,
      message: `${name} ${p.browserVersion ?? ''} is out of date — updating it should fix this.`.replace(
        '  ',
        ' ',
      ),
      action: 'update',
    }
  }
  return {
    ok: false,
    missing,
    belowFloor,
    message: `${name} is missing what INOUT needs to record and export (${missing.join(', ')}). Chrome, Edge, Yandex Browser and Firefox all work.`,
    action: 'switch',
  }
}
