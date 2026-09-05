import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportResult } from '@core/types'

/**
 * J9 — LOSING A CHUNK MUST NOT COST THE TAKE.
 *
 * The defect these pin is one line of control flow: every caller answered a
 * `ChunkedRenderUnavailable` by rendering the whole take unbroken from frame
 * zero. On a 90-minute max60 take that is a second full generation of picture
 * on a machine that renders max60 at about 1x realtime — the export ran longer
 * than the recording, which is exactly what Robert reported on 2026-09-05.
 *
 * Two of the three triggers were live and neither needed a rare machine:
 *   · a second tab's BOOT sweep deletes chunks the first tab is concatenating
 *     (App.tsx passes no keep set — it has no plan to pass);
 *   · one stale chunk disagreeing with its neighbours on codec.
 * The third — the cache filling mid-render — was silent until now.
 */

const files = new Map<string, { size: number; mtime: number }>()

vi.mock('@core/store', () => ({
  blobStore: {
    list: () => Promise.resolve([...files].map(([key, f]) => ({ key, size: f.size }))),
    size: (key: string) =>
      files.has(key) ? Promise.resolve(files.get(key)!.size) : Promise.reject(new Error('gone')),
    read: (key: string) =>
      files.has(key)
        ? Promise.resolve({ lastModified: files.get(key)!.mtime } as unknown as Blob)
        : Promise.reject(new Error('gone')),
    remove: (key: string) => {
      files.delete(key)
      return Promise.resolve()
    },
    move: (from: string, to: string) => {
      const f = files.get(from)
      if (f) {
        files.delete(from)
        files.set(to, f)
      }
      return Promise.resolve()
    },
  },
  createPositionedWriter: (key: string) =>
    Promise.resolve({
      write: (data: Uint8Array) => {
        files.set(key, { size: data.byteLength, mtime: Date.now() })
        return Promise.resolve()
      },
      close: () => Promise.resolve(),
    }),
}))

const { ChunkedRenderUnavailable, renderChunkedResuming } = await import('./chunkedRender')
const { CHUNK_PREFIX, claimChunkCache, makeRoomForChunks, resetChunkStoreForTests, sweepChunks } =
  await import('./chunkStore')

const RESULT = { fileName: 'x.mp4', durationMs: 1 } as unknown as ExportResult
const opts = {} as Parameters<typeof renderChunkedResuming>[0]

/**
 * A finished chunk of `size` bytes, last touched `agoMs` ago.
 *
 * J11: the key must NAME A TAKE. Written as `${CHUNK_PREFIX}${name}` these
 * tests still passed, but for the wrong reason — a key with no recording
 * segment is a pre-J11 key and the sweep now removes it on sight, so a TTL
 * assertion would have been proving the pre-J11 rule instead.
 */
const TAKE = 'rec_cccccccccccc'
function chunk(name: string, size: number, agoMs = 0): string {
  const key = `${CHUNK_PREFIX}${TAKE}-${name}`
  files.set(key, { size, mtime: Date.now() - agoMs })
  return key
}

beforeEach(() => {
  files.clear()
  resetChunkStoreForTests()
  vi.restoreAllMocks()
})

