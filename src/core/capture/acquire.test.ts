import { afterEach, describe, expect, it } from 'vitest'
import {
  cameraVideoConstraints,
  orientedCameraBox,
  displayMediaOptions,
  displayAudioMissingMessage,
  CAPTURE_MAX_FPS,
  CAPTURE_MAX_HEIGHT,
  CAPTURE_MAX_WIDTH,
  CAPTURE_MAX_LONG_EDGE,
} from './acquire'
import { setNativeRes } from './nativeRes'
import { setSourceFrame } from '@core/frame'
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

  /**
   * F13's second, smaller half: the app asked a SCREENLESS take's sensor for a
   * landscape box before anything was composited — on the one kind of take a
   * phone can make.
   */
  describe('the screenless ask follows the device (F13)', () => {
    const g = globalThis as { window?: unknown }

    function withViewport<T>(width: number, height: number, run: () => T): T {
      const had = 'window' in g
      const before = g.window
      g.window = { innerWidth: width, innerHeight: height }
      try {
        return run()
      } finally {
        if (had) g.window = before
        else delete g.window
      }
    }

    afterEach(() => setSourceFrame(null))

    it('is the landscape box it always was while the flag is off', () => {
      setSourceFrame(false)
      withViewport(390, 844, () => {
        const c = cameraVideoConstraints(base)
        expect(c.width).toEqual({ ideal: CAPTURE_MAX_WIDTH })
        expect(c.height).toEqual({ ideal: CAPTURE_MAX_HEIGHT })
      })
    })

    it('asks portrait on a portrait viewport once the frame follows the source', () => {
      setSourceFrame(true)
      withViewport(390, 844, () => {
        const c = cameraVideoConstraints(base)
        expect(c.width).toEqual({ ideal: CAPTURE_MAX_HEIGHT })
        expect(c.height).toEqual({ ideal: CAPTURE_MAX_WIDTH })
      })
    })

    it('the box itself is the export box, turned', () => {
      withViewport(390, 844, () =>
        expect(orientedCameraBox()).toEqual({
          width: CAPTURE_MAX_HEIGHT,
          height: CAPTURE_MAX_WIDTH,
        }),
      )
      withViewport(1440, 900, () =>
        expect(orientedCameraBox()).toEqual({
          width: CAPTURE_MAX_WIDTH,
          height: CAPTURE_MAX_HEIGHT,
        }),
      )
    })

    it('is unchanged on a landscape viewport, flag or no flag', () => {
      setSourceFrame(true)
      withViewport(1440, 900, () => {
        const c = cameraVideoConstraints(base)
        expect(c.width).toEqual({ ideal: CAPTURE_MAX_WIDTH })
        expect(c.height).toEqual({ ideal: CAPTURE_MAX_HEIGHT })
      })
    })

    it('leaves the PiP ask alone — a PiP is 24 % of the width in any shape', () => {
      setSourceFrame(true)
      withViewport(390, 844, () => {
        const c = cameraVideoConstraints({ ...base, screen: true })
        expect(c.width).toEqual({ ideal: 1280 })
        expect(c.height).toEqual({ ideal: 720 })
      })
    })
  })
})

/**
 * THE PICKER IS THE USER'S. It offers what Chrome offers — every surface, in
 * Chrome's own order — and the app does not take an option out of it to make
 * its own life easier (Robert 2026-08-25, after a few hours in which it did).
 */
