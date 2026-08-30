import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WEDGE_PROBE_AFTER_MS,
  classifyDisplayStall,
  displayRequestLevel,
  displayStallMessage,
  displayWedgeCount,
  rememberDisplaySuccess,
  rememberDisplayWedge,
  resetDisplayWedge,
  resetDisplayWedgeForTests,
} from './displayWedge'
import { acquireChannelsProgressive } from './acquire'
import { resetDeviceGuardForTests } from './deviceGuard'
import { resetDisplayReleaseForTests } from './displayRelease'
import { resetDisplayInflightForTests } from './displayInflight'

/**
 * Robert 2026-08-24: "i need this shit never happens to users". The wedge itself
 * is Chrome's (share taken, track never delivered, survives tab close, only a
 * Chrome quit clears it) — but a user hitting it TWICE would be ours. After a
 * wedge, the next record click must send a smaller share request, so that if
 * any of our options is the trigger, the user's second click just works and
 * they never learn any of this existed.
 *
 * Robert 2026-08-25: "share sound in chrome with screen toggle not there anymore".
 * The first cut dropped `audio` on the FIRST wedge and kept it dropped for
 * 24h, which took Chrome's own tab-audio checkbox off the picker for a day.
 * The rungs below exist so the visible feature is the LAST thing to go, and
 * when it does go it goes for one take.
 */

