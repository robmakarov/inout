/**
 * EXPERIMENTAL — OPFS helpers for the research branch.
 *
 * All experimental artifacts live under the OPFS directory `experimental/`,
 * fully separate from the production `blobs/` directory. Nothing here touches
 * production storage. (The one documented exception is the Oracle, which must
 * write channel blobs through the production blobStore because exportRecording
 * reads through it — see oracle/README section in RESEARCH.md.)
 */

const EXP_DIR = 'experimental'

export async function expDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(EXP_DIR, { create: true })
}

export async function expWritable(name: string): Promise<FileSystemWritableFileStream> {
  const dir = await expDir()
  const file = await dir.getFileHandle(name, { create: true })
  return file.createWritable()
}

export async function expReadFile(name: string): Promise<File> {
  const dir = await expDir()
  const file = await dir.getFileHandle(name)
  return file.getFile()
}

export async function expRemove(name: string): Promise<void> {
  const dir = await expDir()
  try {
    await dir.removeEntry(name)
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err
  }
}

export async function expList(): Promise<string[]> {
  const dir = (await expDir()) as FileSystemDirectoryHandle & {
    values(): AsyncIterableIterator<FileSystemHandle>
  }
  const names: string[] = []
  for await (const h of dir.values()) names.push(h.name)
  return names.sort()
}

/** Read-only listing of the PRODUCTION blobs dir (used by recovery orphan scan). */
export async function listProductionBlobs(): Promise<{ name: string; size: number }[]> {
  const root = await navigator.storage.getDirectory()
  let dir: FileSystemDirectoryHandle
  try {
    dir = await root.getDirectoryHandle('blobs')
  } catch {
    return []
  }
  const iter = dir as FileSystemDirectoryHandle & {
    values(): AsyncIterableIterator<FileSystemHandle>
  }
  const out: { name: string; size: number }[] = []
  for await (const h of iter.values()) {
    if (h.kind === 'file') {
      const f = await (h as FileSystemFileHandle).getFile()
      out.push({ name: h.name, size: f.size })
    }
  }
  return out
}

/** Read a PRODUCTION blob by key without importing production code (read-only). */
export async function readProductionBlob(name: string): Promise<Blob> {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('blobs')
  const file = await dir.getFileHandle(name)
  return file.getFile()
}
