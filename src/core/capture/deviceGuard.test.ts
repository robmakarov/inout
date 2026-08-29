import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  guardStream,
  liveDeviceStreamCount,
  releaseAllDevices,
  resetDeviceGuardForTests,
} from './deviceGuard'
import { acquireChannelsProgressive } from './acquire'

interface FakeTrack {
  kind: string
  readyState: 'live' | 'ended'
  label: string
  stop: () => void
  getSettings: () => MediaTrackSettings
  applyConstraints: () => Promise<void>
  addEventListener: () => void
}

function fakeTrack(kind: 'video' | 'audio', settings: MediaTrackSettings = {}): FakeTrack {
  const t: FakeTrack = {
    kind,
    readyState: 'live',
    label: `fake ${kind}`,
    stop: vi.fn(() => {
      t.readyState = 'ended'
    }),
    getSettings: () => settings,
    applyConstraints: () => Promise.resolve(),
    addEventListener: () => undefined,
  }
  return t
}

function fakeStream(tracks: FakeTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  } as unknown as MediaStream
}

afterEach(() => {
  resetDeviceGuardForTests()
  vi.unstubAllGlobals()
})

describe('device guard — the tab can always turn every device off', () => {
  it('releases a stream nobody downstream ever took ownership of', () => {
    const track = fakeTrack('video')
    guardStream(fakeStream([track]))
    expect(liveDeviceStreamCount()).toBe(1)
    releaseAllDevices('test')
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(liveDeviceStreamCount()).toBe(0)
  })

  it('releases EVERY track of a stream, not just the one a channel wanted', () => {
    // The picker hands back video + system audio; only one becomes a channel.
    const video = fakeTrack('video')
    const audio = fakeTrack('audio')
    guardStream(fakeStream([video, audio]))
    releaseAllDevices('test')
    expect(video.stop).toHaveBeenCalled()
    expect(audio.stop).toHaveBeenCalled()
  })

  it('one track that refuses to stop cannot save the others', () => {
    const bad = fakeTrack('audio')
    bad.stop = vi.fn(() => {
      throw new Error('InvalidStateError')
    })
    const good = fakeTrack('video')
    guardStream(fakeStream([bad, good]))
    expect(() => releaseAllDevices('test')).not.toThrow()
    expect(good.stop).toHaveBeenCalled()
  })

  it('is idempotent — releasing twice is a no-op, never a throw', () => {
    const track = fakeTrack('video')
    guardStream(fakeStream([track]))
    releaseAllDevices('first')
    releaseAllDevices('second')
    expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('does not count a stream whose tracks have already ended', () => {
    const track = fakeTrack('audio')
    const s = fakeStream([track])
    guardStream(s)
    track.readyState = 'ended'
    expect(liveDeviceStreamCount()).toBe(0)
  })
})

/**
 * The regression this module exists for (Robert 2026-08-24: "indicator still there
 * after i'm done and refreshed", then a mic that will not connect on the next
 * take). Every previous fix released devices from a structure the SESSION
 * owned, so a stream still in flight between the platform and the session — or
 * one delivered to a session that had already been cancelled — was invisible
 * to release and kept the device claimed. Here the release runs against
 * nothing but the guard, with no session involved at all.
 */
describe('acquisition registers devices before anything downstream sees them', () => {
  const config = { screen: true, camera: false, mic: true, systemAudio: false }

  function stubMedia(): { display: FakeTrack; mic: FakeTrack } {
    const display = fakeTrack('video', { width: 1280, height: 720, frameRate: 30 })
    const mic = fakeTrack('audio', { sampleRate: 48_000 })
    class StubStream {
      private readonly tracks: FakeTrack[]
      constructor(tracks: FakeTrack[] = []) {
        this.tracks = tracks
      }
      getTracks() {
        return this.tracks
      }
      getVideoTracks() {
        return this.tracks.filter((t) => t.kind === 'video')
      }
      getAudioTracks() {
        return this.tracks.filter((t) => t.kind === 'audio')
      }
    }
    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () => Promise.resolve(new StubStream([display])),
        getUserMedia: () => Promise.resolve(new StubStream([mic])),
      },
      permissions: { query: () => Promise.resolve({ state: 'granted' }) },
    })
    return { display, mic }
  }

  it('a caller that walks away still leaves both devices releasable', async () => {
    const { display, mic } = stubMedia()
    // onChannel deliberately does NOTHING — this is the cancelled-arm case,
    // where the session has already given up and drops what arrives.
    const acq = acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
    })
    await acq.settled
    expect(liveDeviceStreamCount()).toBe(2)

    releaseAllDevices('cancelled arm')
    expect(display.stop).toHaveBeenCalled()
    expect(mic.stop).toHaveBeenCalled()
    expect(liveDeviceStreamCount()).toBe(0)
  })

  it('the screen is releasable from the instant the picker closes', async () => {
    const { display } = stubMedia()
    let sawScreen = false
    const acq = acquireChannelsProgressive(
      { ...config, mic: false },
      {
        onChannel: () => {
          sawScreen = true
        },
        onFailure: () => undefined,
      },
    )
    await acq.primaryReady
    // Chrome's indicator is lit the moment getDisplayMedia resolves, which is
    // strictly before delivery (capDisplayTrack awaits in between). The guard
    // must already know about it by then.
    expect(sawScreen).toBe(true)
    expect(liveDeviceStreamCount()).toBe(1)
    releaseAllDevices('test')
    expect(display.stop).toHaveBeenCalled()
    await acq.settled
  })
})
