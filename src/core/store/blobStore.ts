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
 * A worker that never answers used to hang its caller forever — and since
 * arm() awaits a write-stream open, that froze recording with no error and no
 * way out (Robert-hit 2026-08-23, "stuck on waiting for microphone"). Every worker
 * round-trip is now bounded; a timeout surfaces as a normal rejection, which
 * callers already handle by falling back or failing the channel loudly.
 */
const WORKER_OPEN_TIMEOUT_MS = 5_000
const WORKER_WRITE_TIMEOUT_MS = 15_000

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

function callTimeoutFor(cmd: DurableWorkerMsg['cmd']): number {
  return cmd === 'write' ? WORKER_WRITE_TIMEOUT_MS : WORKER_OPEN_TIMEOUT_MS
}

/**
 * Durable OPFS writer via SyncAccessHandle + flush (review verdict item 2).
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
    withDeadline(
      new Promise<DurableWorkerReply>((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        if (msg.cmd === 'write') {
          worker.postMessage({ id, ...msg }, [msg.bytes])
        } else {
          worker.postMessage({ id, ...msg })
        }
      }),
      callTimeoutFor(msg.cmd),
      `durable writer ${msg.cmd}`,
    )

  let opened = false
  return new WritableStream<Uint8Array | Blob>({
    async start() {
      let reply: DurableWorkerReply
      try {
        reply = await call({ cmd: 'open', name: key })
      } catch (err) {
        worker.terminate()
        throw err instanceof Error ? err : new Error(String(err))
      }
      if (!reply.ok) {
        worker.terminate()
        throw new Error(reply.error)
      }
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

/** Same positioned contract over createWritable — used where the durable
 * SyncAccessHandle worker is unavailable (no Worker / no OPFS worker support). */
async function createPositionedFallbackWriter(key: string): Promise<PositionedDurableWriter> {
  const stream = await createFileWritable(key)
  return {
    async write(data, position) {
      // Copy: the caller's view may be reused before this async write lands.
      const bytes = new Uint8Array(data.byteLength)
      bytes.set(data)
      await stream.write({ type: 'write', data: bytes, position })
    },
    async close() {
      await stream.close()
    },
    async abort() {
      await stream.abort().catch(() => undefined)
    },
  }
}

/** Escape hatch and A/B lever: forces the second-worker writer even inside a
 *  dedicated worker (X2 evidence runs, and a manual fallback if a platform ever
 *  misbehaves holding the handle on the render thread). */
let inlineWriterEnabled = true
export function setInlinePositionedWriterEnabled(value: boolean): void {
  inlineWriterEnabled = value
}

/** Read back for the export worker, which lives in its own module instance and
 *  has to be TOLD what the main thread chose (see pipeline.ts). */
export function isInlinePositionedWriterEnabled(): boolean {
  return inlineWriterEnabled
}

/**
 * True when THIS thread may hold a FileSystemSyncAccessHandle itself: the
 * handle is `[Exposed=DedicatedWorker]`, so a caller already running in one
 * needs no second worker at all (task X2).
 */
export function canOwnSyncHandle(): boolean {
  // The project's TS lib set has no WebWorker types, so ask the global object
  // rather than naming the interface (same reason SyncAccessHandle is declared
  // by hand at the top of this file).
  const scope = (globalThis as { DedicatedWorkerGlobalScope?: unknown })
    .DedicatedWorkerGlobalScope as (abstract new () => unknown) | undefined
  return (
    inlineWriterEnabled &&
    typeof scope === 'function' &&
    globalThis instanceof scope &&
    typeof navigator !== 'undefined' &&
    !!navigator.storage?.getDirectory
  )
}

/**
 * The same positioned contract, owned INLINE (task X2).
 *
 * The worker-backed writer below pays three things per chunk that a caller
 * already inside a dedicated worker has no reason to pay: a full `slice()` copy
 * of the chunk (4 MB at the export's chunk size), a structured-clone transfer
 * to a SECOND worker, and an awaited round trip through that worker's event
 * loop. capture/compositor.worker.ts has owned its own handle since it was
 * written; this is the same move for everyone else in a worker.
 *
 * `write` is synchronous by design — that is what a SyncAccessHandle is — and
 * it is the same synchronous write that already happened, one thread over,
 * with the caller blocked on it either way.
 */
async function createInlinePositionedWriter(key: string): Promise<PositionedDurableWriter> {
  const dir = await blobsDir()
  const file = await dir.getFileHandle(key, { create: true })
  const anyFile = file as FileSystemFileHandle & {
    createSyncAccessHandle(): Promise<SyncAccessHandle>
  }
  const handle = await anyFile.createSyncAccessHandle()
  try {
    ;(handle as SyncAccessHandle & { truncate?(size: number): void }).truncate?.(0)
  } catch {
    /* truncate optional */
  }
  let offset = 0
  let closed = false
  const closeOnce = (): void => {
    if (closed) return
    closed = true
    handle.close()
  }
  return {
    async write(data, position) {
      if (closed) throw new Error('inline positioned writer is closed')
      const pos = typeof position === 'number' ? position : offset
      const written = handle.write(data, { at: pos })
      offset = Math.max(offset, pos + written)
      handle.flush()
    },
    async close() {
      closeOnce()
    },
    async abort() {
      closeOnce()
    },
  }
}

/**
 * Positioned writer, durable when the platform allows it. Muxers that seek
 * (mp4 patches its box sizes at finalize) write through this; O(1) memory
 * because nothing is retained after a write returns.
 *
 * Three rungs, in cost order: own the handle inline (dedicated worker), hand it
 * to the durable writer worker (main thread), or fall back to createWritable.
 */
export async function createPositionedWriter(key: string): Promise<PositionedDurableWriter> {
  assertKey(key)
  if (canOwnSyncHandle()) {
    try {
      return await createInlinePositionedWriter(key)
    } catch (err) {
      console.warn('[blobStore] inline positioned writer unavailable, falling back', err)
    }
  }
  if (canUseDurableWriter()) {
    try {
      return await createDurablePositionedWriter(key)
    } catch (err) {
      console.warn('[blobStore] durable positioned writer unavailable, falling back', err)
    }
  }
  return createPositionedFallbackWriter(key)
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
    withDeadline(
      new Promise<DurableWorkerReply>((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, ...msg }, transfer ?? [])
      }),
      callTimeoutFor(msg.cmd),
      `durable writer ${msg.cmd}`,
    )
  let open: DurableWorkerReply
  try {
    open = await call({ cmd: 'open', name: key })
  } catch (err) {
    // Timed out or errored: never leave the worker running behind a failure.
    worker.terminate()
    throw err instanceof Error ? err : new Error(String(err))
  }
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

  /** Flat listing of stored keys (scratch sweeps, orphan scans). */
  async listKeys(): Promise<string[]> {
    const dir = (await blobsDir()) as FileSystemDirectoryHandle & AsyncIterableDirectory
    const names: string[] = []
    for await (const handle of dir.values()) {
      if (handle.kind === 'file') names.push(handle.name)
    }
    return names
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
