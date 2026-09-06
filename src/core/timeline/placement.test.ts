import { describe, expect, it } from 'vitest'
import type { ChannelRecording, Recording } from '@core/types'
import { findPlacementRepairs, repairPlacement } from './placement'

const ch = (
  id: string,
  kind: ChannelRecording['kind'],
  media: ChannelRecording['media'],
  startOffsetMs: number,
  durationMs: number,
): ChannelRecording => ({
  id,
  kind,
  media,
  mimeType: media === 'audio' ? 'audio/webm;codecs=opus' : 'video/mp4',
  blobKey: `blob-${id}`,
  startOffsetMs,
  durationMs,
})

const rec = (channels: ChannelRecording[]): Recording => ({
  id: 'rec_test',
  createdAt: 0,
  durationMs: channels.reduce((m, c) => Math.max(m, c.startOffsetMs + c.durationMs), 0),
  channels,
})

describe('channel placement', () => {
  /**
   * rec_cff9nmm7trmh, 2026-09-06, exactly as it sits in Robert's IndexedDB.
   * 47 minutes of screen + tab audio; the editor opened 553.6 minutes with the
   * sound 8 h 27 min after the picture.
   */
  const robert = rec([
    ch('c-screen', 'screen', 'video', 0, 2_768_642),
    ch('c-sysaudio', 'system-audio', 'audio', 30_445_691, 2_768_680),
  ])

  it('is 553.6 minutes before the repair', () => {
    expect(robert.durationMs / 60_000).toBeCloseTo(553.6, 1)
  })

  it('names the audio channel and nothing else', () => {
    const repairs = findPlacementRepairs(robert)
    expect(repairs).toHaveLength(1)
    expect(repairs[0]!.kind).toBe('system-audio')
    expect(repairs[0]!.wasMs).toBe(30_445_691)
  })

  it('opens as the 46-minute take it is', () => {
    const fixed = repairPlacement(robert)
    expect(fixed.durationMs / 60_000).toBeCloseTo(46.1, 1)
    expect(fixed.channels.find((c) => c.kind === 'system-audio')!.startOffsetMs).toBe(0)
    // The picture never moved.
    expect(fixed.channels.find((c) => c.kind === 'screen')!.startOffsetMs).toBe(0)
    expect(fixed.channels.every((c) => c.durationMs === robert.channels.find((o) => o.id === c.id)!.durationMs)).toBe(true)
  })

  it('leaves a healthy take alone, object identity included', () => {
    const healthy = rec([
      ch('a', 'screen', 'video', 0, 509_136),
      ch('b', 'system-audio', 'audio', 59, 509_160),
    ])
    expect(findPlacementRepairs(healthy)).toEqual([])
    expect(repairPlacement(healthy)).toBe(healthy)
  })

  /**
   * H1's containment: a channel dies at minute 44 and its replacement segment
   * opens at minute 50 of a 90-minute take. That channel starts long after its
   * OWN earlier segment ended and it is entirely real — the screen was still
   * recording — so the rule must not touch it. These are rec_6kzwnfhp68yl's
   * own numbers.
   */
  it('leaves a mid-take segment alone', () => {
    const segmented = rec([
      ch('s', 'screen', 'video', 44, 5_423_505),
      ch('a1', 'system-audio', 'audio', 0, 5_423_520),
      ch('m1', 'mic', 'audio', 14, 2_660_750),
      ch('m2', 'mic', 'audio', 2_991_919, 231_300),
      ch('m3', 'mic', 'audio', 3_922_178, 793_070),
      ch('m4', 'mic', 'audio', 5_365_133, 58_400),
    ])
    expect(findPlacementRepairs(segmented)).toEqual([])
  })

  it('will not judge a single-channel take — there is no second witness', () => {
    const alone = rec([ch('only', 'screen', 'video', 900_000, 1000)])
    expect(findPlacementRepairs(alone)).toEqual([])
  })

  it('puts the broken channel where the take starts, not where zero is', () => {
    const fixed = repairPlacement(
      rec([
        ch('a', 'screen', 'video', 100, 60_000),
        ch('b', 'mic', 'audio', 140, 60_000),
        ch('c', 'system-audio', 'audio', 9_000_000, 60_000),
      ]),
    )
    // It lands on the earliest channel anyone still believes (100), and the
    // rebase then makes that the take's zero. The other two keep their 40 ms.
    expect(fixed.channels.map((c) => c.startOffsetMs)).toEqual([0, 40, 0])
    expect(fixed.durationMs).toBe(60_040)
  })
})
