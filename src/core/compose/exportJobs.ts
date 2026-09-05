/**
 * THE EXPORT IS A BACKGROUND JOB — Robert, 2026-08-30: "i want rendering
 * process shown in block like on screenshot in bottom of screen layout and
 * happening further if i switch app screen, independetly, and i want it
 * sirvive refresh and continue, and several rendering at the same time
 * possible too."
 *
 * Until this, an export owned the editor: mode flipped to 'exporting', the
 * tools locked, and the promise lived in a React handler — so navigating away
 * orphaned it, a refresh killed it silently, and a second export was refused
 * outright. Now a press creates a JOB: a persisted record (jobsRepo) plus a
 * runner, surfaced as a row in a dock that exists on every screen.
 *
 * WHAT "SURVIVES A REFRESH" MEANS, exactly: the job's spec — recording id,
 * the edit snapshotted at the press, the settings — is durable, and the
 * sources it reads are durable (OPFS channels, IndexedDB rows). The encode
 * itself is not checkpointable (a muxer's half-written file is not a file),
 * so a job found 'running' at boot RESTARTS from zero rather than resuming
 * mid-frame. The user sees the same row with its progress starting over,
 * which is the honest version of "continue".
 *
 * SEVERAL AT ONCE is real concurrency, not a queue: each video job runs in
 * its own export worker and streams to its own scratch (scratch.ts sweeps by
 * age now, so parallel workers stopped deleting each other's files). They
 * contend for decode like X4 measured — parallel jobs are each slower than
 * they would be alone — but they finish, and that trade is exactly what was
 * asked for.
 *
 * THE FINISHED FILE downloads immediately (UI1: pressing Export IS asking
 * for the file) from the scratch-backed blob, then a copy is taken under a
 * key this module owns so "Save again" and the cloud link survive both the
 * refresh and the next export's scratch bookkeeping. The download never
 * waits on the copy.
 *
 * A CANCELLED JOB DELIVERS NOTHING. The bug that started all this: cancel
 * was not wired to a joined pre-render, and when the render finished anyway
 * the file downloaded as if the cancel had not happened. The runner checks
 * its own liveness after the export settles, whatever settled it.
 */
import type {
  EditState,
  ExportJobKind,
  ExportJobRecord,
  ExportProgress,
  ExportResult,
  ExportSettings,
  Recording,
} from '@core/types'
import { newId } from '@core/id'
import { analytics } from '@core/analytics'
import {
  blobStore,
  EXPORTJOB_PREFIX,
  jobsRepo,
  persistBlobCopy,
  recordingsRepo,
} from '@core/store'
import { saveToFile } from '@core/share'
import { exportByBestPath } from './choose'

export { EXPORTJOB_PREFIX }
import { setExportJobCanceller } from './jobCancel'
/** A job that keeps killing the page must not restart forever. */
const MAX_RUNS = 3
/** Finished/failed rows (and their files) expire at boot — the download is in
 *  the user's Downloads already; the row is a convenience, not an archive. */
const ROW_TTL_MS = 24 * 60 * 60 * 1000
/** Progress writes to IndexedDB are throttled; the in-memory dock is not. */
const PERSIST_MIN_INTERVAL_MS = 2000
const PERSIST_MIN_RATIO_STEP = 0.05

interface LiveJob {
  record: ExportJobRecord
  abort: AbortController | null
  /** This session's live result handle (blob included); rebuilt from OPFS on
   *  demand after a refresh. */
  result: ExportResult | null
  lastPersistAt: number
  lastPersistRatio: number
}

const jobs = new Map<string, LiveJob>()
const listeners = new Set<(rows: ExportJobRecord[]) => void>()

function snapshot(): ExportJobRecord[] {
  return [...jobs.values()]
    .map((j) => j.record)
    .sort((a, b) => a.createdAt - b.createdAt)
}

function notify(): void {
  const rows = snapshot()
  for (const cb of listeners) cb(rows)
}

/** The dock's feed. Fires immediately with the current rows. */
export function subscribeExportJobs(cb: (rows: ExportJobRecord[]) => void): () => void {
  listeners.add(cb)
  cb(snapshot())
  return () => {
    listeners.delete(cb)
  }
}

function persist(record: ExportJobRecord): void {
  void jobsRepo.save({ ...record }).catch(() => undefined)
}

function persistProgressMaybe(live: LiveJob): void {
  const now = Date.now()
  const { record } = live
  if (
    now - live.lastPersistAt < PERSIST_MIN_INTERVAL_MS &&
    Math.abs(record.progress.ratio - live.lastPersistRatio) < PERSIST_MIN_RATIO_STEP
  ) {
    return
  }
  live.lastPersistAt = now
  live.lastPersistRatio = record.progress.ratio
  persist(record)
}

