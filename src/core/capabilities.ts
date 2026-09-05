import { detectPlatform, type BrowserEngine, type OSName, type PlatformInfo } from './platform'

/**
 * What display capture can carry ALONGSIDE the picture (task P1).
 *
 * This is engine × OS, not engine, and that distinction is the whole reason the
 * type exists. Chromium on WINDOWS hands over the machine's audio when the user
 * shares a whole monitor. Gecko is a third case that reads like a fourth: it
 * ACCEPTS `audio: true` and silently returns video only, so a UI that trusts
 * the constraint shows a channel that records nothing.
 *
 * THIS TABLE IS A GUESS AND IT IS WRONG ON MACOS (B15, 2026-09-05). It used to
 * say the same Chromium on macOS "only ever gives audio for a tab or window
 * share". Robert's `rec_tcjr3v2cskgd` is a whole-MONITOR share — 3024x1964,
 * the macOS menu bar and the dock in every frame — carrying a stereo 48 kHz
 * display-audio track. Chrome 152 ships `CatapAudioInputStream`, a Core Audio
 * process tap, and the native macOS picker has the box that turns it on. Only
 * that picker does: measured on this machine, a monitor surface answered by
 * `--auto-select-desktop-capture-source`, by the newer
 * `--auto-select-screen-capture-source`, with the Catap feature forced on, and
 * with `systemAudio: 'include'` asked for, returns video and NO AUDIO TRACK
 * (docs/qa/b15-surface.json).
 *
 * So the scope is NOT a property of the browser — it is a property of what the
 * user picked, which nothing here can know before the picker closes. This stays
 * as the pre-flight guess (it only ever decides whether to OFFER the channel,
 * and 'tab' and 'system' both offer it); once a take has a surface,
 * `channelLabel` reads THAT instead. Do not use this to decide what a live
 * channel IS.
 */
export type DisplayAudioScope = 'none' | 'tab' | 'system'

export interface Capabilities {
  chromium: boolean
  screenCapture: boolean
  /** Display capture can also carry tab/system audio. See DisplayAudioScope —
   * false on Apple WebKit AND on Gecko, for two different reasons. */
  systemAudioCapture: boolean
  /** WHICH audio a display share can carry here. */
  displayAudioScope: DisplayAudioScope
  camera: boolean
  webCodecs: boolean
  opfs: boolean
  /** Any iOS/iPadOS browser: no getDisplayMedia at all (Apple restricts screen
   * capture to native apps). Camera/mic/audio-only still work. */
  ios: boolean
  /** Apple WebKit: desktop Safari or any iOS browser. Drives honest messaging. */
  appleWebKit: boolean
  /** Engine and OS, from core/platform.ts — probe-first, UA-sniff last. */
  engine: BrowserEngine
  os: OSName
  /**
   * The platform has an AAC encoder, so the export can mux mp4/aac. Gecko does
   * not, and lands on the avc+opus / vp9+opus chains instead. ADVISORY: the
   * codec chains in compose/codecs.ts still probe for themselves, because a
   * capability table is a worse authority than the encoder itself.
   */
  aacEncode: boolean
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

/** Apple WebKit (desktop Safari or any iOS browser) — runtime check for the
 * capture engine, which has no Capabilities object on hand. */
export function isAppleWebKit(): boolean {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  if (!nav) return false
  return detectAppleWebKit(nav, detectIOS(nav))
}

/**
 * The engine × OS matrix, pure so it can be tested without a browser.
 *
 * `hasDisplayMedia` comes from a PROBE, not from the table: a platform that
 * cannot share a screen at all cannot carry its audio either, whatever the
 * matrix says about the engine.
 */
export function displayAudioScopeFor(
  engine: BrowserEngine,
  os: OSName,
  hasDisplayMedia: boolean,
  appleWebKit: boolean,
): DisplayAudioScope {
  if (!hasDisplayMedia || appleWebKit) return 'none'
  // Verified 2026-08: Firefox accepts `audio: true` on getDisplayMedia and
  // returns video only — no error, no track. The channel has to be dropped
  // with honest copy rather than offered and left silent.
  if (engine === 'gecko') return 'none'
  if (engine === 'chromium') return os === 'windows' ? 'system' : 'tab'
  // An engine we do not recognise but which HAS getDisplayMedia: assume the
  // conservative Chromium case rather than promising the machine's audio.
  return 'tab'
}

export function aacEncodeFor(engine: BrowserEngine): boolean {
  return engine !== 'gecko'
}

export function detectCapabilities(platform?: PlatformInfo): Capabilities {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const p = platform ?? detectPlatform()
  const chromium = !!(nav && 'userAgentData' in nav)
  const screenCapture = !!nav?.mediaDevices?.getDisplayMedia
  const camera = !!nav?.mediaDevices?.getUserMedia
  const webCodecs = typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined'
  const opfs = !!nav?.storage?.getDirectory
  const ios = nav ? detectIOS(nav) : false
  const appleWebKit = nav ? detectAppleWebKit(nav, ios) : false
  const displayAudioScope = displayAudioScopeFor(p.engine, p.os, screenCapture, appleWebKit)
  return {
    chromium,
    screenCapture,
    systemAudioCapture: displayAudioScope !== 'none',
    displayAudioScope,
    camera,
    webCodecs,
    opfs,
    ios,
    appleWebKit,
    engine: p.engine,
    os: p.os,
    aacEncode: aacEncodeFor(p.engine),
    full: screenCapture && camera && webCodecs && opfs,
  }
}
