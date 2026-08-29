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
    sampleFps: 8,
    budgetSpent: false,
    approxTokens: 1620,
    clockOffsetMs: 0,
  })

describe('index page', () => {
  // Robert's first real test: the AI opened the file and ASKED WHAT TO DO WITH IT.
  // A reader that cannot tell what a document is cannot use it, so these three
  // are the load-bearing lines of the whole export.
  it('says what the file IS in its first line, before any machine fact', () => {
    const first = lines()[0]!
    expect(first).toContain('SCREEN RECORDING')
    expect(first).toMatch(/\d+\.\d+ seconds/)
    expect(first).toContain('2 frames')
  })

  it('says what the pages after it are, and that they are one recording in order', () => {
    const head = lines().slice(0, 5).join(' ')
    expect(head).toContain('frames from ONE screen recording, in time order')
    expect(head).toContain('not a slide deck')
    expect(head).toContain('no video to play')
  })

  it('tells a reader arriving with no instructions what to do', () => {
    const text = lines().join(' ')
    expect(text).toContain('HOW TO READ IT')
    expect(text).toContain('NO OTHER INSTRUCTION')
    expect(text).toContain('describe what happens in the recording')
    // And why the times are spaced the way they are — a jump is not a loss,
    // and a fast run is an animation the reader can reproduce.
    expect(text).toContain('FRAME SPACING IS NOT EVEN')
    expect(text).toContain('nothing is missing there')
  })

  it('states the clock it uses, because assuming one is the P0', () => {
    const text = lines().join('\n')
    expect(text).toContain('times are seconds from the start of the recording')
    expect(text).toContain('offset 0ms')
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
    expect(lines().join('\n')).toContain('froze mid-take')
  })

  it('is a table an agent can page from: time, page number, what is on it', () => {
    const text = lines().join('\n')
    expect(text).toContain('THE FRAMES - 2 of them')
    expect(text).toContain('  page 2   t=0.00s')
    expect(text).toContain('  page 3   t=12.50s   close-up of the change included, change at the pointer')
  })

  it('logs the pointer trail at low rate, in fractions', () => {
    expect(lines().join('\n')).toContain('1.00@0.34,0.55')
  })

  it('keeps the whole index inside a page image’s worth of tokens', () => {
    // The briefing costs ~120 tokens and bought a reader that knows what the
    // file is; the ceiling that matters is one page image (~800 tokens).
    expect(lines().join(' ').length / 4).toBeLessThan(800)
  })
})
