const ROOT_DIR = 'blobs'

function assertKey(key: string): string {
  if (!key || key.includes('/') || key.includes('\\')) {
    throw new Error(`blobStore: invalid key "${key}" (keys are flat file names)`)
  }
  return key
}

async function blobsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(ROOT_DIR, { create: true })
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotFoundError'
}

/** tsconfig lib set omits DOM.AsyncIterable; OPFS directory iteration typed here. */
interface AsyncIterableDirectory {
  values(): AsyncIterableIterator<FileSystemHandle>
}

// FileSystemSyncAccessHandle is missing from the project's TS lib set.
interface SyncAccessHandle {
  write(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number
  flush(): void
  close(): void
  getSize(): number
}

type DurableWorkerMsg =
  | { cmd: 'open'; name: string }
  | { cmd: 'write'; bytes: ArrayBuffer; at?: number }
  | { cmd: 'close' }

type DurableWorkerReply =
  | { ok: true; cmd: string; flushedBytes?: number }
  | { ok: false; cmd: string; error: string }

/**
 * Durable OPFS writer via SyncAccessHandle + flush (TD-VERDICT item 2).
 * Survives hard tab kill; createWritable swap-file does not.
 * Same WritableStream<Uint8Array | Blob> contract as the legacy path.
 */
function createDurableWritable(key: string): WritableStream<Uint8Array | Blob> {
  const worker = new Worker(new URL('./durableWriter.worker.ts', import.meta.url), {
    type: 'module',
  })
  let seq = 0
  const pending = new Map<number, { resolve: (r: DurableWorkerReply) => void; reject: (e: Error) => void }>()

  worker.onmessage = (ev: MessageEvent<DurableWorkerReply & { id: number }>) => {
    const { id, ...reply } = ev.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    p.resolve(reply)
  }
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(ev.message || 'durable worker error'))
    pending.clear()
  }

  const call = (msg: DurableWorkerMsg): Promise<DurableWorkerReply> =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      if (msg.cmd === 'write') {
        worker.postMessage({ id, ...msg }, [msg.bytes])
      } else {
        worker.postMessage({ id, ...msg })
      }
    })

  let opened = false
  return new WritableStream<Uint8Array | Blob>({
    async start() {
      const reply = await call({ cmd: 'open', name: key })
      if (!reply.ok) throw new Error(reply.error)
      opened = true
    },
    async write(chunk) {
      if (!opened) throw new Error('durable writer not open')
      const bytes =
        chunk instanceof Blob ? await chunk.arrayBuffer() : chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
      const reply = await call({ cmd: 'write', bytes: bytes as ArrayBuffer })
      if (!reply.ok) throw new Error(reply.error)
    },
    async close() {
      try {
        const reply = await call({ cmd: 'close' })
        if (!reply.ok) throw new Error(reply.error)
      } finally {
        worker.terminate()
      }
    },
    async abort() {
      try {
        await call({ cmd: 'close' })
      } catch {
        /* discarding */
      }
      worker.terminate()
    },
  })
}

function canUseDurableWriter(): boolean {
  // SyncAccessHandle exists only in dedicated workers; feature-detect Worker + OPFS.
  return typeof Worker !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
}

/** Positioned durable writer for muxers that patch earlier bytes (WebM headers). */
export interface PositionedDurableWriter {
  write(data: Uint8Array, position: number): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

export async function createDurablePositionedWriter(key: string): Promise<PositionedDurableWriter> {
  assertKey(key)
  const worker = new Worker(new URL('./durableWriter.worker.ts', import.meta.url), {
    type: 'module',
  })
  let seq = 0
  const pending = new Map<number, { resolve: (r: DurableWorkerReply) => void; reject: (e: Error) => void }>()
  worker.onmessage = (ev: MessageEvent<DurableWorkerReply & { id: number }>) => {
    const { id, ...reply } = ev.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    p.resolve(reply)
  }
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(ev.message || 'durable worker error'))
    pending.clear()
  }
  const call = (msg: DurableWorkerMsg, transfer?: Transferable[]): Promise<DurableWorkerReply> =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, ...msg }, transfer ?? [])
    })
  const open = await call({ cmd: 'open', name: key })
  if (!open.ok) {
    worker.terminate()
    throw new Error(open.error)
  }
  return {
    async write(data, position) {
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      const reply = await call({ cmd: 'write', bytes: buf as ArrayBuffer, at: position }, [buf])
      if (!reply.ok) throw new Error(reply.error)
    },
    async close() {
      try {
        const reply = await call({ cmd: 'close' })
        if (!reply.ok) throw new Error(reply.error)
      } finally {
        worker.terminate()
      }
    },
    async abort() {
      try {
        await call({ cmd: 'close' })
      } catch {
        /* discarding */
      }
      worker.terminate()
    },
  }
}


/**
 * Positioned OPFS writable for mediabunny StreamTarget (measured audio mux).
 * Not durable-flushed per chunk — durability for this path lands with the
 * audio-worker merge (Task 1+2 synergy); video/MediaRecorder uses createWriteStream.
 */
export async function createFileWritable(key: string): Promise<FileSystemWritableFileStream> {
  const dir = await blobsDir()
  return dir.getFileHandle(assertKey(key), { create: true }).then((f) => f.createWritable())
}

export const blobStore = {
  /**
   * Streaming write path. Prefers SyncAccessHandle durable worker (crash-safe);
   * falls back to createWritable when workers are unavailable.
   */
  async createWriteStream(key: string): Promise<WritableStream<Uint8Array | Blob>> {
    assertKey(key)
    if (canUseDurableWriter()) {
      try {
        return createDurableWritable(assertKey(key))
      } catch (err) {
        console.warn('[blobStore] durable writer unavailable, falling back to createWritable', err)
      }
    }
    return createFileWritable(key)
  },

  async read(key: string): Promise<Blob> {
    const dir = await blobsDir()
    try {
      const file = await dir.getFileHandle(assertKey(key))
      return await file.getFile()
    } catch (err) {
      if (isNotFound(err)) throw new Error(`blobStore: no blob stored under key "${key}"`)
      throw err
    }
  },

  async remove(key: string): Promise<void> {
    const dir = await blobsDir()
    try {
      await dir.removeEntry(assertKey(key))
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  },

  async usageBytes(): Promise<number> {
    const dir = (await blobsDir()) as FileSystemDirectoryHandle & AsyncIterableDirectory
    let total = 0
    for await (const handle of dir.values()) {
      if (handle.kind === 'file') {
        total += (await (handle as FileSystemFileHandle).getFile()).size
      }
    }
    return total
  },
}

// Silence unused-interface warning when SyncAccessHandle is only referenced in comments/worker.
void (0 as unknown as SyncAccessHandle)
