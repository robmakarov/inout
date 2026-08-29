/**
 * F18 — the export goes to the user's own resolution.
 *
 * Robert: "i want 3024x1964 or whatever users resolution is on roadmap." The
 * ladder stopped at 1440p for inherited reasons: F7/F7b chose its steps by
 * measured file-size separation on a product whose capture was hard-capped at
 * 1080p, O6 later made 1440p real detail, and nobody asked what sits above it.
 *
 * The step is OFF BY DEFAULT (`?sourceres=1`), because lifting it lifts the
 * capture ceiling with it — 40 % more pixels through the encoders O15 counts,
 * which is where Robert's freeze lived.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChannelRecording, CompositeRecording, Recording } from '@core/types'
import { setSingleGenRung } from '@core/singleGen'
import { setSourceFrame, setSourceRes, takeLongEdge } from '@core/frame'
import {
  QUALITY_TIERS,
  SOURCE_TIER,
  copySourceForTier,
  resolveTier,
  settingsForTier,
  sourceStepFor,
  tierById,
  tiersForTake,
} from './quality'

function channel(over: Partial<ChannelRecording> = {}): ChannelRecording {
  return {
    id: 'ch_screen',
    kind: 'screen',
    media: 'video',
    mimeType: 'video/mp4',
    blobKey: 'rec_1_ch_screen.mp4',
    startOffsetMs: 12,
    durationMs: 10_000,
    width: 3024,
    height: 1964,
    bytes: 9_000_000,
    ...over,
  }
}

function composite(over: Partial<CompositeRecording> = {}): CompositeRecording {
  return {
    blobKey: 'rec_1_composite.mp4',
    mimeType: 'video/mp4',
    durationMs: 9_800,
    width: 1920,
    height: 1247,
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
  setSourceRes(true)
  setSourceFrame(true)
})
afterEach(() => {
  setSourceRes(null)
  setSourceFrame(null)
})

describe('whether a take gets a source step at all', () => {
  it('a 3024-wide screen-only take does', () => {
    expect(sourceStepFor(recording())).toBe(3024)
  })

  it('THE GATE: a take already inside the ladder does NOT — the step is not a duplicate', () => {
    const small = recording({
      channels: [channel({ width: 1920, height: 1080 })],
      composite: composite({ width: 1920, height: 1080 }),
    })
    expect(sourceStepFor(small)).toBe(0)
    expect(tiersForTake(small).map((t) => t.id)).toEqual(QUALITY_TIERS.map((t) => t.id))
  })

  it('a 2560 take does not either — that IS the top step', () => {
    expect(sourceStepFor(recording({ channels: [channel({ width: 2560, height: 1440 })] }))).toBe(0)
  })

  it('OFF BY DEFAULT: the flag decides, and off is byte-identical to yesterday', () => {
    setSourceRes(null)
    expect(sourceStepFor(recording())).toBe(0)
    expect(tiersForTake(recording()).map((t) => t.id)).toEqual(QUALITY_TIERS.map((t) => t.id))
  })

  it('a screen+camera take gets NO source step, and the refusal is the feature', () => {
    // The composite is written at 1920 whatever the screen was, so only the raw
    // channel holds the take's own resolution and only single generation hands
    // it over untouched — which needs exactly one video channel. Offering the
    // step here would promise 3024 and deliver the 1920 composite upscaled: the
    // badge disagreeing with the path, which is the bug O3c exists to prevent.
    const two = recording({
      channels: [channel(), channel({ id: 'ch_cam', kind: 'camera', blobKey: 'c.mp4', width: 1280, height: 720 })],
    })
    expect(sourceStepFor(two)).toBe(0)
  })

  it('reads the RAW channel, not the composite — the composite is always 1920', () => {
    expect(takeLongEdge(recording())).toBe(3024)
    expect(recording().composite!.width).toBe(1920)
  })
})

describe('what the step resolves to', () => {
  it("is the take's own geometry, and the aspect is the take's", () => {
    const tiers = tiersForTake(recording())
    const src = tiers.find((t) => t.id === 'source')!
    expect(Math.max(src.width, src.height)).toBe(3024)
    // 3024x1964 is 1.5397:1; the step keeps it.
    expect(src.width / src.height).toBeCloseTo(3024 / 1964, 2)
  })

  it('the export ASKS for that size — the badge and the path cannot disagree', () => {
    const src = tiersForTake(recording()).find((t) => t.id === 'source')!
    const settings = settingsForTier(src, recording())
    expect(Math.max(settings.width, settings.height)).toBe(3024)
  })

  it('and it is delivered by the packet copy, not a re-encode', () => {
    const src = tiersForTake(recording()).find((t) => t.id === 'source')!
    expect(copySourceForTier(recording(), src)?.origin).toBe('single-generation')
  })
})

describe('the step has to survive a smaller take on the next load', () => {
  it("'source' is remembered as an id, because the size is different on every machine", () => {
    expect(tierById('source').id).toBe('source')
    expect(tierById('source').longEdge).toBe(0)
  })

  it('resolving it with NO take in hand answers a real size, never 0x0', () => {
    const t = resolveTier(SOURCE_TIER, 16 / 9, 30)
    expect(t.width).toBe(2560)
    expect(t.height).toBe(1440)
  })

  it('a 3024 take followed by a 1920 one: the second offers no source step to land on', () => {
    const big = recording()
    const small = recording({
      channels: [channel({ width: 1920, height: 1080 })],
      composite: composite({ width: 1920, height: 1080 }),
    })
    expect(tiersForTake(big).some((t) => t.id === 'source')).toBe(true)
    expect(tiersForTake(small).some((t) => t.id === 'source')).toBe(false)
    // …so the editor falls back, and the fallback resolves to a real step.
    expect(resolveTier(tierById('1440p'), 16 / 9, 30).longEdge).toBe(2560)
  })
})

describe('nothing below the top step moves', () => {
  it('every existing step is untouched by the source step existing', () => {
    const tiers = tiersForTake(recording({
      channels: [channel({ width: 1920, height: 1080 })],
      composite: composite({ width: 1920, height: 1080 }),
    }))
    for (const t of QUALITY_TIERS) {
      const got = tiers.find((x) => x.id === t.id)!
      expect(got.longEdge).toBe(t.longEdge)
      expect(got.videoBitrate).toBe(t.videoBitrate)
    }
  })
})
