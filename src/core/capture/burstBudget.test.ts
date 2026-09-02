/**
 * E2 — the absorber's size is a PROMISE ABOUT MEMORY, so it is checked in
 * numbers rather than trusted to a constant that reads small.
 */
import { describe, expect, it } from 'vitest'
import {
  BURST_BUDGET_BYTES_SMALL,
  MAX_BURST_FRAMES,
  burstFramesFor,
  frameBytes,
} from './burstBudget'

describe('the burst absorber is sized in bytes, on this machine', () => {
  it('gives an 8 GB machine four 1080p frames — 12.4 MB, inside its 24 MB budget', () => {
    expect(burstFramesFor(1920, 1080, 8)).toBe(MAX_BURST_FRAMES)
    expect(frameBytes(1920, 1080) * 4).toBeLessThan(BURST_BUDGET_BYTES_SMALL)
  })

  it('shrinks it for a bigger picture, because four frames is not one promise', () => {
    // Robert's own screen: 3024x1964 is 8.9 MB a frame, so 24 MB is two.
    expect(burstFramesFor(3024, 1964, 8)).toBe(2)
    // 4K is 11.9 MB a frame — two, and 23.7 MB held at the very worst.
    expect(burstFramesFor(3840, 2160, 8)).toBe(2)
    expect(frameBytes(3840, 2160) * 2).toBeLessThan(BURST_BUDGET_BYTES_SMALL)
  })

  it('lets a large machine keep the frame cap, never more', () => {
    expect(burstFramesFor(3840, 2160, 32)).toBe(MAX_BURST_FRAMES)
    expect(burstFramesFor(1920, 1080, 32)).toBe(MAX_BURST_FRAMES)
  })

  it('treats an unreported machine as the SMALL one', () => {
    // Guessing a machine is big is the guess that costs a user memory they do
    // not have. navigator.deviceMemory is absent in plenty of contexts.
    expect(burstFramesFor(3840, 2160, null)).toBe(burstFramesFor(3840, 2160, 8))
    expect(burstFramesFor(3840, 2160, undefined)).toBe(burstFramesFor(3840, 2160, 8))
    expect(burstFramesFor(3840, 2160, 0)).toBe(burstFramesFor(3840, 2160, 8))
  })

  it('never goes negative on a picture nothing could buffer', () => {
    expect(burstFramesFor(16_000, 16_000, 8)).toBe(0)
  })
})
