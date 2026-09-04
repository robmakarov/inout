import { afterEach, describe, expect, it, vi } from 'vitest'
import { glueRecorded, glueRung, setGlueRung } from './glue'
import { singleGenRung, setSingleGenRung } from './singleGen'
import { plannedBytesPerSec } from './capture/captureBitrate'

/**
 * J6 — THE GLUED COPY STOPS BEING ENCODED.
 *
 * Robert 2026-09-04 (27): "kill the glued copy encoding and do background
 * render while editing". The default here IS the ruling, so it is asserted
 * first and on its own: a test suite that only checked the flag round-trips
 * would have passed on the day the ruling was not executed.
 */
afterEach(() => {
  setGlueRung(null)
  setSingleGenRung(null)
  vi.unstubAllGlobals()
})

describe('the rung', () => {
  it('IS PAINT BY DEFAULT — the ruling, in one assertion', () => {
    expect(glueRung()).toBe('paint')
    expect(glueRecorded()).toBe(false)
  })

  it('puts yesterday’s take back, because the thing being replaced carries the switch', () => {
    setGlueRung('record')
    expect(glueRecorded()).toBe(true)
    setGlueRung('paint')
    expect(glueRecorded()).toBe(false)
  })

  it('null clears the sticky choice and returns to the default', () => {
    setGlueRung('record')
    setGlueRung(null)
    expect(glueRung()).toBe('paint')
  })

  it('a URL parameter wins for one load, and `1` means the OLD behaviour', () => {
    vi.stubGlobal('location', { search: '?glue=record' })
    expect(glueRecorded()).toBe(true)
    vi.stubGlobal('location', { search: '?glue=1' })
    expect(glueRecorded()).toBe(true)
    vi.stubGlobal('location', { search: '?glue=0' })
    expect(glueRecorded()).toBe(false)
    vi.stubGlobal('location', { search: '?glue=paint' })
    expect(glueRecorded()).toBe(false)
  })

  it('beats a sticky choice, and a value it does not know falls through to it', () => {
    setGlueRung('record')
    vi.stubGlobal('location', { search: '?glue=paint' })
    expect(glueRecorded()).toBe(false)
    vi.stubGlobal('location', { search: '?glue=banana' })
    expect(glueRecorded()).toBe(true)
  })
})

/**
 * THE `?singlegen=capture` RUNG IS GONE, and this is what says so.
 *
 * It was the blunt way to stop recording the composite — it stopped the whole
 * compositor and took the preview and the frozen-screen detector with it — and
 * J6 replaces it. A leftover link carrying it must not resurrect a rung that no
 * longer exists; it falls through to the default like any other unknown value.
 */
describe('the rung J6 deleted', () => {
  it('?singlegen=capture is no longer a rung and reads as the default', () => {
    vi.stubGlobal('location', { search: '?singlegen=capture' })
    expect(singleGenRung()).toBe('export')
  })

  it('the two rungs that are left still work', () => {
    vi.stubGlobal('location', { search: '?singlegen=off' })
    expect(singleGenRung()).toBe('off')
    vi.stubGlobal('location', { search: '?singlegen=export' })
    expect(singleGenRung()).toBe('export')
  })
})

/**
 * THE DISK GUARD MUST STOP PRICING A FILE THAT IS NOT WRITTEN.
 *
 * B5's minutes-left figure is shown BEFORE the press, off `plannedBytesPerSec`.
 * With the composite painted and not encoded, counting its bitrate would tell
 * the user they have less recording time than they do — the one direction a
 * guard is allowed to be wrong in, but wrong by a whole encoder's worth.
 */
describe('what the take is planned to write', () => {
  const config = { screen: true, camera: true, mic: true } as Parameters<typeof plannedBytesPerSec>[0]

  it('is smaller without the composite than with it', () => {
    const withGlue = plannedBytesPerSec({ ...config, composite: true })
    const painted = plannedBytesPerSec({ ...config, composite: false })
    expect(painted).toBeLessThan(withGlue)
  })
})
