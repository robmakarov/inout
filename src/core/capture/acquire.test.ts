import { describe, expect, it } from 'vitest'
import {
  cameraVideoConstraints,
  displayMediaOptions,
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
 * THE PICKER IS THE USER'S. It offers what Chrome offers — every surface, in
 * Chrome's own order — and the app does not take an option out of it to make
 * its own life easier (PO 2026-08-25, after a few hours in which it did).
 */
describe('what the picker offers', () => {
  const withScreen = { ...base, screen: true }

  it('never removes a surface from Chrome\u2019s picker, sound on or off', () => {
    for (const systemAudio of [true, false]) {
      for (const level of [0, 1, 2] as const) {
        const o = displayMediaOptions({ ...withScreen, systemAudio }, level)
        expect((o as Record<string, unknown>).monitorTypeSurfaces).toBeUndefined()
      }
    }
  })

  it('the pane hint is the same one every take: Entire Screen (2026-08-06)', () => {
    for (const systemAudio of [true, false]) {
      const o = displayMediaOptions({ ...withScreen, systemAudio }, 0)
      expect((o.video as MediaTrackConstraints).displaySurface).toBe('monitor')
    }
  })
})

describe('the request Chrome receives, rung by rung', () => {
  const config = { screen: true, camera: false, mic: false, systemAudio: true }

  it('rung 0 asks for everything', () => {
    const o = displayMediaOptions(config, 0)
    expect(o.audio).toBeTruthy()
    expect(o.systemAudio).toBe('include')
    expect(o.selfBrowserSurface).toBe('exclude')
    expect((o.video as MediaTrackConstraints).width).toEqual({ max: CAPTURE_MAX_WIDTH })
  })

  it('rungs 1 and 2 drop only what the user cannot see', () => {
    for (const level of [1, 2] as const) {
      const o = displayMediaOptions(config, level)
      expect(o.selfBrowserSurface).toBeUndefined()
      expect(o.surfaceSwitching).toBeUndefined()
      expect(o.systemAudio).toBeUndefined()
    }
  })

  /**
   * THE INVARIANT, PO 2026-08-25: "i need this shit never happen to user,
   * always fucking clean". Safe mode may drop OUR options; it may never drop
   * one the user chose. If a future session adds a rung that turns Tab Audio
   * off to dodge a wedge, this is the test that has to be deleted first — and
   * deleting it is the bug.
   */
  it('NO rung ever drops the audio the user asked for', () => {
    for (const level of [0, 1, 2] as const) {
      expect(displayMediaOptions(config, level).audio).toBeTruthy()
    }
  })

  it('sound off means sound off at every rung', () => {
    const silent = { ...config, systemAudio: false }
    for (const level of [0, 1, 2] as const) {
      expect(displayMediaOptions(silent, level).audio).toBe(false)
    }
  })
})

describe('when the picker hands back no audio track', () => {
  it('names the box in the picker the user just used', () => {
    expect(displayAudioMissingMessage()).toMatch(/Also share system audio/)
  })
})
