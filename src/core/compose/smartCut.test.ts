import { describe, expect, it } from 'vitest'
import { outputTimeForSpan } from './smartCut'

/**
 * B11: one cold 120 s run in five, the trim threw
 * `Timestamps must be non-negative (got -0.0003333333333337407s)` and fell
 * silently to a full render. That number is not noise — it is exactly one tick
 * of a 3000 timescale below the cut, i.e. the key packet the copy loop is
 * ALLOWED to start from.
 *
 * The cell below is the failing value itself, born red against the old
 * `outCursorSec + (compSec - spanStartSec)`.
 */
describe('outputTimeForSpan', () => {
  /** The exact arithmetic from the failing run: a 120 s cut, timescale 3000. */
  const SPAN_START = 120
  const ONE_TICK = 1 / 3000

  it('never emits a negative output time for a key packet one tick before the cut', () => {
    const out = outputTimeForSpan(SPAN_START - ONE_TICK, SPAN_START, 0)
    expect(out).toBe(0)
    expect(out).toBeGreaterThanOrEqual(0)
  })

  it('snaps that packet onto the span origin rather than before the previous span', () => {
    // Second span: the cursor is already 42 s in, so the old maths gave
    // 41.99966… — not an exception, but a packet stacked before the frame
    // that ends the previous span.
    expect(outputTimeForSpan(SPAN_START - ONE_TICK, SPAN_START, 42)).toBe(42)
  })

  it('leaves every timestamp the copy loop actually rebases untouched', () => {
    // Byte-identical behaviour where no snap was needed: the whole point.
    expect(outputTimeForSpan(120, 120, 0)).toBe(0)
    expect(outputTimeForSpan(125.5, 120, 0)).toBeCloseTo(5.5, 12)
    expect(outputTimeForSpan(125.5, 120, 42)).toBeCloseTo(47.5, 12)
    expect(outputTimeForSpan(0.5, 0, 0)).toBeCloseTo(0.5, 12)
  })

  it('still surfaces a real hole as a negative instead of hiding it under max(0)', () => {
    // A whole frame before the span start is not a rounding tick; if that ever
    // reaches the muxer it SHOULD refuse, and a blanket clamp would have
    // buried it inside the file instead.
    expect(outputTimeForSpan(119.9, 120, 0)).toBeLessThan(0)
  })

  it('accepts a span that begins before the composite does', () => {
    // spanStartSec < 0 is a real hole in the composite (P0-instant-sync), and
    // the copy loop reads from 0: that must stay a forward shift.
    expect(outputTimeForSpan(0, -0.4, 0)).toBeCloseTo(0.4, 12)
  })
})
