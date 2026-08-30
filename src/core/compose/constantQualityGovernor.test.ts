import { describe, expect, it } from 'vitest'
import { clampQp, DEFAULT_QP } from './constantQuality'

/**
 * THE GOVERNOR, AS ARITHMETIC.
 *
 * The encoder itself needs a real `VideoEncoder`, so what is pinned here is the
 * rule it runs — the same expression, against the same numbers. The measured
 * defect it exists for (2026-08-30, one 30 s take at the 1080p step):
 *
 *     constant quality, ungoverned   36.9 MB   finalize 9,164 ms
 *     the tier's bitrate target      14.3 MB   finalize    70 ms
 *
 * Finalize is proportional to output size, so an unbounded encoder is not only
 * a big file — it is the "stuck at 95 %" a user waits through.
 */

const MAX_GOVERNED_QP = 32

/** The rule from ConstantQualityAvcEncoder.spend(), isolated. */
function step(qp: number, targetQp: number, spentPerSec: number, ceiling: number): number {
  const over = spentPerSec / ceiling
  if (over > 1.15 && qp < MAX_GOVERNED_QP) return clampQp(qp + 1)
  if (over < 0.85 && qp > targetQp) return clampQp(qp - 1)
  return qp
}

describe('the constant-quality rate governor', () => {
  it('does nothing at all while the file is inside its tier', () => {
    for (const over of [0.9, 1.0, 1.1, 1.15]) {
      expect(step(DEFAULT_QP, DEFAULT_QP, over, 1)).toBe(DEFAULT_QP)
    }
  })

  it('gives quality back, one step at a time, when the file overshoots', () => {
    let qp = DEFAULT_QP
    for (let i = 0; i < 5; i++) qp = step(qp, DEFAULT_QP, 3, 1)
    expect(qp).toBe(DEFAULT_QP + 5)
  })

  it('NEVER goes finer than what the page asked for — it can only shrink a file', () => {
    // Even with the file costing almost nothing, the QP does not drop below
    // the target. Constant quality's whole point is that a cheap frame stays
    // cheap; the governor must not turn that into "spend the ceiling".
    let qp = DEFAULT_QP
    for (let i = 0; i < 10; i++) qp = step(qp, DEFAULT_QP, 0.01, 1)
    expect(qp).toBe(DEFAULT_QP)
  })

  it('comes back down after a hard stretch, but only to the target', () => {
    let qp = DEFAULT_QP
    for (let i = 0; i < 4; i++) qp = step(qp, DEFAULT_QP, 3, 1)
    expect(qp).toBeGreaterThan(DEFAULT_QP)
    for (let i = 0; i < 20; i++) qp = step(qp, DEFAULT_QP, 0.1, 1)
    expect(qp).toBe(DEFAULT_QP)
  })

  it('stops before the picture is destroyed, however hopeless the source', () => {
    let qp = DEFAULT_QP
    for (let i = 0; i < 200; i++) qp = step(qp, DEFAULT_QP, 1000, 1)
    expect(qp).toBe(MAX_GOVERNED_QP)
  })

  it('a take with no ceiling to bound against is governed not at all', () => {
    // bytesPerSecCeiling null is the early return in spend(); modelled here as
    // "the rule is never consulted", which is what that return means.
    expect(step(DEFAULT_QP, DEFAULT_QP, 999, Number.POSITIVE_INFINITY)).toBe(DEFAULT_QP)
  })
})
