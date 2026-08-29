import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireChannelsProgressive, type AcquiredChannel } from './acquire'
import { knownGranted, rememberGrant } from './grants'
import { resetDeviceGuardForTests } from './deviceGuard'
import { resetDisplayReleaseForTests } from './displayRelease'

/**
 * Robert 2026-08-24: "it must start together immediately, why the fuck waiting is
 * happening". Measured: our arming code costs ~22 ms. Everything else the user
 * waits for after the picker closes is the microphone opening — which is
 * supposed to have happened DURING the picker, concurrently, and silently
 * wasn't. getUserMedia was dispatched behind `await permissions.query(...)`,
 * an IPC to the browser process that is at that moment displaying a modal
 * screen picker; whenever that answer came back late the mic did not start
 * until the picker closed, and its whole hardware spin-up landed on the user's
 * clock with the screen already shared.
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

const track = (kind: 'video' | 'audio'): StubTrack => ({
  kind,
  readyState: 'live',
  label: `stub ${kind}`,
  stop: vi.fn(),
  getSettings: () => (kind === 'video' ? { width: 1280, height: 720, frameRate: 30 } : {}),
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

afterEach(() => {
  resetDisplayReleaseForTests()
  resetDeviceGuardForTests()
  rememberGrant('microphone', false)
  rememberGrant('camera', false)
  vi.unstubAllGlobals()
})

describe('the mic opens WHILE the picker is up, not after it closes', () => {
  it('dispatches getUserMedia before the permission probe has answered', async () => {
    rememberGrant('microphone', true) // learned on a previous take / at mount
    expect(knownGranted('microphone')).toBe(true)

    let gumAt: 'never' | 'before probe' | 'after probe' = 'never'
    let probeAnswered = false
    let answerProbe!: () => void
    let closePicker!: (s: unknown) => void

    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () => new Promise((r) => (closePicker = r)),
        getUserMedia: () => {
          gumAt = probeAnswered ? 'after probe' : 'before probe'
          return Promise.resolve(new StubStream([track('audio')]))
        },
      },
      permissions: {
        // The picker is modal and the browser process is busy: this answer
        // does not come back until the user is done choosing a surface.
        query: () =>
          new Promise((r) => {
            answerProbe = () => {
              probeAnswered = true
              r({ state: 'granted' })
            }
          }),
      },
    })

    const got: AcquiredChannel[] = []
    const acq = acquireChannelsProgressive(
      { screen: true, camera: false, mic: true, systemAudio: false },
      { onChannel: (c) => got.push(c), onFailure: () => undefined },
    )
    await flush()

    // THE ASSERTION: the picker is still open, the permission answer has not
    // come back, and the microphone is already opening.
    expect(gumAt).toBe('before probe')

    answerProbe()
    closePicker(new StubStream([track('video')]))
    await acq.settled
    expect(got.map((c) => c.kind).sort()).toEqual(['mic', 'screen'])
  })

  it('a device we have never been granted still waits for the picker, so its prompt cannot hide behind one', async () => {
    // knownGranted is false here — the conservative default. A first-time user
    // must not get a mic bubble stacked underneath Chrome's screen picker.
    let gumCalled = false
    let closePicker!: (s: unknown) => void
    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () => new Promise((r) => (closePicker = r)),
        getUserMedia: () => {
          gumCalled = true
          return Promise.resolve(new StubStream([track('audio')]))
        },
      },
      permissions: { query: () => Promise.resolve({ state: 'prompt' }) },
    })

    const acq = acquireChannelsProgressive(
      { screen: true, camera: false, mic: true, systemAudio: false },
      { onChannel: () => undefined, onFailure: () => undefined },
    )
    await flush()
    expect(gumCalled).toBe(false)

    closePicker(new StubStream([track('video')]))
    await acq.settled
    expect(gumCalled).toBe(true)
  })

  it('a grant learned from a successful take makes the NEXT take concurrent', async () => {
    expect(knownGranted('microphone')).toBe(false)
    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () => Promise.resolve(new StubStream([track('video')])),
        getUserMedia: () => Promise.resolve(new StubStream([track('audio')])),
      },
      permissions: { query: () => Promise.resolve({ state: 'prompt' }) },
    })
    const acq = acquireChannelsProgressive(
      { screen: true, camera: false, mic: true, systemAudio: false },
      { onChannel: () => undefined, onFailure: () => undefined },
    )
    await acq.settled
    // The browser handed it over, whatever query() claimed — that IS the grant.
    expect(knownGranted('microphone')).toBe(true)
  })
})
