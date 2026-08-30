import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditState, ExportJobRecord, ExportResult, Recording } from '@core/types'

/**
 * The export-job contract (2026-08-30). Three properties carry the feature:
 * a cancelled job DELIVERS NOTHING (the bug that started this: cancel, then
 * the download fired anyway when the render finished), a duplicate press
 * JOINS the running job, and a job interrupted by a refresh restarts — but
 * not forever.
 */

let exportCalls = 0
let settle: ((r: { result: ExportResult }) => void) | null = null
let fail: ((e: unknown) => void) | null = null

vi.mock('./choose', () => ({
  exportByBestPath: (opts: { signal?: AbortSignal }) => {
    exportCalls += 1
    return new Promise<{ result: ExportResult }>((res, rej) => {
      settle = res
      fail = rej
      opts.signal?.addEventListener('abort', () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        rej(e)
      })
    })
  },
}))

const saved: ExportResult[] = []
vi.mock('@core/share', () => ({
  saveToFile: (r: ExportResult) => {
    saved.push(r)
  },
}))

vi.mock('@core/analytics', () => ({ analytics: { track: () => undefined } }))

const repo = new Map<string, ExportJobRecord>()
const blobs = new Map<string, number>()
const recordings = new Map<string, Recording>()
vi.mock('@core/store', () => ({
  EXPORTJOB_PREFIX: 'xjob-',
  jobsRepo: {
    save: (r: ExportJobRecord) => {
      repo.set(r.id, structuredClone(r))
      return Promise.resolve()
    },
    list: () => Promise.resolve([...repo.values()].map((r) => structuredClone(r))),
    remove: (id: string) => {
      repo.delete(id)
      return Promise.resolve()
    },
  },
  recordingsRepo: {
    get: (id: string) => Promise.resolve(recordings.get(id)),
  },
  blobStore: {
    read: (key: string) =>
      Promise.resolve({
        size: blobs.get(key) ?? 0,
        slice: (_s: number, _e: number, type: string) =>
          ({ size: blobs.get(key) ?? 0, type }) as unknown as Blob,
      }),
    remove: (key: string) => {
      blobs.delete(key)
      return Promise.resolve()
    },
    list: () => Promise.resolve([...blobs.keys()].map((key) => ({ key, size: 1 }))),
  },
  persistBlobCopy: (blob: Blob, key: string) => {
    blobs.set(key, blob.size)
    return Promise.resolve({ size: blob.size, type: blob.type } as unknown as Blob)
  },
}))

const {
  removeExportJob,
  resetExportJobsForTests,
  resumeExportJobs,
  startExportJob,
  subscribeExportJobs,
} = await import('./exportJobs')

const recording = { id: 'rec1', createdAt: 0, durationMs: 1000, channels: [] } as unknown as Recording
const edit = { channels: [], segments: [] } as unknown as EditState

function fakeResult(): { result: ExportResult } {
  return {
    result: {
      blob: { size: 42, type: 'video/mp4' } as unknown as Blob,
      mimeType: 'video/mp4',
      fileName: 'inout-test.mp4',
      durationMs: 1000,
      width: 1920,
      height: 1080,
      scratchKey: 'xport-abc',
    },
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  resetExportJobsForTests()
  exportCalls = 0
  settle = null
  fail = null
  saved.length = 0
  repo.clear()
  blobs.clear()
  recordings.clear()
})

