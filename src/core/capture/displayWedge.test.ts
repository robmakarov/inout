import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  displayRequestLevel,
  displayWedgeCount,
  rememberDisplaySuccess,
  rememberDisplayWedge,
  resetDisplayWedgeForTests,
} from './displayWedge'
import { acquireChannelsProgressive } from './acquire'
import { resetDeviceGuardForTests } from './deviceGuard'
import { resetDisplayReleaseForTests } from './displayRelease'

/**
 * PO 2026-08-24: "i need this shit never happens to users". The wedge itself
 * is Chrome's (share taken, track never delivered, survives tab close, only a
 * Chrome quit clears it) — but a user hitting it TWICE would be ours. After a
 * wedge, the next record click must send a smaller share request, so that if
 * any of our options is the trigger, the user's second click just works and
 * they never learn any of this existed.
 *
 * PO 2026-08-25: "share sound in chrome with screen toggle not there anymore".
 * The first cut dropped `audio` on the FIRST wedge and kept it dropped for
 * 24h, which took Chrome's own tab-audio checkbox off the picker for a day.
 * The rungs below exist so the visible feature is the LAST thing to go, and
 * when it does go it goes for one take.
 */

afterEach(() => {
  resetDisplayReleaseForTests()
  resetDisplayWedgeForTests()
  resetDeviceGuardForTests()
  vi.unstubAllGlobals()
})

describe('wedge memory', () => {
  it('starts clean — full-featured requests by default', () => {
    expect(displayRequestLevel()).toBe(0)
  })

  it('one wedge steps down ONE rung — audio is still requested there', () => {
    rememberDisplayWedge(1_000_000)
    expect(displayRequestLevel(1_000_001)).toBe(1)
  })

  it('the ladder bottoms out at 2 and stays there — there is no rung below it', () => {
    rememberDisplayWedge(1_000_000)
    rememberDisplayWedge(1_000_001)
    expect(displayRequestLevel(1_000_002)).toBe(2)
    // Wedge all day: the floor holds. Below it lies only the user's own asks,
    // and those are not ours to drop (PO 2026-08-25).
    rememberDisplayWedge(1_000_003)
    rememberDisplayWedge(1_000_004)
    expect(displayRequestLevel(1_000_005)).toBe(2)
  })

  it('a FULL-request success clears the mark — nothing stays degraded on a healthy machine', () => {
    rememberDisplayWedge(1_000_000)
    rememberDisplaySuccess(0)
    expect(displayRequestLevel(1_000_001)).toBe(0)
  })

  it('a rung-1 success keeps the rung — invisible to the user, and the rung above choked', () => {
    rememberDisplayWedge(1_000_000)
    rememberDisplaySuccess(1)
    expect(displayRequestLevel(1_000_001)).toBe(1)
  })

  it('a rung-2 success keeps the floor — still nothing the user can see is gone', () => {
    for (let i = 0; i < 3; i++) rememberDisplayWedge(1_000_000 + i)
    rememberDisplaySuccess(2)
    expect(displayRequestLevel(1_000_005)).toBe(2)
  })

  it('the mark expires 24h after the last wedge — a fixed Chrome restores the full request', () => {
    rememberDisplayWedge(1_000_000)
    expect(displayRequestLevel(1_000_000 + 23 * 3600_000)).toBe(1)
    expect(displayRequestLevel(1_000_000 + 25 * 3600_000)).toBe(0)
  })

  it('a machine marked by the OLD audio-dropping safe mode lands on rung 1, not the silent one', () => {
    // Exactly what the shipped 2026-08-25 build wrote: no rung recorded. Any
    // PO or user carrying that record gets the tab-audio checkbox back on
    // their next click instead of waiting out the 24h TTL.
    const raw = JSON.stringify({ wedgedAt: 1_000_000, count: 1 })
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'inout.displayWedge.v1' ? raw : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    })
    resetDisplayWedgeForTests() // drops the in-memory copy → next read is storage
    expect(displayRequestLevel(1_000_001)).toBe(1)
  })

  it('counts wedges for telemetry', () => {
    rememberDisplayWedge()
    rememberDisplayWedge()
    expect(displayWedgeCount()).toBe(2)
  })
})

