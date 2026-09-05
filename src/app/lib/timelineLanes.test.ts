import { describe, expect, it } from 'vitest'
import type { ChannelKind, ChannelRecording } from '@core/types'
import { timelineLanes } from './timelineLanes'

function ch(id: string, kind: ChannelKind, startOffsetMs: number, durationMs: number): ChannelRecording {
  return {
    id,
    kind,
    media: kind === 'mic' || kind === 'system-audio' ? 'audio' : 'video',
    mimeType: 'video/mp4',
    blobKey: id,
    startOffsetMs,
    durationMs,
  }
}

describe('timelineLanes', () => {
  it('gives one lane per input, not one per file', () => {
    // Robert's 2026-09-05 take, in the order prod actually produced it:
    // camera and mic toggled off and on mid-take, so their kinds have several
    // files each. Seven files, four inputs, four lanes.
    const lanes = timelineLanes([
      ch('c1', 'camera', 0, 4000),
      ch('s1', 'screen', 0, 20000),
      ch('m1', 'mic', 0, 9000),
      ch('a1', 'system-audio', 0, 20000),
      ch('c2', 'camera', 6500, 9000),
      ch('m2', 'mic', 11500, 8500),
      ch('c3', 'camera', 17000, 3000),
    ])
    expect(lanes.map((l) => l.kind)).toEqual(['screen', 'camera', 'mic', 'system-audio'])
    expect(lanes.map((l) => l.channels.length)).toEqual([1, 3, 2, 1])
  })

  it('orders lanes like the chips, whatever order the devices armed in', () => {
    // The screen answering LAST must not put its lane last: the same report
    // said "screen lane not shown at all".
    const lanes = timelineLanes([
      ch('a1', 'system-audio', 0, 100),
      ch('m1', 'mic', 0, 100),
      ch('s1', 'screen', 40, 100),
    ])
    expect(lanes.map((l) => l.kind)).toEqual(['screen', 'mic', 'system-audio'])
  })

  it('puts a lane’s files in the order they were recorded', () => {
    const lanes = timelineLanes([
      ch('c2', 'camera', 9000, 1000),
      ch('c1', 'camera', 0, 1000),
      ch('c3', 'camera', 20000, 1000),
    ])
    expect(lanes).toHaveLength(1)
    expect(lanes[0]!.channels.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('leaves the gaps between a lane’s files alone — the blank is the fact', () => {
    // Nothing is stretched or merged: the timeline draws each file where it
    // was, and the stretch the input was off is simply not drawn.
    const [lane] = timelineLanes([ch('c1', 'camera', 0, 4000), ch('c2', 'camera', 6500, 9000)])
    expect(lane!.channels.map((c) => [c.startOffsetMs, c.durationMs])).toEqual([
      [0, 4000],
      [6500, 9000],
    ])
  })

  it('is the identity on a take with one file per input', () => {
    const lanes = timelineLanes([ch('s1', 'screen', 0, 100), ch('m1', 'mic', 0, 100)])
    expect(lanes.map((l) => l.channels.map((c) => c.id))).toEqual([['s1'], ['m1']])
  })

  it('has no lanes for a take with no channels', () => {
    expect(timelineLanes([])).toEqual([])
  })
})