describe('export jobs', () => {
  it('a finished job downloads once, keeps its row, and lands a durable copy', async () => {
    let rows: ExportJobRecord[] = []
    subscribeExportJobs((r) => {
      rows = r
    })
    const id = startExportJob({ kind: 'video', recording, edit, allowPacketCopy: true })
    expect(rows[0]?.state).toBe('running')
    settle!(fakeResult())
    await flush()
    expect(saved.length).toBe(1)
    expect(rows[0]?.state).toBe('done')
    expect(rows[0]?.result?.fileName).toBe('inout-test.mp4')
    // The durable copy landed under the job's own key and was persisted.
    expect(blobs.has(`xjob-${id}`)).toBe(true)
    expect(repo.get(id)?.result?.blobKey).toBe(`xjob-${id}`)
  })

  it('CANCELLED DELIVERS NOTHING — even when the export wins the race', async () => {
    const id = startExportJob({ kind: 'video', recording, edit, allowPacketCopy: true })
    removeExportJob(id)
    // The abort rejected the in-flight promise; but even a result that
    // arrives anyway must go nowhere.
    settle?.(fakeResult())
    await flush()
    expect(saved.length).toBe(0)
    expect(repo.size).toBe(0)
  })

  it('pressing export twice for the same output joins the first press', () => {
    const a = startExportJob({ kind: 'video', recording, edit, allowPacketCopy: true })
    const b = startExportJob({ kind: 'video', recording, edit, allowPacketCopy: true })
    expect(b).toBe(a)
    expect(exportCalls).toBe(1)
  })

  it('a different output is a second, parallel job', () => {
    const a = startExportJob({ kind: 'video', recording, edit, allowPacketCopy: true })
    const b = startExportJob({
      kind: 'video',
      recording,
      edit,
      settings: { width: 2560, height: 1440, fps: 30 },
      allowPacketCopy: false,
    })
    expect(b).not.toBe(a)
    expect(exportCalls).toBe(2)
  })

  it('a failed job says so and stays dismissable', async () => {
    let rows: ExportJobRecord[] = []
    subscribeExportJobs((r) => {
      rows = r
    })
    const id = startExportJob({ kind: 'video', recording, edit, allowPacketCopy: true })
    fail!(new Error('encoder died'))
    await flush()
    expect(rows[0]?.state).toBe('failed')
    expect(rows[0]?.error).toBe('encoder died')
    removeExportJob(id)
    expect(rows.length).toBe(0)
  })

  it('resume RESTARTS an interrupted job when its recording still exists', async () => {
    recordings.set('rec1', recording)
    repo.set('j1', {
      id: 'j1',
      kind: 'video',
      recordingId: 'rec1',
      edit,
      allowPacketCopy: true,
      createdAt: Date.now(),
      runs: 1,
      state: 'running',
      progress: { phase: 'rendering', ratio: 0.7 },
    })
    await resumeExportJobs()
    expect(exportCalls).toBe(1)
    expect(repo.get('j1')?.runs).toBe(2)
    expect(repo.get('j1')?.progress.ratio).toBe(0)
  })

  it('resume STOPS a job that keeps dying instead of restarting it forever', async () => {
    recordings.set('rec1', recording)
    repo.set('j1', {
      id: 'j1',
      kind: 'video',
      recordingId: 'rec1',
      edit,
      allowPacketCopy: true,
      createdAt: Date.now(),
      runs: 3,
      state: 'running',
      progress: { phase: 'rendering', ratio: 0.7 },
    })
    await resumeExportJobs()
    expect(exportCalls).toBe(0)
    expect(repo.get('j1')?.state).toBe('failed')
  })

  it('resume restores a done row with a file, drops one without', async () => {
    let rows: ExportJobRecord[] = []
    blobs.set('xjob-keep', 42)
    const done = (id: string, blobKey: string | null): ExportJobRecord => ({
      id,
      kind: 'video',
      recordingId: 'rec1',
      edit,
      allowPacketCopy: true,
      createdAt: Date.now(),
      runs: 1,
      state: 'done',
      progress: { phase: 'finalizing', ratio: 1 },
      result: {
        fileName: 'f.mp4',
        mimeType: 'video/mp4',
        bytes: 42,
        durationMs: 1000,
        width: 1920,
        height: 1080,
        blobKey,
      },
    })
    repo.set('keep', done('keep', 'xjob-keep'))
    repo.set('gone', done('gone', null))
    await resumeExportJobs()
    subscribeExportJobs((r) => {
      rows = r
    })
    expect(rows.map((r) => r.id)).toEqual(['keep'])
    expect(repo.has('gone')).toBe(false)
  })
})
