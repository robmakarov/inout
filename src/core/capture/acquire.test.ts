import { describe, expect, it } from 'vitest'
import {
  cameraVideoConstraints,
  displayMediaOptions,
  displayPaneHint,
  displayAudioMissingMessage,
  CAPTURE_MAX_HEIGHT,
  CAPTURE_MAX_WIDTH,
} from './acquire'

const base = { screen: false, camera: true, mic: false, systemAudio: false }

describe('cameraVideoConstraints', () => {
  it('asks for the full export size when the camera fills the frame', () => {
    // No screen channel ⇒ the camera-full layout rule ⇒ 720p would be upscaled.
    const c = cameraVideoConstraints(base)
    expect(c.width).toEqual({ ideal: CAPTURE_MAX_WIDTH })
    expect(c.height).toEqual({ ideal: CAPTURE_MAX_HEIGHT })
  })

  it('stays at 720p when the camera is only the PiP', () => {
    // PiP is 24% of output width — 720p already exceeds what the output uses,
    // and the smaller frame is cheaper to encode.
    const c = cameraVideoConstraints({ ...base, screen: true })
    expect(c.width).toEqual({ ideal: 1280 })
    expect(c.height).toEqual({ ideal: 720 })
  })
})

/**
 * PO 2026-08-25: "share sound in chrome with screen toggle not there anymore."
 * On macOS/Linux Chromium the "Also share tab audio" checkbox lives on the
 * Chrome-Tab pane and nowhere else, so a take that asked for sound must open
 * the picker there — otherwise the user is staring at a picker with no sound
 * toggle in it and a Tab Audio chip that is lit.
 */
describe('which pane the picker opens on', () => {
  const withScreen = { ...base, screen: true }

  it('tab-audio platform + sound wanted: the Chrome-Tab pane, where the checkbox is', () => {
    expect(displayPaneHint({ ...withScreen, systemAudio: true }, 'tab')).toBe('browser')
  })

  it('no sound wanted: the Entire-Screen pane, unchanged since 2026-08-06', () => {
    expect(displayPaneHint({ ...withScreen, systemAudio: false }, 'tab')).toBe('monitor')
  })

  it('Windows: a monitor share carries the machine audio, so nothing moves', () => {
    expect(displayPaneHint({ ...withScreen, systemAudio: true }, 'system')).toBe('monitor')
  })
})

describe('the request Chrome receives, rung by rung', () => {
  const config = { screen: true, camera: false, mic: false, systemAudio: true }

  it('rung 0 asks for everything', () => {
    const o = displayMediaOptions(config, 0, 'tab')
    expect(o.audio).toBeTruthy()
    expect(o.systemAudio).toBe('include')
    expect(o.selfBrowserSurface).toBe('exclude')
    expect((o.video as MediaTrackConstraints).width).toEqual({ max: CAPTURE_MAX_WIDTH })
  })

  it('rungs 1 and 2 drop only what the user cannot see — audio survives both', () => {
    for (const level of [1, 2] as const) {
      const o = displayMediaOptions(config, level, 'tab')
      expect(o.audio).toBeTruthy()
      expect(o.selfBrowserSurface).toBeUndefined()
      expect(o.surfaceSwitching).toBeUndefined()
      expect(o.systemAudio).toBeUndefined()
    }
  })

  it('only the last rung is silent', () => {
    expect(displayMediaOptions(config, 3, 'tab').audio).toBe(false)
  })

  it('sound off means sound off at every rung', () => {
    const silent = { ...config, systemAudio: false }
    for (const level of [0, 1, 2, 3] as const) {
      expect(displayMediaOptions(silent, level, 'tab').audio).toBe(false)
    }
  })
})

describe('when the picker hands back no audio track', () => {
  it('names the box that platform actually shows', () => {
    expect(displayAudioMissingMessage('browser', 'tab')).toMatch(/Also share tab audio/)
    expect(displayAudioMissingMessage('monitor', 'system')).toMatch(/Also share system audio/)
  })

  it('does not tell a macOS user to tick a box Chrome never showed them', () => {
    // Monitor share on a tab-only platform: no checkbox existed, so "tick it"
    // would be a lie. Say what would actually work instead.
    const msg = displayAudioMissingMessage('monitor', 'tab')
    expect(msg).not.toMatch(/tick/)
    expect(msg).toMatch(/Chrome Tab/)
  })
})