afterEach(() => {
  resetDisplayReleaseForTests()
  resetDisplayWedgeForTests()
  resetDeviceGuardForTests()
  // A wedged request stays outstanding for the life of the DOCUMENT
  // (displayInflight.ts) — which in a test file is every case after the one
  // that wedged. Without this reset the next case is correctly refused a
  // dispatch and reads as 'stale', which is the new behaviour working, not the
  // case under test.
  resetDisplayInflightForTests()
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

  it('the ladder bottoms out at 3 and stays there — there is no rung below it', () => {
    for (let i = 0; i < 3; i++) rememberDisplayWedge(1_000_000 + i)
    expect(displayRequestLevel(1_000_005)).toBe(3)
    // Wedge all day: the floor holds. Below it lies only the user's own asks,
    // and those are not ours to drop (Robert 2026-08-25). Rung 3 does not drop
    // the tab audio either — it moves our three raw flags onto the track.
    rememberDisplayWedge(1_000_006)
    rememberDisplayWedge(1_000_007)
    expect(displayRequestLevel(1_000_008)).toBe(3)
  })

  /*
   * NO NUMBER OF GOOD TAKES CLIMBS. Twice this was driven by a counter and
   * twice the counter walked the machine back onto the request that wedges it —
   * on one good take (wedge every second record), then on three (every fourth).
   * Robert's own stored state on 2026-08-30 was `level:2, count:5, goodRun:2`:
   * five wedges, parked on the floor, two takes into earning the climb back.
   * A good take at rung N is evidence about rung N. It is never evidence about
   * the rung above, which is the one that choked.
   */
  it('THE CLIMB IS GONE: a hundred good takes do not move the ladder', () => {
    rememberDisplayWedge(1_000_000)
    for (let i = 0; i < 100; i++) rememberDisplaySuccess(1)
    expect(displayRequestLevel(1_000_001)).toBe(1)
  })

  it('a good take at the FULL request does not clear the mark either — it cannot happen', () => {
    // usedLevel is whatever the ladder handed out, so a success at 0 on a
    // marked machine is not a state this can reach; if it ever did, the mark
    // stays and the day-long probe is what moves it.
    rememberDisplayWedge(1_000_000)
    rememberDisplaySuccess(0)
    expect(displayRequestLevel(1_000_001)).toBe(1)
  })

  it('A QUIET DAY PROBES ONE RUNG UP, not the whole ladder', () => {
    for (let i = 0; i < 3; i++) rememberDisplayWedge(1_000_000 + i)
    expect(displayRequestLevel(1_000_005)).toBe(3)
    const day = WEDGE_PROBE_AFTER_MS
    // A day later it tries rung 2 — not rung 0, which is the call that broke it.
    expect(displayRequestLevel(1_000_005 + day)).toBe(2)
    // And the probe re-stamps, so the next one is another day away, not now.
    expect(displayRequestLevel(1_000_005 + day + 1)).toBe(2)
    expect(displayRequestLevel(1_000_005 + day * 2 + 10)).toBe(1)
    expect(displayRequestLevel(1_000_005 + day * 3 + 20)).toBe(0)
    // Home, and the mark is gone rather than merely aged out.
    expect(displayRequestLevel(1_000_005 + day * 3 + 21)).toBe(0)
  })

  it('a wedge during the probe drops straight back — a sick machine cannot ratchet out', () => {
    rememberDisplayWedge(1_000_000)
    rememberDisplayWedge(1_000_001)
    expect(displayRequestLevel(1_000_002)).toBe(2)
    const day = WEDGE_PROBE_AFTER_MS
    expect(displayRequestLevel(1_000_002 + day)).toBe(1)
    rememberDisplayWedge(1_000_003 + day)
    expect(displayRequestLevel(1_000_004 + day)).toBe(2)
  })

  it('the mark expires 24h after the last wedge — a fixed Chrome restores the full request', () => {
    rememberDisplayWedge(1_000_000)
    expect(displayRequestLevel(1_000_000 + 23 * 3600_000)).toBe(1)
    expect(displayRequestLevel(1_000_000 + 25 * 3600_000)).toBe(0)
  })

  it('a machine marked by the OLD audio-dropping safe mode lands on rung 1, not the silent one', () => {
    // Exactly what the shipped 2026-08-25 build wrote: no rung recorded. Any
    // Robert or user carrying that record gets the tab-audio checkbox back on
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

  it('ONE wedge: the HINTS go, the BOUNDS stay — backing off must not capture more', async () => {
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
    // AND THE BOUNDS SURVIVE, corrected 2026-08-29. This rung used to throw the
    // size and rate limits out along with the hints, so a machine that had
    // already choked once went on to capture its WHOLE monitor uncapped —
    // Robert's take read "reduced request 2/2 after a stuck share" at
    // 3024x1964, and no flag could reach it because every flag lives in the
    // bounds this rung had removed. The wedge is Chrome hanging on the exotic
    // OPTIONS; the bounds were never part of it.
    const video = seen.video as Record<string, unknown>
    expect(video.width).toBeDefined()
    expect(video.height).toBeDefined()
    expect(video.frameRate).toBeDefined()
    expect(video.displaySurface).toBe('monitor')
  })

  it('two wedges: the bare request — still audio, still RAW, no video constraints at all', async () => {
    rememberDisplayWedge()
    rememberDisplayWedge()
    let seen: Record<string, unknown> = {}
    stubDisplay((o) => (seen = o))
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
    }).settled
    expect(seen.video).toBe(true)
    // Until 2026-08-26 the floor asked for bare `audio: true`, which hands the
    // tab audio to Chrome's default AEC/NS/AGC — a machine the game wedges
    // parked on rung 2 recorded every tab-music take as mono warble for a day
    // (Robert: "music from tab sounds shitty"). The processing flags are part of
    // the user's ask and ride every rung; only VIDEO constraints shrink here.
    const audio = seen.audio as Record<string, unknown>
    expect(audio.echoCancellation).toBe(false)
    expect(audio.noiseSuppression).toBe(false)
    expect(audio.autoGainControl).toBe(false)
  })

  it('wedge it five times: the request still carries the audio the user asked for', async () => {
    // THE ONE THAT MUST NEVER GO GREEN BY GOING SILENT. No number of wedges
    // buys the app the right to record a take without the sound the user
    // switched on (Robert 2026-08-25: "always fucking clean").
    for (let i = 0; i < 5; i++) rememberDisplayWedge()
    let seen: Record<string, unknown> = {}
    stubDisplay((o) => (seen = o))
    await acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
    }).settled
    expect(seen.audio).toBeTruthy()
  })

  it('GATE, END TO END: real takes do NOT walk the machine back onto the wedge', async () => {
    // Driven through the actual acquisition path — which is where the rung is
    // read and written — because that is where both broken versions of the
    // climb lived. This used to assert the opposite, twice: first that one good
    // take climbs, then that three do. Both walked Robert back onto the request
    // that had been wedging him, the second one just took four takes to do it.
    for (let i = 0; i < 3; i++) rememberDisplayWedge()
    expect(displayRequestLevel()).toBe(3)

    // Ten good takes in a row, the release barrier reset each time so every
    // request is instant. The floor holds through all of them.
    for (let i = 0; i < 10; i++) {
      resetDisplayReleaseForTests()
      stubDisplay(() => undefined)
      await acquireChannelsProgressive(config, {
        onChannel: () => undefined,
        onFailure: () => undefined,
      }).settled
    }
    expect(displayRequestLevel()).toBe(3)
  })
})

/**
 * W1, 2026-08-29 — A STALL IS NOT ALWAYS A WEDGE.
 *
 * With macOS screen recording ungranted, Chrome's picker opens, SAYS SO, and
 * getDisplayMedia never settles: identical to the wedge from the page. Before
 * this, every such stall escalated the safe-mode ladder against a permission
 * no request of ours can satisfy — parking the machine on a reduced request
 * for 24 h over a checkbox — and reported "the device never connected" while
 * Chrome was displaying the actual answer on screen.
 */
