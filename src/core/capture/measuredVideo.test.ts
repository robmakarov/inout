import { describe, expect, it } from 'vitest'
import { canMeasureVideoCapture, rebaseFrameTimestampUs } from './measuredVideo'

describe('measuredVideo helpers', () => {
  it('rebases frame timestamps so the first frame is file t=0', () => {
    expect(rebaseFrameTimestampUs(5_000_000, 5_000_000)).toBe(0)
    expect(rebaseFrameTimestampUs(5_033_333, 5_000_000)).toBe(33_333)
    expect(rebaseFrameTimestampUs(4_999_000, 5_000_000)).toBe(0)
  })

  it('reports capability from global APIs (false in node test env)', () => {
    // Node vitest has no VideoEncoder / OffscreenCanvas.
    expect(canMeasureVideoCapture()).toBe(false)
  })
})
