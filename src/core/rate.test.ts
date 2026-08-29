/**
 * F15 — the rate follows the take.
 *
 * THE FIRST DESCRIBE IS THE WHOLE SAFETY NET, and it is the dullest on purpose:
 * the task's gate is "a 30 fps source's take is byte-identical to today", and
 * "byte-identical" is not an argument about a cadence gate — it is these
 * numbers. Every step, every constraint and every fence has to answer exactly
 * what the constant answered for a take at or below 30.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ChannelRecording, CompositeRecording, Recording } from '@core/types'
import { DEFAULT_EXPORT_SETTINGS } from '@core/types'
import {
  CAPTURE_MAX_FPS,
  displayVideoConstraints,
  exceedsCaptureCeiling,
} from '@core/capture/acquire'
import { QUALITY_TIERS, resolveTier, settingsForTier, tiersForTake } from '@core/compose/quality'
import { chooseCopySource } from '@core/compose/copySource'
import { DEFAULT_FRAME_ASPECT } from './frame'
import {
  DEFAULT_FRAME_RATE,
  MAX_FRAME_RATE,
  captureRateCeiling,
  normalizeRate,
  setSourceRate,
  sourceRateEnabled,
  takeRate,
} from './rate'

afterEach(() => setSourceRate(null))

function channel(over: Partial<ChannelRecording> = {}): ChannelRecording {
  return {
    id: 'ch_screen',
    kind: 'screen',
    media: 'video',
    mimeType: 'video/mp4',
    blobKey: 'rec_1_ch_screen.mp4',
    startOffsetMs: 0,
    durationMs: 10_000,
    width: 1920,
    height: 1080,
    ...over,
  }
}

function composite(over: Partial<CompositeRecording> = {}): CompositeRecording {
  return {
    blobKey: 'rec_1_composite.mp4',
    mimeType: 'video/mp4',
    durationMs: 10_000,
    width: 1920,
    height: 1080,
    startOffsetMs: 0,
    engine: 'v2',
    ...over,
  }
}

function recording(over: Partial<Recording> = {}): Recording {
  return { id: 'rec_1', createdAt: 0, durationMs: 10_000, channels: [channel()], ...over }
}

describe('30 fps is the identity', () => {
  it('the four steps of a 30 fps take are QUALITY_TIERS, field for field', () => {
    expect(tiersForTake(recording({ composite: composite({ fps: 30 }) }))).toEqual(QUALITY_TIERS)
  })

  it('a take that never recorded a rate is a 30 fps take — every file made before F15', () => {
    expect(takeRate(recording())).toBe(DEFAULT_FRAME_RATE)
    expect(takeRate(recording({ composite: composite() }))).toBe(DEFAULT_FRAME_RATE)
    expect(tiersForTake(recording())).toEqual(QUALITY_TIERS)
  })

  it('resolving a step at 16:9 and 30 returns that exact step object', () => {
    for (const t of QUALITY_TIERS) {
      expect(resolveTier(t, DEFAULT_FRAME_ASPECT, 30)).toBe(t)
      // The rate defaults to 30, so every caller written before F15 is unmoved.
      expect(resolveTier(t, DEFAULT_FRAME_ASPECT)).toBe(t)
    }
  })

  it('a slow source is NOT followed down — the ceiling moved, the floor did not', () => {
    expect(takeRate(recording({ composite: composite({ fps: 24 }) }))).toBe(30)
    expect(normalizeRate(24)).toBe(30)
    expect(normalizeRate(15)).toBe(30)
  })

  it('the default export settings still say 30', () => {
    expect(DEFAULT_EXPORT_SETTINGS.fps).toBe(30)
    expect(DEFAULT_FRAME_RATE).toBe(30)
    expect(CAPTURE_MAX_FPS).toBe(30)
  })

  it('with the flag off capture asks for exactly what it always asked for', () => {
    expect(sourceRateEnabled()).toBe(false)
    expect(captureRateCeiling()).toBe(30)
    const c = displayVideoConstraints() as { frameRate: { ideal: number; max: number } }
    expect(c.frameRate).toEqual({ ideal: 30, max: 30 })
    expect(exceedsCaptureCeiling({ width: 1920, height: 1080, frameRate: 60 })).toBe(true)
  })
})

describe('normalizeRate', () => {
  it('rounds what capturers actually report', () => {
    expect(normalizeRate(29.97)).toBe(30)
    expect(normalizeRate(30.000001)).toBe(30)
    expect(normalizeRate(59.94)).toBe(60)
  })

  it('caps at the ruling', () => {
    expect(normalizeRate(120)).toBe(MAX_FRAME_RATE)
    expect(MAX_FRAME_RATE).toBe(60)
  })

  it('is total — nothing here can answer NaN', () => {
    expect(normalizeRate(undefined)).toBe(30)
    expect(normalizeRate(null)).toBe(30)
    expect(normalizeRate(0)).toBe(30)
    expect(normalizeRate(-1)).toBe(30)
    expect(normalizeRate(Number.NaN)).toBe(30)
    // Infinity is not a rate a track can have — it reads as "said nothing".
    expect(normalizeRate(Number.POSITIVE_INFINITY)).toBe(30)
  })
})

describe('the take answers, and the composite answers first', () => {
  it('a 60 fps composite makes it a 60 fps take', () => {
    expect(takeRate(recording({ composite: composite({ fps: 60 }) }))).toBe(60)
  })

  it('the composite outranks the channels — that file is what the copy hands over', () => {
    const rec = recording({
      channels: [channel({ fps: 60 })],
      composite: composite({ fps: 30 }),
    })
    expect(takeRate(rec)).toBe(30)
  })

  it('with no composite the screen decides, not a faster PiP camera', () => {
    const rec = recording({
      channels: [
        channel({ id: 'cam', kind: 'camera', fps: 60, width: 1280, height: 720 }),
        channel({ fps: 30 }),
      ],
    })
    expect(takeRate(rec)).toBe(30)
  })

  it('with no screen the camera IS the take', () => {
    const rec = recording({
      channels: [channel({ id: 'cam', kind: 'camera', fps: 60, width: 1280, height: 720 })],
    })
    expect(takeRate(rec)).toBe(60)
  })
})

describe('a step keeps its name and its bits-per-frame', () => {
  const rec60 = recording({ composite: composite({ fps: 60 }) })

  it('only the rate moves — every step keeps its pixels and its label', () => {
    const tiers = tiersForTake(rec60)
    expect(tiers.map((t) => [t.id, t.width, t.height, t.fps])).toEqual([
      ['540p', 960, 540, 60],
      ['720p', 1280, 720, 60],
      ['1080p', 1920, 1080, 60],
      ['1440p', 2560, 1440, 60],
    ])
  })

  it('the bitrate CEILING doubles with the rate, so 60 fps is not a quieter encode', () => {
    const tiers = tiersForTake(rec60)
    for (const [i, t] of tiers.entries()) {
      expect(t.videoBitrate).toBe(QUALITY_TIERS[i]!.videoBitrate * 2)
    }
  })

  it('resolving twice changes nothing', () => {
    const once = resolveTier(QUALITY_TIERS[2]!, DEFAULT_FRAME_ASPECT, 60)
    expect(resolveTier(once, DEFAULT_FRAME_ASPECT, 60)).toEqual(once)
  })

  it('the export settings a step asks for carry the take’s rate', () => {
    expect(settingsForTier(QUALITY_TIERS[2]!, rec60).fps).toBe(60)
    expect(settingsForTier(QUALITY_TIERS[2]!, recording()).fps).toBe(30)
  })

  it('shape and rate compose — a portrait 60 fps step is both', () => {
    const t = resolveTier(QUALITY_TIERS[2]!, 9 / 16, 60)
    expect([t.width, t.height, t.fps]).toEqual([1080, 1920, 60])
  })
})

describe('the copy fence refuses a file of the wrong rate', () => {
  /** Two video channels, so single generation declines and the COMPOSITE is
   *  the candidate under test — the fence this block is about. */
  function composited(over: Partial<CompositeRecording> = {}): Recording {
    return recording({
      channels: [channel(), channel({ id: 'cam', kind: 'camera', width: 1280, height: 720 })],
      composite: composite(over),
    })
  }

  it('a 60 fps composite is not handed over under a 30 fps step', () => {
    const chosen = chooseCopySource(composited({ fps: 60 }), {
      width: 1920,
      height: 1080,
      fps: 30,
    })
    expect(chosen.source).toBeNull()
    expect(chosen.declined.find((d) => d.origin === 'composite')?.reason).toContain('@60')
  })

  it('a 30 fps composite is not handed over under a 60 fps step either', () => {
    const chosen = chooseCopySource(composited({ fps: 30 }), {
      width: 1920,
      height: 1080,
      fps: 60,
    })
    expect(chosen.source).toBeNull()
  })

  it('rates that agree still copy, at 30 and at 60', () => {
    expect(
      chooseCopySource(composited({ fps: 30 }), { width: 1920, height: 1080, fps: 30 }).source
        ?.origin,
    ).toBe('composite')
    expect(
      chooseCopySource(composited({ fps: 60 }), { width: 1920, height: 1080, fps: 60 }).source
        ?.origin,
    ).toBe('composite')
  })

  it('an omitted rate on either side reads as 30 — every take made before F15 still copies', () => {
    expect(chooseCopySource(composited(), { width: 1920, height: 1080 }).source?.origin).toBe(
      'composite',
    )
  })

  it('a raw channel of the wrong rate is refused by single generation', () => {
    const rec = recording({ channels: [channel({ fps: 60 })] })
    const chosen = chooseCopySource(rec, { width: 1920, height: 1080, fps: 30 })
    expect(chosen.source).toBeNull()
    expect(chosen.declined.find((d) => d.origin === 'single-generation')?.reason).toContain(
      'not the same frames',
    )
  })

  it('a raw channel at the take’s own rate is still the preferred copy', () => {
    const rec = recording({ channels: [channel({ fps: 60 })] })
    expect(chooseCopySource(rec, { width: 1920, height: 1080, fps: 60 }).source?.origin).toBe(
      'single-generation',
    )
  })
})

