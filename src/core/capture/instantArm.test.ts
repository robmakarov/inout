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
import { setNativeRes } from './nativeRes'

/**
 * Run `fn` with the native-res preference forced. This suite has no DOM, so the
 * sticky store has to exist for the preference to be readable at all.
 */
function withNativeRes<T>(on: boolean, fn: () => T): T {
  const store = new Map<string, string>()
  const g = globalThis as { localStorage?: unknown }
  const had = 'localStorage' in g
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  setNativeRes(on)
  const done = () => {
    if (!had) delete g.localStorage
  }
  try {
    const out = fn()
    if (out instanceof Promise) return out.finally(done) as T
    done()
    return out
  } catch (err) {
    done()
    throw err
  }
}

// Robert 2026-08-23 removed the tab/window "Heads-up:" toasts. The picker the user
// just used already shows which surface they chose, so the notice narrated
// their own click; the frozen-source banner still covers the case where the
// surface really does stop delivering, and it fires on measurement. The test
// stays, inverted, so a well-meaning re-introduction has to argue with it.
describe('shared-surface notice', () => {
  it('says nothing for any surface — the picker already showed the user their choice', () => {
    expect(surfaceNotice('browser')).toBeNull()
    expect(surfaceNotice('window')).toBeNull()
    expect(surfaceNotice('monitor')).toBeNull()
    expect(surfaceNotice(undefined)).toBeNull()
  })
})

