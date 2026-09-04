import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { census, censusWhere, dynamicReads } from '../../scripts/switch-census.mjs'
import {
  DYNAMIC_READS,
  NOT_SWITCHES,
  SWITCHES,
  SWITCH_CEILING,
  SWITCH_GROUPS,
  changedSwitches,
  readSwitch,
  resetAllSwitches,
  switchById,
  switchStateLine,
  urlWithoutSwitches,
  writeSwitchStorage,
} from './switches'

/**
 * U4's gate. The registry is only worth something if it cannot lie, so every
 * one of these is a way it could: a switch the code reads with no row, a row for
 * a parameter nobody reads, a read the census cannot see, and a count that went
 * up.
 */
describe('the switch registry is the whole truth', () => {
  it('has a row for every URL parameter the product reads', () => {
    const rows = new Set(SWITCHES.map((s) => s.id))
    const missing = census().filter((name) => !rows.has(name) && !NOT_SWITCHES.has(name))
    expect(missing, `no panel row and no reason: ${missing.join(', ')}`).toEqual([])
  })

  it('has no row for a parameter nobody reads', () => {
    const read = new Set(census())
    const orphans = SWITCHES.filter((s) => !read.has(s.id)).map((s) => s.id)
    expect(orphans, `a row for a switch the code no longer reads: ${orphans.join(', ')}`).toEqual([])
  })

  it('accounts for every read whose parameter name is a variable', () => {
    const unexplained = dynamicReads()
      .map((d) => d.split(':')[0])
      .filter((file) => !DYNAMIC_READS.has(file))
    expect([...new Set(unexplained)], 'a switch could be added here invisibly').toEqual([])
  })

  it('stays under the ceiling — the count only ever goes down', () => {
    expect(SWITCHES.length).toBeLessThanOrEqual(SWITCH_CEILING)
  })

  it('gives every switch a plain-words label and a hint that says what to DO', () => {
    for (const s of SWITCHES) {
      expect(s.label.length, s.id).toBeGreaterThan(3)
      expect(s.hint.length, s.id).toBeGreaterThan(20)
      expect(SWITCH_GROUPS).toContain(s.group)
      if (s.kind === 'choice') expect(s.options?.length, s.id).toBeGreaterThan(1)
      // U4 part 3: no switch may exist without the census having ruled on it.
      expect(['fallback', 'harness', 'product', 'answered'], s.id).toContain(s.verdict)
    }
  })

  it('has one row per id and one storage key per switch', () => {
    const ids = SWITCHES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const keys = SWITCHES.map((s) => s.storageKey).filter((k): k is string => k !== null)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('points at a real file for every dynamic read it excuses', () => {
    const files = new Set(dynamicReads().map((d) => d.split(':')[0]))
    for (const file of DYNAMIC_READS.keys()) expect(files, file).toContain(file)
  })

  it('names where each switch is read, so a census miss is findable', () => {
    expect(censusWhere().get('nativeres')?.[0]).toMatch(/nativeRes\.ts:\d+/)
  })
})

/** Node has no localStorage; this is the whole of the one these tests use. */
function memoryStorage(): void {
  const mem = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  })
}

describe('the state line cannot lie', () => {
  beforeEach(memoryStorage)
  afterEach(() => vi.unstubAllGlobals())

  it('reads "default" on a clean load', () => {
    expect(switchStateLine('')).toBe('default')
    expect(changedSwitches('')).toEqual([])
  })

  it('names every switch on a dirty one — three set, three counted', () => {
    writeSwitchStorage(switchById('chunked')!, '0')
    writeSwitchStorage(switchById('painter')!, '2d')
    const line = switchStateLine('?nativeres=0')
    const changed = changedSwitches('?nativeres=0').map((r) => r.spec.id)
    expect(line).toBe('3 changed')
    expect(changed.sort()).toEqual(['chunked', 'nativeres', 'painter'])
  })

  it('says where each value comes from, because a URL parameter beats storage', () => {
    writeSwitchStorage(switchById('chunked')!, '0')
    const fromUrl = readSwitch(switchById('chunked')!, '?chunked=1')
    expect(fromUrl.source).toBe('url')
    expect(fromUrl.value).toBe('1')
    expect(fromUrl.stored).toBe('0')
    expect(readSwitch(switchById('chunked')!, '').source).toBe('storage')
  })

  it('does not count the quality slider as something Robert pressed by mistake', () => {
    writeSwitchStorage(switchById('qstep')!, 'max')
    expect(switchStateLine('')).toBe('default')
    // …but an override hiding in the address bar is exactly what it must catch.
    expect(switchStateLine('?qstep=540p')).toBe('1 changed')
  })

  it('counts a bare parameter as set', () => {
    expect(switchStateLine('?synthetic')).toBe('1 changed')
    expect(readSwitch(switchById('synthetic')!, '?synthetic').value).toBe('1')
  })
})

describe('reset puts everything back', () => {
  beforeEach(memoryStorage)
  afterEach(() => vi.unstubAllGlobals())

  it('clears storage AND strips the address bar', () => {
    writeSwitchStorage(switchById('chunked')!, '0')
    writeSwitchStorage(switchById('painter')!, '2d')
    const next = resetAllSwitches('https://inout.app/?nativeres=0&chunked=0&keepme=1#edit')
    expect(next).toBe('/?keepme=1#edit')
    expect(switchStateLine('')).toBe('default')
    expect(changedSwitches(next.slice(next.indexOf('?')))).toEqual([])
  })

  it('leaves a parameter that is not ours alone', () => {
    expect(urlWithoutSwitches('https://inout.app/?code=abc&test')).toBe('/?code=abc&test=')
  })
})
