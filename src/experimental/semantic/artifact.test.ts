import { describe, expect, it } from 'vitest'
import type { EditState, Recording } from '@core/types'
import { defaultEditState } from '@core/timeline'
import { fakeTranscriber, searchTranscript, silenceGaps, type TranscriptArtifact } from './artifact'

function rec(): Recording {
  return {
    id: 'rec_sem',
    createdAt: 0,
    durationMs: 10_000,
    channels: [
      {
        id: 'ch_mic',
        kind: 'mic',
        media: 'audio',
        mimeType: 'audio/webm',
        blobKey: 'k',
        startOffsetMs: 500,
        durationMs: 9500,
      },
    ],
  }
}

async function makeArtifact(): Promise<TranscriptArtifact> {
  const sr = 16_000
  const audio = new Float32Array(sr * 4) // 4s of "speech"
  const words = await fakeTranscriber().transcribe(audio, sr)
  return { v: 1, recordingId: 'rec_sem', channelId: 'ch_mic', engine: 'fake', words }
}

describe('semantic artifact', () => {
  it('fake transcriber is deterministic and time-structured', async () => {
    const a = await makeArtifact()
    expect(a.words).toHaveLength(10) // 4000ms / 400ms
    expect(a.words[3]).toEqual({ text: 'word3', startMs: 1200, endMs: 1400, confidence: 1 })
  })

  it('search maps channel-local word times to output time via startOffset', async () => {
    const a = await makeArtifact()
    const r = rec()
    const e = defaultEditState(r)
    const hits = searchTranscript(a, r, e, 'word3')
    expect(hits).toHaveLength(1)
    // channel-local 1200ms + startOffset 500ms = recording/output 1700ms.
    expect(hits[0].outStartMs).toBe(1700)
  })

  it('trimmed-away words drop out of search results', async () => {
    const a = await makeArtifact()
    const r = rec()
    const e: EditState = {
      ...defaultEditState(r),
      globalTrimStartMs: 2000, // output starts at recording 2000ms
      globalTrimEndMs: 10_000,
    }
    // word3 sits at recording 1700ms -> trimmed away.
    expect(searchTranscript(a, r, e, 'word3')).toHaveLength(0)
    // word5: local 2000ms -> recording 2500ms -> output 500ms.
    const hits = searchTranscript(a, r, e, 'word5')
    expect(hits).toHaveLength(1)
    expect(hits[0].outStartMs).toBe(500)
  })

  it('empty query returns nothing; substring match works', async () => {
    const a = await makeArtifact()
    const r = rec()
    const e = defaultEditState(r)
    expect(searchTranscript(a, r, e, '  ')).toHaveLength(0)
    expect(searchTranscript(a, r, e, 'word').length).toBe(10)
  })

  it('silenceGaps finds inter-word gaps for a future tighten pass', async () => {
    const a = await makeArtifact()
    const gaps = silenceGaps(a, 150)
    expect(gaps).toHaveLength(9) // 200ms between every pair of fake words
    expect(gaps[0]).toEqual({ startMs: 200, endMs: 400 })
  })
})
