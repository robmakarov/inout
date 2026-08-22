import { describe, expect, it, vi } from 'vitest'
import {
  ACQUIRE_TIMEOUT_MS,
  CAPTURE_MAX_FPS,
  CAPTURE_MAX_HEIGHT,
  CAPTURE_MAX_WIDTH,
  PROMPT_TIMEOUT_MS,
  capDisplayTrack,
  displayVideoConstraints,
  exceedsCaptureCeiling,
  primaryKindFor,
  surfaceNotice,
  withTimeout,
} from './acquire'
import { DEFAULT_EXPORT_SETTINGS } from '@core/types'
import { parseSlowChannels } from './synthetic'

describe('shared-surface notice', () => {
  it('warns that a single tab records nothing else', () => {
    expect(surfaceNotice('browser')).toMatch(/ONE browser tab/)
    expect(surfaceNotice('browser')).toMatch(/whole screen/)
  })
  it('warns that a single window can freeze', () => {
    expect(surfaceNotice('window')).toMatch(/ONE app window/)
    expect(surfaceNotice('window')).toMatch(/freezes/)
  })
  it('stays quiet for a whole monitor — that records everything', () => {
    expect(surfaceNotice('monitor')).toBeNull()
  })
  it('stays quiet when the browser does not report a surface', () => {
    expect(surfaceNotice(undefined)).toBeNull()
  })
})

describe('capture ceiling (4K game tab froze the take, PO 2026-08-22)', () => {
  const track = (settings: MediaTrackSettings, apply = vi.fn().mockResolvedValue(undefined)) =>
    ({
      getSettings: () => settings,
      applyConstraints: apply,
    }) as unknown as MediaStreamTrack

  it('never pulls more pixels than the product can emit', () => {
    // If these drift apart we pay for frames that are thrown away at export.
    expect(CAPTURE_MAX_WIDTH).toBe(DEFAULT_EXPORT_SETTINGS.width)
    expect(CAPTURE_MAX_HEIGHT).toBe(DEFAULT_EXPORT_SETTINGS.height)
    expect(CAPTURE_MAX_FPS).toBe(DEFAULT_EXPORT_SETTINGS.fps)
  })

  it('constrains the picker request by MAX only — a small surface can never be overconstrained', () => {
    const c = displayVideoConstraints() as {
      width: { max: number }
      height: { max: number }
      frameRate: { max: number; ideal: number }
    }
    expect(c.width).toEqual({ max: CAPTURE_MAX_WIDTH })
    expect(c.height).toEqual({ max: CAPTURE_MAX_HEIGHT })
    // A 60 fps game tab must be capped, not merely nudged: `ideal` alone lets
    // Chrome deliver 60 and every extra frame is encoded twice, then dropped.
    expect(c.frameRate.max).toBe(CAPTURE_MAX_FPS)
  })

  it('recognises an oversized surface and leaves a compliant one alone', () => {
    expect(exceedsCaptureCeiling({ width: 3840, height: 2160, frameRate: 30 })).toBe(true)
    expect(exceedsCaptureCeiling({ width: 1920, height: 1080, frameRate: 60 })).toBe(true)
    expect(exceedsCaptureCeiling({ width: 1920, height: 1080, frameRate: 30 })).toBe(false)
    // Capturers report 29.97 / 30.000001 — slack must not trigger a re-apply.
    expect(exceedsCaptureCeiling({ width: 1280, height: 720, frameRate: 30.000001 })).toBe(false)
  })

  it('downscales a 4K surface when the browser ignored the picker constraints', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    await capDisplayTrack(track({ width: 3840, height: 2160, frameRate: 60 }, apply))
    expect(apply).toHaveBeenCalledWith({
      width: { max: CAPTURE_MAX_WIDTH },
      height: { max: CAPTURE_MAX_HEIGHT },
      frameRate: { max: CAPTURE_MAX_FPS },
    })
  })

  it('touches nothing when the surface already fits', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    await capDisplayTrack(track({ width: 1440, height: 900, frameRate: 30 }, apply))
    expect(apply).not.toHaveBeenCalled()
  })

  it('an oversized take beats no take: a rejecting applyConstraints never throws', async () => {
    const apply = vi.fn().mockRejectedValue(new Error('OverconstrainedError'))
    await expect(
      capDisplayTrack(track({ width: 3840, height: 2160, frameRate: 30 }, apply)),
    ).resolves.toBeUndefined()
  })
})

describe('instant-arm primary channel selection', () => {
  const base = { screen: false, camera: false, mic: false, systemAudio: false }
  it('screen gates start whenever requested', () => {
    expect(primaryKindFor({ ...base, screen: true, camera: true, mic: true })).toBe('screen')
  })
  it('camera gates when no screen', () => {
    expect(primaryKindFor({ ...base, camera: true, mic: true })).toBe('camera')
  })
  it('audio-only takes gate on mic', () => {
    expect(primaryKindFor({ ...base, mic: true })).toBe('mic')
  })
  it('nothing requested → no primary', () => {
    expect(primaryKindFor(base)).toBeNull()
  })
})

describe('instant-arm harness knobs', () => {
  it('parses slow= into per-kind delays', () => {
    const m = parseSlowChannels('?synthetic=1&slow=camera:3000,mic:8000')
    expect(m.get('camera')).toBe(3000)
    expect(m.get('mic')).toBe(8000)
    expect(m.size).toBe(2)
  })
  it('ignores junk kinds and non-numeric delays', () => {
    const m = parseSlowChannels('?slow=webcam:100,camera:abc,mic:-5,screen:250')
    expect(m.size).toBe(1)
    expect(m.get('screen')).toBe(250)
  })
  it('empty when absent', () => {
    expect(parseSlowChannels('?synthetic=1').size).toBe(0)
  })
})

describe('acquire budgets', () => {
  it('device budget: above real spin-ups, but bounded — every device gates start', () => {
    // Since synchronized start (2026-07-20) EVERY device blocks the take start,
    // so this budget is exactly how long the UI can freeze on one wedged device
    // ("stuck waiting for mic", PO 2026-07-23). Lower bound: 5s falsely killed
    // slow-but-alive granted inputs (loaded Mac mic, mobile Safari getUserMedia).
    expect(ACQUIRE_TIMEOUT_MS).toBeGreaterThan(5_000)
    expect(ACQUIRE_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
    // Never time a person: prompts and pickers get longer still.
    expect(PROMPT_TIMEOUT_MS).toBeGreaterThan(ACQUIRE_TIMEOUT_MS)
  })

  it('a stream resolving AFTER timeout is released, never leaked', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    class FakeMediaStream {
      getTracks() {
        return [{ stop }]
      }
    }
    vi.stubGlobal('MediaStream', FakeMediaStream)
    try {
      const fakeStream = new FakeMediaStream() as unknown as MediaStream
      let resolveLate!: (v: MediaStream) => void
      const late = new Promise<MediaStream>((r) => {
        resolveLate = r
      })
      const guarded = withTimeout(late, 1000, 'test')
      const rejection = expect(guarded).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(1001)
      await rejection
      // The user answers the prompt AFTER the deadline — light must go off.
      resolveLate(fakeStream)
      await Promise.resolve()
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
