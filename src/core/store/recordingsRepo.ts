import type { EditState, ExportJobRecord, Recording } from '../types'
import { blobStore } from './blobStore'

const DB_NAME = 'inout'
/**
 * v2 (F4) adds the `edits` store.
 *
 * THIS NUMBER MUST NEVER GO UP AGAIN (2026-08-30, measured on prod the hour
 * it was tried). A version bump needs a `versionchange` transaction, and ANY
 * connection at the old version — another tab, a bfcached page, an old build
 * of this PWA that a user has had open for days — blocks it forever, because
 * shipped builds never registered an onversionchange handler that closes.
 * Worse: every open request issued AFTER the blocked upgrade queues behind
 * it, so the entire database is unreachable for the new page — boot recovery
 * hangs silently and stop() hangs saving the Recording, which is a LOST
 * TAKE. A new table goes in its OWN database (see jobsRepo): a fresh name
 * has no old holders anywhere, so it opens instantly, forever.
 * Connections DO close on versionchange now, but a handler shipped today is
 * not on the tabs already out there — the rule stands.
 */
const DB_VERSION = 2
const STORE = 'recordings'
const EDITS_STORE = 'edits'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const adopt = (db: IDBDatabase): void => {
      // Browser may close the connection (e.g. storage eviction); reopen lazily.
      db.onclose = () => {
        dbPromise = null
      }
      // Hygiene for any future page that needs a versionchange: step aside
      // instead of blocking it forever. See the note on DB_VERSION.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' })
      }
      if (!req.result.objectStoreNames.contains(EDITS_STORE)) {
        req.result.createObjectStore(EDITS_STORE, { keyPath: 'recordingId' })
      }
    }
    req.onsuccess = () => adopt(req.result)
    req.onerror = () => {
      // VersionError: this profile's DB is ABOVE v2 — the build that briefly
      // bumped to v3 (live ~20 min on 2026-08-30) upgraded it. v3 is v2 plus
      // an unused table, so attach at whatever version exists; a versioned
      // open below the current version can never succeed and would otherwise
      // brick the app for exactly the profiles that caught the bad window.
      if (req.error?.name === 'VersionError') {
        const anyVersion = indexedDB.open(DB_NAME)
        anyVersion.onsuccess = () => adopt(anyVersion.result)
        anyVersion.onerror = () => {
          dbPromise = null
          reject(anyVersion.error ?? new Error('recordingsRepo: failed to open IndexedDB'))
        }
        return
      }
      dbPromise = null
      reject(req.error ?? new Error('recordingsRepo: failed to open IndexedDB'))
    }
  })
  return dbPromise
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('recordingsRepo: request failed'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
  store: string = STORE,
): Promise<T> {
  const db = await openDb()
  return promisify(fn(db.transaction(store, mode).objectStore(store)))
}

function get(id: string): Promise<Recording | undefined> {
  return withStore('readonly', (s) => s.get(id) as IDBRequest<Recording | undefined>)
}

export const recordingsRepo = {
  async save(r: Recording): Promise<void> {
    await withStore('readwrite', (s) => s.put(r))
  },

  get,

  async list(): Promise<Recording[]> {
    const rows = await withStore('readonly', (s) => s.getAll() as IDBRequest<Recording[]>)
    return rows.sort((a, b) => b.createdAt - a.createdAt)
  },

  /**
   * J11 — AND EVERYTHING THE TAKE CAUSED TO EXIST. This used to drop the
   * channels, the composite, the row and the edit, and leave the take's RENDER
   * on the disk: its chunks (2.686 GB of them on Robert's own machine, for
   * takes already dealt with), its pre-render, and every finished export job's
   * private copy of the output. Robert, 2026-09-05: "users disk must not get
   * trashed by our app".
   *
   * It lives behind `remove` rather than at the Delete button because there is
   * more than one way to delete a take, and a cleanup at one caller is a
   * cleanup the others forget. The import is dynamic to keep the store→compose
   * edge from closing a cycle, and the purge never throws — a delete that
   * half-fails must still delete the take.
   */
  async remove(id: string): Promise<void> {
    const r = await get(id)
    if (r) {
      await Promise.all(r.channels.map((c) => blobStore.remove(c.blobKey)))
      if (r.composite) await blobStore.remove(r.composite.blobKey).catch(() => undefined)
    }
    await withStore('readwrite', (s) => s.delete(id))
    await editsRepo.remove(id)
    try {
      const { purgeDerivedFor } = await import('@core/compose/purge')
      await purgeDerivedFor(id)
    } catch (err) {
      console.warn('[store] the take is gone but its derived files are not', err)
    }
  },
}

