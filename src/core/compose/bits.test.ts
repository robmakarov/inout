import { describe, expect, it } from 'vitest'
import { BitsAudit, formatBits, summarizeBits } from './bits'

describe('bits audit', () => {
  it('splits keyframe bytes out of the video total', () => {
    const a = new BitsAudit(8_000_000, 2)
    a.video(100_000, 'key')
    a.video(10_000, 'delta')
    a.video(10_000, 'delta')
    a.audio(4_000)
    const s = a.summarize(1)
    expect(s.videoBytes).toBe(120_000)
    expect(s.keyframeBytes).toBe(100_000)
    expect(s.keyframeSharePct).toBe(83.3)
    expect(s.meanKeyframeBytes).toBe(100_000)
    expect(s.meanDeltaBytes).toBe(10_000)
    expect(s.audioBytes).toBe(4_000)
  })

  it('prices the achieved bitrate against the requested ceiling', () => {
    const s = summarizeBits(
      {
        videoBytes: 1_000_000,
        videoPackets: 300,
        keyframeBytes: 0,
        keyframeCount: 0,
        audioBytes: 160_000,
        audioPackets: 500,
        requestedVideoBitrate: 8_000_000,
        keyFrameIntervalSec: 2,
      },
      10,
    )
    expect(s.achievedVideoBitrate).toBe(800_000)
    expect(s.achievedAudioBitrate).toBe(128_000)
    expect(s.bitrateUsePct).toBe(10)
  })

  it('is division-safe on an empty run', () => {
    const s = new BitsAudit(8_000_000, 2).summarize(0)
    expect(s.achievedVideoBitrate).toBe(0)
    expect(s.keyframeSharePct).toBe(0)
    expect(s.meanDeltaBytes).toBe(0)
    expect(formatBits(s, 'empty')).toContain('[bits] empty')
  })
})
