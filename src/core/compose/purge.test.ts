import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * J11 — DELETING A VIDEO DELETES ITS VIDEO.
 *
 * Robert 2026-09-05: "i need deleting video in app delet all this video junk
 * too, users disk must not get trashed by our app". Measured on his own Chrome
 * the same day: 1,855 chunk files, 2.686 GB, for takes he had already dealt
 * with — sitting exactly on the cache ceiling, because a chunk was named by the
 * hash of its descriptor and a hash cannot be reversed, so nothing could ever
 * find a deleted take's render.
 */

const files = new Map<string, number>()
const jobs: { id: string; recordingId: string; result?: { blobKey: string } }[] = []
const locked = new Set<string>()
let cancelledFor: string | null = null
let liveJob: { recordingId: string; blobKey: string } | null = null

vi.mock('@core/store', () => ({
  EXPORTJOB_PREFIX: 'xjob-',
  blobStore: {
    list: () => Promise.resolve([...files].map(([key, size]) => ({ key, size }))),
    size: (key: string) =>
      files.has(key) ? Promise.resolve(files.get(key)!) : Promise.reject(new Error('gone')),
    remove: (key: string) => {
      if (locked.has(key)) return Promise.reject(new Error('still open'))
      files.delete(key)
      return Promise.resolve()
    },
  },
  jobsRepo: {
    list: () => Promise.resolve(jobs.map((j) => ({ ...j }))),
    remove: (id: string) => {
      const i = jobs.findIndex((j) => j.id === id)
      if (i >= 0) jobs.splice(i, 1)
      return Promise.resolve()
    },
  },
}))

const cancelledJobs: string[] = []
/** Jobs THIS page session is running. `removeExportJob` no-ops on any other —
 *  a row from an earlier session is a row, not work, and step 4 clears it. */
const liveIds = new Set<string>()
vi.mock('./exportJobs', () => ({
  removeExportJob: (id: string) => {
    if (!liveIds.has(id)) return
    cancelledJobs.push(id)
    const i = jobs.findIndex((j) => j.id === id)
    if (i >= 0) jobs.splice(i, 1)
    files.delete(`xjob-${id}`)
  },
}))

vi.mock('./prerender', () => ({
  prerenderBlobFor: (id: string) => (liveJob?.recordingId === id ? liveJob.blobKey : null),
  cancelPrerenderFor: (id: string) => {
    if (liveJob?.recordingId !== id) return false
    cancelledFor = id
    return true
  },
}))

const { purgeDerivedFor } = await import('./purge')
const { chunkKeyFor, recordingOfChunk, recordingOfChunkPart } = await import('./chunkStore')
const { recordingOfScratch } = await import('./scratch')
const { recordingOfAiSink } = await import('@core/ai/build')

const MINE = 'rec_aaaaaaaaaaaa'
const THEIRS = 'rec_bbbbbbbbbbbb'

beforeEach(() => {
  files.clear()
  locked.clear()
  jobs.length = 0
  cancelledJobs.length = 0
  liveIds.clear()
  cancelledFor = null
  liveJob = null
})

describe('a chunk key names the take that made it', () => {
  it('round-trips the recording id', () => {
    const key = chunkKeyFor(MINE, 'deadbeef')
    expect(key).toBe('rchunk-rec_aaaaaaaaaaaa-deadbeef')
    expect(recordingOfChunk(key)).toBe(MINE)
  })

  it('reads a key written before J11 as belonging to nobody', () => {
    // A bare hash: hex, so it carries no '-' and cannot be mistaken for an id.
    expect(recordingOfChunk('rchunk-deadbeefcafe1234')).toBeNull()
    // The FNV fallback shape too.
    expect(recordingOfChunk('rchunk-f1a2b3c4d5e6')).toBeNull()
  })

  it('is not confused by a key that is not a chunk at all', () => {
    expect(recordingOfChunk('prerender-s_x-p_y')).toBeNull()
    expect(recordingOfChunk('xjob-j_1')).toBeNull()
  })
})

