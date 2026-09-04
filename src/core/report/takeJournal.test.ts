import { afterEach, describe, expect, it } from 'vitest'
import type { ReportCard } from './reportCard'
import { __resetTakeReports, appendTakeReport, readTakeReports } from './takeJournal'

/**
 * The fleet has to survive the takes. Robert deletes recordings; the point of
 * S1 is the pattern ACROSS his days, so a verdict outlives the file it graded.
 */
afterEach(() => __resetTakeReports())

const card = (over: Partial<ReportCard> = {}): ReportCard => ({
  recordingId: 'rec_1',
  createdAt: 1_000,
  buildId: 'abc12345',
  durationMs: 12_000,
  verdict: 'green',
  line: 'rec_1 · 12.0s · GREEN — 10 of 10 dimensions measured and inside band.',
  dimensions: [{ id: 'channels', status: 'pass', detail: '2 channels' }],
  ...over,
})

describe('the take report journal', () => {
  it('keeps one line per take, oldest first, with the failing dimensions named', () => {
    appendTakeReport(card())
    appendTakeReport(
      card({
        recordingId: 'rec_2',
        createdAt: 2_000,
        verdict: 'red',
        dimensions: [
          { id: 'rescue', status: 'fail', detail: '6 revive bursts' },
          { id: 'channels', status: 'pass', detail: 'ok' },
        ],
      }),
    )
    expect(readTakeReports().map((e) => [e.id, e.verdict, e.failed])).toEqual([
      ['rec_1', 'green', undefined],
      ['rec_2', 'red', ['rescue']],
    ])
  })

  it('re-grading a take replaces its row instead of growing the log', () => {
    appendTakeReport(card())
    appendTakeReport(card({ verdict: 'red', line: 'regraded' }))
    expect(readTakeReports()).toHaveLength(1)
    expect(readTakeReports()[0].line).toBe('regraded')
  })

  it('is a ring — a year of daily takes cannot grow storage without limit', () => {
    for (let i = 0; i < 400; i++) appendTakeReport(card({ recordingId: `rec_${i}`, createdAt: i }))
    const all = readTakeReports()
    expect(all.length).toBeLessThanOrEqual(60)
    expect(all[all.length - 1].id).toBe('rec_399')
  })
})
