import { describe, expect, it } from 'vitest'
import type { ChannelEdit, EditState, Recording } from '../types'
import {
  activeChannelsAt,
  channelHasOutputWindow,
  channelSourceTimeAt,
  clampEditState,
  defaultEditState,
  hasCuts,
  hasEnabledVideo,
  isDefaultEdit,
  editSegments,
  keptSegments,
  outputDurationMs,
  outputToRecordingMs,
  recordingToOutputMs,
  removeSegment,
  segmentJoinsMs,
  splitAtOutputMs,
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

// ---------------------------------------------------------------------------
// Kept segments — mid-take cuts (F1)
// ---------------------------------------------------------------------------

describe('kept segments', () => {
  const rec: Recording = {
    id: 'r1',
    createdAt: 0,
    durationMs: 10_000,
    channels: [
      {
        id: 'v',
        kind: 'screen',
        media: 'video',
        mimeType: 'video/webm',
        blobKey: 'v',
        startOffsetMs: 0,
        durationMs: 10_000,
      },
    ],
  }
  const base = defaultEditState(rec)
  // Cut out 3000-5000: two kept spans.
  const cut: EditState = {
    ...base,
    segments: [
      { startMs: 0, endMs: 3000 },
      { startMs: 5000, endMs: 10_000 },
    ],
  }

  it('absent segments behave exactly like one span over the whole trim', () => {
    expect(keptSegments(base)).toEqual([{ startMs: 0, endMs: 10_000 }])
    expect(outputDurationMs(base)).toBe(10_000)
    expect(outputToRecordingMs(base, 4200)).toBe(4200)
    expect(hasCuts(base)).toBe(false)
    expect(isDefaultEdit(rec, base)).toBe(true)
  })

  it('output duration is the sum of kept spans', () => {
    expect(outputDurationMs(cut)).toBe(8000)
    expect(hasCuts(cut)).toBe(true)
    // A cut take can never take the instant packet-copy path.
    expect(isDefaultEdit(rec, cut)).toBe(false)
  })

  it('maps output time across the join', () => {
    expect(outputToRecordingMs(cut, 0)).toBe(0)
    expect(outputToRecordingMs(cut, 2999)).toBe(2999)
    // The instant after the join is the far side of the cut.
    expect(outputToRecordingMs(cut, 3000)).toBe(5000)
    expect(outputToRecordingMs(cut, 7999)).toBe(9999)
    expect(outputToRecordingMs(cut, 8000)).toBeNull()
  })

  it('round-trips recording time back to output time, and reports cut material', () => {
    expect(recordingToOutputMs(cut, 2999)).toBe(2999)
    expect(recordingToOutputMs(cut, 5000)).toBe(3000)
    expect(recordingToOutputMs(cut, 4000)).toBeNull() // inside the cut
    for (const t of [0, 1500, 2999, 5000, 7000, 9999]) {
      const out = recordingToOutputMs(cut, t)
      expect(out).not.toBeNull()
      expect(outputToRecordingMs(cut, out as number)).toBe(t)
    }
  })

  it('samples the right source frame either side of a join', () => {
    expect(channelSourceTimeAt(rec, cut, 'v', 2999)).toBe(2999)
    expect(channelSourceTimeAt(rec, cut, 'v', 3000)).toBe(5000)
    expect(channelSourceTimeAt(rec, cut, 'v', 8000)).toBeNull()
  })

  it('reports the joins on the output timeline', () => {
    expect(segmentJoinsMs(cut)).toEqual([3000])
    expect(segmentJoinsMs(base)).toEqual([])
  })

  it('splits at the playhead and deletes a segment', () => {
    const split = splitAtOutputMs(base, 4000)
    // The editor keeps the split marker...
    expect(editSegments(split)).toEqual([
      { startMs: 0, endMs: 4000 },
      { startMs: 4000, endMs: 10_000 },
    ])
    // ...but nothing was removed, so the engine still sees one continuous span
    // and the take keeps its instant packet-copy path.
    expect(keptSegments(split)).toEqual([{ startMs: 0, endMs: 10_000 }])
    expect(hasCuts(split)).toBe(false)
    expect(isDefaultEdit(rec, split)).toBe(true)
    expect(segmentJoinsMs(split)).toEqual([])
    expect(outputDurationMs(split)).toBe(10_000)

    const dropped = removeSegment(split, 0)
    expect(keptSegments(dropped)).toEqual([{ startMs: 4000, endMs: 10_000 }])
    expect(outputDurationMs(dropped)).toBe(6000)
    // One span that no longer covers the trim IS a cut.
    expect(hasCuts(dropped)).toBe(true)
    expect(isDefaultEdit(rec, dropped)).toBe(false)
    // The last remaining span is never removable.
    expect(removeSegment(dropped, 0)).toBe(dropped)
  })

  it('refuses a split that would leave a sliver', () => {
    expect(splitAtOutputMs(base, 50)).toBe(base)
    expect(splitAtOutputMs(base, 9990)).toBe(base)
  })

  it('normalizes overlapping and out-of-order spans, and drops a no-op list', () => {
    const messy = clampEditState(rec, {
      ...base,
      segments: [
        { startMs: 5000, endMs: 7000 },
        { startMs: 1000, endMs: 3000 },
        { startMs: 2500, endMs: 4000 },
        { startMs: 8000, endMs: 7000 }, // reversed → [7000,8000): adjacent, not
      ],                                //            overlapping, so it stays
    })
    // Overlaps merge; adjacency does not (that is what a split looks like).
    expect(editSegments(messy)).toEqual([
      { startMs: 1000, endMs: 4000 },
      { startMs: 5000, endMs: 7000 },
      { startMs: 7000, endMs: 8000 },
    ])
    // The engine sees the adjacent pair as one continuous run.
    expect(keptSegments(messy)).toEqual([
      { startMs: 1000, endMs: 4000 },
      { startMs: 5000, endMs: 8000 },
    ])
    // One span covering the whole trim is not a cut — the field is dropped.
    const noop = clampEditState(rec, { ...base, segments: [{ startMs: 0, endMs: 10_000 }] })
    expect(noop.segments).toBeUndefined()
    expect(isDefaultEdit(rec, noop)).toBe(true)
  })

  it('drops a channel that every kept span misses', () => {
    const twoCh: Recording = {
      ...rec,
      channels: [
        rec.channels[0]!,
        {
          id: 'a',
          kind: 'mic',
          media: 'audio',
          mimeType: 'audio/webm',
          blobKey: 'a',
          startOffsetMs: 3200,
          durationMs: 1000,
        },
      ],
    }
    const e = clampEditState(twoCh, {
      ...defaultEditState(twoCh),
      segments: [
        { startMs: 0, endMs: 3000 },
        { startMs: 5000, endMs: 10_000 },
      ],
    })
    // The mic only exists inside the cut-out span.
    expect(channelHasOutputWindow(twoCh, e, 'a')).toBe(false)
    expect(channelHasOutputWindow(twoCh, e, 'v')).toBe(true)
  })
})
