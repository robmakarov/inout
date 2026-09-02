import { describe, expect, it } from 'vitest'
import type { ChannelRecording, Recording } from '@core/types'
import { buildReportCard, reviveBursts, WARMUP_MS } from './reportCard'

/**
 * THE TAKE THIS INSTRUMENT EXISTS FOR.
 *
 * rec_78ogcw052vdn — 2026-09-01, 50.4 min, quality=max, screen 3024x1964@30,
 * camera + mic + tab audio. Its black box is quoted verbatim in
 * capture/reviveSchedule.ts, which was rewritten from it: 25 revive attempts in
 * six bursts, silentTailMs 1,650,144 of a 3,026,276 ms channel, the track live
 * and unmuted throughout, paddedMs 5,647. Robert found out by listening.
 *
 * The fixture is those numbers and nothing else. If the card cannot convict
 * this take, it cannot convict anything.
 */
const ATTEMPTS_S = [
  5.2, 10.2, 20.2, 40.2, 80.2, 160.2, 194.4, 199.4, 209.4, 229.4, 269.5, 349.5, 460.1, 465.1,
  475.1, 495.1, 535.1, 712.7, 1333.4, 1381.3, 1386.3, 1396.3, 1416.3, 1456.3, 1536.4,
]
const TAKE_MS = 3_026_276

const anchor = { rawAnchorMs: 0, reportedInputLatencyMs: 10 }

function ch(over: Partial<ChannelRecording> & Pick<ChannelRecording, 'kind' | 'media'>): ChannelRecording {
  return {
    id: `c_${over.kind}`,
    mimeType: over.media === 'audio' ? 'audio/webm;codecs=opus' : 'video/webm;codecs=vp9',
    blobKey: `b_${over.kind}`,
    startOffsetMs: 0,
    durationMs: TAKE_MS,
    bytes: 1_000_000,
    diagnostics: { anchor },
    ...over,
  } as ChannelRecording
}

function fiftyMinuteTake(): Recording {
  return {
    id: 'rec_78ogcw052vdn',
    createdAt: 1_756_700_000_000,
    durationMs: TAKE_MS,
    channels: [
      ch({ kind: 'screen', media: 'video', fps: 30, width: 3024, height: 1964, bytes: 1_138_000_000 }),
      ch({ kind: 'camera', media: 'video', fps: 30, width: 1920, height: 1080 }),
      ch({ kind: 'mic', media: 'audio', bytes: 48_000_000 }),
      ch({
        kind: 'system-audio',
        media: 'audio',
        bytes: 14_000_000,
        diagnostics: {
          anchor,
          paddedMs: 5_647,
          silentTailMs: 1_650_144,
          revivals: ATTEMPTS_S.length,
          events: ATTEMPTS_S.map((s) => ({ atMs: Math.round(s * 1000), type: 'revive' })),
        },
      }),
    ],
    qualityStep: 'max',
    stopStats: {
      requestedFps: 60,
      heapBytes: 900_000_000,
      heapLimitBytes: 4_000_000_000,
      storageUsageBytes: 2_000_000_000,
      storageQuotaBytes: 40_000_000_000,
    },
  }
}

/** A take where nothing went wrong, carrying every witness this build writes. */
function cleanTake(): Recording {
  const ms = 12_000
  const c = (over: Partial<ChannelRecording> & Pick<ChannelRecording, 'kind' | 'media'>) =>
    ch({ durationMs: ms, ...over })
  return {
    id: 'rec_clean',
    createdAt: 1_756_700_000_000,
    durationMs: ms,
    channels: [
      c({ kind: 'screen', media: 'video', fps: 60, width: 2560, height: 1440 }),
      c({ kind: 'mic', media: 'audio', diagnostics: { anchor, paddedMs: 40, silentTailMs: 120 } }),
    ],
    qualityStep: 'max',
    stopStats: {
      requestedFps: 60,
      heapBytes: 300_000_000,
      heapLimitBytes: 4_000_000_000,
      storageUsageBytes: 1_000_000_000,
      storageQuotaBytes: 40_000_000_000,
    },
  }
}

describe('revive bursts — the runs, not the attempt count', () => {
  it('regroups the 50-minute take’s 25 attempts into its six silent runs', () => {
    const bursts = reviveBursts(ATTEMPTS_S.map((s) => ({ atMs: s * 1000, type: 'revive' })))
    expect(bursts.map((b) => b.attempts)).toEqual([6, 6, 5, 1, 1, 6])
    expect(bursts).toHaveLength(6)
    // The runs reviveSchedule.ts names, to the second it names them at.
    expect(bursts.map((b) => Math.round(b.runStartMs / 100) / 10)).toEqual([
      0.2, 189.4, 455.1, 707.7, 1328.4, 1376.3,
    ])
  })

  it('keeps one long run under the CURRENT capped ladder as one burst', () => {
    // 5/10/20/40/80 then the 60 s cadence — reviveSchedule's own sequence.
    const at = [5, 10, 20, 40, 80, 140, 200, 260].map((s) => ({ atMs: s * 1000, type: 'revive' }))
    expect(reviveBursts(at)).toHaveLength(1)
    expect(reviveBursts(at)[0].attempts).toBe(8)
  })

  it('counts a refused attempt — a look at the channel is not free', () => {
    const at = [
      { atMs: 5_000, type: 'revive' },
      { atMs: 10_000, type: 'revive-failed' },
      { atMs: 20_000, type: 'revive' },
    ]
    expect(reviveBursts(at)[0].attempts).toBe(3)
  })

  it('is empty when the rescue never fired', () => {
    expect(reviveBursts([{ atMs: 10, type: 'mute' }])).toEqual([])
    expect(reviveBursts(undefined)).toEqual([])
  })
})

