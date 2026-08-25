import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  displayWedgeCount,
  isDisplayConservative,
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
 * wedge, the next record click must send the minimal possible share request,
 * so that if any of our options is the trigger, the user's second click just
 * works and they never learn any of this existed.
 */

afterEach(() => {
  resetDisplayWedgeForTests()
  resetDeviceGuardForTests()
  vi.unstubAllGlobals()
})

describe('wedge memory', () => {
  it('starts clean — full-featured requests by default', () => {
    expect(isDisplayConservative()).toBe(false)
  })

  it('one wedge → the next request is conservative', () => {
    rememberDisplayWedge(1_000_000)
    expect(isDisplayConservative(1_000_001)).toBe(true)
  })

  it('a FULL-request success clears the mark — nothing stays degraded on a healthy machine', () => {
    rememberDisplayWedge(1_000_000)
    rememberDisplaySuccess(false)
    expect(isDisplayConservative(1_000_001)).toBe(false)
  })

  it('a CONSERVATIVE success keeps the mark — this machine chokes on the full request', () => {
    rememberDisplayWedge(1_000_000)
    rememberDisplaySuccess(true)
    expect(isDisplayConservative(1_000_001)).toBe(true)
  })

  it('the mark expires after 24h — a Chrome update that fixes the bug restores tab audio by itself', () => {
    rememberDisplayWedge(1_000_000)
    expect(isDisplayConservative(1_000_000 + 23 * 3600_000)).toBe(true)
    expect(isDisplayConservative(1_000_000 + 25 * 3600_000)).toBe(false)
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

  it('wedged machine: minimal options — no audio, no hints, no constraints beyond the pane', async () => {
    rememberDisplayWedge()
    let seen: Record<string, unknown> = {}
    const failures: { kind: string; message: string }[] = []
    stubDisplay((o) => (seen = o))
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: (f) => failures.push(f),
    }).settled
    expect(seen.audio).toBe(false)
    expect(seen.systemAudio).toBeUndefined()
    expect(seen.selfBrowserSurface).toBeUndefined()
    expect(seen.surfaceSwitching).toBeUndefined()
    expect((seen.video as Record<string, unknown>).width).toBeUndefined()
    // Tab audio is skipped HONESTLY: reported as a failure the user can read,
    // in words that do not blame them for a box we never showed Chrome.
    const sysAudio = failures.find((f) => f.kind === 'system-audio')
    expect(sysAudio?.message).toMatch(/skipped this take/)
    expect(sysAudio?.message).not.toMatch(/tick/)
  })

  it('a conservative take that succeeds keeps safe mode; a later full take clears it', async () => {
    rememberDisplayWedge()
    stubDisplay(() => undefined)
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
    }).settled
    // Conservative success — still marked (the machine proved it chokes).
    expect(isDisplayConservative()).toBe(true)
  })
})
