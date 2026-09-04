import { afterEach, describe, expect, it, vi } from 'vitest'
import { noiseGateActive, noiseGateEnabled, setNoiseGate, setNoiseGateOverride } from './gateFlag'

/**
 * OFF, AND OFF MEANS THE EXPORT IS THE ONE THAT SHIPPED. O10c changes the
 * samples themselves, so the whole task rests on this switch answering `false`
 * everywhere nothing has been said — including inside the export worker, which
 * has no `localStorage` and whose `location` is its own script URL (the trap
 * that left `?cq=`, `?loudness=` and `?sourceframe=` dead on the shipped path
 * from O5a until 2026-08-30).
 */
function at(search: string, stored: string | null = null): void {
  vi.stubGlobal('location', { search })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k === 'inout.compose.noisegate' ? stored : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  })
}

afterEach(() => {
  setNoiseGateOverride(null)
  vi.unstubAllGlobals()
})

describe('the noise gate is off until it is asked for', () => {
  it('is off with no location, no storage and nothing told to it', () => {
    at('')
    expect(noiseGateEnabled()).toBe(false)
    expect(noiseGateActive()).toBe(false)
  })

  it('is off in a worker, where there is no storage at all', () => {
    vi.stubGlobal('location', { search: '' })
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('no storage in here')
      },
    })
    expect(noiseGateActive()).toBe(false)
  })

  it('takes on / 1 / true, and off / 0 / false', () => {
    for (const on of ['on', '1', 'true']) {
      at(`?noisegate=${on}`)
      expect(noiseGateEnabled(), on).toBe(true)
    }
    for (const off of ['off', '0', 'false']) {
      at(`?noisegate=${off}`, 'on')
      expect(noiseGateEnabled(), off).toBe(false)
    }
  })

  it('reads the sticky value when the address bar says nothing', () => {
    at('', 'on')
    expect(noiseGateEnabled()).toBe(true)
    at('', 'off')
    expect(noiseGateEnabled()).toBe(false)
  })

  it('lets a URL parameter beat both storage and what the worker was told', () => {
    at('?noisegate=off', 'on')
    setNoiseGateOverride(true)
    expect(noiseGateActive()).toBe(false)
  })

  it('is TOLD, because the worker cannot read the page', () => {
    at('')
    setNoiseGateOverride(true)
    expect(noiseGateActive()).toBe(true)
    setNoiseGateOverride(null)
    expect(noiseGateActive()).toBe(false)
  })

  it('clears back to the default rather than remembering an off', () => {
    const written: Record<string, string | null> = {}
    vi.stubGlobal('location', { search: '' })
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => written[k] ?? null,
      setItem: (k: string, v: string) => void (written[k] = v),
      removeItem: (k: string) => void delete written[k],
    })
    setNoiseGate(true)
    expect(noiseGateEnabled()).toBe(true)
    setNoiseGate(null)
    expect(written['inout.compose.noisegate']).toBeUndefined()
    expect(noiseGateEnabled()).toBe(false)
  })
})

/**
 * THE GATE CANNOT LEAK WHEN IT IS OFF — asserted on the source, in the style of
 * doorOnly.test.ts, because "off is byte-identical" is a claim about which code
 * runs and not about a value.
 */
const SOURCE = import.meta.glob('/src/{core,app}/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe('nothing outside the flagged branch can reach the gate', () => {
  it('is used by render.ts and nothing else that ships', () => {
    const users = Object.entries(SOURCE)
      .filter(([path]) => !/\.test\.tsx?$/.test(path))
      .filter(([path, src]) => path !== '/src/core/compose/spectralGate.ts' && /StreamingGate|noiseProfile\(/.test(src))
      .map(([path]) => path)
    expect(users).toEqual(['/src/core/compose/render.ts'])
  })

  it('runs only behind `gateOn`, which is the flag', () => {
    const render = SOURCE['/src/core/compose/render.ts']!
    expect(render).toContain('const gateOn = wantAudio && noiseGateActive()')
    // Every entry into the gate is guarded: the chunk branch by `if (gateOn)`,
    // the tail by finishGate's own early return.
    expect(render).toContain('if (gateOn) {')
    expect(render).toContain('if (!gateOn) return')
  })
})

describe('the copying paths decline when the gate is on', () => {
  it('says so by name in choose.ts — a switch that silently does nothing is the defect', () => {
    const choose = SOURCE['/src/core/compose/choose.ts']!
    expect(choose).toContain('const wantGate = noiseGateActive()')
    expect(choose).toContain('the noise gate is on: a packet copy hands over the sound the take already has')
    // The instant/smart-cut source is refused when it is on, the same way full
    // colour and separate tracks refuse it.
    expect(choose).toContain('fullColour || wantSeparate || wantGate ? null : copy.source')
  })
})

describe('a gated file says so in its own certificate', () => {
  it('carries audio.noiseGate only when the gate is on', () => {
    const certify = SOURCE['/src/core/compose/certify.ts']!
    expect(certify).toContain("...(noiseGateActive() ? { noiseGate: true as const } : null)")
    // Absent, not `false`: every file before this existed has no such field,
    // and a default export must stay byte-identical in its comment tag too.
    expect(certify).toContain('noiseGate?: true')
  })
})
