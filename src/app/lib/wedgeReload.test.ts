import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WEDGE_RELOAD_WINDOW_MS,
  noteWedgeReload,
  shouldReloadForWedge,
  takeWedgeReloadNotice,
} from './wedgeReload'

// The capture test environment has no DOM storage; the module itself treats a
// missing/refusing sessionStorage as "never reloaded", so the tests provide one.
const store = new Map<string, string>()
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, String(v))
  },
  removeItem: (k: string) => {
    store.delete(k)
  },
  clear: () => store.clear(),
})

afterEach(() => {
  store.clear()
})

describe('the wedge refresh ritual', () => {
  it('the first wedge gets an automatic refresh', () => {
    expect(shouldReloadForWedge(1_000_000)).toBe(true)
  })

  it('a wedge right after a wedge-refresh does NOT reload again — no loop, show ⌘Q instead', () => {
    noteWedgeReload(1_000_000)
    expect(shouldReloadForWedge(1_000_000 + 30_000)).toBe(false)
    // …but a wedge long after the last ritual earns a fresh refresh.
    expect(shouldReloadForWedge(1_000_000 + WEDGE_RELOAD_WINDOW_MS + 1)).toBe(true)
  })

  it('no wedge, no notice', () => {
    expect(takeWedgeReloadNotice(1_000_000)).toBe(false)
  })

  it('SURVIVES A SLOW BOOT — the wedge saturates the machine, so its own reload is the slow one', () => {
    noteWedgeReload(1_000_000)
    // The old rule expired the notice after 15 s and Robert got no message at all
    // on a machine loaded enough to wedge in the first place.
    expect(takeWedgeReloadNotice(1_000_000 + 45_000)).toBe(true)
  })

  it('shows exactly once — a remount must not repeat it', () => {
    noteWedgeReload(1_000_000)
    expect(takeWedgeReloadNotice(1_000_000 + 5_000)).toBe(true)
    expect(takeWedgeReloadNotice(1_000_000 + 5_100)).toBe(false)
  })

  it('a reload that never committed does not surprise the user much later', () => {
    noteWedgeReload(1_000_000)
    expect(takeWedgeReloadNotice(1_000_000 + WEDGE_RELOAD_WINDOW_MS + 1)).toBe(false)
  })

  it('taking the notice leaves the ⌘Q escalation armed', () => {
    noteWedgeReload(1_000_000)
    takeWedgeReloadNotice(1_000_000 + 5_000)
    expect(shouldReloadForWedge(1_000_000 + 30_000)).toBe(false)
  })
})
