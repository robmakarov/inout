import { describe, expect, it } from 'vitest'
import type { ChannelEdit, EditState, Recording } from '../types'
import {
  activeChannelsAt,
  channelSourceTimeAt,
  clampEditState,
  defaultEditState,
  hasEnabledVideo,
  outputDurationMs,
} from './timeline'

const rec: Recording = {
  id: 'rec-1',
  createdAt: 1_700_000_000_000,
  durationMs: 10_000,
  channels: [
    {
      id: 'ch-screen',
      kind: 'screen',
      media: 'video',
      mimeType: 'video/webm;codecs=vp9',
      blobKey: 'b-screen',
      startOffsetMs: 0,
      durationMs: 10_000,
      width: 1920,
      height: 1080,
    },
    {
      id: 'ch-cam',
      kind: 'camera',
      media: 'video',
      mimeType: 'video/webm;codecs=vp9',
      blobKey: 'b-cam',
      startOffsetMs: 2_000,
      durationMs: 6_000,
      width: 1280,
      height: 720,
    },
    {
      id: 'ch-mic',
      kind: 'mic',
      media: 'audio',
      mimeType: 'audio/webm;codecs=opus',
      blobKey: 'b-mic',
      startOffsetMs: 500,
      durationMs: 9_500,
    },
  ],
}

function edit(overrides: Partial<EditState> = {}, channelOverrides: Partial<ChannelEdit>[] = []): EditState {
  const base = defaultEditState(rec)
  const channels = base.channels.map((ce) => {
    const o = channelOverrides.find((co) => co.channelId === ce.channelId)
    return o ? { ...ce, ...o } : ce
  })
  return { ...base, ...overrides, channels }
}

describe('defaultEditState', () => {
  it('covers the full recording with every channel enabled and untrimmed', () => {
    const e = defaultEditState(rec)
    expect(e.recordingId).toBe('rec-1')
    expect(e.globalTrimStartMs).toBe(0)
    expect(e.globalTrimEndMs).toBe(10_000)
    expect(e.channels).toEqual([
      { channelId: 'ch-screen', enabled: true, trimStartMs: 0, trimEndMs: 10_000 },
      { channelId: 'ch-cam', enabled: true, trimStartMs: 0, trimEndMs: 6_000 },
      { channelId: 'ch-mic', enabled: true, trimStartMs: 0, trimEndMs: 9_500 },
    ])
  })
})

describe('outputDurationMs', () => {
  it('is the global trim span', () => {
    expect(outputDurationMs(defaultEditState(rec))).toBe(10_000)
    expect(outputDurationMs(edit({ globalTrimStartMs: 4_000, globalTrimEndMs: 9_000 }))).toBe(5_000)
  })
})

describe('channelSourceTimeAt — channel offsets', () => {
  const e = defaultEditState(rec)

  it('a late-starting channel is inactive before its offset', () => {
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 1_000)).toBeNull()
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 1_999)).toBeNull()
  })

  it('maps recording time to channel-local time past the offset', () => {
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 2_000)).toBe(0)
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 5_000)).toBe(3_000)
    expect(channelSourceTimeAt(rec, e, 'ch-mic', 1_000)).toBe(500)
  })

  it('a channel is inactive after its span ends', () => {
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 7_999)).toBe(5_999)
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 8_000)).toBeNull()
  })

  it('returns null for unknown or disabled channels', () => {
    expect(channelSourceTimeAt(rec, e, 'ch-ghost', 0)).toBeNull()
    const disabled = edit({}, [{ channelId: 'ch-screen', enabled: false }])
    expect(channelSourceTimeAt(rec, disabled, 'ch-screen', 0)).toBeNull()
  })
})

describe('channelSourceTimeAt — channel trims blank without shifting', () => {
  const e = edit({}, [{ channelId: 'ch-cam', trimStartMs: 1_000, trimEndMs: 3_000 }])

  it('is blank before the kept window', () => {
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 2_500)).toBeNull()
  })

  it('keeps channel-local time inside the window (no time shift)', () => {
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 3_000)).toBe(1_000)
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 4_500)).toBe(2_500)
  })

  it('is blank at and after trimEnd', () => {
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 4_999)).toBe(2_999)
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 5_000)).toBeNull()
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 6_000)).toBeNull()
  })
})