describe('the take report card', () => {
  it('convicts the 50-minute take: RED, tab audio, six bursts', () => {
    const card = buildReportCard(fiftyMinuteTake(), { wedgeJournal: [] })
    expect(card.verdict).toBe('red')
    expect(card.line).toContain('RED')
    // The dimension that decides it names the channel and what it lost.
    expect(card.line).toContain('tab audio')
    expect(card.line).toContain('6 revive bursts')
    const audio = card.dimensions.find((d) => d.id === 'audio-continuity')!
    expect(audio.status).toBe('fail')
    expect(audio.kinds).toEqual(['system-audio'])
    expect(audio.detail).toContain('54.5%')
    const rescue = card.dimensions.find((d) => d.id === 'rescue')!
    expect(rescue.status).toBe('fail')
    expect(rescue.detail).toContain('25 attempts')
    expect(rescue.detail).toContain('5 after warm-up')
  })

  it('grades the clock apart from the input — 5,647 ms of padding is not the fault', () => {
    const clock = buildReportCard(fiftyMinuteTake(), { wedgeJournal: [] }).dimensions.find(
      (d) => d.id === 'audio-clock',
    )!
    expect(clock.status).toBe('pass')
    expect(clock.detail).toContain('5647ms')
  })

  it('a clean take is GREEN, with every dimension measured', () => {
    const card = buildReportCard(cleanTake(), { wedgeJournal: [] })
    expect(card.dimensions.filter((d) => d.status !== 'pass')).toEqual([])
    expect(card.verdict).toBe('green')
    expect(card.line).toContain('GREEN')
    expect(card.line).not.toContain('Not measured')
  })

  it('never cries wolf: a take whose sound ended before the stop button', () => {
    // The 240 s take that made the user-facing banner learn this (channels.ts):
    // six quiet seconds at the end is a person reaching for stop.
    const take = cleanTake()
    take.durationMs = 240_000
    for (const c of take.channels) c.durationMs = 240_000
    take.channels[1].diagnostics = { anchor, silentTailMs: 6_000 }
    const card = buildReportCard(take, { wedgeJournal: [] })
    expect(card.verdict).toBe('green')
    expect(card.dimensions.find((d) => d.id === 'audio-continuity')!.detail).toContain('6000ms')
  })

  it('a take with no stop stats is INCOMPLETE, never green', () => {
    const take = cleanTake()
    delete take.stopStats
    const card = buildReportCard(take, { wedgeJournal: [] })
    expect(card.verdict).toBe('incomplete')
    expect(card.dimensions.find((d) => d.id === 'memory')!.status).toBe('unmeasured')
    expect(card.dimensions.find((d) => d.id === 'rate')!.status).toBe('unmeasured')
    expect(card.line).toContain('Not measured: rate, storage, memory')
  })

  it('an unsupplied wedge journal is unmeasured, not clean', () => {
    const card = buildReportCard(cleanTake())
    expect(card.dimensions.find((d) => d.id === 'wedges')!.status).toBe('unmeasured')
    expect(card.verdict).toBe('incomplete')
  })

  it('names a channel that was requested and never arrived', () => {
    const take = cleanTake()
    take.missing = ['system-audio']
    const card = buildReportCard(take, { wedgeJournal: [] })
    expect(card.verdict).toBe('red')
    expect(card.line).toContain('tab audio was requested and never delivered')
  })

  it('names a device that died mid-take (H4’s shape)', () => {
    const take = cleanTake()
    take.channels[1].durationMs = 4_000
    const card = buildReportCard(take, { wedgeJournal: [] })
    const ch0 = card.dimensions.find((d) => d.id === 'channels')!
    expect(ch0.status).toBe('fail')
    expect(ch0.detail).toContain('mic ended 8.0s before the take did')
  })

  it('a frozen source fails the picture, and says which', () => {
    const take = cleanTake()
    take.stalled = ['screen']
    const card = buildReportCard(take, { wedgeJournal: [] })
    expect(card.dimensions.find((d) => d.id === 'picture')!.status).toBe('fail')
    expect(card.line).toContain('screen froze mid-take')
  })

  /**
   * H1 — A KIND MADE OF SEVERAL SEGMENTS.
   *
   * Allowed since 08-23 (pause/resume, O16's resolution step, a contained
   * component death) and graded wrongly until H1: every segment was measured
   * against the take's length on its own, so segment 1 of a screen that ran
   * the whole take was convicted of ending early.
   */
  it('a channel in two abutting segments is NOT short — the kind lasted', () => {
    const take = cleanTake()
    take.channels = [
      { ...take.channels[0], id: 'c_screen_1', startOffsetMs: 0, durationMs: 6_000 },
      { ...take.channels[0], id: 'c_screen_2', startOffsetMs: 6_060, durationMs: 5_940 },
      take.channels[1],
    ]
    const ch0 = buildReportCard(take, { wedgeJournal: [] }).dimensions.find(
      (d) => d.id === 'channels',
    )!
    expect(ch0.status).toBe('pass')
  })

  it('but the LAST segment ending early still convicts the kind', () => {
    const take = cleanTake()
    take.channels = [
      { ...take.channels[0], id: 'c_screen_1', startOffsetMs: 0, durationMs: 3_000 },
      { ...take.channels[0], id: 'c_screen_2', startOffsetMs: 3_060, durationMs: 900 },
      take.channels[1],
    ]
    const ch0 = buildReportCard(take, { wedgeJournal: [] }).dimensions.find(
      (d) => d.id === 'channels',
    )!
    expect(ch0.status).toBe('fail')
    expect(ch0.detail).toContain('screen ended 8.0s before the take did')
  })

  it('a contained component death is certified, not graded green (H1)', () => {
    const take = cleanTake()
    take.channels = [
      { ...take.channels[0], id: 'c_screen_1', startOffsetMs: 0, durationMs: 6_000 },
      { ...take.channels[0], id: 'c_screen_2', startOffsetMs: 6_062, durationMs: 5_938 },
      take.channels[1],
    ]
    take.seams = [{ kind: 'screen', atMs: 6_000, gapMs: 62, cause: 'worker-death' }]
    const card = buildReportCard(take, { wedgeJournal: [] })
    const ch0 = card.dimensions.find((d) => d.id === 'channels')!
    expect(ch0.status).toBe('fail')
    expect(ch0.detail).toContain('screen survived a worker-death at 6.0s')
    expect(ch0.detail).toContain('62 ms missing there')
  })

  it('a take with no seams says nothing about them', () => {
    const ch0 = buildReportCard(cleanTake(), { wedgeJournal: [] }).dimensions.find(
      (d) => d.id === 'channels',
    )!
    expect(ch0.status).toBe('pass')
    expect(ch0.detail).not.toContain('survived')
  })

  it('a take that degraded to keep up fails the rate, naming what it gave up', () => {
    const take = cleanTake()
    take.stopStats = { ...take.stopStats, degradedWhy: 'the rate ladder stepped: backpressure' }
    const card = buildReportCard(take, { wedgeJournal: [] })
    expect(card.dimensions.find((d) => d.id === 'rate')!.status).toBe('fail')
    expect(card.line).toContain('the rate ladder stepped')
  })

  it('a wedge inside the take’s own window convicts it; one outside does not', () => {
    const take = cleanTake()
    const during = take.createdAt - 5_000
    expect(
      buildReportCard(take, { wedgeJournal: [{ t: during, kind: 'wedge' }] }).verdict,
    ).toBe('red')
    expect(
      buildReportCard(take, { wedgeJournal: [{ t: take.createdAt - 600_000, kind: 'wedge' }] })
        .verdict,
    ).toBe('green')
  })

  it('the WebKit audio path reads unmeasured, not passed', () => {
    const take = cleanTake()
    take.channels[1] = { ...take.channels[1], mimeType: 'audio/mp4', diagnostics: { anchor } }
    const card = buildReportCard(take, { wedgeJournal: [] })
    // The anchor is stamped for every lane, so sync still reads; the silence
    // counters are the measured path's and only it has them.
    expect(card.dimensions.find((d) => d.id === 'audio-continuity')!.status).toBe('unmeasured')
    expect(card.verdict).toBe('incomplete')
  })

  it('warm-up is what separates an arming tap from A1', () => {
    const take = cleanTake()
    take.durationMs = 600_000
    for (const c of take.channels) c.durationMs = 600_000
    const early = { ...take, channels: [...take.channels] }
    early.channels[1] = {
      ...take.channels[1],
      diagnostics: { anchor, events: [{ atMs: 5_000, type: 'revive' }] },
    }
    expect(buildReportCard(early, { wedgeJournal: [] }).dimensions.find((d) => d.id === 'rescue')!.status).toBe(
      'pass',
    )
    const late = { ...take, channels: [...take.channels] }
    late.channels[1] = {
      ...take.channels[1],
      diagnostics: { anchor, events: [{ atMs: WARMUP_MS + 30_000, type: 'revive' }] },
    }
    expect(buildReportCard(late, { wedgeJournal: [] }).dimensions.find((d) => d.id === 'rescue')!.status).toBe(
      'fail',
    )
  })
})
