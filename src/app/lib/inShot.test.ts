import { describe, expect, it } from 'vitest'
import { inShotNotice, previewWouldMirror } from './inShot'

describe('inShotNotice', () => {
  it('says nothing while the user is somewhere else', () => {
    expect(inShotNotice('monitor', false)).toBeNull()
    expect(inShotNotice('window', false)).toBeNull()
  })

  it('says nothing when the take has no screen channel', () => {
    expect(inShotNotice(null, true)).toBeNull()
    expect(inShotNotice(undefined, true)).toBeNull()
  })

  it('a whole-screen take puts this window inside the frame', () => {
    const n = inShotNotice('monitor', true)
    expect(n?.kind).toBe('in-shot')
    expect(n?.foot).toMatch(/sharing bar/i)
  })

  it('a window or tab take is covered, not filmed', () => {
    expect(inShotNotice('window', true)?.kind).toBe('covering')
    expect(inShotNotice('window', true)?.title).toMatch(/window/)
    expect(inShotNotice('browser', true)?.title).toMatch(/tab/)
  })
})

describe('previewWouldMirror', () => {
  it('only the monitor case films itself', () => {
    expect(previewWouldMirror('monitor', true)).toBe(true)
    expect(previewWouldMirror('monitor', false)).toBe(false)
    expect(previewWouldMirror('window', true)).toBe(false)
    expect(previewWouldMirror('browser', true)).toBe(false)
    expect(previewWouldMirror(null, true)).toBe(false)
  })
})
