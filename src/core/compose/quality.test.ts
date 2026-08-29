/**
 * O3c — the quality wiring: the panel's "is this step instant, and is its
 * number the file?" is answered by the same function the export ladder uses,
 * so the badge, the estimate and the path cannot disagree about capability.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChannelRecording, CompositeRecording, Recording } from '@core/types'
import { setSingleGenRung } from '@core/singleGen'
import { QUALITY_TIERS, copySourceForTier, estimateExportBytes } from './quality'

const tier = (id: string) => QUALITY_TIERS.find((t) => t.id === id)!

function channel(over: Partial<ChannelRecording> = {}): ChannelRecording {
  return {
    id: 'ch_screen',
    kind: 'screen',
    media: 'video',
    mimeType: 'video/mp4',
    blobKey: 'rec_1_ch_screen.mp4',
    startOffsetMs: 12,
    durationMs: 10_000,
    width: 2560,
    height: 1440,
    bytes: 6_500_000,
    ...over,
  }
}

function composite(over: Partial<CompositeRecording> = {}): CompositeRecording {
  return {
    blobKey: 'rec_1_composite.mp4',
    mimeType: 'video/mp4',
    durationMs: 9_800,
    width: 1920,
    height: 1080,
    startOffsetMs: 180,
    engine: 'v2',
    bytes: 2_000_000,
    ...over,
  }
}

function recording(over: Partial<Recording> = {}): Recording {
  return {
    id: 'rec_1',
    createdAt: 0,
    durationMs: 10_000,
    channels: [channel()],
    composite: composite(),
    ...over,
  } as Recording
}

beforeEach(() => {
  setSingleGenRung('export')
})

describe('copySourceForTier', () => {
  it('the 1440p step packet-copies a native-res 1440p raw channel', () => {
    expect(copySourceForTier(recording(), tier('1440p'))?.origin).toBe('single-generation')
  })

  it('the default step still copies the composite on a take that must composite', () => {
    const two = recording({
      channels: [channel(), channel({ id: 'ch_cam', kind: 'camera', blobKey: 'c.mp4' })],
    })
    expect(copySourceForTier(two, tier('1080p'))?.origin).toBe('composite')
    expect(copySourceForTier(two, tier('1440p'))).toBeNull()
  })

  it('steps that match nothing on disk cannot copy', () => {
    expect(copySourceForTier(recording(), tier('720p'))).toBeNull()
    expect(copySourceForTier(recording(), tier('540p'))).toBeNull()
  })
})

describe('estimateExportBytes on a copyable step', () => {
  it('is exact, priced off the raw channel’s own byte rate', () => {
    const est = estimateExportBytes(recording(), tier('1440p'), 10_000)
    expect(est.exact).toBe(true)
    // 6.5 MB of video over 10 s, no audio channel in this fixture.
    expect(est.bytes).toBe(6_500_000)
  })

  it('stays a model when the channel never recorded its size', () => {
    const blind = recording({ channels: [channel({ bytes: undefined })] })
    expect(estimateExportBytes(blind, tier('1440p'), 10_000).exact).toBe(false)
  })
})
