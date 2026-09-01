import { describe, expect, it } from 'vitest'
import { SourceLiveness, SOURCE_NEVER_DELIVERED_MS } from './sourceLiveness'
import { parseDeadChannels, parseDyingChannels } from './synthetic'
import { deadChannelMessage, endedChannelMessage, lostChannelsMessages } from '@app/lib/channels'
import type { Capabilities } from '@core/capabilities'
import type { ChannelLoss, Recording } from '@core/types'
import { buildReportCard } from '@core/report/reportCard'

/**
 * H4 / B4 — A CHANNEL THAT RECORDED NOTHING, AND ONE THAT DIED HALFWAY.
 *
 * The distinction the whole task turns on: a STATIC screen delivers its first
 * frame and then goes quiet, and a SENSOR-OFF camera delivers nothing ever.
 * The browser calls both healthy (`muted` stays false), so `muted` — the
 * disambiguator the frozen-source detector was rebuilt around on 2026-08-25 —
 * cannot separate them. The frame count can, and it is the only thing that can.
 */

/** Sample every 33 ms for `ms`, with no frame ever delivered. */
function silentRun(det: SourceLiveness, ms: number, opts: { delivered: boolean }) {
  const out: { t: number; ev: string }[] = []
  for (let t = 0; t <= ms; t += 33) {
    // The browser's verdict is HEALTHY throughout — that is the whole point.
    const ev = det.sample(t, 0, true, opts.delivered)
    if (ev) out.push({ t, ev })
  }
  return out
}

describe('never-delivered detection', () => {
  it('calls a source that has never delivered a frame dead, once', () => {
    const det = new SourceLiveness()
    const edges = silentRun(det, 10_000, { delivered: false })
    expect(edges.map((e) => e.ev)).toEqual(['dead'])
    expect(edges[0]!.t).toBeGreaterThanOrEqual(SOURCE_NEVER_DELIVERED_MS)
    // and not a millisecond of hair-trigger: one sample earlier is still quiet.
    expect(edges[0]!.t).toBeLessThan(SOURCE_NEVER_DELIVERED_MS + 100)
    expect(det.stalled).toBe(true)
  })

  it('says NOTHING about a static screen that delivered its first frame', () => {
    // This is the regression the 2026-08-25 rebuild exists to prevent, and the
    // case the new rule must not touch: frames delivered, media clock frozen,
    // browser healthy. Ten seconds of it, silent.
    const det = new SourceLiveness()
    expect(silentRun(det, 10_000, { delivered: true })).toEqual([])
    expect(det.stalled).toBe(false)
  })

  it('is not healed by the browser calling the source healthy', () => {
    // A dead camera's track is live and unmuted for the whole take. If the
    // browser's word could clear the flag, the banner would flicker on and off
    // for an hour instead of staying said.
    const det = new SourceLiveness()
    const edges = silentRun(det, 60_000, { delivered: false })
    expect(edges).toHaveLength(1)
  })

  it('is healed by an actual frame', () => {
    const det = new SourceLiveness()
    expect(silentRun(det, 6_000, { delivered: false }).map((e) => e.ev)).toEqual(['dead'])
    expect(det.sample(6_100, 0.033, true, true)).toBe('resumed')
    expect(det.stalled).toBe(false)
  })

  it('defaults to delivered, so a caller with no frame count can never raise it', () => {
    const det = new SourceLiveness()
    const out: string[] = []
    for (let t = 0; t <= 20_000; t += 33) {
      const ev = det.sample(t, 0, true)
      if (ev) out.push(ev)
    }
    expect(out).toEqual([])
  })
})

describe('the repro knobs', () => {
  it('?dead= names video kinds only — a silent audio source is a different failure', () => {
    expect([...parseDeadChannels('?dead=camera')]).toEqual(['camera'])
    expect([...parseDeadChannels('?dead=screen,camera')]).toEqual(['screen', 'camera'])
    expect([...parseDeadChannels('?dead=mic')]).toEqual([])
    expect([...parseDeadChannels('?synthetic=1')]).toEqual([])
  })

  it('?die= takes every kind with a millisecond offset from the press', () => {
    expect([...parseDyingChannels('?die=camera:20000')]).toEqual([['camera', 20000]])
    expect([...parseDyingChannels('?die=mic:6000,screen:1000')]).toEqual([
      ['mic', 6000],
      ['screen', 1000],
    ])
    expect([...parseDyingChannels('?die=camera:nope')]).toEqual([])
    expect([...parseDyingChannels('?die=nothing:100')]).toEqual([])
  })
})