export interface StartExportJobInput {
  kind: ExportJobKind
  recording: Recording
  edit: EditState
  settings?: ExportSettings
  allowPacketCopy: boolean
}

/**
 * Create and start a job; returns its id immediately. Pressing Export twice
 * for the same output joins the first press instead of rendering it twice —
 * the same argument as F16's join, one level up.
 */
export function startExportJob(input: StartExportJobInput): string {
  const specOf = (r: ExportJobRecord): string =>
    JSON.stringify([r.kind, r.recordingId, r.edit, r.settings ?? null])
  const spec = JSON.stringify([input.kind, input.recording.id, input.edit, input.settings ?? null])
  for (const j of jobs.values()) {
    if (j.record.state === 'running' && specOf(j.record) === spec) return j.record.id
  }

  const record: ExportJobRecord = {
    id: newId('job'),
    kind: input.kind,
    recordingId: input.recording.id,
    edit: input.edit,
    settings: input.settings,
    allowPacketCopy: input.allowPacketCopy,
    createdAt: Date.now(),
    runs: 1,
    state: 'running',
    progress: { phase: 'preparing', ratio: 0 },
  }
  const live: LiveJob = {
    record,
    abort: new AbortController(),
    result: null,
    lastPersistAt: 0,
    lastPersistRatio: 0,
  }
  jobs.set(record.id, live)
  persist(record)
  notify()
  void run(live, input.recording)
  return record.id
}

