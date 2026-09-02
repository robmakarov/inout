import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Recording } from '@core/types'

/**
 * THE SALVAGE PATH HAD NO TEST (H2, 2026-09-01).
 *
 * `salvagePendingRecording` is the only thing standing between a killed tab and
 * a lost take, and until this file the only coverage anywhere was the
 * EXPERIMENTAL copy in src/experimental/recovery — a different function over a
 * different orphan definition, which cannot fail when this one breaks.
 *
 * What H2 measured on real SIGKILLs is what these cases pin from underneath:
 * every channel comes back, the offsets between them survive, a channel that
 * cannot be read costs only itself, and a salvage that throws never bricks the
 * next boot. The numbers are in the handoff; this is the shape they depend on.
 */

const probed = new Map<string, number | Error>()
const removedBlobs: string[] = []
let saved: Recording[] = []
let existing: Recording | null = null

vi.mock('@core/store', () => ({
  blobStore: {
    read: (key: string) => Promise.resolve({ size: probed.has(key) ? 1024 : 0, key } as unknown as Blob),
    remove: (key: string) => {
      removedBlobs.push(key)
      return Promise.resolve()
    },
  },
  recordingsRepo: {
    get: () => Promise.resolve(existing),
    save: (r: Recording) => {
      saved.push(r)
      return Promise.resolve()
    },
    list: () => Promise.resolve(saved),
  },
}))

/** The demux is stubbed at the seam salvage actually uses: one duration per
 *  blob, or a throw where a crash left something unreadable. */
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {
    constructor(public blob: { key: string }) {}
  },
  Input: class {
    private key: string
    constructor(opts: { source: { blob: { key: string } } }) {
      this.key = opts.source.blob.key
    }
    computeDuration() {
      const v = probed.get(this.key)
      if (v instanceof Error) return Promise.reject(v)
      return Promise.resolve((v ?? 0) / 1000)
    }
    dispose() {}
  },
}))

const { clearPendingManifest, pendingBlobKeys, salvagePendingRecording, writePendingManifest } =
  await import('./recovery')

const store = new Map<string, string>()
function stubStorage() {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
}

/**
 * H2b(a) — THE DURABLE COPY, STUBBED AT THE SAME SEAM localStorage IS.
 *
 * One row map for the whole file (the module caches its open connection, so a
 * fresh map per test would be written to by a database nobody reads), plus the
 * two switches the cases below need: what durability the transaction asked for,
 * and a refusal that must cost the take nothing.
 */
const idbRows = new Map<string, string>()
let idbDurability: string | undefined
let idbRefuses = false

type Req = { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void }

function fakeStore(ops: (() => void)[]) {
  return {
    put(v: string, key: string) {
      const r: Req = {}
      ops.push(() => {
        idbRows.set(key, v)
        r.onsuccess?.()
      })
      return r
    },
    delete(k: string) {
      const r: Req = {}
      ops.push(() => {
        idbRows.delete(k)
        r.onsuccess?.()
      })
      return r
    },
    get(k: string) {
      const r: Req = {}
      ops.push(() => {
        r.result = idbRows.get(k)
        r.onsuccess?.()
      })
      return r
    },
  }
}

function stubIndexedDB() {
  idbDurability = undefined
  vi.stubGlobal('indexedDB', {
    open() {
      const req: Req & { onupgradeneeded?: () => void } = {}
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => idbRows.size >= 0 && false },
          createObjectStore: () => undefined,
          close: () => undefined,
          transaction(_name: string, _mode: string, opts?: { durability?: string }) {
            if (idbRefuses) throw new Error('storage refused')
            idbDurability = opts?.durability
            const ops: (() => void)[] = []
            const tx: { objectStore: () => unknown; oncomplete?: () => void; onerror?: () => void; onabort?: () => void; error: unknown } = {
              objectStore: () => fakeStore(ops),
              error: null,
            }
            queueMicrotask(() => {
              for (const op of ops) op()
              tx.oncomplete?.()
            })
            return tx
          },
        }
        req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  })
}

/** The durable writes are fire-and-forget from a synchronous caller; let the
 *  microtask chain they run on drain before asserting on the row. */
const settle = () => new Promise((r) => setTimeout(r, 0))

function manifest(channels: { id: string; blobKey: string; startOffsetMs: number; media?: 'video' | 'audio' }[]) {
  return {
    v: 1 as const,
    recordingId: 'rec_killed',
    createdAt: 1_700_000_000_000,
    channels: channels.map((c) => ({
      id: c.id,
      kind: 'screen' as const,
      media: (c.media ?? 'video') as 'video' | 'audio',
      mimeType: 'video/mp4',
      blobKey: c.blobKey,
      startOffsetMs: c.startOffsetMs,
    })),
  }
}