/**
 * The edit, persisted (task F4). Until now a reload rebuilt a DEFAULT edit even
 * though recovery faithfully restored the recording — so every trim, every F1
 * cut and every camera move silently evaporated on refresh, in an app whose
 * whole durability story is "a refresh never costs you a take". Camera motion
 * made that visible enough to fix: it is the first edit that is obviously work
 * rather than a setting.
 *
 * Best-effort by design. A failed read must never keep a recording out of the
 * editor, so callers fall back to the default edit and carry on.
 */
export const editsRepo = {
  async save(edit: EditState): Promise<void> {
    await withStore('readwrite', (s) => s.put(edit), EDITS_STORE)
  },

  async get(recordingId: string): Promise<EditState | undefined> {
    return withStore(
      'readonly',
      (s) => s.get(recordingId) as IDBRequest<EditState | undefined>,
      EDITS_STORE,
    )
  },

  async remove(recordingId: string): Promise<void> {
    await withStore('readwrite', (s) => s.delete(recordingId), EDITS_STORE).catch(() => undefined)
  },
}

/**
 * Export jobs, persisted (2026-08-30). An export is a background job now: the
 * dock shows it on every screen, and a page refresh RESTARTS it rather than
 * losing it — the sources (OPFS) and the snapshotted edit (in the record) are
 * already durable, so the spec here is everything a restart needs. The row of
 * a finished job keeps the result's metadata so "Save again" and the cloud
 * link survive the refresh too. compose/exportJobs.ts owns the lifecycle;
 * this is only the shelf it stands on.
 */
/** OPFS namespace of a job's own finished-file copy: `xjob-<job id>`. Lives
 *  here (not in compose/exportJobs.ts) so reclaim.ts can honour it without
 *  dragging the whole compose graph into the boot sweep. */
export const EXPORTJOB_PREFIX = 'xjob-'

/**
 * ITS OWN DATABASE, NOT A VERSION BUMP OF `inout` — the bump was tried and
 * wedged prod within the hour (see the note on DB_VERSION above): one old
 * tab blocks the versionchange forever, the whole open queue jams behind it,
 * and stop() hangs saving the Recording. A database nobody has ever opened
 * has no old holders on any profile, so it opens instantly, everywhere.
 */
const JOBS_DB_NAME = 'inout-jobs'
const JOBS_DB_VERSION = 1
const JOBS_STORE = 'exportJobs'

let jobsDbPromise: Promise<IDBDatabase> | null = null

function openJobsDb(): Promise<IDBDatabase> {
  jobsDbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(JOBS_DB_NAME, JOBS_DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(JOBS_STORE)) {
        req.result.createObjectStore(JOBS_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => {
      req.result.onclose = () => {
        jobsDbPromise = null
      }
      req.result.onversionchange = () => {
        req.result.close()
        jobsDbPromise = null
      }
      resolve(req.result)
    }
    req.onerror = () => {
      jobsDbPromise = null
      reject(req.error ?? new Error('jobsRepo: failed to open IndexedDB'))
    }
  })
  return jobsDbPromise
}

async function withJobsStore<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openJobsDb()
  return promisify(fn(db.transaction(JOBS_STORE, mode).objectStore(JOBS_STORE)))
}

export const jobsRepo = {
  async save(job: ExportJobRecord): Promise<void> {
    await withJobsStore('readwrite', (s) => s.put(job))
  },

  async list(): Promise<ExportJobRecord[]> {
    const rows = await withJobsStore('readonly', (s) => s.getAll() as IDBRequest<ExportJobRecord[]>)
    return rows.sort((a, b) => a.createdAt - b.createdAt)
  },

  async remove(id: string): Promise<void> {
    await withJobsStore('readwrite', (s) => s.delete(id)).catch(() => undefined)
  },
}
