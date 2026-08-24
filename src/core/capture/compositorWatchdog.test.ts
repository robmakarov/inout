import { describe, expect, it } from 'vitest'
import {
  WATCHDOG_AFTER_MS,
  WATCHDOG_NO_OUTPUT_MS,
  watchdogVerdict,
} from './compositorWatchdog'

describe('compositorWatchdog', () => {
  it('never degrades a static composition (nothing dropped, nothing asked)', () => {
    expect(
      watchdogVerdict({
        nowMs: 60_000,
        startedAtMs: 0,
        firstOutputAtMs: 100,
        realFramesEncoded: 55, // ~1 keep-alive fps
        framesDropped: 0,
      }),
    ).toBeNull()
  })

  it('tolerates a slow initialization: no verdict while the encoder has not produced yet', () => {
    // 8 s in, drops piling up, first output still pending — the 2026-08-24
    // cold-start shape. The old watchdog killed this take at 5 s.
    expect(
      watchdogVerdict({
        nowMs: 8000,
        startedAtMs: 0,
        firstOutputAtMs: null,
        realFramesEncoded: 0,
        framesDropped: 120,
      }),
    ).toBeNull()
  })

  it('degrades a true wedge: still nothing encoded at the no-output deadline', () => {
    expect(
      watchdogVerdict({
        nowMs: WATCHDOG_NO_OUTPUT_MS,
        startedAtMs: 0,
        firstOutputAtMs: null,
        realFramesEncoded: 0,
        framesDropped: 300,
      }),
    ).toMatch(/no encoded frame/)
  })

  it('excludes initialization from the rate: healthy after a late first output', () => {
    // First output at 8 s, then 29 fps for 6 s. Cumulative-from-start would
    // read 174/14 = 12.4 fps — barely passing by luck; from-first-output reads
    // the true 29. Either way this take must live.
    expect(
      watchdogVerdict({
        nowMs: 14_000,
        startedAtMs: 0,
        firstOutputAtMs: 8000,
        realFramesEncoded: 174,
        framesDropped: 130,
      }),
    ).toBeNull()
  })

  it('still degrades sustained slowness measured after the first output', () => {
    expect(
      watchdogVerdict({
        nowMs: 1000 + WATCHDOG_AFTER_MS,
        startedAtMs: 0,
        firstOutputAtMs: 1000,
        realFramesEncoded: 25, // 5 fps since first output
        framesDropped: 80,
      }),
    ).toMatch(/only 5\.0 fps/)
  })

  it('waits out the settling window after the first output before judging', () => {
    expect(
      watchdogVerdict({
        nowMs: 1000 + WATCHDOG_AFTER_MS - 1,
        startedAtMs: 0,
        firstOutputAtMs: 1000,
        realFramesEncoded: 5,
        framesDropped: 80,
      }),
    ).toBeNull()
  })
})
