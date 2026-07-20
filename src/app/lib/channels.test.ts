import { describe, expect, it } from 'vitest'
import type { Capabilities } from '@core/capabilities'
import { CHANNEL_KINDS, isKindSupported, unsupportedReason } from './channels'

const base: Capabilities = {
  chromium: true,
  screenCapture: true,
  systemAudioCapture: true,
  camera: true,
  webCodecs: true,
  opfs: true,
  ios: false,
  appleWebKit: false,
  full: true,
}

const chromium = base
const safariDesktop: Capabilities = {
  ...base,
  chromium: false,
  systemAudioCapture: false, // Apple: no tab/system audio
  appleWebKit: true,
  full: false,
}
const ios: Capabilities = {
  ...base,
  chromium: false,
  screenCapture: false, // no getDisplayMedia on any iOS browser
  systemAudioCapture: false,
  appleWebKit: true,
  ios: true,
  full: false,
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
