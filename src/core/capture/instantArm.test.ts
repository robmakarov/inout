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
  CAPTURE_MAX_LONG_EDGE,
} from './acquire'
import { DEFAULT_EXPORT_SETTINGS } from '@core/types'
import { QUALITY_TIERS } from '@core/compose/quality'
import { deliverSyntheticProgressively, parseSlowChannels } from './synthetic'
import { setNativeRes } from './nativeRes'
import { setQualityStep, type QualityStepId } from '@core/qualityStep'

/**
 * Run `fn` with the quality ceiling forced (UI1). `setQualityStep` keeps a
 * module-level override precisely so a test with no localStorage can set it.
 */
function withQualityStep<T>(id: QualityStepId, fn: () => T): T {
  try {
    setQualityStep(id)
    return fn()
  } finally {
    setQualityStep(null)
  }
}

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

  it('DEFAULT bounds the request by the CHOSEN QUALITY STEP, not the monitor', () => {
    // Native resolution means everything the product can DELIVER, not the
    // monitor's own size: Robert's 3024x1964 screen was 5.9 Mpx of which 4.25
    // could ever reach a file, and the rest was encoded, written and discarded
    // while a game shared the GPU. A SQUARE box, so a rotated display is
    // bounded on its own long edge rather than crushed onto the wrong axis.
    //
    // UI1 handed that ceiling to the user: the slider above the chips bounds
    // CAPTURE and not just the export ladder, so the pixels above the chosen
    // step are never encoded at all. 1920 at the default step.
    const c = displayVideoConstraints() as { width: { max: number }; height: { max: number } }
    expect(c.width).toEqual({ max: 1920 })
    expect(c.height).toEqual({ max: 1920 })
  })

  it('the step moves the bound, and `max` lifts it entirely', () => {
    withQualityStep('540p', () => {
      const c = displayVideoConstraints() as { width: { max: number } }
      expect(c.width).toEqual({ max: 960 })
    })
    withQualityStep('1440p', () => {
      const c = displayVideoConstraints() as { width: { max: number } }
      expect(c.width).toEqual({ max: CAPTURE_MAX_LONG_EDGE })
    })
    withQualityStep('max', () => {
      const c = displayVideoConstraints() as { width?: unknown; frameRate: { max: number } }
      expect(c.width).toBeUndefined()
      // Robert on what the top step means, 2026-08-30: "max - maximum
      // resolution, 60 fps, all maximum".
      expect(c.frameRate.max).toBe(60)
    })
  })

  it('the ceiling IS the largest quality step, so adding a bigger step moves it', () => {
    // The tie that keeps the claim honest: "nothing above this can ever be
    // exported" is only true while this is the top of the export ladder.
    expect(CAPTURE_MAX_LONG_EDGE).toBe(Math.max(...QUALITY_TIERS.map((t) => t.longEdge)))
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

  it('DEFAULT: a 4K surface is bounded even when the REQUEST carried no bound', async () => {
    // After a stuck share the wedge ladder drops to `{video: true}` and sends
    // NO video constraints — Robert's log read "reduced request 2/2" — so a
    // machine that has ever wedged was capturing its whole monitor however this
    // flag was set. A bound that lives only in the request is a bound the
    // degraded path does not have.
    const apply = vi.fn().mockResolvedValue(undefined)
    await capDisplayTrack(track({ width: 3840, height: 2160, frameRate: 30 }, apply))
    expect(apply).toHaveBeenCalledWith({
      width: { max: 1920 },
      height: { max: 1920 },
    })
  })

  it('a surface already inside the chosen step is left completely alone', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    await capDisplayTrack(track({ width: 1920, height: 1080, frameRate: 30 }, apply))
    expect(apply).not.toHaveBeenCalled()
    // …and the SAME surface is capped once the step is below it (UI1).
    const apply720 = vi.fn().mockResolvedValue(undefined)
    await withQualityStep('720p', () =>
      capDisplayTrack(track({ width: 1920, height: 1080, frameRate: 30 }, apply720)),
    )
    expect(apply720).toHaveBeenCalledWith({ width: { max: 1280 }, height: { max: 1280 } })
  })

  it('`max` bounds nothing: the whole monitor arrives untouched', async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    await withQualityStep('max', () =>
      capDisplayTrack(track({ width: 3456, height: 2234, frameRate: 30 }, apply)),
    )
    expect(apply).not.toHaveBeenCalled()
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

  /**
   * THE WIRING, WHICH IS THE HALF THAT HAD NO TEST (task G6e, 2026-09-02).
   *
   * `slow=` was carried as DEAD CODE — "parseSlowChannels has no caller" — in
   * .ai/TASKS, BACKLOG.md, docs/FLAGS.md and CLAUDE.md. It is not: the parser
   * is called by createSyntheticChannelsProgressive, which session.ts uses for
   * every synthetic arm, and the knob works. Measured on prod the same day:
   * `?synthetic=1` armed in 183 ms, `?synthetic=1&slow=mic:6000` armed in
   * 6079 ms with "Waiting for microphone…" on screen from t=30 ms.
   *
   * The belief survived three sessions because the three cases above cover the
   * PARSE and nothing covered the DELIVERY, so the only way to tell a live knob
   * from a dead one was to open a browser. These two close that: a fake rig,
   * fake timers, no canvas and no AudioContext.
   */
  const fakeChannel = (kind: 'mic' | 'camera') => {
    const track = { stop: () => undefined } as unknown as MediaStreamTrack
    return {
      kind,
      media: (kind === 'mic' ? 'audio' : 'video') as 'audio' | 'video',
      stream: { getTracks: () => [track] } as unknown as MediaStream,
      track,
    }
  }
  const config = { screen: false, camera: false, mic: true, systemAudio: false }

  /** The URL under test, for code that reads `location.search` directly. Node
   *  defines no `location`, so this is an addition and not an override. */
  const withSearch = async (search: string, fn: () => Promise<void>): Promise<void> => {
    const had = 'location' in globalThis
    const prev = (globalThis as { location?: unknown }).location
    ;(globalThis as { location?: unknown }).location = { search }
    try {
      await fn()
    } finally {
      if (had) (globalThis as { location?: unknown }).location = prev
      else delete (globalThis as { location?: unknown }).location
    }
  }

  it('a parsed delay holds the delivery back by exactly that long', async () => {
    vi.useFakeTimers()
    try {
      await withSearch('?synthetic=1&slow=mic:6000', async () => {
        const delivered: { kind: string }[] = []
        const rig = deliverSyntheticProgressively(
          { channels: [fakeChannel('mic')], dispose: () => undefined },
          config,
          { onChannel: (c) => delivered.push({ kind: c.kind }), onFailure: () => undefined },
        )
        await vi.advanceTimersByTimeAsync(5999)
        expect(delivered).toEqual([])
        await vi.advanceTimersByTimeAsync(2)
        expect(delivered).toEqual([{ kind: 'mic' }])
        await rig.settled
        rig.dispose()
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a kind the URL does not name is delivered immediately', async () => {
    vi.useFakeTimers()
    try {
      await withSearch('?synthetic=1&slow=mic:6000', async () => {
        const delivered: string[] = []
        const rig = deliverSyntheticProgressively(
          { channels: [fakeChannel('mic'), fakeChannel('camera')], dispose: () => undefined },
          { ...config, camera: true },
          { onChannel: (c) => delivered.push(c.kind), onFailure: () => undefined },
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(delivered).toEqual(['camera'])
        await vi.advanceTimersByTimeAsync(6000)
        expect(delivered).toEqual(['camera', 'mic'])
        await rig.settled
        rig.dispose()
      })
    } finally {
      vi.useRealTimers()
    }
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