describe('channelSourceTimeAt — global trim remaps output time', () => {
  const e = edit({ globalTrimStartMs: 4_000, globalTrimEndMs: 9_000 })

  it('output t=0 corresponds to recording t=globalTrimStartMs', () => {
    expect(channelSourceTimeAt(rec, e, 'ch-screen', 0)).toBe(4_000)
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 0)).toBe(2_000)
    expect(channelSourceTimeAt(rec, e, 'ch-mic', 0)).toBe(3_500)
  })

  it('is null outside [0, outputDurationMs)', () => {
    expect(channelSourceTimeAt(rec, e, 'ch-screen', -1)).toBeNull()
    expect(channelSourceTimeAt(rec, e, 'ch-screen', 4_999)).toBe(8_999)
    expect(channelSourceTimeAt(rec, e, 'ch-screen', 5_000)).toBeNull()
  })

  it('composes with channel spans: cam ends at recording t=8000 -> output t=4000', () => {
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 3_999)).toBe(5_999)
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 4_000)).toBeNull()
  })
})

describe('boundary exclusivity ([start, end))', () => {
  it('output end is exclusive', () => {
    const e = defaultEditState(rec)
    expect(channelSourceTimeAt(rec, e, 'ch-screen', 9_999)).toBe(9_999)
    expect(channelSourceTimeAt(rec, e, 'ch-screen', 10_000)).toBeNull()
  })

  it('trimStart is inclusive, trimEnd is exclusive', () => {
    const e = edit({}, [{ channelId: 'ch-screen', trimStartMs: 1_000, trimEndMs: 2_000 }])
    expect(channelSourceTimeAt(rec, e, 'ch-screen', 999)).toBeNull()
    expect(channelSourceTimeAt(rec, e, 'ch-screen', 1_000)).toBe(1_000)
    expect(channelSourceTimeAt(rec, e, 'ch-screen', 1_999)).toBe(1_999)
    expect(channelSourceTimeAt(rec, e, 'ch-screen', 2_000)).toBeNull()
  })

  it('channel span start is inclusive, end is exclusive', () => {
    const e = defaultEditState(rec)
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 2_000)).toBe(0)
    expect(channelSourceTimeAt(rec, e, 'ch-cam', 8_000)).toBeNull()
  })
})

describe('activeChannelsAt', () => {
  it('returns active channels in recording order', () => {
    const e = defaultEditState(rec)
    expect(activeChannelsAt(rec, e, 1_000).map((c) => c.id)).toEqual(['ch-screen', 'ch-mic'])
    expect(activeChannelsAt(rec, e, 3_000).map((c) => c.id)).toEqual(['ch-screen', 'ch-cam', 'ch-mic'])
  })

  it('is empty outside output bounds', () => {
    const e = defaultEditState(rec)
    expect(activeChannelsAt(rec, e, -1)).toEqual([])
    expect(activeChannelsAt(rec, e, 10_000)).toEqual([])
  })

  it('respects disabled flags', () => {
    const e = edit({}, [
      { channelId: 'ch-screen', enabled: false },
      { channelId: 'ch-cam', enabled: false },
    ])
    expect(activeChannelsAt(rec, e, 3_000).map((c) => c.id)).toEqual(['ch-mic'])
  })
})

