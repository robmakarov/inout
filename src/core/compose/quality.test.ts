/**
 * O3c — the quality wiring: the panel's "is this step instant, and is its
 * number the file?" is answered by the same function the export ladder uses,
 * so the badge, the estimate and the path cannot disagree about capability.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChannelRecording, CompositeRecording, Recording } from '@core/types'
import { setSingleGenRung } from '@core/singleGen'
import { setSourceFrame } from '@core/frame'
import { VIDEO_BITRATE } from './codecs'
import {
  QUALITY_TIERS,
  copySourceForTier,
  estimateExportBytes,
  resolveTier,
  settingsForTier,
  tiersForTake,
} from './quality'

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

/**
 * F13 — a step is a pixel budget at the take's own aspect.
 *
 * The first test is the task's byte-identical gate expressed where it can
 * actually fail: the four steps a 16:9 take exports at, field for field.
 */
describe('the steps follow the take (F13)', () => {
  afterEach(() => setSourceFrame(null))

  it('a 16:9 take resolves to the declared steps, field for field', () => {
    setSourceFrame(true)
    const rec = recording() // a 2560x1440 screen channel — 16:9
    expect(tiersForTake(rec)).toEqual(QUALITY_TIERS)
    for (const t of QUALITY_TIERS) {
      expect(settingsForTier(t, rec)).toEqual(settingsForTier(t))
    }
  })

  it('with the flag off a portrait take still gets the landscape steps', () => {
    const portrait = recording({
      channels: [channel({ kind: 'camera', width: 1080, height: 1920 })],
      composite: undefined,
    })
    expect(tiersForTake(portrait)).toEqual(QUALITY_TIERS)
  })

  it('with the flag on the same take gets portrait steps of the same long edge', () => {
    setSourceFrame(true)
    const portrait = recording({
      channels: [channel({ kind: 'camera', width: 1080, height: 1920 })],
      composite: undefined,
    })
    const steps = tiersForTake(portrait)
    expect(steps.map((t) => [t.id, t.width, t.height])).toEqual([
      ['540p', 540, 960],
      ['720p', 720, 1280],
      ['1080p', 1080, 1920],
      ['1440p', 1440, 2560],
    ])
    // Same pixels, same name, same bits — only the shape moved.
    for (const [i, t] of steps.entries()) {
      expect(t.videoBitrate).toBe(QUALITY_TIERS[i]!.videoBitrate)
      expect(t.label).toBe(QUALITY_TIERS[i]!.label)
    }
  })

  it('a taller frame gets proportionally more bits, so a step is not quietly starved', () => {
    setSourceFrame(true)
    const fourThree = recording({
      channels: [channel({ kind: 'camera', width: 640, height: 480 })],
      composite: undefined,
    })
    const step = tiersForTake(fourThree).find((t) => t.id === '1080p')!
    expect([step.width, step.height]).toEqual([1920, 1440])
    expect(step.videoBitrate).toBe(Math.round((VIDEO_BITRATE * (1920 * 1440)) / (1920 * 1080)))
  })

  it('resolving twice changes nothing', () => {
    const once = resolveTier(tier('1080p'), 9 / 16)
    expect(resolveTier(once, 9 / 16)).toEqual(once)
  })

  it('a portrait take copies its portrait raw channel at the step that matches it', () => {
    setSourceFrame(true)
    const portrait = recording({
      channels: [channel({ kind: 'camera', width: 1080, height: 1920 })],
      composite: undefined,
    })
    const step = tiersForTake(portrait).find((t) => t.id === '1080p')!
    const copy = copySourceForTier(portrait, step)
    expect(copy?.origin).toBe('single-generation')
    expect([copy?.width, copy?.height]).toEqual([1080, 1920])
  })
})
