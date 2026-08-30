import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCaptureSession } from './session'
import { CaptureError } from '../types'
import { resetDeviceGuardForTests } from './deviceGuard'
import { resetDisplayReleaseForTests } from './displayRelease'
import {
  displayRequestOutstanding,
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
