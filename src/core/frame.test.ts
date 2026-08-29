/**
 * F13 — the frame follows the take.
 *
 * THE FIRST DESCRIBE IS THE WHOLE SAFETY NET and it is deliberately the
 * dullest: every geometry this product has ever emitted comes back to the
 * pixel. The task's own gate says a 16:9 take may not move, and "may not move"
 * is not an argument about a contain-fit — it is these numbers.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ChannelRecording, Recording } from '@core/types'
import {
  DEFAULT_FRAME_ASPECT,
  adoptedFrame,
  aspectOf,
  evenDim,
  frameAspectFor,
  frameForAspect,
  frameScale,
  setSourceFrame,
  sourceFrameEnabled,
  takeAspect,
} from './frame'

afterEach(() => setSourceFrame(null))

function channel(over: Partial<ChannelRecording> = {}): ChannelRecording {
  return {
    id: 'ch',
    kind: 'screen',
    media: 'video',
    mimeType: 'video/mp4',
    blobKey: 'k',
    startOffsetMs: 0,
    durationMs: 1000,
    width: 1920,
    height: 1080,
    ...over,
  }
}

function recording(channels: ChannelRecording[]): Recording {
  return { id: 'rec', createdAt: 0, durationMs: 1000, channels }
}

describe('16:9 is the identity', () => {
  it('every quality step resolves to exactly the box it always was', () => {
    expect(frameForAspect(16 / 9, 960)).toEqual({ width: 960, height: 540 })
    expect(frameForAspect(16 / 9, 1280)).toEqual({ width: 1280, height: 720 })
    expect(frameForAspect(16 / 9, 1920)).toEqual({ width: 1920, height: 1080 })
    expect(frameForAspect(16 / 9, 2560)).toEqual({ width: 2560, height: 1440 })
  })

  it('the layout scale is width / 1920 on every landscape frame', () => {
    for (const [w, h] of [
      [960, 540],
      [1280, 720],
      [1920, 1080],
      [2560, 1440],
      [1920, 1440],
    ] as const) {
      expect(frameScale(w, h)).toBe(w / 1920)
    }
  })
})

describe('the flag is the whole of the change', () => {
  it('off, a portrait take is still landscape 16:9 — nothing moves', () => {
    expect(sourceFrameEnabled()).toBe(false)
    const rec = recording([channel({ kind: 'camera', width: 1080, height: 1920 })])
    expect(frameAspectFor(rec)).toBe(DEFAULT_FRAME_ASPECT)
    expect(frameForAspect(frameAspectFor(rec), 1920)).toEqual({ width: 1920, height: 1080 })
  })

  it('on, the same take is portrait', () => {
    setSourceFrame(true)
    const rec = recording([channel({ kind: 'camera', width: 1080, height: 1920 })])
    expect(frameAspectFor(rec)).toBeCloseTo(1080 / 1920, 10)
    expect(frameForAspect(frameAspectFor(rec), 1920)).toEqual({ width: 1080, height: 1920 })
  })

  it('on, a 16:9 take is still exactly 1920x1080', () => {
    setSourceFrame(true)
    const rec = recording([channel({ width: 2560, height: 1440 })])
    expect(frameForAspect(frameAspectFor(rec), 1920)).toEqual({ width: 1920, height: 1080 })
  })
})

describe('the frame the take asks for', () => {
  it('a 9:16 phone camera keeps all of itself at the 1080p budget', () => {
    expect(frameForAspect(9 / 16, 1920)).toEqual({ width: 1080, height: 1920 })
  })

  it('a 4:3 camera keeps its full height instead of losing 25 % of it', () => {
    expect(frameForAspect(4 / 3, 1920)).toEqual({ width: 1920, height: 1440 })
    // The crop this task exists to remove: cover into 1920x1080 kept 1080/1440.
    expect(1080 / 1440).toBeCloseTo(0.75, 10)
  })

  it('every side is even, whatever the aspect', () => {
    for (const a of [1.333, 0.5625, 1.6, 2.35, 1 / 2.35, 1.539]) {
      for (const long of [960, 1280, 1920, 2560]) {
        const f = frameForAspect(a, long)
        expect(f.width % 2).toBe(0)
        expect(f.height % 2).toBe(0)
        expect(Math.max(f.width, f.height)).toBe(long)
      }
    }
  })

  it('a nonsense aspect falls back rather than emitting NaN', () => {
    expect(frameForAspect(Number.NaN, 1920)).toEqual({ width: 1920, height: 1080 })
    expect(frameForAspect(0, 1920)).toEqual({ width: 1920, height: 1080 })
    expect(frameForAspect(Number.POSITIVE_INFINITY, 1920)).toEqual({ width: 1920, height: 1080 })
  })

  it('evenDim never collapses a side to zero', () => {
    expect(evenDim(0)).toBe(2)
    expect(evenDim(1)).toBe(2)
    expect(evenDim(1079)).toBe(1080)
  })
})

describe('which channel the take follows', () => {
  it('the screen decides when there is one', () => {
    setSourceFrame(true)
    const rec = recording([
      channel({ id: 'cam', kind: 'camera', width: 640, height: 480 }),
      channel({ id: 'scr', kind: 'screen', width: 2560, height: 1440 }),
    ])
    expect(takeAspect(rec)).toBeCloseTo(16 / 9, 10)
  })

  it('with no screen, the camera does — that take IS the camera', () => {
    setSourceFrame(true)
    const rec = recording([channel({ id: 'cam', kind: 'camera', width: 640, height: 480 })])
    expect(takeAspect(rec)).toBeCloseTo(4 / 3, 10)
  })

  it('audio-only, and a video channel that never recorded its size, keep the constant', () => {
    setSourceFrame(true)
    const audio = channel({ id: 'mic', kind: 'mic', media: 'audio', width: undefined, height: undefined })
    expect(takeAspect(recording([audio]))).toBe(DEFAULT_FRAME_ASPECT)
    expect(takeAspect(recording([]))).toBe(DEFAULT_FRAME_ASPECT)
    expect(
      takeAspect(recording([channel({ width: undefined, height: undefined })])),
    ).toBe(DEFAULT_FRAME_ASPECT)
    expect(takeAspect(recording([channel({ width: 0, height: 0 })]))).toBe(DEFAULT_FRAME_ASPECT)
  })

  it('the composite answers first — a take is the shape it was recorded at', () => {
    setSourceFrame(true)
    // A 4:3 camera take whose composite was written landscape, i.e. every take
    // made before the frame followed anything. The default step copies that
    // file, so the frame has to BE that file or the badge lies.
    const rec: Recording = {
      ...recording([channel({ kind: 'camera', width: 640, height: 480 })]),
      composite: {
        blobKey: 'c',
        mimeType: 'video/mp4',
        durationMs: 1000,
        width: 1920,
        height: 1080,
      },
    }
    expect(takeAspect(rec)).toBeCloseTo(16 / 9, 10)
  })

  it('a composite recorded portrait carries the take portrait', () => {
    setSourceFrame(true)
    const rec: Recording = {
      ...recording([channel({ kind: 'camera', width: 1080, height: 1920 })]),
      composite: {
        blobKey: 'c',
        mimeType: 'video/mp4',
        durationMs: 1000,
        width: 1080,
        height: 1920,
      },
    }
    expect(frameForAspect(frameAspectFor(rec), 1920)).toEqual({ width: 1080, height: 1920 })
  })

  it('aspectOf refuses to invent one', () => {
    expect(aspectOf(1920, 1080)).toBeCloseTo(16 / 9, 10)
    expect(aspectOf(undefined, 1080)).toBeNull()
    expect(aspectOf(1920, 0)).toBeNull()
    expect(aspectOf(-4, 3)).toBeNull()
  })
})

describe('the portrait frame keeps the layout it was authored with', () => {
  it('a 1080x1920 frame scales the PiP border by the long edge, not the width', () => {
    // width/1920 would be 0.5625 here — a 44 % thinner border and a 44 % tighter
    // corner than the same layout drawn landscape.
    expect(frameScale(1080, 1920)).toBe(1)
    expect(frameScale(540, 960)).toBe(0.5)
  })
})

/**
 * F13, SECOND PASS — the phone. PO judged the first pass on a real device and
 * it was still cropped: `track.getSettings()` describes the SENSOR, so a phone
 * held portrait reports 1920x1080 while every frame delivered is 1080x1920.
 * Capture believed the settings. These are the cases that produced.
 */