describe('hasEnabledVideo', () => {
  it('is true by default', () => {
    expect(hasEnabledVideo(rec, defaultEditState(rec))).toBe(true)
  })

  it('is false when all video channels are disabled', () => {
    const e = edit({}, [
      { channelId: 'ch-screen', enabled: false },
      { channelId: 'ch-cam', enabled: false },
    ])
    expect(hasEnabledVideo(rec, e)).toBe(false)
  })

  it('is false when video is enabled but trimmed fully outside the global window', () => {
    // Global window [0, 2000): cam's span starts at 2000, screen kept only [3000, 10000).
    const e = edit({ globalTrimStartMs: 0, globalTrimEndMs: 2_000 }, [
      { channelId: 'ch-screen', trimStartMs: 3_000, trimEndMs: 10_000 },
    ])
    expect(hasEnabledVideo(rec, e)).toBe(false)
  })

  it('is true when a video window partially overlaps the global window', () => {
    const e = edit({ globalTrimStartMs: 0, globalTrimEndMs: 2_500 }, [
      { channelId: 'ch-screen', enabled: false },
    ])
    // cam spans [2000, 8000) -> overlap [2000, 2500) is non-empty.
    expect(hasEnabledVideo(rec, e)).toBe(true)
  })

  it('is false for audio-only recordings', () => {
    const audioOnly: Recording = {
      ...rec,
      channels: rec.channels.filter((c) => c.media === 'audio'),
    }
    expect(hasEnabledVideo(audioOnly, defaultEditState(audioOnly))).toBe(false)
  })
})

describe('clampEditState', () => {
  it('clamps the global trim into recording bounds', () => {
    const e = clampEditState(rec, edit({ globalTrimStartMs: -500, globalTrimEndMs: 20_000 }))
    expect(e.globalTrimStartMs).toBe(0)
    expect(e.globalTrimEndMs).toBe(10_000)
  })

  it('enforces a 100ms minimum global span', () => {
    const tiny = clampEditState(rec, edit({ globalTrimStartMs: 5_000, globalTrimEndMs: 5_040 }))
    expect(tiny.globalTrimEndMs - tiny.globalTrimStartMs).toBe(100)
    expect(tiny.globalTrimStartMs).toBe(5_000)

    const atEnd = clampEditState(rec, edit({ globalTrimStartMs: 9_950, globalTrimEndMs: 9_970 }))
    expect(atEnd.globalTrimStartMs).toBe(9_900)
    expect(atEnd.globalTrimEndMs).toBe(10_000)

    const reversed = clampEditState(rec, edit({ globalTrimStartMs: 6_000, globalTrimEndMs: 5_000 }))
    expect(reversed.globalTrimStartMs).toBeLessThan(reversed.globalTrimEndMs)
    expect(reversed.globalTrimEndMs - reversed.globalTrimStartMs).toBeGreaterThanOrEqual(100)
  })

  it('clamps channel trims into channel bounds and enforces min span', () => {
    const e = clampEditState(
      rec,
      edit({}, [{ channelId: 'ch-cam', trimStartMs: -100, trimEndMs: 99_999 }]),
    )
    const cam = e.channels.find((c) => c.channelId === 'ch-cam')
    expect(cam).toEqual({ channelId: 'ch-cam', enabled: true, trimStartMs: 0, trimEndMs: 6_000 })

    const tiny = clampEditState(
      rec,
      edit({}, [{ channelId: 'ch-cam', trimStartMs: 5_990, trimEndMs: 5_995 }]),
    )
    const camTiny = tiny.channels.find((c) => c.channelId === 'ch-cam')
    expect(camTiny).toEqual({ channelId: 'ch-cam', enabled: true, trimStartMs: 5_900, trimEndMs: 6_000 })
  })

  it('drops unknown channel edits and fills missing ones with defaults', () => {
    const input: EditState = {
      recordingId: 'rec-1',
      globalTrimStartMs: 0,
      globalTrimEndMs: 10_000,
      channels: [
        { channelId: 'ch-ghost', enabled: true, trimStartMs: 0, trimEndMs: 1_000 },
        { channelId: 'ch-cam', enabled: false, trimStartMs: 500, trimEndMs: 4_000 },
      ],
    }
    const e = clampEditState(rec, input)
    expect(e.channels.map((c) => c.channelId)).toEqual(['ch-screen', 'ch-cam', 'ch-mic'])
    expect(e.channels[0]).toEqual({ channelId: 'ch-screen', enabled: true, trimStartMs: 0, trimEndMs: 10_000 })
    expect(e.channels[1]).toEqual({ channelId: 'ch-cam', enabled: false, trimStartMs: 500, trimEndMs: 4_000 })
  })
})
