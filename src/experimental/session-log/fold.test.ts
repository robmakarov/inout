import { describe, expect, it } from 'vitest'
import type { Recording } from '@core/types'
import { chainHash, GENESIS_HASH, verifyChain, type FactBody, type SessionFact } from './facts'
import { diffAgainstRecording, foldSession, summarizeDiff } from './fold'

/** Build a valid chained fact sequence from bodies at given times. */
function makeFacts(entries: { atMs: number; body: FactBody }[]): SessionFact[] {
  const facts: SessionFact[] = []
  let prev = GENESIS_HASH
  let epoch: number | null = null
  entries.forEach(({ atMs, body }, seq) => {
    if (body.kind === 'state' && body.state === 'recording' && epoch === null) epoch = atMs
    const hash = chainHash(prev, seq, atMs, body)
    prev = hash
    facts.push({ v: 1, seq, atMs, relMs: epoch === null ? null : atMs - epoch, body, hash })
  })
  return facts
}

function sessionFixture(): SessionFact[] {
  return makeFacts([
    {
      atMs: 1000,
      body: {
        kind: 'log-opened',
        config: { screen: true, camera: true, mic: true, systemAudio: false },
        synthetic: true,
      },
    },
    { atMs: 1001, body: { kind: 'channel-armed', channel: 'screen', media: 'video', width: 1280, height: 720 } },
    { atMs: 1002, body: { kind: 'channel-armed', channel: 'camera', media: 'video', width: 640, height: 480 } },
    { atMs: 1003, body: { kind: 'channel-armed', channel: 'mic', media: 'audio' } },
    { atMs: 2000, body: { kind: 'state', state: 'recording' } },
    { atMs: 2250, body: { kind: 'tick', elapsedMs: 250 } },
    { atMs: 4500, body: { kind: 'tick', elapsedMs: 2500 } },
    { atMs: 5010, body: { kind: 'state', state: 'stopping' } },
    { atMs: 5300, body: { kind: 'state', state: 'stopped' } },
    { atMs: 5301, body: { kind: 'stop-returned', recordingId: 'rec_x' } },
  ])
}

function recordingFixture(): Recording {
  return {
    id: 'rec_x',
    createdAt: 0,
    durationMs: 2950, // ~stop at rel 3010 minus ~60ms recorder startup normalization
    channels: [
      { id: 'c1', kind: 'screen', media: 'video', mimeType: 'video/webm', blobKey: 'b1', startOffsetMs: 0, durationMs: 2950, width: 1280, height: 720 },
      { id: 'c2', kind: 'camera', media: 'video', mimeType: 'video/webm', blobKey: 'b2', startOffsetMs: 12, durationMs: 2930, width: 640, height: 480 },
      { id: 'c3', kind: 'mic', media: 'audio', mimeType: 'audio/webm', blobKey: 'b3', startOffsetMs: 5, durationMs: 2940 },
    ],
  }
}

describe('session-log fold', () => {
  it('derives lifecycle, channels, and duration estimate from facts', () => {
    const folded = foldSession(sessionFixture())
    expect(folded.chainValid).toBe(true)
    expect(folded.synthetic).toBe(true)
    expect(folded.channels.map((c) => c.channel)).toEqual(['screen', 'camera', 'mic'])
    expect(folded.sawRecording && folded.sawStopping && folded.sawStopped).toBe(true)
    expect(folded.stoppingAtRelMs).toBe(3010)
    expect(folded.lastTickElapsedMs).toBe(2500)
    expect(folded.stopReturnedRecordingId).toBe('rec_x')
  })

  it('detects chain corruption', () => {
    const facts = sessionFixture()
    facts[4] = { ...facts[4], body: { kind: 'state', state: 'stopped' } } // tamper
    expect(verifyChain(facts)).toBe(4)
    expect(foldSession(facts).chainValid).toBe(false)
  })

  it('is replayable: same facts, same fold (purity)', () => {
    const facts = sessionFixture()
    expect(foldSession(facts)).toEqual(foldSession(facts))
  })
})

describe('differential comparison vs production Recording', () => {
  it('classifies fields: channels matched, duration approximate, offsets unobservable', () => {
    const diff = diffAgainstRecording(foldSession(sessionFixture()), recordingFixture())

    const by = (f: string) => diff.fields.find((x) => x.field === f)
    expect(by('channels')?.verdict).toBe('matched')

    const dur = by('durationMs')
    expect(dur?.verdict).toBe('approximate')
    expect(dur?.errorMs).toBeCloseTo(60, 5) // 3010 observed vs 2950 normalized

    expect(by('screen.dimensions')?.verdict).toBe('matched')
    expect(by('camera.dimensions')?.verdict).toBe('matched')

    expect(by('screen.startOffsetMs')?.verdict).toBe('unobservable')
    expect(diff.gaps.length).toBeGreaterThanOrEqual(4)
    expect(summarizeDiff(diff)).toContain('mismatch=0')
  })

  it('flags duration mismatch beyond tolerance', () => {
    const rec = { ...recordingFixture(), durationMs: 10_000 }
    const diff = diffAgainstRecording(foldSession(sessionFixture()), rec)
    expect(diff.fields.find((f) => f.field === 'durationMs')?.verdict).toBe('mismatched')
  })
})
