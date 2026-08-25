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

  it('each further wedge steps down again, and the ladder bottoms out at 3', () => {
    rememberDisplayWedge(1_000_000)
    rememberDisplayWedge(1_000_001)
    expect(displayRequestLevel(1_000_002)).toBe(2)
    rememberDisplayWedge(1_000_003)
    rememberDisplayWedge(1_000_004)
    expect(displayRequestLevel(1_000_005)).toBe(3)
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

  it('the SILENT rung is one-shot — tab audio is back on the next take', () => {
    for (let i = 0; i < 3; i++) rememberDisplayWedge(1_000_000 + i)
    expect(displayRequestLevel(1_000_004)).toBe(3)
    rememberDisplaySuccess(3)
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

  it('two wedges: the bare request — still audio, no constraints object at all', async () => {
    rememberDisplayWedge()
    rememberDisplayWedge()
    let seen: Record<string, unknown> = {}
    stubDisplay((o) => (seen = o))
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
    }).settled
    expect(seen.video).toBe(true)
    expect(seen.audio).toBe(true)
  })

  it('three wedges: audio finally goes — and is reported, not silently absent', async () => {
    for (let i = 0; i < 3; i++) rememberDisplayWedge()
    let seen: Record<string, unknown> = {}
    const failures: { kind: string; message: string }[] = []
    stubDisplay((o) => (seen = o))
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: (f) => failures.push(f),
    }).settled
    expect(seen.audio).toBe(false)
    expect(seen.video).toBe(true)
    // Tab audio is skipped HONESTLY: reported as a failure the user can read,
    // in words that do not blame them for a box we never showed Chrome.
    const sysAudio = failures.find((f) => f.kind === 'system-audio')
    expect(sysAudio?.message).toMatch(/skipped this take/)
    expect(sysAudio?.message).not.toMatch(/tick/)
  })

  it('a safe-mode take that succeeds keeps its rung; the silent rung steps back up', async () => {
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
    expect(displayRequestLevel()).toBe(3)
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
    }).settled
    expect(displayRequestLevel()).toBe(2)
  })
})
