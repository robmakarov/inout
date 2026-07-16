import type { Recording } from '../types'
import { blobStore } from './blobStore'

const DB_NAME = 'inout'
const DB_VERSION = 1
const STORE = 'recordings'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' })
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
): Promise<T> {
  const db = await openDb()
  return promisify(fn(db.transaction(STORE, mode).objectStore(STORE)))
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
  },
}
