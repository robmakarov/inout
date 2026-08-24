import { describe, expect, it } from 'vitest'
import type { EditState, Recording } from '@core/types'
import { buildIndexLines } from './indexText'

const recording: Recording = {
  id: 'r1',
  createdAt: 0,
  durationMs: 20_000,
  channels: [
    {
      id: 'c-screen',
      kind: 'screen',
      media: 'video',
      mimeType: 'video/webm;codecs=vp9',
      blobKey: 'k1',
      startOffsetMs: 0,
      durationMs: 20_000,
      width: 1920,
      height: 1080,
    },
    {
      id: 'c-mic',
      kind: 'mic',
      media: 'audio',
      mimeType: 'audio/webm;codecs=opus',
      blobKey: 'k2',
      startOffsetMs: 240,
      durationMs: 19_760,
    },
  ],
  stalled: ['screen'],
}

const edit: EditState = {
  recordingId: 'r1',
  globalTrimStartMs: 0,
  globalTrimEndMs: 20_000,
  channels: [
    { channelId: 'c-screen', enabled: true, trimStartMs: 0, trimEndMs: 20_000 },
    { channelId: 'c-mic', enabled: false, trimStartMs: 0, trimEndMs: 19_760 },
  ],
  segments: [
    { startMs: 0, endMs: 5_000 },
    { startMs: 9_000, endMs: 20_000, speed: 2 },
  ],
}

const lines = (): string[] =>
  buildIndexLines({
    recording,
    edit,
    keyframes: [
      { atRecMs: 0, page: 2, hasCrop: false, atCursor: false },
      { atRecMs: 12_500, page: 3, hasCrop: true, atCursor: true },
    ],
    trail: [{ atRecMs: 1_000, xFrac: 0.34, yFrac: 0.55 }],
    width: 1024,
    height: 576,
    sampleFps: 4,
    approxTokens: 1620,
    clockOffsetMs: 0,
  })

describe('index page', () => {
  it('states the clock it uses, because assuming one is the P0', () => {
    expect(lines()[2]).toContain('recording epoch')
    expect(lines()[2]).toContain('offset 0ms')
  })

  it('lists every channel with its own window on that clock', () => {
    const text = lines().join('\n')
    expect(text).toContain('  screen 0.00-20.00s 1920x1080')
    expect(text).toContain('  mic 0.24-20.00s')
  })

  it('says what the edit removed, so absent content is explained and not a gap', () => {
    const text = lines().join('\n')
    expect(text).toContain('cut: 5.00-9.00s removed')
    expect(text).toContain('speed 2x on 9.00-20.00s')
    expect(text).toContain('mic channel switched off')
  })

  it('surfaces capture facts a viewer could only guess at', () => {
    expect(lines().join('\n')).toContain('stalled mid-take')
  })

  it('is a table an agent can page from: time, page number, what is on it', () => {
    const text = lines().join('\n')
    expect(text).toContain('keyframes 2 (~1.6k tokens total)')
    expect(text).toContain('  p2 t=0.00s')
    expect(text).toContain('  p3 t=12.50s crop at cursor')
  })

  it('logs the pointer trail at low rate, in fractions', () => {
    expect(lines().join('\n')).toContain('1.00@0.34,0.55')
  })

  it('stays inside the token budget it exists to protect', () => {
    // ~200 tokens at 4 chars per token.
    expect(lines().join(' ').length).toBeLessThan(900)
  })
})
