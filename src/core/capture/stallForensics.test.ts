import { describe, expect, it } from 'vitest'
import { beginDisplayForensics, describeForensics, foldFocus } from './stallForensics'
import type { StallForensics } from './stallForensics'

/**
 * The forensics exist to convict one of three suspects the page cannot tell
 * apart any other way (stallForensics.ts). These tests pin the fold — the
 * interpretation is the product; the listeners are plumbing.
 */
describe('what the focus trace convicts', () => {
  it('a quiet trace means no UI was ever interacted with — the below-Chrome suspect', () => {
    expect(foldFocus([])).toBe('never-lost')
  })

  it('picker answered, Chrome silent — the classic wedge signature', () => {
    expect(foldFocus([{ type: 'blur' }, { type: 'focus' }])).toBe('lost-and-returned')
  })

  it('focus gone and not back — something still holds it', () => {
    expect(foldFocus([{ type: 'blur' }])).toBe('still-lost')
  })

  it('visibility transitions count the same as focus ones', () => {
    expect(foldFocus([{ type: 'hidden' }, { type: 'visible' }])).toBe('lost-and-returned')
  })

  it('the LAST state wins — a second departure is a departure', () => {
    expect(foldFocus([{ type: 'blur' }, { type: 'focus' }, { type: 'blur' }])).toBe('still-lost')
  })
})

describe('the witness statement', () => {
  it('reads as one line a screenshot can carry, with the clustering number in it', () => {
    const f: StallForensics = {
      waitedMs: 30_000,
      focus: 'never-lost',
      trace: 'quiet',
      deliveriesThisSession: 0,
      pageAgeMs: 8_000,
    }
    const line = describeForensics(f)
    expect(line).toMatch(/30\.0s/)
    expect(line).toMatch(/focus never left/)
    expect(line).toMatch(/0 screen deliveries this session/)
  })

  it('report() works without a DOM — the capture test environment has none', () => {
    const w = beginDisplayForensics(1_000, 1_000)
    const r = w.report(31_000)
    expect(r.waitedMs).toBe(30_000)
    expect(r.focus).toBe('never-lost')
    w.settle() // must not throw with no listeners installed
  })
})
