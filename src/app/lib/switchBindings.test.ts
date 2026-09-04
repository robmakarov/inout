import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SWITCHES, switchById, writeSwitchStorage } from '@core/switches'
import { SWITCH_READERS, liveValue } from './switchBindings'

/**
 * THE ROW MUST DO WHAT IT SAYS. A panel row that writes `separate` into a key
 * the module reads as `multi` shows Robert a setting his takes are not made
 * with — the exact defect U4 exists to end — and no amount of care in the
 * registry catches it, because the registry is where the mistake would be.
 *
 * So this walks the registry, writes each row's OWN encoding into storage, and
 * asks the module what it will do on the next take.
 */
function memoryStorage(): Map<string, string> {
  const mem = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  })
  vi.stubGlobal('location', { search: '' })
  return mem
}

beforeEach(memoryStorage)
afterEach(() => vi.unstubAllGlobals())

describe('every sticky switch is bound to the module that reads it', () => {
  const sticky = SWITCHES.filter((s) => s.storageKey !== null)

  it('has a live reader for every switch that is not link-only', () => {
    const unbound = sticky.filter((s) => !SWITCH_READERS[s.id]).map((s) => s.id)
    expect(unbound, 'a panel row that cannot say what it is doing').toEqual([])
  })

  it.each(sticky.filter((s) => s.kind === 'toggle').map((s) => s.id))(
    '%s: writing 1 and 0 moves what the module will do',
    (id) => {
      const spec = switchById(id)!
      writeSwitchStorage(spec, '1')
      expect(liveValue(id), `${id} did not read the "1" this panel writes`).toBe('1')
      writeSwitchStorage(spec, '0')
      expect(liveValue(id), `${id} did not read the "0" this panel writes`).toBe('0')
    },
  )

  it.each(
    sticky
      .filter((s) => s.kind === 'choice')
      .flatMap((s) => (s.options ?? []).map((o) => [s.id, o] as const)),
  )('%s: the option "%s" is what the module reads back', (id, option) => {
    writeSwitchStorage(switchById(id)!, option)
    expect(liveValue(id), `${id}=${option} is not the encoding this module reads`).toBe(option)
  })

  it('reads the numbers back too', () => {
    writeSwitchStorage(switchById('gop')!, '5')
    expect(liveValue('gop')).toBe('5')
    writeSwitchStorage(switchById('cq')!, '28')
    expect(liveValue('cq')).toBe('28')
    writeSwitchStorage(switchById('cq')!, 'off')
    expect(liveValue('cq')).toBe('off')
  })

  it('never throws for a switch that has no module to ask', () => {
    expect(liveValue('killenc')).toBeNull()
    expect(liveValue('nothing-of-the-sort')).toBeNull()
  })
})
