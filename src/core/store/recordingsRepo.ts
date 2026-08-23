import type { EditState, Recording } from '../types'
import { blobStore } from './blobStore'

const DB_NAME = 'inout'
/** v2 (F4) adds the `edits` store — see editsRepo below. */
const DB_VERSION = 2
const STORE = 'recordings'
const EDITS_STORE = 'edits'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' })
      }
      if (!req.result.objectStoreNames.contains(EDITS_STORE)) {
        req.result.createObjectStore(EDITS_STORE, { keyPath: 'recordingId' })
      }
    }
    req.onsuccess = () => {
      // Browser may close the connection (e.g. storage eviction); reopen lazily.
      req.result.onclose = () => {
        dbPromise = null
      }
      resolve(req.result)
    }
    req.onerror = () => {
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

  async remove(id: string): Promise<void> {
    const r = await get(id)
    if (r) {
      await Promise.all(r.channels.map((c) => blobStore.remove(c.blobKey)))
      if (r.composite) await blobStore.remove(r.composite.blobKey).catch(() => undefined)
    }
    await withStore('readwrite', (s) => s.delete(id))
    await editsRepo.remove(id)
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