beforeEach(() => {
  store.clear()
  idbRows.clear()
  idbRefuses = false
  probed.clear()
  removedBlobs.length = 0
  saved = []
  existing = null
  stubStorage()
  stubIndexedDB()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('salvaging a killed take', () => {
  it('keeps every channel that decodes, and the gaps between them', async () => {
    writePendingManifest(manifest([
      { id: 'a', blobKey: 'k_a', startOffsetMs: 200 },
      { id: 'b', blobKey: 'k_b', startOffsetMs: 350 },
    ]))
    probed.set('k_a', 30_000)
    probed.set('k_b', 29_800)

    const rec = await salvagePendingRecording()
    expect(rec?.channels.map((c) => c.id)).toEqual(['a', 'b'])
    // Rebased onto the first channel to arrive, and the 150 ms between them —
    // which is the sync the take was recorded with — survives the rebasing.
    expect(rec?.channels.map((c) => c.startOffsetMs)).toEqual([0, 150])
    // The take is as long as its LAST material, not as its longest channel.
    expect(rec?.durationMs).toBe(30_000)
    expect(saved).toHaveLength(1)
  })

  it('a channel that will not decode costs only itself', async () => {
    writePendingManifest(manifest([
      { id: 'good', blobKey: 'k_good', startOffsetMs: 0 },
      { id: 'torn', blobKey: 'k_torn', startOffsetMs: 10 },
    ]))
    probed.set('k_good', 12_000)
    probed.set('k_torn', new Error('moov never closed'))

    const rec = await salvagePendingRecording()
    expect(rec?.channels.map((c) => c.id)).toEqual(['good'])
    expect(rec?.durationMs).toBe(12_000)
  })

  it('a channel the crash left empty is dropped rather than saved at zero', async () => {
    writePendingManifest(manifest([
      { id: 'good', blobKey: 'k_good', startOffsetMs: 0 },
      { id: 'empty', blobKey: 'k_empty', startOffsetMs: 5 },
    ]))
    probed.set('k_good', 8_000)
    probed.set('k_empty', 0)

    const rec = await salvagePendingRecording()
    expect(rec?.channels.map((c) => c.id)).toEqual(['good'])
  })

  it('nothing decodable is no take, and nothing is written', async () => {
    writePendingManifest(manifest([{ id: 'a', blobKey: 'k_a', startOffsetMs: 0 }]))
    probed.set('k_a', 0)
    expect(await salvagePendingRecording()).toBeNull()
    expect(saved).toEqual([])
  })

  it('is one-shot: a second boot after a salvage does not run it again', async () => {
    writePendingManifest(manifest([{ id: 'a', blobKey: 'k_a', startOffsetMs: 0 }]))
    probed.set('k_a', 5_000)
    expect(await salvagePendingRecording()).not.toBeNull()
    // The manifest is consumed BEFORE the work, so a salvage that throws cannot
    // brick every subsequent boot with the same throw.
    expect(await salvagePendingRecording()).toBeNull()
  })

  it('drops the crashed composite instead of orphaning it, under both names', async () => {
    writePendingManifest(manifest([{ id: 'a', blobKey: 'k_a', startOffsetMs: 0 }]))
    probed.set('k_a', 5_000)
    await salvagePendingRecording()
    // A crash-truncated composite has an unknown tail and must never be packet
    // copied (2026-08-23) — so it is removed, not salvaged.
    expect(removedBlobs).toEqual(['rec_killed_composite.mp4', 'rec_killed_composite.webm'])
  })

  it('never rebuilds a take the repo already has', async () => {
    writePendingManifest(manifest([{ id: 'a', blobKey: 'k_a', startOffsetMs: 0 }]))
    probed.set('k_a', 5_000)
    existing = { id: 'rec_killed', createdAt: 0, durationMs: 1, channels: [] }
    expect(await salvagePendingRecording()).toBeNull()
    expect(saved).toEqual([])
  })
})

describe('the manifest the salvage hangs off', () => {
  it('names exactly the blobs the orphan sweep must leave alone', async () => {
    writePendingManifest(manifest([
      { id: 'a', blobKey: 'k_a', startOffsetMs: 0 },
      { id: 'b', blobKey: 'k_b', startOffsetMs: 0 },
    ]))
    // These are unreferenced by any Recording ON PURPOSE — the row is written at
    // stop and this stands in for it until then. Reclaiming them would turn a
    // recoverable take into a lost one.
    expect(await pendingBlobKeys()).toEqual(['k_a', 'k_b'])
  })

  it('a clean stop clears only its own take', async () => {
    writePendingManifest(manifest([{ id: 'a', blobKey: 'k_a', startOffsetMs: 0 }]))
    clearPendingManifest('rec_someone_else')
    await settle()
    expect(await pendingBlobKeys()).toEqual(['k_a'])
    clearPendingManifest('rec_killed')
    await settle()
    expect(await pendingBlobKeys()).toEqual([])
  })

  it('a refused localStorage costs the take nothing at record time', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => undefined,
    })
    expect(() => writePendingManifest(manifest([{ id: 'a', blobKey: 'k_a', startOffsetMs: 0 }]))).not.toThrow()
    await settle()
    // The DURABLE copy still has it: a browser that refuses localStorage is
    // exactly the case the second home exists for.
    expect(await pendingBlobKeys()).toEqual(['k_a'])
  })
})

