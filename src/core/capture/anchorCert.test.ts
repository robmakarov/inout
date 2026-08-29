import { describe, expect, it } from 'vitest'
import { buildCertification, certificationComment } from '@core/compose/certify'
import type { ChannelAnchor, Recording } from '@core/types'

/**
 * B7. The alignment inputs are INSTRUMENTATION, and these are the two
 * properties that keep them so.
 *
 * 1. THEY SURVIVE A RELOAD. They are persisted through recordingsRepo, which is
 *    IndexedDB, which stores by structured clone — so the only way they can be
 *    lost is by not being clonable. Pinned against `structuredClone` itself
 *    rather than a mock of it.
 * 2. THEY CANNOT REACH THE EXPORTED FILE. The certification is written into the
 *    container's comment tag, so anything that leaks into it changes every
 *    exported byte. B7 ships no behaviour change, and this is where that is
 *    enforced: the same take certifies IDENTICALLY with and without anchors.
 *    Whoever later decides the numbers SHOULD travel with the file (a real
 *    option — a field report is a file) has to delete this test on purpose,
 *    with Robert's yes, rather than discover it by a diff nobody expected.
 */
const anchor: ChannelAnchor = {
  rawAnchorMs: 185.2,
  reportedInputLatencyMs: 10,
  firstFrameDelayMs: 233.4,
}

function take(withAnchor: boolean): Recording {
  return {
    id: 'rec_b7',
    createdAt: 0,
    durationMs: 10_000,
    channels: [
      {
        id: 'ch_screen',
        kind: 'screen',
        media: 'video',
        mimeType: 'video/mp4',
        blobKey: 'k1',
        startOffsetMs: 0,
        durationMs: 10_000,
        ...(withAnchor ? { diagnostics: { anchor } } : {}),
      },
      {
        id: 'ch_mic',
        kind: 'mic',
        media: 'audio',
        mimeType: 'audio/webm',
        blobKey: 'k2',
        startOffsetMs: 20,
        durationMs: 9_980,
        ...(withAnchor ? { diagnostics: { paddedMs: 12, anchor } } : {}),
      },
    ],
  }
}

describe('B7 anchors', () => {
  it('survive the structured clone IndexedDB stores them with', () => {
    const round = structuredClone(take(true))
    expect(round.channels[0]!.diagnostics?.anchor).toEqual(anchor)
    expect(round.channels[1]!.diagnostics?.anchor).toEqual(anchor)
    // The neighbouring witness must not be disturbed by the new field.
    expect(round.channels[1]!.diagnostics?.paddedMs).toBe(12)
  })

  it('keep every value, including the zeros', () => {
    // A Bluetooth take whose platform reports NO latency is the finding, and an
    // absent field cannot state it. Zero must round-trip as zero, not vanish.
    const zeroed: ChannelAnchor = { rawAnchorMs: 0, reportedInputLatencyMs: 0, firstFrameDelayMs: 0 }
    const round = structuredClone({ anchor: zeroed })
    expect(round.anchor.reportedInputLatencyMs).toBe(0)
    expect(round.anchor.firstFrameDelayMs).toBe(0)
  })

  it('do NOT change one byte of the exported file', () => {
    const settings = { width: 1920, height: 1080 } as const
    const withAnchors = certificationComment(
      buildCertification({ recording: take(true), path: 'instant', settings, audioChannels: 2 }),
    )
    const without = certificationComment(
      buildCertification({ recording: take(false), path: 'instant', settings, audioChannels: 2 }),
    )
    expect(withAnchors).toBe(without)
    expect(withAnchors).not.toContain('anchor')
    expect(withAnchors).not.toContain('rawAnchorMs')
  })

  it('does not change the render path either', () => {
    const settings = { width: 1280, height: 720 } as const
    const a = certificationComment(
      buildCertification({ recording: take(true), path: 'render', settings, audioChannels: 1 }),
    )
    const b = certificationComment(
      buildCertification({ recording: take(false), path: 'render', settings, audioChannels: 1 }),
    )
    expect(a).toBe(b)
  })
})