describe('a lost piece costs the piece, not the take', () => {
  it('renders unbroken when the take cannot be chunked at all', async () => {
    const attempt = vi.fn(async () => {
      throw new ChunkedRenderUnavailable('the take has no video')
    })
    await expect(renderChunkedResuming(opts, attempt)).rejects.toThrow('no video')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('re-enters once when a chunk went missing, and keeps what the first pass made', async () => {
    const attempt = vi
      .fn<() => Promise<ExportResult>>()
      .mockRejectedValueOnce(new ChunkedRenderUnavailable('chunk 812 is gone from the cache', true))
      .mockResolvedValueOnce(RESULT)
    await expect(renderChunkedResuming(opts, attempt)).resolves.toBe(RESULT)
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('gives up after exactly one retry — a disk losing chunks is not worth a third pass', async () => {
    const attempt = vi.fn(async () => {
      throw new ChunkedRenderUnavailable('chunk 3 is gone from the cache', true)
    })
    await expect(renderChunkedResuming(opts, attempt)).rejects.toThrow('chunk 3')
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('never retries an abort — a cancelled export is cancelled', async () => {
    const attempt = vi.fn(async () => {
      throw new DOMException('Export aborted', 'AbortError')
    })
    await expect(renderChunkedResuming(opts, attempt)).rejects.toThrow('aborted')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('marks a plan refusal unrecoverable and a piece failure recoverable', () => {
    expect(new ChunkedRenderUnavailable('no plan').recoverable).toBe(false)
    expect(new ChunkedRenderUnavailable('chunk 1 is gone from the cache', true).recoverable).toBe(true)
  })
})

describe("another tab's sweep cannot eat a live render", () => {
  it('stands down while an export holds a claim, and sweeps once it is released', async () => {
    chunk('old', 10, 48 * 60 * 60 * 1000)
    const claim = await claimChunkCache()
    expect(claim).not.toBeNull()

    const during = await sweepChunks()
    expect(during.deferred).toBe(true)
    expect(during.removed).toBe(0)
    expect(files.has(`${CHUNK_PREFIX}${TAKE}-old`)).toBe(true)

    await claim!.release()
    const after = await sweepChunks()
    expect(after.deferred).toBe(false)
    expect(after.removed).toBe(1)
  })

  it('ignores a claim left by a tab that died, so a leak cannot block the sweep forever', async () => {
    chunk('old', 10, 48 * 60 * 60 * 1000)
    // A claim names its own heartbeat, so an ancient one is readable as stale
    // without opening it. Three minutes is past the two-minute window.
    files.set(`rclaim-${(Date.now() - 3 * 60 * 1000).toString(36)}-kdead`, {
      size: 1,
      mtime: 0,
    })
    const swept = await sweepChunks()
    expect(swept.deferred).toBe(false)
    expect(swept.removed).toBe(1)
    expect([...files.keys()].some((k) => k.startsWith('rclaim-'))).toBe(false)
  })
})

describe('the cache is asked whether the take fits, before the hour is spent', () => {
  const quota = (bytes: number): void => {
    vi.stubGlobal('navigator', {
      storage: { estimate: () => Promise.resolve({ quota: bytes }) },
    })
  }

  it('evicts another take’s chunks to make room for this one', async () => {
    quota(4000) // cap = 1000
    const mine = chunk('mine', 400, 0)
    chunk('stale', 400, 10 * 60 * 1000)
    chunk('staler', 400, 20 * 60 * 1000)

    const room = await makeRoomForChunks(500, new Set([mine]))
    expect(room.fits).toBe(true)
    expect(room.freedBytes).toBe(800)
    expect(files.has(mine)).toBe(true)
    // Least recently used went first.
    expect(files.has(`${CHUNK_PREFIX}${TAKE}-staler`)).toBe(false)
  })

  it('says so when the take is simply bigger than the cache can hold', async () => {
    quota(4000) // cap = 1000
    const mine = chunk('mine', 400, 0)
    const room = await makeRoomForChunks(5000, new Set([mine]))
    expect(room.fits).toBe(false)
    expect(room.capBytes).toBe(1000)
    // And it did not delete this export's own work on the way to finding out.
    expect(files.has(mine)).toBe(true)
  })

  it('changes nothing when the browser will not say what the quota is', async () => {
    quota(0)
    chunk('a', 400, 0)
    const room = await makeRoomForChunks(1e12, new Set())
    expect(room.fits).toBe(true)
    expect(room.freedBytes).toBe(0)
    expect(files.has(`${CHUNK_PREFIX}${TAKE}-a`)).toBe(true)
  })
})

describe('a chunk key from before J11 is unreachable, not merely old', () => {
  it('is swept on sight, whatever its age, because its shape can never be hit again', async () => {
    // Fresh: a TTL rule would keep this for 24 hours.
    files.set(`${CHUNK_PREFIX}deadbeefcafe`, { size: 2_686_000_000, mtime: Date.now() })
    const swept = await sweepChunks()
    expect(swept.removed).toBe(1)
    expect(swept.freedBytes).toBe(2_686_000_000)
    expect(files.has(`${CHUNK_PREFIX}deadbeefcafe`)).toBe(false)
  })

  it('keeps a key that does name a take', async () => {
    const mine = chunk('h1', 10)
    expect((await sweepChunks()).removed).toBe(0)
    expect(files.has(mine)).toBe(true)
  })
})
