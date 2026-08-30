import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_QUALITY_STEP,
  QUALITY_STEPS,
  currentQualityStep,
  isQualityStepId,
  loadQualityStep,
  qualityStepById,
  qualityStepIndex,
  setQualityStep,
  stepAtOrBelow,
} from './qualityStep'
import { MAX_OUTPUT_LONG_EDGE, captureCeilingLongEdge, sourceResEnabled } from './frame'
import { MAX_FRAME_RATE, captureRateCeiling, sourceRateEnabled } from './rate'
import { QUALITY_TIERS } from './compose/quality'

afterEach(() => setQualityStep(null))

describe('the ladder', () => {
  it('is the export ladder, rung for rung, plus the source step on top', () => {
    // THE TIE THAT KEEPS THE SLIDER HONEST. The steps the user chooses between
    // before recording have to be the steps the export ladder offers
    // afterwards, or "no higher than you chose" is comparing two different
    // scales. If a rung is ever added to one, this fails until it is added to
    // the other.
    expect(QUALITY_STEPS.map((s) => s.id)).toEqual([...QUALITY_TIERS.map((t) => t.id), 'max'])
    for (const t of QUALITY_TIERS) {
      expect(qualityStepById(t.id).longEdge).toBe(t.longEdge)
    }
  })

  it('rises strictly, and only the top step is unbounded', () => {
    const edges = QUALITY_STEPS.map((s) => s.longEdge)
    for (let i = 1; i < edges.length; i++) expect(edges[i]!).toBeGreaterThan(edges[i - 1]!)
    expect(edges.filter((e) => !Number.isFinite(e))).toEqual([Number.POSITIVE_INFINITY])
    expect(QUALITY_STEPS[QUALITY_STEPS.length - 1]!.id).toBe('max')
  })

  it('orders steps and answers "at or below"', () => {
    expect(qualityStepIndex('540p')).toBe(0)
    expect(qualityStepIndex('max')).toBe(QUALITY_STEPS.length - 1)
    expect(stepAtOrBelow('720p', '1080p')).toBe(true)
    expect(stepAtOrBelow('1080p', '1080p')).toBe(true)
    expect(stepAtOrBelow('1440p', '1080p')).toBe(false)
    expect(stepAtOrBelow('1080p', 'max')).toBe(true)
  })

  it('reads an unknown id as the default rather than throwing', () => {
    expect(qualityStepById('nonsense').id).toBe(DEFAULT_QUALITY_STEP)
    expect(qualityStepById(null).id).toBe(DEFAULT_QUALITY_STEP)
    expect(qualityStepIndex(undefined)).toBe(qualityStepIndex(DEFAULT_QUALITY_STEP))
    expect(isQualityStepId('1080p')).toBe(true)
    expect(isQualityStepId('4k')).toBe(false)
  })
})

describe('the default step', () => {
  /**
   * THE ONE THING THIS TASK MUST NOT MOVE BY ACCIDENT. The frozen constraint is
   * "instant default export" (.ai/TASKS): the default export packet-copies the
   * composite, which is written at a 1920 long edge. A default step above 1080p
   * would make the untouched export a full RE-RENDER of every take, and nothing
   * else in the repo would notice.
   */
  it('is the step the composite is written at, so the default export stays instant', () => {
    expect(DEFAULT_QUALITY_STEP).toBe('1080p')
    expect(qualityStepById(DEFAULT_QUALITY_STEP).longEdge).toBe(1920)
    expect(loadQualityStep()).toBe(DEFAULT_QUALITY_STEP)
  })

  it('records at 30 — every step but the top one does', () => {
    for (const s of QUALITY_STEPS) {
      expect(s.fps).toBe(s.id === 'max' ? MAX_FRAME_RATE : 30)
    }
  })
})

describe('what a step actually binds', () => {
  it('bounds capture at its own long edge, never past what the product can emit', () => {
    setQualityStep('540p')
    expect(captureCeilingLongEdge()).toBe(960)
    setQualityStep('720p')
    expect(captureCeilingLongEdge()).toBe(1280)
    setQualityStep('1080p')
    expect(captureCeilingLongEdge()).toBe(1920)
    setQualityStep('1440p')
    expect(captureCeilingLongEdge()).toBe(MAX_OUTPUT_LONG_EDGE)
  })

  it('`max` is the one step that lifts the size bound and the rate bound together', () => {
    setQualityStep('max')
    // Robert, 2026-08-30: "max - maximum resolution, 60 fps, all maximum".
    expect(captureCeilingLongEdge()).toBe(Number.POSITIVE_INFINITY)
    expect(sourceResEnabled()).toBe(true)
    expect(sourceRateEnabled()).toBe(true)
    expect(captureRateCeiling()).toBe(MAX_FRAME_RATE)
  })

  it('every other step leaves the rate exactly where the product has always had it', () => {
    for (const id of ['540p', '720p', '1080p', '1440p'] as const) {
      setQualityStep(id)
      expect(sourceRateEnabled()).toBe(false)
      expect(captureRateCeiling()).toBe(30)
      expect(sourceResEnabled()).toBe(false)
      expect(Number.isFinite(captureCeilingLongEdge())).toBe(true)
    }
  })

  it('round-trips through the module override without a DOM', () => {
    setQualityStep('720p')
    expect(loadQualityStep()).toBe('720p')
    expect(currentQualityStep().longEdge).toBe(1280)
    setQualityStep(null)
    expect(loadQualityStep()).toBe(DEFAULT_QUALITY_STEP)
  })
})
