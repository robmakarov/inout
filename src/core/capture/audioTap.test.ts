import { afterEach, describe, expect, it } from 'vitest'
import { audioTapChoice, canReadTrackPcm, trackPcmSampleRate } from './audioTap'

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
