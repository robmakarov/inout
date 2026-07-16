/**
 * EXPERIMENTAL — Durable writer worker (Experiment 3).
 *
 * FileSystemSyncAccessHandle writes bytes directly into the target file
 * (no swap-file commit on close), so flushed data survives a hard tab kill.
 * This worker is the durability counterpart to the atomic-on-close
 * createWritable() used by the production blobStore.
 *
 * Protocol (message -> reply):
 *   {cmd:'open', name}                  -> {ok, cmd:'open'}
 *   {cmd:'write', bytes: ArrayBuffer}   -> {ok, cmd:'write', flushedBytes}
 *   {cmd:'close'}                       -> {ok, cmd:'close'}
 */

interface OpenMsg {
  cmd: 'open'
  name: string
}
interface WriteMsg {
  cmd: 'write'
  bytes: ArrayBuffer
}
interface CloseMsg {
  cmd: 'close'
}
type Msg = OpenMsg | WriteMsg | CloseMsg

// FileSystemSyncAccessHandle is missing from the project's TS lib set.
interface SyncAccessHandle {
  write(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number
  flush(): void
  close(): void
  getSize(): number
}

let handle: SyncAccessHandle | null = null
let offset = 0

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const msg = ev.data
  try {
    if (msg.cmd === 'open') {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('experimental', { create: true })
      const file = await dir.getFileHandle(msg.name, { create: true })
      const anyFile = file as FileSystemFileHandle & {
        createSyncAccessHandle(): Promise<SyncAccessHandle>
      }
      handle = await anyFile.createSyncAccessHandle()
      offset = 0
      self.postMessage({ ok: true, cmd: 'open' })
    } else if (msg.cmd === 'write') {
      if (!handle) throw new Error('not open')
      offset += handle.write(msg.bytes, { at: offset })
      handle.flush() // the durability point: bytes are on disk after this line
      self.postMessage({ ok: true, cmd: 'write', flushedBytes: offset })
    } else if (msg.cmd === 'close') {
      handle?.close()
      handle = null
      self.postMessage({ ok: true, cmd: 'close' })
    }
  } catch (err) {
    self.postMessage({ ok: false, cmd: msg.cmd, error: err instanceof Error ? err.message : String(err) })
  }
}
