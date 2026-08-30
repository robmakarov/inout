import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  heldShare,
  holdShare,
  isHeldTrack,
  keepShareEnabled,
  releaseHeldShare,
  resetPersistentShareForTests,
  setKeepShare,
} from './persistentShare'

/**
 * O12, built 2026-08-30 because Robert was blocked by the thing it prevents:
 * "i got screen permissions wedges after first record … cant test further until
 * chrome wedge is gone".
 *
 * The wedge is Chrome's and no page can cure it. This is the only lever that
 * reduces how many times the page ASKS — and a getDisplayMedia call that is
 * never made cannot wedge.
 */
const track = (state: MediaStreamTrackState = 'live') => {
  const listeners: (() => void)[] = []
  return {
    readyState: state,
    stop: vi.fn(function (this: { readyState: string }) {
      this.readyState = 'ended'
    }),
    addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
    fire: () => listeners.forEach((f) => f()),
  } as unknown as MediaStreamTrack & { fire: () => void }
}

afterEach(() => resetPersistentShareForTests())

describe('holding a share', () => {
  it('is OFF by default — every take asks for its own share, as it always did', () => {
    expect(keepShareEnabled()).toBe(false)
    const v = track()
    holdShare({} as MediaStream, v, null)
    expect(heldShare()).toBeNull()
  })

  it('holds the video and its audio when turned on', () => {
    setKeepShare(true)
    const v = track()
    const a = track()
    holdShare({} as MediaStream, v, a)
    expect(heldShare()?.video).toBe(v)
    expect(isHeldTrack(v)).toBe(true)
    expect(isHeldTrack(a)).toBe(true)
    expect(isHeldTrack(track())).toBe(false)
  })

  it('NEVER HANDS OUT A DEAD SHARE — the next take asks for a fresh one', () => {
    setKeepShare(true)
    const v = track()
    holdShare({} as MediaStream, v, null)
    ;(v as unknown as { readyState: string }).readyState = 'ended'
    expect(heldShare()).toBeNull()
    expect(isHeldTrack(v)).toBe(false)
  })

  it("Chrome's own Stop sharing drops the hold", () => {
    setKeepShare(true)
    const v = track()
    holdShare({} as MediaStream, v, null)
    ;(v as unknown as { readyState: string }).readyState = 'ended'
    ;(v as unknown as { fire: () => void }).fire()
    expect(heldShare()).toBeNull()
  })

  it('releasing stops both tracks, and is safe twice', () => {
    setKeepShare(true)
    const v = track()
    const a = track()
    holdShare({} as MediaStream, v, a)
    releaseHeldShare('test')
    expect(v.stop).toHaveBeenCalled()
    expect(a.stop).toHaveBeenCalled()
    expect(heldShare()).toBeNull()
    releaseHeldShare('again')
  })

  it('a share that is already dead is never held in the first place', () => {
    setKeepShare(true)
    holdShare({} as MediaStream, track('ended'), null)
    expect(heldShare()).toBeNull()
  })
})