interface StubTrack {
  kind: string
  readyState: string
  label: string
  stop: () => void
  getSettings: () => MediaTrackSettings
  applyConstraints: () => Promise<void>
  addEventListener: () => void
}
const stubTrack = (kind: 'video' | 'audio'): StubTrack => ({
  kind,
  readyState: 'live',
  label: `stub ${kind}`,
  stop: vi.fn(),
  getSettings: () => ({}),
  applyConstraints: () => Promise.resolve(),
  addEventListener: () => undefined,
})
class StubStream {
  constructor(private readonly tracks: StubTrack[] = []) {}
  getTracks(): StubTrack[] {
    return this.tracks
  }
  getVideoTracks(): StubTrack[] {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  getAudioTracks(): StubTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
}

describe('the request Chrome actually receives after a wedge', () => {
  const config = { screen: true, camera: false, mic: false, systemAudio: true }

  function stubDisplay(onOpts: (opts: Record<string, unknown>) => void): StubTrack {
    const video = stubTrack('video')
    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: (opts: Record<string, unknown>) => {
          onOpts(opts)
          return Promise.resolve(new StubStream([video]))
        },
        getUserMedia: () => Promise.resolve(new StubStream([stubTrack('audio')])),
      },
      permissions: { query: () => Promise.resolve({ state: 'granted' }) },
    })
    return video
  }

  it('healthy machine: full options, audio requested', async () => {
    let seen: Record<string, unknown> = {}
    stubDisplay((o) => (seen = o))
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
    }).settled
    expect(seen.systemAudio).toBe('include')
    expect(seen.audio).toBeTruthy()
    expect(seen.selfBrowserSurface).toBe('exclude')
  })

  it('ONE wedge: hints and constraints go — the audio request, and so Chrome’s checkbox, stays', async () => {
    rememberDisplayWedge()
    let seen: Record<string, unknown> = {}
    stubDisplay((o) => (seen = o))
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
    }).settled
    // THE REGRESSION THIS FILE EXISTS FOR: audio must still be asked for.
    expect(seen.audio).toBeTruthy()
    expect(seen.selfBrowserSurface).toBeUndefined()
    expect(seen.surfaceSwitching).toBeUndefined()
    expect(seen.systemAudio).toBeUndefined()
    expect((seen.video as Record<string, unknown>).width).toBeUndefined()
  })

  it('two wedges: the bare request — still audio, still RAW, no video constraints at all', async () => {
    rememberDisplayWedge()
    rememberDisplayWedge()
    let seen: Record<string, unknown> = {}
    stubDisplay((o) => (seen = o))
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
    }).settled
    expect(seen.video).toBe(true)
    // Until 2026-08-26 the floor asked for bare `audio: true`, which hands the
    // tab audio to Chrome's default AEC/NS/AGC — a machine the game wedges
    // parked on rung 2 recorded every tab-music take as mono warble for a day
    // (PO: "music from tab sounds shitty"). The processing flags are part of
    // the user's ask and ride every rung; only VIDEO constraints shrink here.
    const audio = seen.audio as Record<string, unknown>
    expect(audio.echoCancellation).toBe(false)
    expect(audio.noiseSuppression).toBe(false)
    expect(audio.autoGainControl).toBe(false)
  })

  it('wedge it five times: the request still carries the audio the user asked for', async () => {
    // THE ONE THAT MUST NEVER GO GREEN BY GOING SILENT. No number of wedges
    // buys the app the right to record a take without the sound the user
    // switched on (PO 2026-08-25: "always fucking clean").
    for (let i = 0; i < 5; i++) rememberDisplayWedge()
    let seen: Record<string, unknown> = {}
    stubDisplay((o) => (seen = o))
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
    }).settled
    expect(seen.audio).toBeTruthy()
  })

  it('a reduced-request take that succeeds keeps its rung, and the floor holds', async () => {
    rememberDisplayWedge()
    stubDisplay(() => undefined)
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
    }).settled
    // Rung-1 success — still marked (the machine proved it chokes on rung 0),
    // but nothing the user can see is missing there.
    expect(displayRequestLevel()).toBe(1)

    for (let i = 0; i < 2; i++) rememberDisplayWedge()
    expect(displayRequestLevel()).toBe(2)
    // This test is about the LADDER, not the release barrier: pretend the
    // previous take's share released long ago so the next request is instant.
    resetDisplayReleaseForTests()
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
    }).settled
    expect(displayRequestLevel()).toBe(2)
  })
})
