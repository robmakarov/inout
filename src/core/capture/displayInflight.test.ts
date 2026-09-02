import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCaptureSession } from './session'
import { CaptureError } from '../types'
import { resetDeviceGuardForTests } from './deviceGuard'
import { resetDisplayReleaseForTests, trackDisplayCapture } from './displayRelease'
import {
  displayRequestOutstanding,
  displayRequestPending,
  markDisplayRequest,
  resetDisplayInflightForTests,
} from './displayInflight'
import {
  ESCALATE_AT_STALLS,
  consecutiveDisplayStalls,
  displayStallMessage,
  rememberDisplayStall,
  rememberDisplaySuccess,
  resetDisplayWedgeForTests,
} from './displayWedge'

/**
 * ROBERT, 2026-08-30, four presses in a row: "screen share got stuck again,
 * make this shit gone completly" · "twice, after reload chrome again" · "first
 * time waiting for screen, second waiting for screen and microphone" · "third
 * time too, screen" · "fourth too".
 *
 * A wedged getDisplayMedia never settles, so after our budget gives up the
 * REQUEST is still open against this RenderFrame — and every press after that
 * used to dispatch another one into the same frame. This file pins the two
 * things that stops: the second call is never made, and the advice stops
 * repeating a remedy the user has already carried out twice.
 */

class StubStream {
  constructor(private readonly tracks: unknown[] = []) {}
  getTracks(): unknown[] {
    return this.tracks
  }
  getVideoTracks(): unknown[] {
    return this.tracks
  }
  getAudioTracks(): unknown[] {
    return []
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

afterEach(() => {
  resetDisplayInflightForTests()
  resetDisplayWedgeForTests()
  resetDisplayReleaseForTests()
  resetDeviceGuardForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('one outstanding screen request per document', () => {
  it('a request the deadline gave up on keeps the document marked, forever', () => {
    expect(displayRequestOutstanding()).toBe(false)
    const req = markDisplayRequest(new Promise(() => {}))
    // Merely outstanding is not poison — the user may still be at the picker.
    expect(displayRequestOutstanding()).toBe(false)
    req.stuck()
    expect(displayRequestOutstanding()).toBe(true)
  })

  it('AN ABANDONED PICKER IS NOT A WEDGE — cancel, then record, must not refresh the app', async () => {
    // The user cancels the arm while the picker is open, then presses record
    // again. Chrome rejects the abandoned request as the picker closes; nothing
    // about that frame is stuck, and the next press must dispatch normally.
    const rejected = Promise.reject(new Error('user cancelled the picker'))
    markDisplayRequest(rejected)
    rejected.catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(displayRequestOutstanding()).toBe(false)
  })

  it('a share that arrives late, after we gave up, clears the mark', async () => {
    let deliver!: (s: unknown) => void
    const late = new Promise((r) => (deliver = r))
    const req = markDisplayRequest(late)
    req.stuck()
    expect(displayRequestOutstanding()).toBe(true)
    deliver('a stream nobody is waiting for any more')
    await Promise.resolve()
    await Promise.resolve()
    expect(displayRequestOutstanding()).toBe(false)
  })

  it('THE SECOND PRESS MAKES NO CALL AT ALL — and says so instantly', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('MediaRecorder', StubRecorder)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        // The wedge itself: taken, never delivered, never refused.
        getDisplayMedia: () => {
          calls += 1
          return new Promise(() => {})
        },
        getUserMedia: () => new Promise(() => {}),
      },
      permissions: { query: () => Promise.resolve({ state: 'granted' }) },
    })

    const config = { screen: true, camera: false, mic: false, systemAudio: false }

    const first = createCaptureSession(config).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(35_000)
    const firstErr = await first
    expect(firstErr).toBeInstanceOf(CaptureError)
    expect((firstErr as CaptureError).reason).toBe('wedged')
    expect(calls).toBe(1)

    // The user presses record again. Chrome still has the first request open;
    // dispatching a second one into this frame is the "it wedged again" loop.
    const second = createCaptureSession(config).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(50)
    const secondErr = await second
    expect(secondErr).toBeInstanceOf(CaptureError)
    expect((secondErr as CaptureError).reason).toBe('stale')
    // The whole point: no second call, and no 30 s spent discovering that.
    expect(calls).toBe(1)
  })

  /**
   * ROBERT'S MACHINE, 2026-09-02: the 'stale' refusal was journalled at
   * 08:53:03 and the reload it promised landed at 08:53:21. The screen was
   * refused in a tick, as designed — and the take then started the camera and
   * the mic anyway and ran their budgets and re-asks, for a take session.ts
   * was always going to throw away (a timed-out primary fails the take). A
   * wedge costs one press; it must not cost eighteen seconds of "Waiting for
   * camera and microphone…" on top.
   */
  it('A REFUSED SCREEN ASKS FOR NOTHING ELSE — the reload is a tick away, not a budget', async () => {
    vi.useFakeTimers()
    let displayCalls = 0
    let userMediaCalls = 0
    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('MediaRecorder', StubRecorder)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () => {
          displayCalls += 1
          return new Promise(() => {})
        },
        getUserMedia: () => {
          userMediaCalls += 1
          return new Promise(() => {})
        },
      },
      permissions: { query: () => Promise.resolve({ state: 'granted' }) },
    })
    const config = { screen: true, camera: true, mic: true, systemAudio: false }

