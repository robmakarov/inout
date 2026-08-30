import { blobStore, createPositionedWriter } from './blobStore'

/**
 * Copy a blob to a key the caller owns, and return a blob backed by the copy.
 *
 * Exists because an ExportResult's blob is a view of the export scratch, and
 * scratch files belong to the export machinery — anything that must OUTLIVE
 * the next export (a pre-render waiting to be claimed, a finished job's
 * "Save again" file) takes its own copy. Streamed rather than arrayBuffer():
 * these are hundreds of megabytes, and memory pressure is what breaks the
 * machine. Lifted out of prerender.ts when export jobs needed the same move.
 */
export async function persistBlobCopy(blob: Blob, key: string): Promise<Blob> {
  const writer = await createPositionedWriter(key)
  const reader = blob.stream().getReader()
  let position = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await writer.write(value, position)
      position += value.byteLength
    }
  } finally {
    await writer.close()
  }
  const file = await blobStore.read(key)
  return file.slice(0, file.size, blob.type)
}