describe('capture ceiling (4K game tab froze the take, Robert 2026-08-22)', () => {
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

  it('caps the frame rate on every rung, native-res or not', () => {
    // A 60 fps game tab must be capped, not merely nudged: `ideal` alone lets
    // Chrome deliver 60 and every extra frame is encoded twice, then dropped.
    // This bound is about frames and not pixels, so native-res never lifts it.
    const c = displayVideoConstraints() as { frameRate: { max: number; ideal: number } }
    expect(c.frameRate.max).toBe(CAPTURE_MAX_FPS)
    withNativeRes(false, () => {
      const off = displayVideoConstraints() as { frameRate: { max: number } }
      expect(off.frameRate.max).toBe(CAPTURE_MAX_FPS)
    })
  })

  it('DEFAULT sends the size bound again — the freeze appeared and Robert said', () => {
    const c = displayVideoConstraints() as { width: { max: number }; height: { max: number } }
    expect(c.width).toEqual({ max: CAPTURE_MAX_WIDTH })
    expect(c.height).toEqual({ max: CAPTURE_MAX_HEIGHT })
  })

  it('with native-res ON the bound is dropped, which is the whole point of the flag', () => {
    withNativeRes(true, () => {
      const c = displayVideoConstraints() as { width?: unknown; height?: unknown }
      expect(c.width).toBeUndefined()
      expect(c.height).toBeUndefined()
    })
  })

  it('with native-res OFF the request is bounded by MAX only — a small surface is never overconstrained', () => {
    withNativeRes(false, () => {
      const c = displayVideoConstraints() as { width: { max: number }; height: { max: number } }
      expect(c.width).toEqual({ max: CAPTURE_MAX_WIDTH })
      expect(c.height).toEqual({ max: CAPTURE_MAX_HEIGHT })
    })
  })

  it('recognises an oversized surface and leaves a compliant one alone', () => {
    expect(exceedsCaptureCeiling({ width: 3840, height: 2160, frameRate: 30 })).toBe(true)
    expect(exceedsCaptureCeiling({ width: 1920, height: 1080, frameRate: 60 })).toBe(true)
    expect(exceedsCaptureCeiling({ width: 1920, height: 1080, frameRate: 30 })).toBe(false)
    // Capturers report 29.97 / 30.000001 — slack must not trigger a re-apply.
    expect(exceedsCaptureCeiling({ width: 1280, height: 720, frameRate: 30.000001 })).toBe(false)
  })

  it('with native-res ON a 4K surface is KEPT — the ladder is that flag\'s safety net', async () => {
    // The risk Robert took explicitly on 2026-08-29, and took back the same day
    // when the freeze arrived. Behind the flag the ladder is still the net.
    const apply = vi.fn().mockResolvedValue(undefined)
    await withNativeRes(true, () =>
      capDisplayTrack(track({ width: 3840, height: 2160, frameRate: 30 }, apply)),
    )
    expect(apply).not.toHaveBeenCalled()
  })

  it('DEFAULT: a 4K surface is capped again, which is what stops the 08-22 freeze', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    await capDisplayTrack(track({ width: 3840, height: 2160, frameRate: 60 }, apply))
    expect(apply).toHaveBeenCalledWith({
      width: { max: CAPTURE_MAX_WIDTH },
      height: { max: CAPTURE_MAX_HEIGHT },
      frameRate: { max: CAPTURE_MAX_FPS },
    })
  })

  it('with native-res OFF a 4K surface is still downscaled when the picker was ignored', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    await withNativeRes(false, () =>
      capDisplayTrack(track({ width: 3840, height: 2160, frameRate: 60 }, apply)),
    )
    expect(apply).toHaveBeenCalledWith({
      width: { max: CAPTURE_MAX_WIDTH },
      height: { max: CAPTURE_MAX_HEIGHT },
      frameRate: { max: CAPTURE_MAX_FPS },
    })
  })

  it('touches nothing when the surface already fits', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    await withNativeRes(false, () =>
      capDisplayTrack(track({ width: 1440, height: 900, frameRate: 30 }, apply)),
    )
    expect(apply).not.toHaveBeenCalled()
  })

  /**
   * THE TAKE ROBERT LOST ITS SCREEN ON, the morning native-res went default.
   * AVC cannot encode an odd side, so a 1728x1117 display — a stock macOS
   * "More Space" mode — made the raw channel's VideoEncoder answer "no
   * supported AVC config", the MediaRecorder fallback wrote nothing either,
   * and the take came back "Missing from this take: Screen" while the preview
   * had shown the screen throughout. Reproduced on prod with
   * `?synthetic=1&screensize=1728x1117`; 1728x1118 and 1512x982 were fine.
   */
  it('DEFAULT: an ODD side is evened, because AVC refuses it and the channel is lost', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    await capDisplayTrack(track({ width: 1728, height: 1117, frameRate: 30 }, apply))
    expect(apply).toHaveBeenCalledWith({ width: { max: 1728 }, height: { max: 1116 } })
  })

  it('EVERY branch is evened, including the escape hatch — `?nativeres=0` caps to an ODD width', async () => {
    // THE HOLE THAT SURVIVED THE FIRST FIX. Evening only the native-res branch
    // left `?nativeres=0` — the documented switch for a machine that is
    // struggling — producing an odd track, because capping a 3456x2234 screen
    // into a 1920x1080 box gives 1671x1080. Aspect ratio makes an odd side the
    // NORM after a cap, not the exception. Measured: 0 frames encoded of 199.
    const apply = vi.fn().mockResolvedValue(undefined)
    const t = track({ width: 3456, height: 2234, frameRate: 30 }, apply)
    // The cap lands first, then the track reports what the cap gave it.
    let settings: MediaTrackSettings = { width: 3456, height: 2234, frameRate: 30 }
    t.getSettings = () => settings
    apply.mockImplementation(async () => {
      settings = { width: 1671, height: 1080, frameRate: 30 }
    })
    await withNativeRes(false, () => capDisplayTrack(t))
    expect(apply).toHaveBeenLastCalledWith({ width: { max: 1670 }, height: { max: 1080 } })
  })

  it('DEFAULT: an even native surface is still left completely alone', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    await capDisplayTrack(track({ width: 1512, height: 982, frameRate: 30 }, apply))
    expect(apply).not.toHaveBeenCalled()
  })

  it('evening the track is never fatal: a track that refuses is still recorded', async () => {
    const apply = vi.fn().mockRejectedValue(new Error('OverconstrainedError'))
    await expect(
      capDisplayTrack(track({ width: 1728, height: 1117, frameRate: 30 }, apply)),
    ).resolves.toBeUndefined()
  })

  it('an oversized take beats no take: a rejecting applyConstraints never throws', async () => {
    const apply = vi.fn().mockRejectedValue(new Error('OverconstrainedError'))
    await expect(
      withNativeRes(false, () =>
        capDisplayTrack(track({ width: 3840, height: 2160, frameRate: 30 }, apply)),
      ),
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
    // ("stuck waiting for mic", Robert 2026-07-23). Lower bound: 5s falsely killed
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

  /**
   * Robert 2026-08-23, "why the fuck mic dont connects". A pre-granted mic starts
   * CONCURRENTLY with the screen picker — that overlap is the instant-start
   * win — but it carried ACQUIRE_TIMEOUT_MS, which is a HARDWARE budget. So
   * the 8 s ran while the user was reading Chrome's picker, and any take where
   * choosing a surface took longer than that lost its microphone. Every time,
   * deterministically, with a mic that was working perfectly.
   */
  describe('a device budget never counts time a human is spending', () => {
    it('does not fire while the picker is still open', async () => {
      vi.useFakeTimers()
      try {
        let closePicker!: () => void
        const picker = new Promise<void>((r) => {
          closePicker = r
        })
        const device = new Promise<string>(() => {}) // never resolves
        const guarded = withTimeout(device, 8_000, 'getUserMedia(mic)', picker)
        let settled = false
        void guarded.catch(() => {
          settled = true
        })
        // Thirty seconds of picker time — four budgets' worth.
        await vi.advanceTimersByTimeAsync(30_000)
        expect(settled).toBe(false)
        // Picker closes: NOW the hardware has its 8 s, and not a moment before.
        closePicker()
        await vi.advanceTimersByTimeAsync(7_000)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1_500)
        expect(settled).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a device that arrives during the picker is kept, however long it took', async () => {
      vi.useFakeTimers()
      try {
        let closePicker!: () => void
        const picker = new Promise<void>((r) => {
          closePicker = r
        })
        let deliver!: (v: string) => void
        const device = new Promise<string>((r) => {
          deliver = r
        })
        const guarded = withTimeout(device, 8_000, 'getUserMedia(mic)', picker)
        await vi.advanceTimersByTimeAsync(60_000)
        deliver('mic-stream')
        closePicker()
        await expect(guarded).resolves.toBe('mic-stream')
        // And no stray timer may fire afterwards and reject a resolved promise.
        await vi.advanceTimersByTimeAsync(20_000)
      } finally {
        vi.useRealTimers()
      }
    })

    it('still times out normally when no human is in the loop', async () => {
      vi.useFakeTimers()
      try {
        const guarded = withTimeout(new Promise<string>(() => {}), 8_000, 'getUserMedia(mic)')
        const rejection = expect(guarded).rejects.toThrow(/timed out/)
        await vi.advanceTimersByTimeAsync(8_001)
        await rejection
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
