import { describe, expect, it } from 'vitest'
import type { Capabilities } from '@core/capabilities'
import { aacEncodeFor, displayAudioScopeFor } from '@core/capabilities'
import {
  CHANNEL_KINDS,
  channelLabel,
  isKindSupported,
  missingChannelsMessage,
  unsupportedReason,
} from './channels'

const base: Capabilities = {
  chromium: true,
  screenCapture: true,
  systemAudioCapture: true,
  displayAudioScope: 'tab',
  camera: true,
  webCodecs: true,
  opfs: true,
  ios: false,
  appleWebKit: false,
  engine: 'chromium',
  os: 'macos',
  aacEncode: true,
  full: true,
}

const chromium = base
const safariDesktop: Capabilities = {
  ...base,
  chromium: false,
  systemAudioCapture: false, // Apple: no tab/system audio
  displayAudioScope: 'none',
  appleWebKit: true,
  engine: 'webkit',
  full: false,
}
const ios: Capabilities = {
  ...base,
  chromium: false,
  screenCapture: false, // no getDisplayMedia on any iOS browser
  systemAudioCapture: false,
  displayAudioScope: 'none',
  appleWebKit: true,
  engine: 'webkit',
  os: 'ios',
  ios: true,
  full: false,
}

/** Firefox: screen yes, display AUDIO silently absent, no AAC encoder (P1). */
const firefox: Capabilities = {
  ...base,
  chromium: false,
  systemAudioCapture: false,
  displayAudioScope: 'none',
  engine: 'gecko',
  aacEncode: false,
}

/** Chromium on Windows: a monitor share carries the machine's audio (P1). */
const chromiumWindows: Capabilities = {
  ...base,
  displayAudioScope: 'system',
  os: 'windows',
}

describe('isKindSupported', () => {
  it('Chromium supports every channel', () => {
    for (const k of CHANNEL_KINDS) expect(isKindSupported(k, chromium)).toBe(true)
  })
  it('desktop Safari drops only tab audio', () => {
    expect(isKindSupported('screen', safariDesktop)).toBe(true)
    expect(isKindSupported('camera', safariDesktop)).toBe(true)
    expect(isKindSupported('mic', safariDesktop)).toBe(true)
    expect(isKindSupported('system-audio', safariDesktop)).toBe(false)
  })
  it('iOS drops screen and tab audio, keeps camera/mic', () => {
    expect(isKindSupported('screen', ios)).toBe(false)
    expect(isKindSupported('system-audio', ios)).toBe(false)
    expect(isKindSupported('camera', ios)).toBe(true)
    expect(isKindSupported('mic', ios)).toBe(true)
  })
})

describe('engine x OS matrix (P1)', () => {
  it('Firefox keeps screen and camera but drops display audio', () => {
    expect(isKindSupported('screen', firefox)).toBe(true)
    expect(isKindSupported('camera', firefox)).toBe(true)
    expect(isKindSupported('mic', firefox)).toBe(true)
    expect(isKindSupported('system-audio', firefox)).toBe(false)
  })
  it('the Firefox copy says what it DOES, not just that it cannot', () => {
    const r = unsupportedReason('system-audio', firefox)
    expect(r).toMatch(/Firefox/i)
    expect(r).toMatch(/video only/i)
    expect(r).toMatch(/Chrome|Edge/i)
  })
  it('Windows Chromium calls it System Audio, macOS calls it Tab Audio', () => {
    expect(channelLabel('system-audio', chromiumWindows)).toBe('System Audio')
    expect(channelLabel('system-audio', chromium)).toBe('Tab Audio')
    // Every other channel is named the same everywhere.
    expect(channelLabel('screen', chromiumWindows)).toBe(channelLabel('screen', chromium))
  })
  it('the scope table is engine x OS, and a probe can veto it', () => {
    expect(displayAudioScopeFor('chromium', 'windows', true, false)).toBe('system')
    expect(displayAudioScopeFor('chromium', 'macos', true, false)).toBe('tab')
    expect(displayAudioScopeFor('chromium', 'linux', true, false)).toBe('tab')
    expect(displayAudioScopeFor('gecko', 'windows', true, false)).toBe('none')
    expect(displayAudioScopeFor('webkit', 'macos', true, true)).toBe('none')
    // No getDisplayMedia at all beats anything the table would say.
    expect(displayAudioScopeFor('chromium', 'windows', false, false)).toBe('none')
    // An engine we do not know, but which can share a screen: assume the
    // conservative case rather than promising the machine's audio.
    expect(displayAudioScopeFor('unknown', 'linux', true, false)).toBe('tab')
  })
  it('only Gecko lacks an AAC encoder', () => {
    expect(aacEncodeFor('gecko')).toBe(false)
    for (const e of ['chromium', 'webkit', 'unknown'] as const) expect(aacEncodeFor(e)).toBe(true)
  })
})

describe('unsupportedReason', () => {
  it('null for every supported channel (never nags)', () => {
    for (const k of CHANNEL_KINDS) expect(unsupportedReason(k, chromium)).toBeNull()
  })
  it('iOS screen names the native-app / Apple limit', () => {
    const r = unsupportedReason('screen', ios)
    expect(r).toBeTruthy()
    expect(r).toMatch(/iPhone|iPad|native/i)
  })
  it('desktop Safari tab audio names Safari + points to Chrome', () => {
    const r = unsupportedReason('system-audio', safariDesktop)
    expect(r).toMatch(/Safari/i)
    expect(r).toMatch(/Chrome/i)
  })
  it('supported channel on a limited platform still returns null', () => {
    expect(unsupportedReason('camera', ios)).toBeNull()
    expect(unsupportedReason('screen', safariDesktop)).toBeNull()
  })
})

describe('missingChannelsMessage', () => {
  it('points at the box in the screen picker when the sound channel is missing', () => {
    expect(missingChannelsMessage(['system-audio'], chromium)).toMatch(/Also share system audio/)
  })

  it('a missing device is a missing device, not a picker problem', () => {
    expect(missingChannelsMessage(['mic'], chromium)).toMatch(/never connected/)
  })
})
