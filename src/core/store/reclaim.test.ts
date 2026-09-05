import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * THE TWO DEFECTS THIS PINS, both reported the same way — "reclaim button still
 * fucking doing nothing" (Robert, 2026-08-30) — and both invisible from the
 * outside because their symptom is silence.
 *
 *  1. ONE LOCKED FILE KILLED THE WHOLE SWEEP. The button's own copy of this
 *     loop awaited `remove()` with no catch, so the first refusal threw and
 *     every remaining orphan survived untouched.
 *  2. IT COUNTED AND TARGETED THE EXPORT SCRATCH. `xport-*` is unreferenced by
 *     any Recording by design — it is the file a finished export's blob reads
 *     from — so a references-only rule reads a live export as garbage. It is
 *     also the file most likely to be open, which is how it triggered (1):
 *     the button was most reliably broken right after an export.
 */

const files: { key: string; size: number }[] = []
const locked = new Set<string>()
const removed: string[] = []
let recordings: { channels: { blobKey: string }[]; composite?: { blobKey: string } }[] = []
let pending: string[] = []

vi.mock('./index', () => ({
  blobStore: {
    list: () => Promise.resolve(files.map((f) => ({ ...f }))),
    remove: (key: string) => {
      if (locked.has(key)) return Promise.reject(new Error('still open'))
      removed.push(key)
      return Promise.resolve()
    },
  },
  recordingsRepo: { list: () => Promise.resolve(recordings) },
}))
vi.mock('@core/capture/recovery', () => ({ pendingBlobKeys: () => Promise.resolve(pending) }))
vi.mock('@core/compose/scratch', () => ({ SCRATCH_PREFIX: 'xport-' }))

const { orphanBlobBytes, reclaimOrphanBlobs } = await import('./reclaim')

beforeEach(() => {
  files.length = 0
  locked.clear()
  removed.length = 0
  recordings = []
  pending = []
})

describe('the orphan sweep', () => {
  it('a locked file costs ONE file, not the whole sweep', async () => {
    files.push(
      { key: 'a', size: 100 },
      { key: 'stuck', size: 200 },
      { key: 'b', size: 300 },
      { key: 'c', size: 400 },
    )
    locked.add('stuck')
    const r = await reclaimOrphanBlobs()
    expect(removed).toEqual(['a', 'b', 'c'])
    expect(r.removed).toBe(3)
    expect(r.failed).toBe(1)
    expect(r.bytes).toBe(800)
  })

  it('leaves the export scratch alone — it is a live file, not garbage', async () => {
    files.push({ key: 'xport-abc', size: 900 }, { key: 'junk', size: 50 })
    const r = await reclaimOrphanBlobs()
    expect(removed).toEqual(['junk'])
    expect(r.bytes).toBe(50)
  })

  /**
   * J10 — AND IT WOULD HAVE SILENTLY UNDONE J9. A claim file is referenced by
   * nothing on purpose: its whole content is its name, so `keepSet` can never
   * hold it, and this sweep would have deleted the one record that tells
   * another tab an export is running — at boot, beside the very sweeps that
   * read it. Found by reading this file rather than by a failure, which is why
   * it is pinned here.
   */
  it('leaves the render and pre-render claims alone — deleting them re-opens J9', async () => {
    files.push(
      { key: 'rclaim-abc-k1', size: 1 },
      { key: 'pclaim-abc-s1', size: 1 },
      { key: 'junk', size: 50 },
    )
    // The count first: a claim must not even be OFFERED as reclaimable.
    expect(await orphanBlobBytes()).toBe(50)
    const r = await reclaimOrphanBlobs()
    expect(removed).toEqual(['junk'])
    expect(r.bytes).toBe(50)
  })

  it('does not COUNT the export scratch either — the number and the button agree', async () => {
    files.push({ key: 'xport-abc', size: 900 }, { key: 'junk', size: 50 })
    expect(await orphanBlobBytes()).toBe(50)
  })

  it('never touches a saved take, its composite, or a pending recovery', async () => {
    files.push(
      { key: 'ch1', size: 10 },
      { key: 'comp', size: 20 },
      { key: 'crashed', size: 30 },
      { key: '__dump', size: 40 },
      { key: 'junk', size: 50 },
    )
    recordings = [{ channels: [{ blobKey: 'ch1' }], composite: { blobKey: 'comp' } }]
    pending = ['crashed']
    const r = await reclaimOrphanBlobs()
    expect(removed).toEqual(['junk'])
    expect(r.removed).toBe(1)
  })

  it('reports nothing-to-do rather than throwing, so the button can say so', async () => {
    const r = await reclaimOrphanBlobs()
    expect(r).toEqual({ removed: 0, bytes: 0, failed: 0 })
    expect(await orphanBlobBytes()).toBe(0)
  })
})
