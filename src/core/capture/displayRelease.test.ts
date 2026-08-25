import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISPLAY_RELEASE_BUDGET_MS,
  DISPLAY_RELEASE_GRACE_MS,
  awaitDisplayCaptureClear,
  displayCaptureClear,
  resetDisplayReleaseForTests,
  trackDisplayCapture,
} from './displayRelease'
import { acquireChannelsProgressive } from './acquire'
import { resetDeviceGuardForTests } from './deviceGuard'

/**
 * PO 2026-08-25 stress test: "connect screen, 2 seconds recording, back and
 * again 10 times — it happens again." The one overlap the page controls is a
 * new share request racing the previous share's teardown; these tests pin the
 * serializer that removes it.
 */

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

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetDisplayReleaseForTests()
  resetDeviceGuardForTests()
})

describe('displayRelease registry', () => {
  it('is clear when no share was ever held — the first take costs nothing', () => {
    expect(displayCaptureClear()).toBe(true)
  })

  it('is not clear while a delivered display track is live, and clears after end + grace', async () => {
    vi.useFakeTimers()
    const t = stubTrack('video')
    trackDisplayCapture(t as unknown as MediaStreamTrack)
    expect(displayCaptureClear()).toBe(false)
    t.readyState = 'ended'
    // The poller notices, then the grace gap must still pass.
    await vi.advanceTimersByTimeAsync(300)
    expect(displayCaptureClear()).toBe(false)
    await vi.advanceTimersByTimeAsync(DISPLAY_RELEASE_GRACE_MS)
    expect(displayCaptureClear()).toBe(true)
  })

  it('awaitDisplayCaptureClear resolves once the previous share releases', async () => {
    vi.useFakeTimers()
    const t = stubTrack('video')
    trackDisplayCapture(t as unknown as MediaStreamTrack)
    let cleared: boolean | null = null
    void awaitDisplayCaptureClear().then((v) => {
      cleared = v
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(cleared).toBeNull()
    t.readyState = 'ended'
    await vi.advanceTimersByTimeAsync(DISPLAY_RELEASE_GRACE_MS + 500)
    expect(cleared).toBe(true)
  })

  it('never holds a click past the budget — a stuck teardown means dispatch anyway', async () => {
    vi.useFakeTimers()
    trackDisplayCapture(stubTrack('video') as unknown as MediaStreamTrack) // never ends
    let cleared: boolean | null = null
    void awaitDisplayCaptureClear().then((v) => {
      cleared = v
    })
    await vi.advanceTimersByTimeAsync(DISPLAY_RELEASE_BUDGET_MS + 300)
    expect(cleared).toBe(false)
  })
})

describe('a new share request waits for the previous share to release', () => {
  it('getDisplayMedia is not dispatched while the last take’s display track is live', async () => {
    vi.useFakeTimers()
    const prev = stubTrack('video')
    trackDisplayCapture(prev as unknown as MediaStreamTrack)
    let dispatched = 0
    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('document', { hasFocus: () => true })
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () => {
          dispatched++
          return Promise.resolve(new StubStream([stubTrack('video')]))
        },
        getUserMedia: () => Promise.resolve(new StubStream([stubTrack('audio')])),
      },
      permissions: { query: () => Promise.resolve({ state: 'granted' }) },
    })
    acquireChannelsProgressive(
      { screen: true, camera: false, mic: false, systemAudio: false },
      { onChannel: () => undefined, onFailure: () => undefined },
    )
    await vi.advanceTimersByTimeAsync(500)
    expect(dispatched).toBe(0) // held: the previous share is still live
    prev.readyState = 'ended'
    await vi.advanceTimersByTimeAsync(DISPLAY_RELEASE_GRACE_MS + 500)
    expect(dispatched).toBe(1) // released + grace passed → request went out
  })
})
