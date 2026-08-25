import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISPLAY_TOTAL_BUDGET_MS,
  PICKER_SETTLE_MS,
  PROMPT_TIMEOUT_MS,
  pickerClosed,
  withTimeout,
} from './acquire'
import { createCaptureSession } from './session'
import { liveDeviceStreamCount, resetDeviceGuardForTests } from './deviceGuard'
import { resetDisplayReleaseForTests } from './displayRelease'
import { rememberGrant } from './grants'

/**
 * PO 2026-08-24, from the console of a real take:
 *
 *   [capture:arming] display start   +0ms
 *   [capture:arming] camera done  +1256ms
 *   [capture:arming] mic done     +1530ms
 *   [capture:arming] display timeout +120004ms — getDisplayMedia timed out
 *   [capture:arming] armed +120007ms (2 channel(s), all start together)
 *
 * getDisplayMedia neither resolved nor rejected for two minutes while Chrome's
 * indicator showed the screen as shared, and the take then armed with camera
 * and mic — devices held, and lit, the whole time.
 */

let focused = true
function stubFocusableDocument(): void {
  const listeners = new Set<() => void>()
  vi.stubGlobal('document', { hasFocus: () => focused })
  vi.stubGlobal('window', {
    addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
  })
}

afterEach(() => {
  resetDisplayReleaseForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetDeviceGuardForTests()
  focused = true
})

describe('a picker that has been answered is no longer a human', () => {
  it('does not start the clock while the picker still has focus', async () => {
    vi.useFakeTimers()
    stubFocusableDocument()
    focused = false // picker is open, page is not focused
    let closed = false
    void pickerClosed().then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(60_000) // a full minute of deliberating
    expect(closed).toBe(false)
  })

  it('resolves once focus comes back — the picker closed, the answer is the browser\'s now', async () => {
    vi.useFakeTimers()
    stubFocusableDocument()
    focused = false
    let closed = false
    void pickerClosed().then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(closed).toBe(false)
    focused = true
    await vi.advanceTimersByTimeAsync(500)
    expect(closed).toBe(true)
  })

  it('never fires when focus was never taken — a human is not timed on a guess', async () => {
    vi.useFakeTimers()
    stubFocusableDocument()
    focused = true // picker never took focus; we know nothing, so we claim nothing
    let closed = false
    void pickerClosed().then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(closed).toBe(false)
  })

  it('a getDisplayMedia that never settles fails 8s after the picker closes, not 120s', async () => {
    vi.useFakeTimers()
    stubFocusableDocument()
    focused = false
    const wedged = new Promise<MediaStream>(() => {}) // Chrome shares, never answers
    const guarded = withTimeout(
      withTimeout(wedged, PICKER_SETTLE_MS, 'getDisplayMedia (picker closed)', pickerClosed()),
      DISPLAY_TOTAL_BUDGET_MS,
      'getDisplayMedia',
    )
    let outcome = 'pending'
    void guarded.catch((e: Error) => {
      outcome = e.message
    })

    await vi.advanceTimersByTimeAsync(20_000) // user is in the picker
    expect(outcome).toBe('pending')

    focused = true // they picked; Chrome is sharing
    await vi.advanceTimersByTimeAsync(PICKER_SETTLE_MS - 1_000)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(outcome).toMatch(/picker closed/)
    // And the outer ceiling is what it never had to reach.
    expect(PICKER_SETTLE_MS).toBeLessThan(DISPLAY_TOTAL_BUDGET_MS)
  })

  /**
   * PO 2026-08-24, fresh Chrome, first take: wedged again with the fast path
   * never engaging — macOS's native sharing pill can open and close without
   * the page ever observing a focus change. Detection is allowed to fail;
   * the hostage-taking is not. The absolute ceiling fires regardless.
   */
  it('fails at the absolute ceiling even when NO focus change is ever observed', async () => {
    vi.useFakeTimers()
    stubFocusableDocument()
    focused = true // the native pill never took page focus — we see nothing
    const wedged = new Promise<MediaStream>(() => {})
    const guarded = withTimeout(
      withTimeout(wedged, PICKER_SETTLE_MS, 'getDisplayMedia (picker closed)', pickerClosed()),
      DISPLAY_TOTAL_BUDGET_MS,
      'getDisplayMedia',
    )
    let outcome = 'pending'
    void guarded.catch((e: Error) => {
      outcome = e.message
    })
    await vi.advanceTimersByTimeAsync(DISPLAY_TOTAL_BUDGET_MS - 1_000)
    expect(outcome).toBe('pending') // still inside the budget
    await vi.advanceTimersByTimeAsync(2_000)
    expect(outcome).toMatch(/getDisplayMedia timed out/)
    // Half a minute, not two: the whole point.
    expect(DISPLAY_TOTAL_BUDGET_MS).toBeLessThanOrEqual(30_000)
    expect(DISPLAY_TOTAL_BUDGET_MS).toBeLessThan(PROMPT_TIMEOUT_MS / 3)
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

describe('a wedged screen kills the take instead of recording something else', () => {
  it('fails loudly and releases the camera and mic it was holding', async () => {
    vi.useFakeTimers()
    stubFocusableDocument()
    focused = false
    rememberGrant('microphone', true)
    rememberGrant('camera', true)
    const camTrack = stubTrack('video')
    const micTrack = stubTrack('audio')
    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () => new Promise(() => {}), // the wedge
        getUserMedia: (c: { video?: unknown }) =>
          Promise.resolve(new StubStream([c.video ? camTrack : micTrack])),
      },
      permissions: { query: () => Promise.resolve({ state: 'granted' }) },
    })

    const starting = createCaptureSession(
      { screen: true, camera: true, mic: true, systemAudio: true },
      {},
    )
    let failed: Error | null = null
    void starting.catch((e: Error) => {
      failed = e
    })

    await vi.advanceTimersByTimeAsync(2_000) // camera + mic land, screen does not
    focused = true // the user picked; Chrome says it is sharing
    await vi.advanceTimersByTimeAsync(PICKER_SETTLE_MS + 2_000)

    expect(failed).toBeTruthy()
    expect((failed as unknown as Error).message).toMatch(/never delivered the screen/)
    // The whole complaint in one assertion: nothing is still held.
    expect(camTrack.stop).toHaveBeenCalled()
    expect(micTrack.stop).toHaveBeenCalled()
    expect(liveDeviceStreamCount()).toBe(0)
    rememberGrant('microphone', false)
    rememberGrant('camera', false)
  })
})