describe('what the picker offers', () => {
  const withScreen = { ...base, screen: true }

  it('never removes a surface from Chrome\u2019s picker, sound on or off', () => {
    for (const systemAudio of [true, false]) {
      for (const level of [0, 1, 2, 3] as const) {
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
    // The frame-rate bound is not about resolution and holds on every rung.
    expect((o.video as MediaTrackConstraints).frameRate).toEqual({
      ideal: CAPTURE_MAX_FPS,
      max: CAPTURE_MAX_FPS,
    })
  })

  it('a DEGRADED rung drops the exotic options, never the bounds', () => {
    // The inversion this fixes: rung 1 threw the size and rate bounds out with
    // the options, so a machine that had already choked once started capturing
    // its WHOLE monitor uncapped — the opposite of backing off, and no flag
    // could reach it because the flag lives in the bounds that were removed.
    const v = displayMediaOptions(config, 1).video as MediaTrackConstraints & {
      displaySurface?: string
    }
    expect(v.width).toEqual({ max: 1920 })
    expect(v.height).toEqual({ max: 1920 })
    expect(v.frameRate).toBeDefined()
    expect(v.displaySurface).toBe('monitor')
    // …and the exotic options ARE gone, which is what the rung is for.
    const full = displayMediaOptions(config, 0) as Record<string, unknown>
    const degraded = displayMediaOptions(config, 1) as Record<string, unknown>
    expect(full.selfBrowserSurface).toBeDefined()
    expect(degraded.selfBrowserSurface).toBeUndefined()
  })

  it('rung 2 stays bare, because it is the rung for a machine that wedges on ANY constraint', () => {
    // Covered on the TRACK instead: capDisplayTrack enforces the export ceiling
    // on what actually arrives, whatever the request managed to say.
    expect(displayMediaOptions(config, 2).video).toBe(true)
    // …but it still carries OUR three raw-audio flags, which is what made it a
    // floor that was not one.
    expect(displayMediaOptions(config, 2).audio).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    })
  })

  it('THE REAL FLOOR IS RUNG 3: nothing of ours is left in the request at all', () => {
    // Robert's machine wedged FIVE times with the ladder already on rung 2, so
    // whatever chokes is in what rung 2 still sends — and the only thing rung 2
    // still sends is ours: three audio flags added in 2026-08-26 on the claim
    // that they "cannot reject or hang a request", asserted and never measured.
    const o = displayMediaOptions(config, 3)
    expect(o.video).toBe(true)
    // The user's ask survives — the tab-audio checkbox is still in the picker.
    expect(o.audio).toBe(true)
    // What moved is HOW the raw flags are applied: on the delivered track
    // (repairDisplayAudio) instead of in the request, so the music is still raw.
    expect(Object.keys(o)).toEqual(['video', 'audio'])
  })

  it('rung 3 with the sound off asks for no audio at all', () => {
    expect(displayMediaOptions({ ...config, systemAudio: false }, 3).audio).toBe(false)
  })

  it('THE BOUND IS THE CHOSEN QUALITY STEP, not the monitor', () => {
    // Robert's game-tab take captured 3024x1964 — 5.9 Mpx of which 4.25 could
    // ever reach a file, the rest encoded, written and discarded while a game
    // shared the GPU. A SQUARE box, so a rotated display is bounded on its own
    // long edge rather than crushed onto the wrong axis (F13).
    //
    // UI1 made the bound the user's own: the slider above the chips is a real
    // ceiling on capture, not a label on the export ladder — Robert: "to save
    // resources on other processes". At the default step that is 1920.
    const v = displayMediaOptions(config, 0).video as MediaTrackConstraints
    expect(v.width).toEqual({ max: 1920 })
    expect(v.height).toEqual({ max: 1920 })
    expect(1920).toBeLessThanOrEqual(CAPTURE_MAX_LONG_EDGE)
  })

  it('a higher step raises the bound, and `max` removes it', () => {
    withQualityStep('1440p', () => {
      const v = displayMediaOptions(config, 0).video as MediaTrackConstraints
      expect(v.width).toEqual({ max: CAPTURE_MAX_LONG_EDGE })
      expect(v.height).toEqual({ max: CAPTURE_MAX_LONG_EDGE })
    })
    withQualityStep('max', () => {
      // `{ max: Infinity }` is not a constraint — it is a bug accepted
      // silently — so the bound is OMITTED rather than widened (F18).
      const v = displayMediaOptions(config, 0).video as MediaTrackConstraints
      expect(v.width).toBeUndefined()
      expect(v.height).toBeUndefined()
    })
  })

  it('turning native-res OFF puts the 1080p ceiling back', () => {
    // This suite runs without a DOM, so the sticky store has to exist for the
    // preference to be readable at all.
    const store = new Map<string, string>()
    const g = globalThis as { localStorage?: unknown }
    const had = 'localStorage' in g
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    try {
      setNativeRes(false)
      const v = displayMediaOptions(config, 0).video as MediaTrackConstraints
      expect(v.width).toEqual({ max: CAPTURE_MAX_WIDTH })
      expect(v.height).toEqual({ max: CAPTURE_MAX_HEIGHT })
    } finally {
      if (!had) delete g.localStorage
    }
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
   * THE INVARIANT, Robert 2026-08-25: "i need this shit never happen to user,
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

  /**
   * THE OTHER HALF OF THE SAME INVARIANT, Robert 2026-08-26 ("music from tab
   * sounds shitty"): the audio must arrive as the user's audio. Chromium
   * defaults AEC/NS/AGC ON for display audio, and voice processing turns tab
   * music into mono warble — so a rung that requests bare `audio: true` has
   * dropped something the user chose just as surely as dropping the track.
   * Until 2026-08-26 the floor did exactly that, and a machine parked on
   * rung 2 by the game wedges recorded every tab-audio take processed.
   */
  it('NO rung ever hands the user’s audio to voice processing', () => {
    for (const level of [0, 1, 2] as const) {
      const audio = displayMediaOptions(config, level).audio as MediaTrackConstraints
      expect(audio.echoCancellation).toBe(false)
      expect(audio.noiseSuppression).toBe(false)
      expect(audio.autoGainControl).toBe(false)
    }
  })
})

describe('when the picker hands back no audio track', () => {
  it('names the box in the picker the user just used', () => {
    expect(displayAudioMissingMessage()).toMatch(/Also share system audio/)
  })
})
