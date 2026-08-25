import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACQUIRE_TIMEOUT_MS,
  CONNECT_ATTEMPTS_BEFORE_START,
  CONNECT_RETRY_PAUSE_MS,
  GRANT_PROBE_BUDGET_MS,
  acquireChannelsProgressive,
  type AcquireFailure,
  type AcquiredChannel,
} from './acquire'
import { resetDeviceGuardForTests } from './deviceGuard'
import { rememberGrant } from './grants'

/**
 * PO 2026-08-25, verbatim: "all input must connect everytime without fails".
 * One timeout used to be a verdict — a mic that missed its 8 s budget was out
 * of the take forever, even though the user's own workaround (refresh, press
 * record again) proved a fresh getUserMedia often succeeds. These tests pin
 * the persistent-connect contract: ask again before the take starts, keep
 * asking in the background after it, stop instantly on denial, on the user's
 * off-switch, or on the take ending — and never, ever, spam a prompt.
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

const MIC_ONLY = { screen: false, camera: false, mic: true, systemAudio: false }

/** getUserMedia stub whose per-call behaviour is scripted by the test. */
function stubDevices(script: Array<'hang' | 'resolve' | 'deny' | 'manual'>): {
  calls: () => number
  resolveManual: (s: StubStream) => void
} {
  let n = 0
  let manual: ((s: StubStream) => void) | undefined
  vi.stubGlobal('MediaStream', StubStream)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: () => {
        const step = script[Math.min(n, script.length - 1)]
        n++
        if (step === 'resolve') return Promise.resolve(new StubStream([stubTrack('audio')]))
        if (step === 'deny')
          return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
        if (step === 'manual')
          return new Promise<StubStream>((r) => {
            manual = r
          })
        return new Promise<StubStream>(() => {})
      },
    },
    permissions: { query: () => Promise.resolve({ state: 'granted' }) },
  })
  return { calls: () => n, resolveManual: (s) => manual?.(s) }
}

function collect(stillWanted?: () => boolean): {
  channels: AcquiredChannel[]
  failures: AcquireFailure[]
  handlers: Parameters<typeof acquireChannelsProgressive>[1]
} {
  const channels: AcquireFailure extends never ? never : AcquiredChannel[] = []
  const failures: AcquireFailure[] = []
  return {
    channels,
    failures,
    handlers: {
      onChannel: (ch) => channels.push(ch),
      onFailure: (f) => failures.push(f),
      ...(stillWanted ? { stillWanted } : {}),
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetDeviceGuardForTests()
  rememberGrant('microphone', false)
  rememberGrant('camera', false)
})

describe('a granted device that misses one budget is asked again', () => {
  it('the second ask still makes the synchronized start — no failure at all', async () => {
    vi.useFakeTimers()
    const gum = stubDevices(['hang', 'resolve'])
    const { channels, failures, handlers } = collect(() => true)
    const acq = acquireChannelsProgressive(MIC_ONLY, handlers)
    let settled = false
    void acq.settled.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + CONNECT_RETRY_PAUSE_MS + 1_000)
    expect(settled).toBe(true)
    expect(channels.map((c) => c.kind)).toEqual(['mic'])
    expect(failures).toEqual([])
    expect(gum.calls()).toBe(2)
  })

  it('after the foreground attempts the take starts without it and it late-joins from the hunt', async () => {
    vi.useFakeTimers()
    const gum = stubDevices(['hang', 'hang', 'resolve'])
    const { channels, failures, handlers } = collect(() => true)
    const acq = acquireChannelsProgressive(MIC_ONLY, handlers)
    let settled = false
    void acq.settled.then(() => {
      settled = true
    })
    // Both foreground attempts time out → the take may start; hunt continues.
    const foregroundMs =
      CONNECT_ATTEMPTS_BEFORE_START * ACQUIRE_TIMEOUT_MS + CONNECT_RETRY_PAUSE_MS + 500
    await vi.advanceTimersByTimeAsync(foregroundMs)
    expect(settled).toBe(true)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.timedOut).toBe(true)
    expect(failures[0]?.message).toMatch(/still asking/)
    expect(channels).toHaveLength(0)
    // …and the background ask connects it.
    await vi.advanceTimersByTimeAsync(CONNECT_RETRY_PAUSE_MS + 1_000)
    expect(channels.map((c) => c.kind)).toEqual(['mic'])
    expect(gum.calls()).toBe(3)
  })

  it('a hung permissions.query cannot stall the hunt — the cached grant picks the budget', async () => {
    vi.useFakeTimers()
    rememberGrant('microphone', true)
    const gum = stubDevices(['hang', 'resolve'])
    // The one IPC that wedges with the browser: the permission lookup.
    ;(navigator as unknown as { permissions: unknown }).permissions = {
      query: () => new Promise(() => {}),
    }
    const { channels, handlers } = collect(() => true)
    acquireChannelsProgressive(MIC_ONLY, handlers)
    await vi.advanceTimersByTimeAsync(
      GRANT_PROBE_BUDGET_MS + ACQUIRE_TIMEOUT_MS + CONNECT_RETRY_PAUSE_MS + 1_000,
    )
    // The 120 s human budget would still be pending here; the cached grant's
    // hardware budget let the retry run instead.
    expect(channels.map((c) => c.kind)).toEqual(['mic'])
    expect(gum.calls()).toBe(2)
  })
})

describe('the hunt has hard fences', () => {
  it('a denial is an answer: one ask, no retry, ever', async () => {
    vi.useFakeTimers()
    const gum = stubDevices(['deny'])
    const { channels, failures, handlers } = collect(() => true)
    acquireChannelsProgressive(MIC_ONLY, handlers)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.denied).toBe(true)
    expect(channels).toHaveLength(0)
    expect(gum.calls()).toBe(1)
  })

  it('stillWanted=false ends the hunt, and a stream landing after the flip is stopped', async () => {
    vi.useFakeTimers()
    const gum = stubDevices(['hang', 'hang', 'manual'])
    let wanted = true
    const { channels, handlers } = collect(() => wanted)
    acquireChannelsProgressive(MIC_ONLY, handlers)
    const foregroundMs =
      CONNECT_ATTEMPTS_BEFORE_START * ACQUIRE_TIMEOUT_MS + CONNECT_RETRY_PAUSE_MS + 500
    await vi.advanceTimersByTimeAsync(foregroundMs + CONNECT_RETRY_PAUSE_MS + 500)
    expect(gum.calls()).toBe(3) // background ask dispatched while still wanted
    // The user turns the channel off / the take ends — then the device answers.
    wanted = false
    const late = new StubStream([stubTrack('audio')])
    gum.resolveManual(late)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(channels).toHaveLength(0)
    expect(late.getTracks()[0]?.stop).toHaveBeenCalled()
    // And no further asks: the loop is gone.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(gum.calls()).toBe(3)
  })

  it('no stillWanted means no background hunting at all — one-shot callers stay one-shot', async () => {
    vi.useFakeTimers()
    const gum = stubDevices(['hang'])
    const { failures, handlers } = collect()
    acquireChannelsProgressive(MIC_ONLY, handlers)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(failures).toHaveLength(1)
    expect(gum.calls()).toBe(CONNECT_ATTEMPTS_BEFORE_START)
  })
})
