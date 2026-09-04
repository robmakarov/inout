import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fullColourActive,
  fullColourCodec,
  fullColourEnabled,
  setFullColourOverride,
} from './fullColour'

afterEach(() => {
  setFullColourOverride(null)
  vi.unstubAllGlobals()
})

describe('the colour switch is a colour word, not a codec word', () => {
  it('is off unless asked — the file is blind-shared and 4:4:4 has no hardware decoder', () => {
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('location', { search: '' })
    expect(fullColourEnabled()).toBe(false)
  })

  it('reads ?colour=all and ?colour=420', () => {
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('location', { search: '?colour=all' })
    expect(fullColourEnabled()).toBe(true)
    vi.stubGlobal('location', { search: '?colour=420' })
    expect(fullColourEnabled()).toBe(false)
  })

  it('falls through to off inside a worker, and obeys what the page forwarded', () => {
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('location', { search: '' })
    expect(fullColourActive()).toBe(false)
    setFullColourOverride(true)
    expect(fullColourActive()).toBe(true)
  })
})

describe('the capability gate', () => {
  /**
   * Node has no VideoEncoder at all, which is exactly the shape of a machine
   * that cannot encode 4:4:4: the probe must answer null and the export must
   * take today's rung, never throw and never encode a profile it did not probe.
   */
  it('answers null where there is no encoder, so the export keeps today’s rung', async () => {
    expect(typeof VideoEncoder).toBe('undefined')
    await expect(fullColourCodec(1920, 1080, 8_000_000)).resolves.toBeNull()
  })
})
