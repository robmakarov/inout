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
    // EVEN, like every real composite: frameForAspect rounds both sides to even
    // and is idempotent on the result. An odd height here made this fixture
    // resolve to 1248 and decline its own composite copy — a fixture bug that
    // looked exactly like the two-pixel drift F18 had just fixed for real.
    height: 1248,
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
    expect(sourceStepFor(recording())).toEqual({ width: 3024, height: 1964 })
  })

  it('THE GATE: a take already inside the ladder does NOT — the step is not a duplicate', () => {
    const small = recording({
      channels: [channel({ width: 1920, height: 1080 })],
      composite: composite({ width: 1920, height: 1080 }),
    })
    expect(sourceStepFor(small)).toBeNull()
    expect(tiersForTake(small).map((t) => t.id)).toEqual(QUALITY_TIERS.map((t) => t.id))
  })

  it('a 2560 take does not either — that IS the top step', () => {
    expect(sourceStepFor(recording({ channels: [channel({ width: 2560, height: 1440 })] }))).toBeNull()
  })

  it('OFF BY DEFAULT: the flag decides, and off is byte-identical to yesterday', () => {
    setSourceRes(null)
    expect(sourceStepFor(recording())).toBeNull()
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
    expect(sourceStepFor(two)).toBeNull()
  })

  it("O16's GATE: a STEPPED take declines the native copy rather than getting it wrong", () => {
    // A resolution step gives the screen kind two non-overlapping segments with
    // two geometries. They cannot be packet-copied as ONE file, so the take's
    // own-resolution export must decline — which it does by the same rule that
    // refuses a screen+camera take: single generation needs exactly one video
    // channel. The DEFAULT tier's instant export is unaffected, because that one
    // copies the composite, which is one continuous file at one size throughout.
    const stepped = recording({
      channels: [
        channel({ id: 'ch_screen_1', width: 1920, height: 1080, durationMs: 5_000 }),
        channel({ id: 'ch_screen_2', blobKey: 's2.mp4', startOffsetMs: 5_100, durationMs: 5_000 }),
      ],
    })
    expect(sourceStepFor(stepped)).toBeNull()
    expect(copySourceForTier(stepped, SOURCE_TIER)).toBeNull()
    // …and the default step still copies the composite. Resolved through
    // tiersForTake, which is the one place a step is resolved against a take.
    const dflt = tiersForTake(stepped).find((t) => t.id === '1080p')!
    expect(copySourceForTier(stepped, dflt)?.origin).toBe('composite')
  })

  it('reads the RAW channel, not the composite — the composite is always 1920', () => {
    expect(takeLongEdge(recording())).toBe(3024)
    expect(recording().composite!.width).toBe(1920)
  })
})

describe('what the step resolves to', () => {
  it("THE REGRESSION: it is the take's EXACT pixels, not a reconstruction of them", () => {
    // Found on prod. Every other step is a pixel budget resolved against the
    // take's aspect, which is right for them. Doing that here turned 3024x1964
    // into 3024x1962 — 1.53971… reconstructed — and two pixels are enough for
    // the copy fence to refuse the raw channel and send the take to a full
    // render, under a panel note promising no re-encode.
    const src = tiersForTake(recording()).find((t) => t.id === 'source')!
    expect(src.width).toBe(3024)
    expect(src.height).toBe(1964)
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

/**
 * UI1 — THE LADDER STOPS WHERE THE TAKE WAS RECORDED.
 *
 * Robert, 2026-08-30: "make it not possible to choose higher quality that was
 * choosen before start of record to save resources on other processes". The
 * saving is real — capture asked for no more than the chosen long edge, so the
 * pixels above it were never encoded — and that is exactly why the step above
 * must not be offered: it could only be delivered by upscaling.
 */
describe('the take carries its own ceiling', () => {
  it('offers only the steps at or below what the take was recorded at', () => {
    const at720 = recording({
      channels: [channel({ width: 1280, height: 720 })],
      composite: composite({ width: 1280, height: 720 }),
      qualityStep: '720p',
    })
    expect(tiersForTake(at720).map((t) => t.id)).toEqual(['540p', '720p'])
  })

  it('a take recorded at max keeps its source step whatever the slider says today', () => {
    const atMax = recording({ qualityStep: 'max' })
    setSourceRes(false) // the load's flag says no; the TAKE says yes
    expect(sourceStepFor(atMax)).toEqual({ width: 3024, height: 1964 })
    expect(tiersForTake(atMax).map((t) => t.id)).toEqual([
      '540p',
      '720p',
      '1080p',
      '1440p',
      'source',
    ])
  })

  it('a take recorded BELOW max never gets a source step, however big its channel is', () => {
    // The pixels the step would promise were never captured — the fixture's
    // 3024-wide channel cannot happen under a 1080p ceiling, and if it somehow
    // did, offering "Source" would still be the badge disagreeing with the
    // ladder the user was given.
    const at1080 = recording({ qualityStep: '1080p' })
    expect(sourceStepFor(at1080)).toBeNull()
    expect(tiersForTake(at1080).map((t) => t.id)).toEqual(['540p', '720p', '1080p'])
  })

  it('a take from before UI1 is uncapped — it keeps the ladder it was made under', () => {
    const legacy = recording()
    expect(legacy.qualityStep).toBeUndefined()
    expect(tiersForTake(legacy).map((t) => t.id)).toEqual([
      '540p',
      '720p',
      '1080p',
      '1440p',
      'source',
    ])
  })

  it('never returns an empty ladder: the lowest rung is reachable from every ceiling', () => {
    for (const step of ['540p', '720p', '1080p', '1440p', 'max'] as const) {
      const tiers = tiersForTake(recording({ qualityStep: step }))
      expect(tiers.length).toBeGreaterThan(0)
      expect(tiers[0]!.id).toBe('540p')
    }
  })
})
