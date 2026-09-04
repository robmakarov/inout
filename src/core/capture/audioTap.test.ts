import { afterEach, describe, expect, it } from 'vitest'
import {
  TRACK_TAP_BUFFER_MS,
  audioTapChoice,
  audioTapThreadChoice,
  setAudioTapThread,
  canReadTrackPcm,
  trackPcmSampleRate,
  trackTapBufferChunks,
  trackTapBufferMs,
} from './audioTap'

/**
 * A1, 2026-09-01. The worklet tap loses ten per cent of a take's audio time on a
 * machine whose cores are saturated (measured, audioTap.ts carries the table);
 * the track tap loses none. This pins the two things that decide which one a
 * take gets: the choice, and the capability that can veto it.
 */
const g = globalThis as Record<string, unknown>

function search(v: string | null): void {
  if (v === null) delete g.location
  else g.location = { search: v }
}
function stored(v: string | null | 'throws'): void {
  if (v === null) {
    delete g.localStorage
    return
  }
  g.localStorage = {
    getItem: (k: string) => {
      if (v === 'throws') throw new Error('storage refused')
      return k === 'inout.capture.audiotap' ? v : null
    },
  }
}
function track(sampleRate: number | undefined): MediaStreamTrack {
  return { getSettings: () => ({ sampleRate }) } as unknown as MediaStreamTrack
}

afterEach(() => {
  delete g.location
  delete g.localStorage
  delete g.MediaStreamTrackProcessor
  delete g.AudioData
})

describe('which tap a take asks for', () => {
  it('is the track tap by default — the starvation fix is the shipped path', () => {
    expect(audioTapChoice()).toBe('track')
  })

  it('takes the sticky setting when there is one', () => {
    stored('worklet')
    expect(audioTapChoice()).toBe('worklet')
  })

  it('lets the URL beat the sticky setting, which is what an escape hatch is for', () => {
    stored('track')
    search('?audiotap=worklet')
    expect(audioTapChoice()).toBe('worklet')
  })

  it('ignores a value that is neither tap rather than recording through nothing', () => {
    search('?audiotap=yes')
    stored('mediarecorder')
    expect(audioTapChoice()).toBe('track')
  })

  it('survives storage being refused (file:// and private modes refuse it)', () => {
    stored('throws')
    expect(audioTapChoice()).toBe('track')
  })
})

describe('whether the platform can carry the track tap', () => {
  it('says no without MediaStreamTrackProcessor — Safari records unchanged', () => {
    g.AudioData = class {}
    expect(canReadTrackPcm(track(48_000))).toBe(false)
  })

  it('says no when the track will not name its rate', () => {
    g.MediaStreamTrackProcessor = class {}
    g.AudioData = class {}
    // The encoder, the wall-clock hold and the revive ladder are all built from
    // the rate BEFORE the first chunk arrives; without one there is nothing to
    // build them from and the worklet's context has to answer instead.
    expect(canReadTrackPcm(track(undefined))).toBe(false)
    expect(canReadTrackPcm(track(0))).toBe(false)
  })

  it('says yes when both the reader and a rate are there', () => {
    g.MediaStreamTrackProcessor = class {}
    g.AudioData = class {}
    expect(canReadTrackPcm(track(44_100))).toBe(true)
  })

  it('reports the rate it would build the timeline from, or 0', () => {
    expect(trackPcmSampleRate(track(48_000))).toBe(48_000)
    expect(trackPcmSampleRate(track(undefined))).toBe(0)
    expect(trackPcmSampleRate(track(-1))).toBe(0)
  })
})

/**
 * B12, 2026-09-04. The tap's buffer is the whole of the loss: the platform
 * default holds ~87 ms and drops the rest, which cost three 45 s takes 20.1,
 * 28.6 and 32.5 seconds of real audio under a dosed main-thread stall. These
 * pin the depth and its revert lever — the buffer is what a starved reader
 * survives on, so a silent change to either is a silent regression.
 */
describe('track tap buffer (B12)', () => {
  afterEach(() => {
    search(null)
  })

  it('holds the measured depth at both rates a take actually runs at', () => {
    search('')
    // 4000 ms of 128-frame quanta: 48 kHz → 1500, 44.1 kHz → 1379.
    expect(trackTapBufferChunks(48_000)).toBe(1500)
    expect(trackTapBufferChunks(44_100)).toBe(1379)
    // 46x the ~32 quanta the platform default was measured to hold.
    expect(trackTapBufferChunks(48_000) * 128).toBeGreaterThan(32 * 128 * 40)
  })

  it('?audiobuf=0 restores the platform default, and 0 chunks means "say nothing"', () => {
    search('?audiobuf=0')
    expect(trackTapBufferMs()).toBe(0)
    expect(trackTapBufferChunks(48_000)).toBe(0)
  })

  it('?audiobuf= takes a length in ms and ignores nonsense', () => {
    search('?audiobuf=1000')
    expect(trackTapBufferChunks(48_000)).toBe(375)
    search('?audiobuf=banana')
    expect(trackTapBufferMs()).toBe(TRACK_TAP_BUFFER_MS)
    search('?audiobuf=-5')
    expect(trackTapBufferMs()).toBe(TRACK_TAP_BUFFER_MS)
  })

  it('a track with no rate buys no buffer', () => {
    search('')
    expect(trackTapBufferChunks(0)).toBe(0)
  })
})

/**
 * X11a. WHICH THREAD READS THE PCM is now a switch Robert can press (the panel
 * writes storage), so the read has three sources and an order between them —
 * and the order is the whole point: a link wins for the load it is on, a
 * pressed row persists, and the default is what ships. The transfer itself is
 * still the capability gate; nothing here can promise a worker.
 */
describe('audio tap thread (X11a)', () => {
  afterEach(() => {
    search(null)
    delete g.localStorage
  })

  it('defaults to the worker, with no location and no storage at all', () => {
    expect(audioTapThreadChoice()).toBe('worker')
  })

  it('?audiotapthread=main puts the reader back on the main thread', () => {
    search('?audiotapthread=main')
    expect(audioTapThreadChoice()).toBe('main')
  })

  it('ignores a value that is not a thread', () => {
    search('?audiotapthread=banana')
    expect(audioTapThreadChoice()).toBe('worker')
  })

  it('reads the panel’s storage, and the URL still outranks it', () => {
    const store: Record<string, string> = { 'inout.capture.audioTapThread': 'main' }
    g.localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      },
    }
    search('')
    expect(audioTapThreadChoice()).toBe('main')
    search('?audiotapthread=worker')
    expect(audioTapThreadChoice()).toBe('worker')
    // The panel's own writer, and its reset back to the shipped default.
    search('')
    setAudioTapThread('worker')
    expect(store['inout.capture.audioTapThread']).toBe('worker')
    setAudioTapThread(null)
    expect(store['inout.capture.audioTapThread']).toBeUndefined()
    expect(audioTapThreadChoice()).toBe('worker')
  })

  it('storage that throws is not an opinion — the default stands', () => {
    g.localStorage = {
      getItem: () => {
        throw new Error('storage refused')
      },
    }
    search('')
    expect(audioTapThreadChoice()).toBe('worker')
  })
})