describe('the flag governs what gets RECORDED', () => {
  it('turned on, capture stops capping and asks for nothing', () => {
    setSourceRate(true)
    expect(captureRateCeiling()).toBe(60)
    const c = displayVideoConstraints() as { frameRate: { ideal?: number; max: number } }
    expect(c.frameRate.max).toBe(60)
    // No `ideal`: asking a source for 60 would trade its resolution for a rate
    // it may not have. Nothing is requested — the throttle is simply lifted.
    expect(c.frameRate.ideal).toBeUndefined()
    expect(exceedsCaptureCeiling({ width: 1920, height: 1080, frameRate: 60 })).toBe(false)
    expect(exceedsCaptureCeiling({ width: 3840, height: 2160, frameRate: 30 })).toBe(true)
  })

  it('turned off again, the ask is the one it always was', () => {
    setSourceRate(true)
    setSourceRate(false)
    expect(captureRateCeiling()).toBe(30)
    expect(displayVideoConstraints().frameRate).toEqual({ ideal: 30, max: 30 })
  })

  it('the EXPORT side is not gated — a 60 fps take exports 60 with the flag off', () => {
    const rec = recording({ composite: composite({ fps: 60 }) })
    expect(sourceRateEnabled()).toBe(false)
    expect(takeRate(rec)).toBe(60)
    expect(settingsForTier(QUALITY_TIERS[2]!, rec).fps).toBe(60)
  })
})
