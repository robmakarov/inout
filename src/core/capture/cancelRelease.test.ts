import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCaptureSession } from './session'
import { liveDeviceStreamCount, resetDeviceGuardForTests } from './deviceGuard'

/**
 * THE BUG THIS FILE EXISTS FOR (PO 2026-08-24):
 *   "i press record again to stop it, and indicator still there after i'm done
 *    and refreshed … sometimes app stuck in waiting for mic"
 *
 * Cancelling a start must leave NOTHING running. Not the stream that arrives
 * after the user gave up, not the one whose arming never finished — because a
 * device this tab still holds is a device the NEXT getUserMedia has to wait
 * for, which is the same bug wearing the "waiting for mic" label.
 */

interface StubTrack {
  kind: string
  readyState: 'live' | 'ended'
  label: string
  stop: () => void
  getSettings: () => MediaTrackSettings
  applyConstraints: () => Promise<void>
  addEventListener: () => void
  contentHint?: string
}

function stubTrack(kind: 'video' | 'audio'): StubTrack {
  const t: StubTrack = {
    kind,
    readyState: 'live',
    label: `stub ${kind}`,
    stop: vi.fn(() => {
      t.readyState = 'ended'
    }),
    getSettings: () => (kind === 'video' ? { width: 1280, height: 720, frameRate: 30 } : {}),
    applyConstraints: () => Promise.resolve(),
    addEventListener: () => undefined,
  }
  return t
}

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

class StubRecorder {
  static isTypeSupported(): boolean {
    return true
  }
  state = 'inactive'
  mimeType = 'video/webm'
  start(): void {}
  stop(): void {}
  requestData(): void {}
  addEventListener(): void {}
}

function install(handlers: {
  getDisplayMedia?: () => Promise<unknown>
  getUserMedia?: () => Promise<unknown>
}): void {
  vi.stubGlobal('MediaStream', StubStream)
  vi.stubGlobal('MediaRecorder', StubRecorder)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getDisplayMedia: handlers.getDisplayMedia ?? (() => new Promise(() => {})),
      getUserMedia: handlers.getUserMedia ?? (() => new Promise(() => {})),
    },
    permissions: { query: () => Promise.resolve({ state: 'granted' }) },
  })
}

afterEach(() => {
  resetDeviceGuardForTests()
  vi.unstubAllGlobals()
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('cancelling a start leaves no device running', () => {
  it('a picker answered AFTER the user gave up never leaves the screen shared', async () => {
    const display = stubTrack('video')
    let sharePicked!: (s: unknown) => void
    install({ getDisplayMedia: () => new Promise((r) => (sharePicked = r)) })

    const ac = new AbortController()
    const starting = createCaptureSession(
      { screen: true, camera: false, mic: false, systemAudio: false },
      { signal: ac.signal },
    )
    await flush()

    // The user is tired of the picker and hits the record button again.
    ac.abort()
    await expect(starting).rejects.toThrow(/cancelled/i)

    // …and only THEN clicks Share in Chrome's picker. The stream arrives with
    // no owner; if anything keeps it, the screen-share indicator stays lit
    // with nothing recording behind it.
    sharePicked(new StubStream([display]))
    await flush()
    expect(display.stop).toHaveBeenCalled()
    expect(liveDeviceStreamCount()).toBe(0)
  })

  it('devices are off by the time the cancel rejects — not after its cleanup', async () => {
    const display = stubTrack('video')
    install({
      // Screen lands; the mic is the classic wedge — never resolves, never
      // rejects — so arm() is still waiting when the user gives up.
      getDisplayMedia: () => Promise.resolve(new StubStream([display])),
      getUserMedia: () => new Promise(() => {}),
    })

    const ac = new AbortController()
    const starting = createCaptureSession(
      { screen: true, camera: false, mic: true, systemAudio: false },
      { signal: ac.signal },
    )
    await flush()
    ac.abort()
    await expect(starting).rejects.toThrow(/cancelled/i)
    // The moment the UI is told the start is off, the hardware must already be
    // off too. Nothing about scratch files, writers or recorders may come
    // first: releasing is synchronous and owes nothing to any of them.
    expect(display.stop).toHaveBeenCalled()
    expect(liveDeviceStreamCount()).toBe(0)
  })

  it('a mic that finally answers long after the cancel is turned straight off', async () => {
    const display = stubTrack('video')
    const mic = stubTrack('audio')
    let micAnswers!: (s: unknown) => void
    install({
      getDisplayMedia: () => Promise.resolve(new StubStream([display])),
      getUserMedia: () => new Promise((r) => (micAnswers = r)),
    })

    const ac = new AbortController()
    const starting = createCaptureSession(
      { screen: true, camera: false, mic: true, systemAudio: false },
      { signal: ac.signal },
    )
    await flush()
    ac.abort()
    await expect(starting).rejects.toThrow(/cancelled/i)

    micAnswers(new StubStream([mic]))
    await flush()
    expect(mic.stop).toHaveBeenCalled()
    expect(liveDeviceStreamCount()).toBe(0)
  })
})
