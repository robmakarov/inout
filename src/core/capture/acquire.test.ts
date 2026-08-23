import { describe, expect, it } from 'vitest'
import { cameraVideoConstraints, CAPTURE_MAX_HEIGHT, CAPTURE_MAX_WIDTH } from './acquire'

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
