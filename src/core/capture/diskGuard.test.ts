import { describe, expect, it } from 'vitest'
import {
  MIN_SAMPLE_MS,
  PREFLIGHT_QUIET_MINUTES,
  STOP_SECONDS_LEFT,
  diskVerdict,
  mbPerMinute,
  preflightVerdict,
} from './diskGuard'

const GB = 1073741824

/**
 * B5, built 2026-08-30 from Robert: "we must prevent junk from saving, it will
 * fuck up users disks". One of his takes wrote 1,138 MB before it froze, and
 * nothing in this product has ever read storage.estimate() — so a take could
 * fill a disk and only find out when a write failed, losing the recording AND
 * the space.
 */
describe('room left, in the form a person can act on', () => {
  // 100 MiB per minute, so the rate the message quotes is a round number.
  const base = { usageBytes: 1 * GB, quotaBytes: 100 * GB, takeBytes: 100 * 1048576, takeMs: 60_000 }

  it('says nothing while there is plenty', () => {
    expect(diskVerdict(base)?.level).toBe('ok')
  })

  it('WARNS in time to finish a thought, and says the rate', () => {
    // 100 MiB/min, 150 MiB of room = 1.5 minutes.
    const v = diskVerdict({ ...base, usageBytes: 100 * GB - 150 * 1048576 })
    expect(v?.level).toBe('warn')
    expect(v?.message).toContain('100 MB a minute')
    expect(v?.message).toContain('stop itself')
  })

  it('STOPS before the write fails, because a stopped take is a saved take', () => {
    const v = diskVerdict({ ...base, usageBytes: 100 * GB - 10 * 1048576 })
    expect(v?.level).toBe('stop')
    expect(v?.message).toContain('saved')
  })

  it('will not judge a take from its first seconds — that is the encoder waking up', () => {
    expect(diskVerdict({ ...base, takeMs: MIN_SAMPLE_MS - 1, usageBytes: 100 * GB - 1048576 })).toBeNull()
  })

  it('a browser that reports no quota gets no opinion', () => {
    expect(diskVerdict({ ...base, quotaBytes: 0 })).toBeNull()
  })

  it('a take that has written nothing yet has no rate to project', () => {
    expect(diskVerdict({ ...base, takeBytes: 0 })).toBeNull()
  })

  it('the stop threshold is below the warn one, or the warning never fires', () => {
    const v = diskVerdict({ ...base, usageBytes: 100 * GB - 100 * 1048576 * (STOP_SECONDS_LEFT / 60) })
    expect(v?.level).toBe('stop')
  })
})

/**
 * B5's other half. The in-take guard cannot speak for the first 8 s of a take
 * and answers in "two minutes left"; the question before the press is "is there
 * room for what I am about to record", and its unit is minutes OF RECORDING.
 */
describe('the pre-flight, before a take exists', () => {
  // 2 MB/s ≈ 120 MB a minute, about what a screen + composite + audio take
  // writes at the configured bitrates.
  const rate = 2 * 1048576

  it('says nothing at all on a healthy machine', () => {
    const v = preflightVerdict({ usageBytes: 0, quotaBytes: 100 * GB, bytesPerSec: rate })
    expect(v?.level).toBe('ok')
    expect(v?.message).toBe('')
  })

  it('speaks in minutes of recording, not in gigabytes', () => {
    const free = rate * 60 * 7
    const v = preflightVerdict({ usageBytes: 100 * GB - free, quotaBytes: 100 * GB, bytesPerSec: rate })
    expect(v?.level).toBe('low')
    expect(v?.message).toContain('about 7 more minutes')
    expect(v?.message).toContain('120 MB a minute')
  })

  it('stays quiet at the boundary and speaks one second below it', () => {
    const quiet = rate * 60 * PREFLIGHT_QUIET_MINUTES
    const q = 100 * GB
    expect(preflightVerdict({ usageBytes: q - quiet, quotaBytes: q, bytesPerSec: rate })?.level).toBe('ok')
    expect(
      preflightVerdict({ usageBytes: q - quiet + rate, quotaBytes: q, bytesPerSec: rate })?.level,
    ).toBe('low')
  })

  it('does not promise "0 minutes" — under a minute is said in words', () => {
    const v = preflightVerdict({ usageBytes: 100 * GB - rate * 20, quotaBytes: 100 * GB, bytesPerSec: rate })
    expect(v?.message).toContain('Under a minute')
  })

  it('a machine that reports no quota, or a take with no rate, gets no opinion', () => {
    expect(preflightVerdict({ usageBytes: 0, quotaBytes: 0, bytesPerSec: rate })).toBeNull()
    expect(preflightVerdict({ usageBytes: 0, quotaBytes: 100 * GB, bytesPerSec: 0 })).toBeNull()
  })
})

describe('the rate a message quotes', () => {
  it('keeps a decimal where a whole number would be more than 10 % wrong', () => {
    // A take writing 3.4 a minute reads "3" when rounded — 12 % low, and B5's
    // gate is 10 %.
    expect(mbPerMinute((3.4 * 1048576) / 60)).toBe(3.4)
  })

  it('spends no decimal where it is noise — a max take writes ~140', () => {
    expect(mbPerMinute((140 * 1048576) / 60)).toBe(140)
  })
})
