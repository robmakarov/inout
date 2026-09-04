import { afterEach, describe, expect, it } from 'vitest'
import {
  audioTrackGroups,
  audioTrackMode,
  audioTrackModeActive,
  separateAudioTracks,
  setAudioTrackMode,
  setAudioTrackModeOverride,
} from './audioTracks'
import type { MixSource } from './audio'

/**
 * O10b's whole safety is that the DEFAULT does not move: an export that asks
 * for nothing must take exactly the path it took before this module existed.
 * These pin that, the three sources the choice is read from, and the grouping
 * that decides how many tracks a file gets.
 */
const g = globalThis as Record<string, unknown>

function search(v: string | null): void {
  if (v === null) delete g.location
  else g.location = { search: v }
}

function mixer(channelId: string): MixSource {
  return {
    gain: 1,
    channelId,
    channelIds: channelId ? [channelId] : [],
    mixInto: async () => undefined,
    dispose: () => undefined,
  }
}

const recording = {
  channels: [
    { id: 'a', kind: 'mic' },
    { id: 'b', kind: 'system-audio' },
    { id: 'c', kind: 'screen' },
  ],
}

afterEach(() => {
  search(null)
  setAudioTrackModeOverride(null)
  delete g.localStorage
})

describe('the audio track mode (O10b)', () => {
  it('is flat with no location, no storage and nothing told to it', () => {
    expect(audioTrackMode()).toBe('flat')
    expect(audioTrackModeActive()).toBe('flat')
    expect(separateAudioTracks()).toBe(false)
  })

  it('?audiotracks=separate asks for one track per channel', () => {
    search('?audiotracks=separate')
    expect(audioTrackModeActive()).toBe('separate')
    expect(separateAudioTracks()).toBe(true)
  })

  it('a value that is not a mode leaves the default alone', () => {
    search('?audiotracks=banana')
    expect(audioTrackModeActive()).toBe('flat')
  })

  /** The worker has neither location nor storage: it is TOLD, and the URL
   *  still outranks what it was told, exactly as every other flag here. */
  it('the worker override is used, and a link beats it', () => {
    search('')
    setAudioTrackModeOverride('separate')
    expect(audioTrackModeActive()).toBe('separate')
    search('?audiotracks=flat')
    expect(audioTrackModeActive()).toBe('flat')
  })

  it('the panel writes storage and its reset clears it', () => {
    const store: Record<string, string> = {}
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
    setAudioTrackMode('separate')
    expect(audioTrackModeActive()).toBe('separate')
    setAudioTrackMode(null)
    expect(store['inout.compose.audiotracks']).toBeUndefined()
    expect(audioTrackModeActive()).toBe('flat')
  })

  it('storage that throws is not an opinion — the default stands', () => {
    g.localStorage = {
      getItem: () => {
        throw new Error('refused')
      },
    }
    search('')
    expect(audioTrackModeActive()).toBe('flat')
  })
})

describe('grouping the mixers into tracks', () => {
  it('gives one track per channel and keeps every segment of a channel together', () => {
    // Two channels, three mixers: a cut made two spans of the mic.
    const groups = audioTrackGroups([mixer('a'), mixer('b'), mixer('a')], recording)
    expect(groups.map((x) => x.channelId)).toEqual(['a', 'b'])
    expect(groups[0]!.mixers).toHaveLength(2)
    expect(groups[1]!.mixers).toHaveLength(1)
  })

  it('names the tracks in words a person uses, not ids or kinds', () => {
    const groups = audioTrackGroups([mixer('a'), mixer('b')], recording)
    expect(groups.map((x) => x.label)).toEqual(['Microphone', 'System audio'])
  })

  /**
   * A stretched span mixes several channels into one source and reports no
   * channelId. It cannot be split, so the answer is NO GROUPS — the caller then
   * writes the flat mix rather than a file whose tracks are a guess.
   */
  it('refuses to split when a source is not a single channel', () => {
    expect(audioTrackGroups([mixer('a'), mixer('')], recording)).toEqual([])
  })

  it('one audio channel is one group, so nothing to separate', () => {
    expect(audioTrackGroups([mixer('a')], recording)).toHaveLength(1)
  })
})
