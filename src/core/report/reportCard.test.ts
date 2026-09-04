import { describe, expect, it } from 'vitest'
import type { ChannelRecording, LatenessSummary, Recording } from '@core/types'
import { buildEditorCard, buildReportCard, reviveBursts, WARMUP_MS } from './reportCard'

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

/**
 * G7 — WHAT A QUIET MAIN THREAD READS LIKE. Shaped like a real 12 s reading:
 * 60 Hz of beats, nothing over a frame, the document hidden the whole way
 * (which is what a take is), and the sampler charging hundredths of a
 * millisecond per second for it.
 */
function quietLateness(): LatenessSummary {
  return {
    source: 'worker-beat',
    periodMs: 16,
    spanMs: 12_000,
    samples: 750,
    missed: 0,
    maxMs: 9.4,
    maxAtMs: 3_120,
    p50Ms: 0.4,
    p95Ms: 2.1,
    overFrame: 0,
    frameMs: 16.7,
    histogram: [700, 30, 12, 5, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    worstWindows: [{ startMs: 3_000, maxMs: 9.4, lateMs: 41.2, samples: 62 }],
    owners: [],
    hiddenRatio: 1,
    selfCostMsPerSec: 0.04,
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
      lateness: quietLateness(),
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
    // The dimension that decides it names the channel and what it lost. G6(g):
    // the headline used to lead with '6 revive bursts' — how hard we fought —
    // and now leads with the 27.5 minutes of sound that went missing.
    expect(card.line).toContain('tab audio')
    expect(card.line).toContain('27.5 min of 50.4 min')
    expect(card.line).not.toContain('revive bursts')
    const audio = card.dimensions.find((d) => d.id === 'audio-continuity')!
    expect(audio.status).toBe('fail')
    expect(audio.kinds).toEqual(['system-audio'])
    expect(audio.detail).toContain('54.5%')
    // G6(g): the take is convicted by what it LOST — 54.5 % of the channel gone
    // to digital zeros, above. The rescue dimension still reports its 25
    // attempts, but attempts no longer convict: nothing in this take's black box
    // says a rebuild ever brought the sound back, and a tap that stayed dead is
    // audio-continuity's fault to name, measured as its cost.
    const rescue = card.dimensions.find((d) => d.id === 'rescue')!
    expect(rescue.detail).toContain('25 attempts')
    expect(rescue.status).toBe('pass')
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

  it('E2: a take that shed the unseen work and got its rate back is GREEN', () => {
    // The ruling is about the ORDER, and a shed that recovered is elastic doing
    // its job. Failing it for that is the G6(g) defect one dimension over.
    const take = cleanTake()
    take.stopStats!.elastic = [
      { atMs: 8_000, layer: 'unseen', action: 'shed', what: 'background work full → paused', why: 'pressure serious' },
      { atMs: 8_400, layer: 'burst', action: 'shed', what: 'encoder burst absorber engaged (2 frames held)', why: 'encoder-queue' },
      { atMs: 8_900, layer: 'picture', action: 'shed', what: '60 → 30 fps (predicted)', why: 'pressure critical' },
      { atMs: 14_000, layer: 'picture', action: 'restore', what: '30 → 60 fps (predicted)', why: 'pressure clear' },
      { atMs: 14_200, layer: 'unseen', action: 'restore', what: 'background work paused → half', why: 'nominal' },
    ]
    const card = buildReportCard(take, { wedgeJournal: [] })
    const dim = card.dimensions.find((d) => d.id === 'elastic')!
    expect(dim.status).toBe('pass')
    expect(dim.detail).toContain('order held')
    expect(dim.detail).toContain('5.1 s')
    expect(card.verdict).toBe('green')
  })

  it('E2: a picture step taken while the free work was still running is RED', () => {
    const take = cleanTake()
    take.stopStats!.elastic = [
      { atMs: 9_000, layer: 'picture', action: 'shed', what: '60 → 30 fps (measured)', why: 'delivery floor' },
      { atMs: 9_500, layer: 'unseen', action: 'shed', what: 'background work full → paused', why: 'pressure serious' },
    ]
    const card = buildReportCard(take, { wedgeJournal: [] })
    const dim = card.dimensions.find((d) => d.id === 'elastic')!
    expect(dim.status).toBe('fail')
    expect(dim.headline).toContain('9.0 s')
    expect(card.verdict).toBe('red')
  })

  it('E2: a take that gave up nothing has nothing to grade, and passes', () => {
    const card = buildReportCard(cleanTake(), { wedgeJournal: [] })
    expect(card.dimensions.find((d) => d.id === 'elastic')!.status).toBe('pass')
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
    expect(card.line).toContain('Not measured: rate, storage, memory, lateness')
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

  it('a late revive is not a fault by itself — recovering sound is (G6(g))', () => {
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
    // A rebuild late in a take, into a source that stays quiet: the tab was
    // paused, nothing was lost, and this used to be an automatic red.
    const late = { ...take, channels: [...take.channels] }
    late.channels[1] = {
      ...take.channels[1],
      diagnostics: { anchor, events: [{ atMs: WARMUP_MS + 30_000, type: 'revive' }] },
    }
    expect(buildReportCard(late, { wedgeJournal: [] }).dimensions.find((d) => d.id === 'rescue')!.status).toBe(
      'pass',
    )
    // The same rebuild, with the sound coming back on the other side of it: the
    // source was playing all along and the tap was not hearing it.
    const dead = { ...take, channels: [...take.channels] }
    dead.channels[1] = {
      ...take.channels[1],
      diagnostics: {
        anchor,
        events: [
          { atMs: WARMUP_MS + 30_000, type: 'revive' },
          { atMs: WARMUP_MS + 30_400, type: 'revive-recovered' },
        ],
      },
    }
    const deadDim = buildReportCard(dead, { wedgeJournal: [] }).dimensions.find(
      (d) => d.id === 'rescue',
    )!
    expect(deadDim.status).toBe('fail')
    expect(deadDim.kinds).toEqual(['mic'])
    expect(deadDim.headline).toContain('the tap was dead while the source was playing')
  })

  /**
   * THE GATE FOR G6(g), and it is the take that made A1's gate 2 unreadable for
   * a day: rec_gpsoujs2sydf, 124.8 minutes, 63 revive attempts across 15 silent
   * runs, every one of them a quiet tab (Robert confirmed the silence was real).
   * The old dimension graded attempts and so it graded this RED. Nothing was
   * lost, so nothing may convict.
   */
  it('the 15-run quiet-tab take grades GREEN on rescue (G6(g) gate)', () => {
    const ms = 7_488_000 // 124.8 minutes
    const events: { atMs: number; type: string }[] = []
    // 15 silent runs, spread across the take, ~4 attempts each = 63, and not one
    // of them recovers anything: the tab simply had nothing playing.
    let n = 0
    for (let run = 0; run < 15; run++) {
      const start = 120_000 + run * 460_000
      for (let a = 0; a < (run < 3 ? 5 : 4) && n < 63; a++, n++) {
        events.push({ atMs: start + a * 6_000 * 2 ** a, type: 'revive' })
      }
    }
    expect(events.length).toBe(63)
    const take: Recording = {
      id: 'rec_gpsoujs2sydf',
      createdAt: 1_756_700_000_000,
      durationMs: ms,
      channels: [
        ch({ kind: 'screen', media: 'video', fps: 30, width: 2560, height: 1440, durationMs: ms }),
        ch({
          kind: 'system-audio',
          media: 'audio',
          durationMs: ms,
          // A quiet tab is silent at the end too, and that is honest: the tail
          // band is audio-continuity's, and it is under it here.
          diagnostics: { anchor, silentTailMs: 4_000, revivals: 63, events },
        }),
      ],
    }
    const rescue = buildReportCard(take, { wedgeJournal: [] }).dimensions.find(
      (d) => d.id === 'rescue',
    )!
    expect(rescue.status).toBe('pass')
    expect(rescue.detail).toContain('63 attempts')
    expect(rescue.detail).toContain('no audio was lost')
  })
})

/**
 * G7 — THE DIMENSION B10 IS PROVED AGAINST.
 *
 * The numbers in the RED case are B10's own, measured by
 * scripts/editor-drag-cost.mjs before this instrument existed: drag stalls of
 * 35-201 ms, 0.4-0.7 s into a drag, all of them inside the window where the
 * export panel encodes 300 frames on the main thread.
 */
describe('G7: main-thread lateness', () => {
  const stalled = (over: Partial<LatenessSummary> = {}): LatenessSummary => ({
    ...quietLateness(),
    spanMs: 15_000,
    samples: 890,
    maxMs: 201.4,
    maxAtMs: 11_420,
    p95Ms: 4.8,
    overFrame: 12,
    hiddenRatio: 0,
    worstWindows: [
      { startMs: 11_000, maxMs: 201.4, lateMs: 402.6, samples: 48 },
      { startMs: 12_000, maxMs: 35.2, lateMs: 61.4, samples: 60 },
    ],
    owners: [
      { atMs: 11_210, durationMs: 201.9, blockingMs: 198.4, name: 'sizeProbe.js encodeFrame()' },
    ],
    ...over,
  })

  it('grades the take’s card, in ms, with the worst window’s start', () => {
    const take = cleanTake()
    take.stopStats!.lateness = stalled({ hiddenRatio: 1, owners: [] })
    const dim = buildReportCard(take, { wedgeJournal: [] }).dimensions.find(
      (d) => d.id === 'lateness',
    )!
    expect(dim.status).toBe('fail')
    expect(dim.detail).toContain('worst second at 11.0s')
    expect(dim.detail).toContain('201.4 ms')
    // The strict reading survives on a card whatever the band does.
    expect(dim.detail).toContain('12 of 890 samples over one frame')
    // A hidden document explains its own missing attribution rather than
    // leaving a gap that reads like a broken instrument.
    expect(dim.detail).toContain('no task attribution')
  })

  it('B10 as a number on the editor’s card, with the task that owns it', () => {
    const card = buildEditorCard(stalled(), 'rec_clean')
    expect(card.verdict).toBe('red')
    expect(card.line).toContain('201.4 ms late at 11.0s')
    expect(card.line).toContain('sizeProbe.js encodeFrame()')
    // Blocking time first: what a stall is made of, not how long the frame was.
    expect(card.dimensions[0].detail).toContain(
      'worst task: sizeProbe.js encodeFrame() 198.4 ms blocking of 201.9 ms at 11.2s',
    )
  })

  it('a quiet editor is GREEN and says what it sampled', () => {
    const card = buildEditorCard({ ...quietLateness(), hiddenRatio: 0 })
    expect(card.verdict).toBe('green')
    expect(card.dimensions[0].detail).toContain('sampled every 16 ms by worker-beat')
  })

  it('30 ms is the band, and it is the Phase-1 claim', () => {
    const under = buildEditorCard(
      stalled({ worstWindows: [{ startMs: 1_000, maxMs: 30, lateMs: 44, samples: 60 }] }),
    )
    const over = buildEditorCard(
      stalled({ worstWindows: [{ startMs: 1_000, maxMs: 30.1, lateMs: 44, samples: 60 }] }),
    )
    expect(under.verdict).toBe('green')
    expect(over.verdict).toBe('red')
  })

  it('a clamped fallback reading is UNMEASURED, never a failure', () => {
    // The trap this whole instrument is shaped around: a main-thread timer on a
    // hidden document reads Chrome's ~1 Hz throttle. Grading it would convict
    // every backgrounded take ever recorded.
    const card = buildEditorCard(
      stalled({ source: 'timer', clamped: true, maxMs: 984, hiddenRatio: 1 }),
    )
    expect(card.dimensions[0].status).toBe('unmeasured')
    expect(card.verdict).toBe('incomplete')
    expect(card.dimensions[0].detail).toContain('not graded')
  })

  it('missed beats turn every number into a floor, and say so', () => {
    const card = buildEditorCard(stalled({ missed: 37 }))
    expect(card.dimensions[0].detail).toContain('37 beats never arrived')
  })

  it('no reading at all is unmeasured — a take before G7 never passes it', () => {
    const take = cleanTake()
    delete take.stopStats!.lateness
    const card = buildReportCard(take, { wedgeJournal: [] })
    expect(card.dimensions.find((d) => d.id === 'lateness')!.status).toBe('unmeasured')
    expect(card.verdict).toBe('incomplete')
  })
})

/**
 * P9/O4 — WHICH MACHINERY MADE THE COMPOSITE, ON THE CARD.
 *
 * The intake and the painter are both chosen at runtime by probe and both fall
 * through to a rung below when a machine cannot honour them. A card that does
 * not name them cannot notice one rung behaving differently from another, which
 * is the only enforcement "a silent difference between rungs is a defect" has
 * after the take is over.
 */
describe('the picture line names what made the composite', () => {
  function withComposite(over: Record<string, unknown>): Recording {
    const take = fiftyMinuteTake()
    take.composite = {
      blobKey: 'b_composite',
      mimeType: 'video/mp4',
      durationMs: TAKE_MS,
      width: 1920,
      height: 1080,
      engine: 'v2',
      ...over,
    } as Recording['composite']
    return take
  }
  const picture = (take: Recording): string =>
    buildReportCard(take).dimensions.find((d) => d.id === 'picture')?.detail ?? ''

  it('names the rung and the backend that ran', () => {
    const detail = picture(withComposite({ intake: 'element-sampler', painter: 'webgpu' }))
    expect(detail).toContain('composed by element-sampler into webgpu')
  })

  /**
   * J6 — THE SAME LINE ON A TAKE WITH NO FILE.
   *
   * The glued copy is painted and not encoded on the shipped default, so most
   * takes carry no CompositeRecording at all. The rung and the backend would
   * have disappeared with it; they come out of `stopStats.glue` instead, and
   * the line says the file was never written rather than implying one.
   */
  it('names the rung and the backend on a painted-only take', () => {
    const take = fiftyMinuteTake()
    take.stopStats = {
      ...take.stopStats,
      glue: {
        recorded: false,
        engine: 'v2',
        intake: 'main-processor',
        painter: 'webgpu',
        framesPainted: 1234,
      },
    }
    const detail = picture(take)
    expect(detail).toContain('composed by main-processor into webgpu')
    expect(detail).toContain('painted only (1234 frames)')
    expect(detail).toContain('no composite file was written')
  })

  it('says a take was recorded before the fields existed instead of guessing', () => {
    const detail = picture(withComposite({}))
    expect(detail).toContain('an unrecorded intake')
    expect(detail).toContain('an unrecorded painter')
  })

  it('says nothing about machinery on a take that opened no compositor', () => {
    expect(picture(fiftyMinuteTake())).not.toContain('composed by')
  })
})

describe('audio that dies in the MIDDLE of a take is convicted', () => {
  /**
   * THE CASE THIS WAS WRITTEN FOR, and the case it used to pass. Robert's
   * 71.7-minute take (`rec_yx4mi1or851p`, 2026-09-04) lost its tab audio at
   * 52.5 min and never got it back; its `silentTailMs` read 1840 ms, because a
   * revive delivered one batch near the end and the open run started again from
   * zero. `audio-continuity` graded it PASS at "0.0%".
   */
  const channel = (diagnostics: Record<string, number>) => ({
    id: 'ch_tab',
    kind: 'sysaudio' as const,
    media: 'audio' as const,
    mimeType: 'audio/webm',
    blobKey: 'k',
    startOffsetMs: 0,
    durationMs: 4_300_000,
    silentTailMs: diagnostics.silentTailMs,
    diagnostics,
  })

  const take = (diagnostics: Record<string, number>) =>
    buildReportCard({
      id: 'rec_yx4mi1or851p',
      createdAt: 1,
      durationMs: 4_300_000,
      channels: [channel(diagnostics)],
    } as never)

  const continuity = (card: ReturnType<typeof buildReportCard>) =>
    card.dimensions.find((d) => d.id === 'audio-continuity')!

  it('FAILS a channel silent for a quarter of the take with a tiny tail', () => {
    const d = continuity(take({ silentTailMs: 1_840, silentTotalMs: 1_150_000 }))
    expect(d.status).toBe('fail')
    expect(d.headline).toMatch(/spread through the take, not only at the end/)
    expect(d.headline).toMatch(/unbroken tail was just/)
  })

  it('still passes a healthy channel', () => {
    expect(continuity(take({ silentTailMs: 120, silentTotalMs: 400 })).status).toBe('pass')
  })

  it('reads the tail exactly as before on a take made without the new counter', () => {
    // Absent silentTotalMs: the old arithmetic, so an old take is graded the
    // way it was graded when it was made.
    expect(continuity(take({ silentTailMs: 1_840 })).status).toBe('pass')
    expect(continuity(take({ silentTailMs: 2_000_000 })).status).toBe('fail')
  })

  it('notes scattered silence even when it is under the band', () => {
    const d = continuity(take({ silentTailMs: 100, silentTotalMs: 30_000 }))
    expect(d.status).toBe('pass')
    expect(d.detail).toMatch(/silent in total/)
  })
})