describe('telling the wedge from the permission', () => {
  it('macOS + never delivered = the permission, which is the one Chrome is showing', () => {
    expect(classifyDisplayStall('macos')).toBe('permission')
  })

  it('one delivered share proves the grant — every stall after it is the wedge', () => {
    rememberDisplaySuccess(0)
    expect(classifyDisplayStall('macos')).toBe('wedge')
  })

  it('nowhere else has a grant that HANGS — Windows and Linux read as the wedge', () => {
    // The Wayland portal refuses, and a refusal arrives as a rejection that
    // never reaches this path at all.
    expect(classifyDisplayStall('windows')).toBe('wedge')
    expect(classifyDisplayStall('linux')).toBe('wedge')
  })

  it('the user\'s reset clears the rung and KEEPS the delivery fact', () => {
    rememberDisplaySuccess(0) // this profile has the grant
    for (let i = 0; i < 3; i++) rememberDisplayWedge()
    expect(displayRequestLevel()).toBe(3)
    resetDisplayWedge()
    expect(displayRequestLevel()).toBe(0)
    // Forgetting the delivery would make the very next stall misread a granted
    // machine as an ungranted one, and send the user to System Settings for
    // nothing.
    expect(classifyDisplayStall('macos')).toBe('wedge')
  })

  it('the permission text names the browser the user is actually in', () => {
    const edge = displayStallMessage('permission', 'edge', 'failed')
    expect(edge).toContain('Edge')
    expect(edge).not.toContain('Chrome')
    expect(edge).toContain('Screen & System Audio Recording')
    // THE LINE THIS TASK EXISTS TO DELETE.
    expect(edge).not.toContain('never connected')
  })

  it('the waiting text may not claim anything failed — the request is still alive', () => {
    const waiting = displayStallMessage('wedge', 'chrome', 'waiting')
    expect(waiting).toContain('Still waiting')
    expect(waiting).not.toContain('nothing was recorded')
  })
})

describe('what a real timeout does to the ladder', () => {
  const config = { screen: true, camera: false, mic: false, systemAudio: false }
  const MAC_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

  /** getDisplayMedia that never settles — the wedge, and the ungranted
   *  permission, are the same object from here. */
  function stubNeverSettles(ua = MAC_UA): void {
    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('navigator', {
      userAgent: ua,
      maxTouchPoints: 0,
      mediaDevices: {
        getDisplayMedia: () => new Promise<never>(() => {}),
        getUserMedia: () => Promise.resolve(new StubStream([stubTrack('audio')])),
      },
      permissions: { query: () => Promise.resolve({ state: 'granted' }) },
    })
  }

  it('a PERMISSION stall does not raise the rung at all — W1 gate', async () => {
    vi.useFakeTimers()
    stubNeverSettles()
    const failures: { stall?: string }[] = []
    const acq = acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: (f) => failures.push(f),
    })
    await vi.advanceTimersByTimeAsync(31_000)
    await acq.settled
    expect(failures[0]?.stall).toBe('permission')
    // The whole point: nothing was learned about OUR options, so nothing of
    // ours is dropped on the next click.
    expect(displayRequestLevel()).toBe(0)
    vi.useRealTimers()
  })

  it('the SAME stall after a delivered share is a wedge, and does step down', async () => {
    rememberDisplaySuccess(0) // this profile has the macOS grant
    vi.useFakeTimers()
    stubNeverSettles()
    const failures: { stall?: string }[] = []
    const acq = acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: (f) => failures.push(f),
    })
    await vi.advanceTimersByTimeAsync(31_000)
    await acq.settled
    expect(failures[0]?.stall).toBe('wedge')
    expect(displayRequestLevel()).toBe(1)
    vi.useRealTimers()
  })

  it('says it while the request is STILL RUNNING, not 30 s later', async () => {
    vi.useFakeTimers()
    stubNeverSettles()
    const stalls: { message: string; stall: string }[] = []
    const acq = acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
      onStall: (message, stall) => stalls.push({ message, stall }),
    })
    // Nothing at 11 s — a person may still be reading Chrome's picker.
    await vi.advanceTimersByTimeAsync(11_000)
    expect(stalls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(stalls).toHaveLength(1)
    expect(stalls[0]?.stall).toBe('permission')
    expect(stalls[0]?.message).toContain('Screen & System Audio Recording')
    // And it stays a NOTICE: the take has not failed yet.
    await vi.advanceTimersByTimeAsync(20_000)
    await acq.settled
    expect(stalls).toHaveLength(1)
    vi.useRealTimers()
  })

  it('a share that ARRIVES never nags — the notice is cancelled with the promise', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('MediaStream', StubStream)
    vi.stubGlobal('navigator', {
      userAgent: MAC_UA,
      maxTouchPoints: 0,
      mediaDevices: {
        getDisplayMedia: () => Promise.resolve(new StubStream([stubTrack('video')])),
        getUserMedia: () => Promise.resolve(new StubStream([stubTrack('audio')])),
      },
      permissions: { query: () => Promise.resolve({ state: 'granted' }) },
    })
    const stalls: string[] = []
    const acq = acquireChannelsProgressive(config, {
      onChannel: () => undefined,
      onFailure: () => undefined,
      onStall: (m) => stalls.push(m),
    })
    await acq.settled
    await vi.advanceTimersByTimeAsync(30_000)
    expect(stalls).toEqual([])
    vi.useRealTimers()
  })
})