const CAPS = { displayAudioScope: 'tab' } as unknown as Capabilities

describe('what the user is told', () => {
  it('does not tell a dead camera to re-share the screen', () => {
    const msg = deadChannelMessage(['camera'], CAPS)
    expect(msg).toContain('Camera')
    expect(msg).not.toContain('re-share')
    expect(msg).not.toContain('still image')
  })

  it('names the instant a channel died and how much ran on without it', () => {
    const lost: ChannelLoss[] = [{ kind: 'mic', atMs: 2_400_000, reason: 'ended', lostMs: 600_000 }]
    expect(lostChannelsMessages(lost, CAPS)[0]!.message).toBe(
      'Mic stopped at 40:00 and the take ran on for another 10:00 without it.',
    )
  })

  it('says a never-delivered channel is simply not in the take', () => {
    const lost: ChannelLoss[] = [
      { kind: 'camera', atMs: 0, reason: 'never-delivered', lostMs: 900_000 },
    ]
    const msg = lostChannelsMessages(lost, CAPS)[0]!.message
    expect(msg).toContain('recorded nothing')
    // No instant: there was no moment at which it went bad.
    expect(msg).not.toContain('0:00')
  })

  it('names several dead or ended channels in one line', () => {
    expect(endedChannelMessage(['mic', 'camera'], CAPS)).toContain('Mic & Camera have stopped')
    expect(deadChannelMessage(['screen', 'camera'], CAPS)).toContain('Screen & Camera are')
  })
})

/**
 * MEASURED ON PROD 2026-09-01, BEFORE ANY OF THIS EXISTED: a 45 s take whose
 * camera delivered nothing read `GREEN — 10 of 10 dimensions measured and
 * inside band`. Not missing (the file exists — 28 bytes of container on the
 * real device), not short (a dead source still stamps a full duration), so
 * every dimension passed it honestly and the verdict was still wrong.
 */
describe('the report card cannot call a take with a dead channel green', () => {
  const base = (over: Partial<Recording>): Recording => ({
    id: 'rec_test',
    createdAt: 0,
    durationMs: 45_000,
    channels: [
      {
        id: 'c1',
        kind: 'camera',
        media: 'video',
        mimeType: 'video/mp4',
        blobKey: 'k1',
        startOffsetMs: 0,
        durationMs: 45_000,
        bytes: 28,
      },
      {
        id: 'c2',
        kind: 'mic',
        media: 'audio',
        mimeType: 'audio/webm',
        blobKey: 'k2',
        startOffsetMs: 0,
        durationMs: 45_000,
        bytes: 300_000,
        diagnostics: { silentTailMs: 0, paddedMs: 0, revivals: 0 },
      },
    ],
    ...over,
  })

  it('fails the channels dimension on a never-delivered camera', () => {
    const card = buildReportCard(
      base({ lost: [{ kind: 'camera', atMs: 0, reason: 'never-delivered', lostMs: 45_000 }] }),
    )
    const ch = card.dimensions.find((d) => d.id === 'channels')!
    expect(ch.status).toBe('fail')
    expect(ch.detail).toContain('delivered no frames')
    expect(card.verdict).not.toBe('green')
  })

  it('names the instant on a channel that died mid-take', () => {
    const card = buildReportCard(
      base({ lost: [{ kind: 'mic', atMs: 30_000, reason: 'ended', lostMs: 15_000 }] }),
    )
    const ch = card.dimensions.find((d) => d.id === 'channels')!
    expect(ch.status).toBe('fail')
    expect(ch.detail).toMatch(/died at .*30/)
  })

  it('still passes a take that lost nothing', () => {
    const card = buildReportCard(base({}))
    expect(card.dimensions.find((d) => d.id === 'channels')!.status).toBe('pass')
  })
})
