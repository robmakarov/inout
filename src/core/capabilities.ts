export interface Capabilities {
  chromium: boolean
  screenCapture: boolean
  /** Display capture can also carry tab/system audio. Apple (Safari + every iOS
   * browser) does not — getDisplayMedia there yields video only. */
  systemAudioCapture: boolean
  camera: boolean
  webCodecs: boolean
  opfs: boolean
  /** Any iOS/iPadOS browser: no getDisplayMedia at all (Apple restricts screen
   * capture to native apps via ReplayKit). Camera/mic/audio-only still work. */
  ios: boolean
  /** Apple WebKit: desktop Safari or any iOS browser. Drives honest messaging. */
  appleWebKit: boolean
  /** Full support = every capture + compose feature works. */
  full: boolean
}

/** iOS and iPadOS — iPadOS 13+ masquerades as MacIntel, so touch points disambiguate. */
function detectIOS(nav: Navigator): boolean {
  const ua = nav.userAgent || ''
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1
}

/** Apple WebKit — desktop Safari or any iOS browser (iOS Chrome/Firefox are
 * WebKit too). Chromium/Firefox on other platforms are excluded. */
function detectAppleWebKit(nav: Navigator, ios: boolean): boolean {
  if (ios) return true
  const ua = nav.userAgent || ''
  const isWebKit = /AppleWebKit/.test(ua)
  const isChromiumOrGecko = /Chrome|Chromium|CriOS|Edg|OPR|Android|Firefox|FxiOS/.test(ua)
  return isWebKit && !isChromiumOrGecko
}

export function detectCapabilities(): Capabilities {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const chromium = !!(nav && 'userAgentData' in nav)
  const screenCapture = !!nav?.mediaDevices?.getDisplayMedia
  const camera = !!nav?.mediaDevices?.getUserMedia
  const webCodecs = typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined'
  const opfs = !!nav?.storage?.getDirectory
  const ios = nav ? detectIOS(nav) : false
  const appleWebKit = nav ? detectAppleWebKit(nav, ios) : false
  const systemAudioCapture = screenCapture && !appleWebKit
  return {
    chromium,
    screenCapture,
    systemAudioCapture,
    camera,
    webCodecs,
    opfs,
    ios,
    appleWebKit,
    full: screenCapture && camera && webCodecs && opfs,
  }
}