    const first = createCaptureSession(config).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(((await first) as CaptureError).reason).toBe('wedged')
    expect(displayCalls).toBe(1)
    // The first press did ask for them — same tick as the picker, as always.
    expect(userMediaCalls).toBeGreaterThan(0)

    userMediaCalls = 0
    const t0 = Date.now()
    const second = createCaptureSession(config).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(50)
    const err = await second
    expect(err).toBeInstanceOf(CaptureError)
    expect((err as CaptureError).reason).toBe('stale')
    expect(displayCalls).toBe(1)
    // Nothing else was asked for, and the verdict took a tick, not a budget.
    expect(userMediaCalls).toBe(0)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})

describe('one screen request at a time — Chrome takes exactly one', () => {
  /**
   * ROBERT, 2026-08-30: "i tried to run record from two tabs at same time and
   * wedge happen ... and it happens after that too". Chrome serialises screen
   * requests; a second one dispatched while another is unsettled hangs. The
   * two-tab version is his repro, but the same collision needs no second tab:
   * press record, let the picker open, cancel the arm — a page cannot cancel
   * getDisplayMedia, so that request is still pending — then press again.
   */
  it('A CANCELLED ARM LEAVES A PENDING REQUEST, and the next press does not add a second', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('MediaRecorder', StubRecorder)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        // The picker is open and the user never answers it.
        getDisplayMedia: () => {
          calls += 1
          return new Promise(() => {})
        },
        getUserMedia: () => new Promise(() => {}),
      },
      permissions: { query: () => Promise.resolve({ state: 'granted' }) },
    })
    const config = { screen: true, camera: false, mic: false, systemAudio: false }

    const ac = new AbortController()
    const first = createCaptureSession(config, { signal: ac.signal }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(100)
    ac.abort()
    await first
    expect(calls).toBe(1)
    // Nothing declared it dead — our budget never fired — but Chrome still has it.
    expect(displayRequestOutstanding()).toBe(false)
    expect(displayRequestPending()).toBe(true)

    const second = createCaptureSession(config).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(50)
    const err = await second
    expect(err).toBeInstanceOf(CaptureError)
    // 'busy', NOT 'stale': the UI must not refresh on this one. The pending
    // request can still settle, and replacing the document orphans it.
    expect((err as CaptureError).reason).toBe('busy')
    expect(calls).toBe(1)
  })

  it('NEVER ASKS ON TOP OF A SHARE THAT IS STILL LIVE', async () => {
    // Robert, 2026-08-30: "when we about to ask permission, do we clear
    // previous one in this moment?" We cannot clear a REQUEST — there is no
    // abort — and we must not stop a delivered track here, because the stop
    // path keeps it alive while it drains the recorder. What we can do is not
    // make the call. This used to log "still held — requesting anyway" and ask
    // on top of a live share, which is the collision that hangs Chrome.
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('MediaRecorder', StubRecorder)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () => {
          calls += 1
          return new Promise(() => {})
        },
        getUserMedia: () => new Promise(() => {}),
      },
      permissions: { query: () => Promise.resolve({ state: 'granted' }) },
    })
    // A previous take's screen track that never releases.
    trackDisplayCapture({ readyState: 'live' } as unknown as MediaStreamTrack)

    const attempt = createCaptureSession({
      screen: true,
      camera: false,
      mic: false,
      systemAudio: false,
    }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(6_000)
    const err = await attempt
    expect(err).toBeInstanceOf(CaptureError)
    expect((err as CaptureError).reason).toBe('busy')
    expect(calls).toBe(0)
  })

  it('a share that arrives with nobody left to want it is STOPPED', async () => {
    vi.useFakeTimers()
    const stopped: string[] = []
    const track = {
      stop: () => {
        stopped.push('video')
      },
    }
    let deliver!: (s: unknown) => void
    const late = new Promise((r) => (deliver = r))
    const req = markDisplayRequest(late)
    req.stuck()
    deliver(new StubStream([track]))
    await vi.advanceTimersByTimeAsync(10)
    // Already written off — no grace, it goes the moment it lands. An unowned
    // screen track is a lit macOS indicator and a live capture session for
    // this origin, which is what "and it happens after that too" is made of.
    expect(stopped).toEqual(['video'])
  })

  it('a share the take actually took is left alone', async () => {
    vi.useFakeTimers()
    const stopped: string[] = []
    const track = {
      stop: () => {
        stopped.push('video')
      },
    }
    let deliver!: (s: unknown) => void
    const arriving = new Promise((r) => (deliver = r))
    const req = markDisplayRequest(arriving)
    deliver(new StubStream([track]))
    await Promise.resolve()
    req.claim()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(stopped).toEqual([])
  })
})

