/**
 * Durable OPFS writer worker — SyncAccessHandle + flush per write.
 * Production path for blobStore.createWriteStream (TD-VERDICT item 2).
 *
 * Protocol (message id echoed):
 *   {id, cmd:'open', name}                -> {id, ok, cmd:'open'}
 *   {id, cmd:'write', bytes: ArrayBuffer} -> {id, ok, cmd:'write', flushedBytes}
 *   {id, cmd:'close'}                     -> {id, ok, cmd:'close'}
 */

interface SyncAccessHandle {
  write(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number
  flush(): void
  close(): void
  getSize(): number
}

const ROOT_DIR = 'blobs'

let durableHandle: SyncAccessHandle | null = null
let durableOffset = 0

self.onmessage = async (ev: MessageEvent<{ id: number; cmd: string; name?: string; bytes?: ArrayBuffer; at?: number }>) => {
  const { id, cmd, name, bytes, at } = ev.data
  try {
    if (cmd === 'open') {
      if (!name) throw new Error('open requires name')
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle(ROOT_DIR, { create: true })
      const file = await dir.getFileHandle(name, { create: true })
      const anyFile = file as FileSystemFileHandle & {
        createSyncAccessHandle(): Promise<SyncAccessHandle>
      }
      durableHandle = await anyFile.createSyncAccessHandle()
      durableOffset = 0
      try {
        ;(durableHandle as SyncAccessHandle & { truncate?(size: number): void }).truncate?.(0)
      } catch {
        /* truncate optional */
      }
      self.postMessage({ id, ok: true, cmd: 'open' })
    } else if (cmd === 'write') {
      if (!durableHandle) throw new Error('not open')
      if (!bytes) throw new Error('write requires bytes')
      const pos = typeof at === 'number' ? at : durableOffset
      const written = durableHandle.write(bytes, { at: pos })
      durableOffset = Math.max(durableOffset, pos + written)
      durableHandle.flush()
      self.postMessage({ id, ok: true, cmd: 'write', flushedBytes: durableOffset })
    } else if (cmd === 'close') {
      durableHandle?.close()
      durableHandle = null
      durableOffset = 0
      self.postMessage({ id, ok: true, cmd: 'close' })
    } else {
      throw new Error(`unknown cmd ${cmd}`)
    }
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      cmd,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
