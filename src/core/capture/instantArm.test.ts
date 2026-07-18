import { describe, expect, it } from 'vitest'
import { ACQUIRE_TIMEOUT_MS, primaryKindFor } from './acquire'
import { parseSlowChannels } from './synthetic'

describe('instant-arm primary channel selection', () => {
  const base = { screen: false, camera: false, mic: false, systemAudio: false }
  it('screen gates start whenever requested', () => {
    expect(primaryKindFor({ ...base, screen: true, camera: true, mic: true })).toBe('screen')
  })
  it('camera gates when no screen', () => {
    expect(primaryKindFor({ ...base, camera: true, mic: true })).toBe('camera')
  })
  it('audio-only takes gate on mic', () => {
    expect(primaryKindFor({ ...base, mic: true })).toBe('mic')
  })
  it('nothing requested → no primary', () => {
    expect(primaryKindFor(base)).toBeNull()
  })
})

describe('instant-arm harness knobs', () => {
  it('parses slow= into per-kind delays', () => {
    const m = parseSlowChannels('?synthetic=1&slow=camera:3000,mic:8000')
    expect(m.get('camera')).toBe(3000)
    expect(m.get('mic')).toBe(8000)
    expect(m.size).toBe(2)
  })
  it('ignores junk kinds and non-numeric delays', () => {
    const m = parseSlowChannels('?slow=webcam:100,camera:abc,mic:-5,screen:250')
    expect(m.size).toBe(1)
    expect(m.get('screen')).toBe(250)
  })
  it('empty when absent', () => {
    expect(parseSlowChannels('?synthetic=1').size).toBe(0)
  })
})

describe('acquire budget', () => {
  it('device budget is 5s — a hung device must not hold the take hostage', () => {
    expect(ACQUIRE_TIMEOUT_MS).toBe(5000)
  })
})