describe('deleting a take takes its render with it', () => {
  it('removes every chunk of that take and not one of another', async () => {
    files.set(chunkKeyFor(MINE, 'h1'), 1_000_000)
    files.set(chunkKeyFor(MINE, 'h2'), 2_000_000)
    files.set(chunkKeyFor(THEIRS, 'h3'), 4_000_000)

    const r = await purgeDerivedFor(MINE)
    expect(r.removed).toBe(2)
    expect(r.bytes).toBe(3_000_000)
    expect(files.has(chunkKeyFor(THEIRS, 'h3'))).toBe(true)
  })

  it('leaves a pre-J11 chunk alone — it belongs to no take, and the sweep owns it', async () => {
    files.set('rchunk-deadbeef', 9_000)
    const r = await purgeDerivedFor(MINE)
    expect(r.removed).toBe(0)
    expect(files.has('rchunk-deadbeef')).toBe(true)
  })

  it('cancels and drops a pre-render for this take — the biggest file we write', async () => {
    liveJob = { recordingId: MINE, blobKey: 'prerender-s_1-p_1' }
    files.set('prerender-s_1-p_1', 6_800_000_000)

    const r = await purgeDerivedFor(MINE)
    expect(cancelledFor).toBe(MINE)
    expect(r.prerender).toBe(true)
    expect(r.bytes).toBe(6_800_000_000)
    expect(files.has('prerender-s_1-p_1')).toBe(false)
  })

  it("never cancels a pre-render belonging to a take the user is still working on", async () => {
    liveJob = { recordingId: THEIRS, blobKey: 'prerender-s_1-p_9' }
    files.set('prerender-s_1-p_9', 500)
    const r = await purgeDerivedFor(MINE)
    expect(cancelledFor).toBeNull()
    expect(r.prerender).toBe(false)
    expect(files.has('prerender-s_1-p_9')).toBe(true)
  })

  it("drops each finished export job's own copy of the output, and its row", async () => {
    jobs.push(
      { id: 'j_1', recordingId: MINE, result: { blobKey: 'xjob-j_1' } },
      { id: 'j_2', recordingId: MINE },
      { id: 'j_3', recordingId: THEIRS, result: { blobKey: 'xjob-j_3' } },
    )
    files.set('xjob-j_1', 400_000_000)
    files.set('xjob-j_3', 7_000)

    const r = await purgeDerivedFor(MINE)
    expect(r.jobs).toBe(2)
    expect(r.bytes).toBe(400_000_000)
    expect(files.has('xjob-j_1')).toBe(false)
    expect(files.has('xjob-j_3')).toBe(true)
    expect(jobs.map((j) => j.id)).toEqual(['j_3'])
  })

  it('counts a locked file instead of abandoning the rest of the delete', async () => {
    files.set(chunkKeyFor(MINE, 'h1'), 10)
    jobs.push({ id: 'j_1', recordingId: MINE, result: { blobKey: 'xjob-j_1' } })
    files.set('xjob-j_1', 20)
    locked.add('xjob-j_1')

    const r = await purgeDerivedFor(MINE)
    expect(r.failed).toBe(1)
    // The chunk still went, and the job row still went.
    expect(files.has(chunkKeyFor(MINE, 'h1'))).toBe(false)
    expect(jobs).toHaveLength(0)
  })

  it('does nothing, loudly or otherwise, for a take that rendered nothing', async () => {
    const r = await purgeDerivedFor(MINE)
    expect(r).toEqual({
      removed: 0, bytes: 0, jobs: 0, prerender: false, cancelled: 0, failed: 0,
    })
  })
})

/**
 * J12 — THE THREE TRANSIENT FILES. Each was bounded (a 6-hour TTL, or a
 * newest-only rule) and none carried a recording id, so a deleted take's export
 * scratch, its half-written chunk and its flattened-to-PDF copy all outlived
 * it. Robert, 2026-09-05: "fix those three too".
 */
describe('the transient files name their take as well', () => {
  it('reads the take out of each key, and out of none of the older shapes', () => {
    expect(recordingOfScratch(`xport-abc-${MINE}-x_1`)).toBe(MINE)
    expect(recordingOfChunkPart(`rchunkpart-abc-${MINE}-c_1`)).toBe(MINE)
    expect(recordingOfAiSink(`aixport-${MINE}-ai_1.pdf`)).toBe(MINE)
    // Pre-J12 shapes: no take, so a purge by take never touches them and the
    // TTL / newest-only rules keep owning them exactly as before.
    expect(recordingOfScratch('xport-abc-x_1')).not.toBe(MINE)
    expect(recordingOfChunkPart('rchunkpart-abc-c_1')).toBeNull()
    expect(recordingOfAiSink('aixport-ai_1.pdf')).toBeNull()
  })

  it('takes the export scratch, the staging chunk and the AI pdf with the take', async () => {
    files.set(`xport-abc-${MINE}-x_1`, 6_800_000_000)
    files.set(`rchunkpart-abc-${MINE}-c_1`, 3_000_000)
    files.set(`aixport-${MINE}-ai_1.pdf`, 40_000_000)
    // ...and one of each belonging to another take.
    files.set(`xport-abc-${THEIRS}-x_9`, 1)
    files.set(`rchunkpart-abc-${THEIRS}-c_9`, 1)
    files.set(`aixport-${THEIRS}-ai_9.pdf`, 1)

    const r = await purgeDerivedFor(MINE)
    expect(r.removed).toBe(3)
    expect(r.bytes).toBe(6_843_000_000)
    expect(files.has(`xport-abc-${THEIRS}-x_9`)).toBe(true)
    expect(files.has(`rchunkpart-abc-${THEIRS}-c_9`)).toBe(true)
    expect(files.has(`aixport-${THEIRS}-ai_9.pdf`)).toBe(true)
  })

  it('stops the export before deleting what it writes', async () => {
    jobs.push({ id: 'j_1', recordingId: MINE }, { id: 'j_2', recordingId: THEIRS })
    liveIds.add('j_1')
    liveIds.add('j_2')
    const r = await purgeDerivedFor(MINE)
    expect(cancelledJobs).toEqual(['j_1'])
    expect(r.cancelled).toBe(1)
    expect(jobs.map((j) => j.id)).toEqual(['j_2'])
  })
})

describe('a job row from a dead session is a row, not work', () => {
  it('clears it without claiming to have cancelled anything', async () => {
    jobs.push({ id: 'j_old', recordingId: MINE, result: { blobKey: 'xjob-j_old' } })
    files.set('xjob-j_old', 1234)
    const r = await purgeDerivedFor(MINE)
    expect(cancelledJobs).toEqual([])
    expect(r.cancelled).toBe(0)
    expect(r.jobs).toBe(1)
    expect(files.has('xjob-j_old')).toBe(false)
  })
})