/**
 * H2b(a) — THE FLOOR H2 MEASURED, PINNED FROM UNDERNEATH.
 *
 * The kills at 2.8 / 3.3 / 4.2 s lost the whole take because the only pointer
 * to blobs already on disk was in a localStorage buffer inside the process that
 * died. These cases are that crash, staged at the seam: the manifest is written,
 * localStorage is then emptied as the kill emptied it, and the take must still
 * come back.
 */
describe('the manifest survives a crash localStorage does not', () => {
  it('salvages from the durable copy when localStorage lost the manifest', async () => {
    writePendingManifest(manifest([
      { id: 'a', blobKey: 'k_a', startOffsetMs: 200 },
      { id: 'b', blobKey: 'k_b', startOffsetMs: 350 },
    ]))
    await settle()
    probed.set('k_a', 4_000)
    probed.set('k_b', 3_800)
    // The crash: everything localStorage held is gone.
    store.clear()

    const rec = await salvagePendingRecording()
    expect(rec?.channels.map((c) => c.id)).toEqual(['a', 'b'])
    expect(rec?.channels.map((c) => c.startOffsetMs)).toEqual([0, 150])
  })

  it('asks for a real flush, not a promise of one', async () => {
    writePendingManifest(manifest([{ id: 'a', blobKey: 'k_a', startOffsetMs: 0 }]))
    await settle()
    // 'relaxed' is the default, and it is the property localStorage was already
    // lost to: the commit event can fire before the bytes are anywhere.
    expect(idbDurability).toBe('strict')
  })

  it('keeps the sweep off blobs only the durable copy claims', async () => {
    writePendingManifest(manifest([{ id: 'a', blobKey: 'k_a', startOffsetMs: 0 }]))
    await settle()
    store.clear()
    // Deleting these would turn the one recoverable take into a lost one.
    expect(await pendingBlobKeys()).toEqual(['k_a'])
  })

  it('is one-shot in BOTH homes: a salvage consumes the durable copy too', async () => {
    writePendingManifest(manifest([{ id: 'a', blobKey: 'k_a', startOffsetMs: 0 }]))
    await settle()
    probed.set('k_a', 5_000)
    store.clear()
    expect(await salvagePendingRecording()).not.toBeNull()
    expect(await salvagePendingRecording()).toBeNull()
    expect(await pendingBlobKeys()).toEqual([])
  })

  it('a refused IndexedDB costs the take nothing at record time', async () => {
    idbRefuses = true
    expect(() =>
      writePendingManifest(manifest([{ id: 'a', blobKey: 'k_a', startOffsetMs: 0 }])),
    ).not.toThrow()
    await settle()
    // The shipped path is untouched by the new one failing.
    expect(await pendingBlobKeys()).toEqual(['k_a'])
  })

  it('?crashfloor=0 writes nothing durable — the shipped path, byte for byte', async () => {
    store.set('inout.capture.crashfloor', '0')
    writePendingManifest(manifest([{ id: 'a', blobKey: 'k_a', startOffsetMs: 0 }]))
    await settle()
    expect(idbRows.size).toBe(0)
    store.clear()
    store.set('inout.capture.crashfloor', '0')
    // Nothing to fall back to: exactly what H2 measured at 2.8 s.
    expect(await pendingBlobKeys()).toEqual([])
    expect(await salvagePendingRecording()).toBeNull()
  })
})