describe('advice that knows what it has already told this user', () => {
  it('the first stall gets the ⌘Q text', () => {
    rememberDisplayStall()
    const msg = displayStallMessage('wedge', 'chrome', 'failed')
    expect(msg).toMatch(/⌘Q/)
    expect(msg).not.toMatch(/System Settings/)
  })

  it('THE SECOND IN A ROW STOPS GIVING ORDERS — the app narrows the request instead', () => {
    rememberDisplayStall()
    rememberDisplayStall()
    expect(consecutiveDisplayStalls()).toBe(ESCALATE_AT_STALLS)
    const msg = displayStallMessage('wedge', 'chrome', 'failed')
    expect(msg).toMatch(/narrowed what it asks for/)
    // NO INSTRUCTIONS. Every remedy this used to print was work for the user,
    // and the ones that were tried did not work.
    expect(msg).not.toMatch(/System Settings|⌘Q|Privacy/)
    // It must name the count: "twice in a row, and the refresh did not help" is
    // the evidence that the page has been ruled out. Without it this is just
    // another sentence telling the user to go and change something.
    expect(msg).toMatch(/2 in a row/)
    // And it must stop being a wall — the steps live on the button under it,
    // so the text that used to spell out the pane, the toggle and the relaunch
    // is two sentences now. A user reading an alert does not read five.
    expect(msg.length).toBeLessThan(200)
  })

  it('a delivered screen clears the run — the next stall starts from the top again', () => {
    rememberDisplayStall()
    rememberDisplayStall()
    rememberDisplaySuccess(0)
    expect(consecutiveDisplayStalls()).toBe(0)
    expect(displayStallMessage('wedge', 'chrome', 'failed')).not.toMatch(/narrowed what it asks for/)
  })

  it('the still-running notice never escalates: the share may still land', () => {
    rememberDisplayStall()
    rememberDisplayStall()
    expect(displayStallMessage('wedge', 'chrome', 'waiting')).toMatch(/Still waiting/)
  })

  it('a refused request reads as a refused request, not as a wedge', () => {
    expect(displayStallMessage('stale', 'chrome', 'failed')).toMatch(/Refreshing the app/)
  })
})
