import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WEDGE_NOTICE_WINDOW_MS,
  WEDGE_RELOAD_WINDOW_MS,
  noteWedgeReload,
  shouldReloadForWedge,
  wedgeReloadNoticeDue,
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

  it('the boot notice shows only right after a wedge-refresh', () => {
    expect(wedgeReloadNoticeDue(1_000_000)).toBe(false)
    noteWedgeReload(1_000_000)
    expect(wedgeReloadNoticeDue(1_000_000 + 5_000)).toBe(true)
    expect(wedgeReloadNoticeDue(1_000_000 + WEDGE_NOTICE_WINDOW_MS + 1)).toBe(false)
  })
})
