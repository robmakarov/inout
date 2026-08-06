import { describe, expect, it, vi } from 'vitest'
import {
  ACQUIRE_TIMEOUT_MS,
  PROMPT_TIMEOUT_MS,
  primaryKindFor,
  surfaceNotice,
  withTimeout,
} from './acquire'
import { parseSlowChannels } from './synthetic'

describe('shared-surface notice', () => {
  it('warns that a single tab records nothing else', () => {
    expect(surfaceNotice('browser')).toMatch(/ONE browser tab/)
    expect(surfaceNotice('browser')).toMatch(/whole screen/)
  })
  it('warns that a single window can freeze', () => {
    expect(surfaceNotice('window')).toMatch(/ONE app window/)
    expect(surfaceNotice('window')).toMatch(/freezes/)
  })
  it('stays quiet for a whole monitor — that records everything', () => {
    expect(surfaceNotice('monitor')).toBeNull()
  })
  it('stays quiet when the browser does not report a surface', () => {
    expect(surfaceNotice(undefined)).toBeNull()
  })
})

describe('instant-arm primary channel selection', () => {
  const base = { screen: false, camera: false, mic: false, systemAudio: false }
  it('screen gates start whenever requested', () => {
    expect(primaryKindFor({ ...base, screen: true, camera: true, mic: true })).toBe('screen')
  })
  it('camera gates when no screen', () => {
    expect(primaryKindFor({ ...base, camera: true, mic: true })).toBe('camera')
  })
  it('audio-only takes gate on mic', () => {
    expect(primaryKindFor({ ...base, mic: true })).toBe('mic')
  })
  it('nothing requested → no primary', () => {
    expect(primaryKindFor(base)).toBeNull()
  })
})

describe('instant-arm harness knobs', () => {
  it('parses slow= into per-kind delays', () => {
    const m = parseSlowChannels('?synthetic=1&slow=camera:3000,mic:8000')
    expect(m.get('camera')).toBe(3000)
    expect(m.get('mic')).toBe(8000)
    expect(m.size).toBe(2)
  })
  it('ignores junk kinds and non-numeric delays', () => {
    const m = parseSlowChannels('?slow=webcam:100,camera:abc,mic:-5,screen:250')
    expect(m.size).toBe(1)
    expect(m.get('screen')).toBe(250)
  })
  it('empty when absent', () => {
    expect(parseSlowChannels('?synthetic=1').size).toBe(0)
  })
})

describe('acquire budgets', () => {
  it('device budget: above real spin-ups, but bounded — every device gates start', () => {
    // Since synchronized start (2026-07-20) EVERY device blocks the take start,
    // so this budget is exactly how long the UI can freeze on one wedged device
    // ("stuck waiting for mic", PO 2026-07-23). Lower bound: 5s falsely killed
    // slow-but-alive granted inputs (loaded Mac mic, mobile Safari getUserMedia).
    expect(ACQUIRE_TIMEOUT_MS).toBeGreaterThan(5_000)
    expect(ACQUIRE_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
    // Never time a person: prompts and pickers get longer still.
    expect(PROMPT_TIMEOUT_MS).toBeGreaterThan(ACQUIRE_TIMEOUT_MS)
  })

  it('a stream resolving AFTER timeout is released, never leaked', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    class FakeMediaStream {
      getTracks() {
        return [{ stop }]
      }
    }
    vi.stubGlobal('MediaStream', FakeMediaStream)
    try {
      const fakeStream = new FakeMediaStream() as unknown as MediaStream
      let resolveLate!: (v: MediaStream) => void
      const late = new Promise<MediaStream>((r) => {
        resolveLate = r
      })
      const guarded = withTimeout(late, 1000, 'test')
      const rejection = expect(guarded).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(1001)
      await rejection
      // The user answers the prompt AFTER the deadline — light must go off.
      resolveLate(fakeStream)
      await Promise.resolve()
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
