import { describe, expect, it } from 'vitest'
import { MIN_SAMPLE_MS, STOP_SECONDS_LEFT, diskVerdict } from './diskGuard'

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
