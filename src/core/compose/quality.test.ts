/**
 * O3c — the quality wiring: the panel's "is this step instant, and is its
 * number the file?" is answered by the same function the export ladder uses,
 * so the badge, the estimate and the path cannot disagree about capability.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChannelRecording, CompositeRecording, Recording } from '@core/types'
import type { QualityTier, SizeEstimate } from './quality'
import { setSingleGenRung } from '@core/singleGen'
import { setSourceFrame } from '@core/frame'
import { VIDEO_BITRATE } from './codecs'
import {
  QUALITY_TIERS,
  copySourceForTier,
  estimateExportBytes,
  flooredByPixelOrder,
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
      const withTake = settingsForTier(t, rec)
      const declared = settingsForTier(t)
      // GEOMETRY AND RATE ARE THE IDENTITY THIS TEST GUARDS (F13) and they are
      // untouched. The BITRATE is now bounded by what the take itself needed
      // (cappedTierBitrate, 2026-08-30) — a ceiling extrapolated from a 1440p
      // anchor asked 45 Mbps of a 3024x1964@60 export and advertised 245 MB
      // against Robert's usual 20 MB. It can only ever LOWER the ceiling.
      expect(withTake.width).toBe(declared.width)
      expect(withTake.height).toBe(declared.height)
      expect(withTake.fps).toBe(declared.fps)
      expect(withTake.videoBitrate ?? 0).toBeLessThanOrEqual(declared.videoBitrate ?? 0)
    }
  })

  it('with the flag off a portrait take still gets the landscape steps', () => {
    setSourceFrame(false)
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

/**
 * B1, the cheaper sibling of the 2.15x lie: on a 6 s take on prod the panel
 * ranked `1440p ~308 KB` BELOW `1080p 400 KB (exact)` — an upscale of that very
 * file, priced under it. Two predictions shown side by side as if they were a
 * ladder.
 */
describe('the ladder cannot promise a bigger picture for fewer bytes', () => {
  const step = (id: string, w: number, h: number) =>
    ({ ...tier('1080p'), id, width: w, height: h }) as QualityTier
  const size = (bytes: number, exact = false): SizeEstimate => ({ bytes, fromSource: true, exact })

  it('raises a predicted step to the exact number of a step it contains', () => {
    const out = flooredByPixelOrder([
      { tier: step('1080p', 1920, 1080), size: size(400_000, true) },
      { tier: step('1440p', 2560, 1440), size: size(308_000) },
    ])
    expect(out[1].size.bytes).toBe(400_000)
    expect(out[1].size.floored).toBe(true)
    // The exact number is untouched: it is a file, not arithmetic.
    expect(out[0].size).toEqual(size(400_000, true))
  })

  it('leaves a ladder that is already monotonic exactly as it was', () => {
    const entries = [
      { tier: step('720p', 1280, 720), size: size(200_000) },
      { tier: step('1080p', 1920, 1080), size: size(400_000, true) },
      { tier: step('1440p', 2560, 1440), size: size(520_000) },
    ]
    expect(flooredByPixelOrder(entries)).toEqual(entries)
  })

  it('is monotonic in pixel count afterwards, whatever order it was given in', () => {
    const out = flooredByPixelOrder([
      { tier: step('1440p', 2560, 1440), size: size(90_000) },
      { tier: step('540p', 960, 540), size: size(150_000) },
      { tier: step('1080p', 1920, 1080), size: size(120_000) },
      { tier: step('720p', 1280, 720), size: size(300_000) },
    ])
    const byPixels = [...out].sort(
      (a, b) => a.tier.width * a.tier.height - b.tier.width * b.tier.height,
    )
    const bytes = byPixels.map((e) => e.size.bytes)
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b))
    expect(bytes).toEqual([150_000, 300_000, 300_000, 300_000])
  })

  it('never raises one exact number to another — two files that disagree are two files', () => {
    const out = flooredByPixelOrder([
      { tier: step('1080p', 1920, 1080), size: size(400_000, true) },
      { tier: step('source', 2560, 1440), size: size(380_000, true) },
    ])
    expect(out[1].size.bytes).toBe(380_000)
    expect(out[1].size.floored).toBeUndefined()
  })

  it('a step BELOW an exact one is not dragged up to it', () => {
    const out = flooredByPixelOrder([
      { tier: step('540p', 960, 540), size: size(90_000) },
      { tier: step('1080p', 1920, 1080), size: size(400_000, true) },
    ])
    expect(out[0].size.bytes).toBe(90_000)
  })
})