describe('the picture that arrived beats the settings that were reported', () => {
  it('a landscape sensor report with portrait frames asks for a portrait frame', () => {
    expect(adoptedFrame({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, 1920)).toEqual({
      width: 1080,
      height: 1920,
    })
  })

  it('asks for nothing when the settings were already right', () => {
    expect(adoptedFrame({ width: 1920, height: 1080 }, { width: 1280, height: 720 }, 1920)).toBeNull()
    expect(adoptedFrame({ width: 1920, height: 1080 }, { width: 3840, height: 2160 }, 1920)).toBeNull()
    expect(adoptedFrame({ width: 1080, height: 1920 }, { width: 720, height: 1280 }, 1920)).toBeNull()
  })

  it('asks for nothing when the frame says nothing', () => {
    expect(adoptedFrame({ width: 1920, height: 1080 }, { width: 0, height: 0 }, 1920)).toBeNull()
    expect(adoptedFrame({ width: 1920, height: 1080 }, { width: 640, height: 0 }, 1920)).toBeNull()
  })

  it('keeps the pixel budget — the frame turns, it does not grow', () => {
    const want = adoptedFrame({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, 1920)!
    expect(Math.max(want.width, want.height)).toBe(1920)
  })

  it('a 4:3 sensor reported landscape but delivered 4:3 keeps its full height', () => {
    expect(adoptedFrame({ width: 1920, height: 1080 }, { width: 640, height: 480 }, 1920)).toEqual({
      width: 1920,
      height: 1440,
    })
  })
})