async function run(live: LiveJob, recording: Recording): Promise<void> {
  const { record } = live
  const signal = (live.abort ?? new AbortController()).signal
  analytics.track('export_start')
  const t0 = performance.now()
  const onProgress = (p: ExportProgress): void => {
    if (!jobs.has(record.id)) return
    record.progress = p
    persistProgressMaybe(live)
    notify()
  }
  try {
    const result =
      record.kind === 'ai'
        ? await (await import('@core/ai')).exportForAi({
            recording,
            edit: record.edit,
            onProgress,
            signal,
          })
        : (
            await exportByBestPath({
              recording,
              edit: record.edit,
              settings: record.settings,
              allowPacketCopy: record.allowPacketCopy,
              onProgress,
              signal,
            })
          ).result

    if (signal.aborted || !jobs.has(record.id)) {
      // Cancelled, but the export won the race and finished anyway. Deliver
      // NOTHING — a cancel followed by a surprise download is the exact bug
      // this module was born from. Nothing has read from the scratch, so it
      // can go now instead of waiting for the age sweep.
      if (result.scratchKey) void blobStore.remove(result.scratchKey).catch(() => undefined)
      return
    }

    live.result = result
    record.state = 'done'
    record.progress = { phase: 'finalizing', ratio: 1 }
    const meta = {
      fileName: result.fileName,
      mimeType: result.mimeType,
      bytes: result.blob.size,
      durationMs: result.durationMs,
      width: result.width,
      height: result.height,
      blobKey: null as string | null,
      ai: result.ai,
    }
    record.result = meta
    persist(record)
    notify()
    analytics.track('export_complete', {
      durationMs: Math.round(performance.now() - t0),
      sizeBytes: result.blob.size,
      kind: record.kind,
      runs: record.runs,
    })
    // UI1: the download is not a separate decision — the job finishing IS it.
    saveToFile(result)

    // Now the durable copy, AFTER the download started — it must never delay
    // the file (the instant path stays instant). The scratch is deliberately
    // NOT removed here: the download above may still be streaming from it;
    // the age sweep collects it later.
    try {
      const blobKey = `${EXPORTJOB_PREFIX}${record.id}`
      const held = await persistBlobCopy(result.blob, blobKey)
      if (!jobs.has(record.id)) {
        // Dismissed while copying — the copy belongs to nobody.
        void blobStore.remove(blobKey).catch(() => undefined)
        return
      }
      live.result = { ...result, blob: held, scratchKey: undefined }
      record.result = { ...meta, blobKey }
      persist(record)
    } catch {
      // Best-effort: the file is already in Downloads. The row just cannot
      // offer "Save again" after a refresh.
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    if (aborted || !jobs.has(record.id)) return // cancel already removed the row
    record.state = 'failed'
    record.error = err instanceof Error ? err.message : 'Export failed'
    record.progress = { phase: 'finalizing', ratio: 0 }
    persist(record)
    notify()
    analytics.track('export_error', { message: record.error, kind: record.kind })
  }
}

/**
 * Cancel a running job / dismiss a finished or failed row. One mechanism:
 * the row disappears, the work (if any) is aborted, the job's own file (if
 * any) is removed. The scratch of an aborted render cleans itself up
 * (render.ts discards on failure).
 */
export function removeExportJob(id: string): void {
  const live = jobs.get(id)
  if (!live) return
  jobs.delete(id)
  live.abort?.abort()
  void jobsRepo.remove(id).catch(() => undefined)
  if (live.record.result?.blobKey) {
    void blobStore.remove(live.record.result.blobKey).catch(() => undefined)
  }
  notify()
}

/**
 * The ExportResult of a finished job — live handle when this session made it,
 * rebuilt from the job's own OPFS copy after a refresh. Null when neither
 * exists (the copy failed or was never taken; the download itself is in the
 * user's Downloads folder regardless).
 */
export async function exportJobResult(id: string): Promise<ExportResult | null> {
  const live = jobs.get(id)
  if (!live || live.record.state !== 'done' || !live.record.result) return null
  if (live.result) return live.result
  const meta = live.record.result
  if (!meta.blobKey) return null
  try {
    const file = await blobStore.read(meta.blobKey)
    if (file.size === 0) return null
    live.result = {
      blob: file.slice(0, file.size, meta.mimeType),
      mimeType: meta.mimeType,
      fileName: meta.fileName,
      durationMs: meta.durationMs,
      width: meta.width,
      height: meta.height,
      ai: meta.ai,
    }
    return live.result
  } catch {
    return null
  }
}

/**
 * Boot: restore finished rows, restart interrupted ones, expire the old,
 * sweep files no record claims. Called after crash recovery has run — the
 * jobs read recordings, so recovery must have had its chance to write them.
 */
export async function resumeExportJobs(): Promise<void> {
  let rows: ExportJobRecord[] = []
  try {
    rows = await jobsRepo.list()
  } catch {
    return
  }
  const now = Date.now()
  for (const record of rows) {
    if (jobs.has(record.id)) continue // already live (double resume)

    if (record.state === 'done' || record.state === 'failed') {
      const expired = now - record.createdAt > ROW_TTL_MS
      const restorable = record.state === 'failed' || record.result?.blobKey
      if (expired || !restorable) {
        // The download happened when it happened; a done row with no copy on
        // disk has nothing left to offer after a refresh.
        void jobsRepo.remove(record.id).catch(() => undefined)
        if (record.result?.blobKey) {
          void blobStore.remove(record.result.blobKey).catch(() => undefined)
        }
        continue
      }
      jobs.set(record.id, {
        record,
        abort: null,
        result: null,
        lastPersistAt: 0,
        lastPersistRatio: 1,
      })
      continue
    }

    // 'running': the page died under it. Restart — or stop blaming the page.
    if (record.runs >= MAX_RUNS) {
      record.state = 'failed'
      record.error = `stopped after ${MAX_RUNS} interrupted attempts`
      persist(record)
      jobs.set(record.id, {
        record,
        abort: null,
        result: null,
        lastPersistAt: 0,
        lastPersistRatio: 0,
      })
      continue
    }
    let recording: Recording | undefined
    try {
      recording = await recordingsRepo.get(record.recordingId)
    } catch {
      recording = undefined
    }
    if (!recording) {
      void jobsRepo.remove(record.id).catch(() => undefined)
      continue
    }
    record.runs += 1
    record.progress = { phase: 'preparing', ratio: 0 }
    const live: LiveJob = {
      record,
      abort: new AbortController(),
      result: null,
      lastPersistAt: 0,
      lastPersistRatio: 0,
    }
    jobs.set(record.id, live)
    persist(record)
    void run(live, recording)
  }
  notify()

  // Files under this module's prefix that no live row claims are garbage —
  // a dismissal that died mid-remove, a copy whose record was dropped.
  try {
    for (const f of await blobStore.list()) {
      if (!f.key.startsWith(EXPORTJOB_PREFIX)) continue
      const id = f.key.slice(EXPORTJOB_PREFIX.length)
      const live = jobs.get(id)
      if (!live || live.record.result?.blobKey !== f.key) {
        await blobStore.remove(f.key).catch(() => undefined)
      }
    }
  } catch {
    // Sweep is best-effort; the next boot tries again.
  }
}

/** Test seam — module state outlives test cases. */
export function resetExportJobsForTests(): void {
  jobs.clear()
  listeners.clear()
}

/**
 * J12 — REGISTER THE CANCELLER, because purge.ts may not import this module:
 * the edge closes a worker cycle vite refuses to build. See jobCancel.ts.
 */
setExportJobCanceller(removeExportJob)
