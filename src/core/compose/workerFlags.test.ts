import { afterEach, describe, expect, it, vi } from 'vitest'
import { constantQualityQp, setConstantQualityOverride } from './constantQuality'
import { loudnessMode, setLoudnessMode } from './loudnessMode'

/**
 * THE DEFECT: THE RENDER COULD NOT READ ITS OWN FLAGS.
 *
 * The export moved into a dedicated worker (O5a). A dedicated worker has NO
 * `localStorage` at all, and its `location` is the worker script's URL — so
 * every flag getter called inside the render answered its DEFAULT, whatever the
 * page had been opened with. `?cq=`, `?loudness=` and F13's `?sourceframe=`
 * were all documented, all sticky, and all dead on the path that ships.
 *
 * It surfaced as an A/B whose two lanes came back BYTE-IDENTICAL (2026-08-30).
 * A lever that changes nothing is either measuring the wrong thing or is not
 * connected; this one was not connected.
 *
 * These tests pin the seam, not the plumbing: the page decides, the worker is
 * TOLD, and "the page did not say" stays distinct from "the page said off".
 */

function workerLike(): void {
  // What the render actually sees: no storage, and a location with no query.
  vi.stubGlobal('localStorage', undefined)
  vi.stubGlobal('location', { search: '' })
}

afterEach(() => {
  setConstantQualityOverride(undefined)
  setLoudnessMode(null)
  vi.unstubAllGlobals()
})

describe('flags the export worker cannot read for itself', () => {
  it('constant quality falls through to its default in a worker — the defect', () => {
    workerLike()
    setConstantQualityOverride(undefined)
    // 20 is CQ_DEFAULT. Whatever the page chose, this is what the worker saw.
    expect(constantQualityQp()).toBe(20)
  })

  it('an override the page sends WINS over the worker’s blindness', () => {
    workerLike()
    setConstantQualityOverride(null)
    expect(constantQualityQp()).toBeNull()
    setConstantQualityOverride(26)
    expect(constantQualityQp()).toBe(26)
  })

  it('"the page said off" is not the same as "the page did not say"', () => {
    workerLike()
    setConstantQualityOverride(null)
    expect(constantQualityQp()).toBeNull()
    setConstantQualityOverride(undefined)
    expect(constantQualityQp()).toBe(20)
  })

  it('an override beats even a URL, because the worker’s URL is not the page’s', () => {
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('location', { search: '?cq=14' })
    setConstantQualityOverride(null)
    expect(constantQualityQp()).toBeNull()
  })

  it('loudness has the same seam and the same failure without it', () => {
    workerLike()
    expect(loudnessMode()).toBe('p90')
    setLoudnessMode('r128')
    expect(loudnessMode()).toBe('r128')
  })
})
