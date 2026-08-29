import { describe, expect, it } from 'vitest'
import { exportFileName, exportStem } from './fileName'

/** 2026-08-29 13:45:12 local — built from parts so the test is timezone-proof. */
const AT = new Date(2026, 7, 29, 13, 45, 12).getTime()
/** A single-digit day AND month, which is where a day-first name can go wrong. */
const EARLY = new Date(2026, 0, 5, 9, 4, 7).getTime()

describe('export file name', () => {
  it('is day-first, not ISO-ordered', () => {
    expect(exportFileName(AT, '.mp4')).toBe('inout-29-08-2026-134512.mp4')
  })

  it('pads every field, so 5 January is not 5-1-2026', () => {
    expect(exportFileName(EARLY, '.mp4')).toBe('inout-05-01-2026-090407.mp4')
  })

  it('carries whatever extension the codec ladder landed on', () => {
    expect(exportFileName(AT, '.webm')).toBe('inout-29-08-2026-134512.webm')
  })

  it('shares its stem with the for-AI PDF', () => {
    expect(exportFileName(AT, '.mp4')).toContain(exportStem(AT))
  })
})
