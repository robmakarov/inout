/**
 * Export scratch file — O(1)-memory muxing (task O1).
 *
 * Both export paths used to mux into a BufferTarget, i.e. the whole MP4 lived
 * in one contiguous ArrayBuffer: a 30-min take at 8 Mbps is ~1.8 GB and OOMs
 * the tab. The 30-min cap was the only thing hiding it.
 *
 * Instead the muxer writes through mediabunny's StreamTarget into an OPFS
 * scratch file (positioned writes — mp4 patches its box sizes at finalize), and
 * the ExportResult blob is a DISK-BACKED view of that file. Peak heap becomes
 * the chunk buffer, not the file.
 *
 * File lifetime: a finished scratch must outlive the export because the result
 * blob reads from it (download, cloud upload). So we keep the newest finished
 * file and drop the one before it — at most two on disk — plus a sweep of
 * leftovers from earlier page sessions whenever a new export starts.
 */
import { StreamTarget } from 'mediabunny'
import { newId } from '@core/id'
import { blobStore, createPositionedWriter } from '@core/store'

const SCRATCH_PREFIX = 'xport-'
/** Muxer writes coalesce into chunks of this size before hitting disk. */
const CHUNK_SIZE = 4 * 1024 * 1024

/** Keys this page session must not sweep: open exports + the newest finished one. */
const open = new Set<string>()
let newestFinished: string | null = null
/** Escape hatch: forces the in-memory target. Used by the O1 A/B evidence run,
 *  and available as a manual fallback if a platform ever misbehaves on OPFS. */
let scratchEnabled = true
let lastStats: ScratchStats | null = null

export function setExportScratchEnabled(value: boolean): void {
  scratchEnabled = value
}

/** Stats of the most recently finished/discarded scratch (evidence + O8 bands). */
export function getLastScratchStats(): ScratchStats | null {
  return lastStats
}

/**
 * Publish stats measured somewhere else — specifically, in the export worker
 * (O5a). The render moved off the main thread and this module went with it, so
 * every main-thread caller of getLastScratchStats() started reading null: the
 * O8 peak-memory band read `n/a` on its first run and that is how this was
 * found. pipeline.ts forwards the worker's stats through here so the question
 * "how much output did the muxer hold" has one answer wherever it is asked.
 */
export function setLastScratchStats(s: ScratchStats | null): void {
  lastStats = s
}

export interface ScratchStats {
  bytesWritten: number
  /** High-water of output bytes held in memory at once — the O1 claim, measured. */
  maxOutstandingBytes: number
}

export interface ExportScratch {
  /** Pass as `new Output({ target })`. */
  target: StreamTarget
  /** After output.finalize(): the file as a Blob typed `mimeType`, still on disk. */
  finish(mimeType: string): Promise<Blob>
  /** After output.cancel(), or on any failure: remove the file. */
  discard(): Promise<void>
  stats(): ScratchStats
}

/** Remove scratch files no live result depends on (previous page sessions). */
async function sweepStale(): Promise<void> {
  const keys = await blobStore.listKeys()
  for (const key of keys) {
    if (!key.startsWith(SCRATCH_PREFIX)) continue
    if (open.has(key) || key === newestFinished) continue
    await blobStore.remove(key).catch(() => undefined)
  }
}

/**
 * Open a scratch target, or null when OPFS is unusable — callers then keep the
 * in-memory BufferTarget, so no platform loses the ability to export.
 */
export async function createExportScratch(): Promise<ExportScratch | null> {
  if (!scratchEnabled) return null
  const key = `${SCRATCH_PREFIX}${newId('x')}`
  try {
    await sweepStale().catch(() => undefined)
    const writer = await createPositionedWriter(key)
    open.add(key)
    let closed = false
    const closeWriter = async (): Promise<void> => {
      if (closed) return
      closed = true
      await writer.close()
    }
    let bytesWritten = 0
    let outstanding = 0
    let maxOutstandingBytes = 0
    const writable = new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
      async write(chunk) {
        outstanding += chunk.data.byteLength
        if (outstanding > maxOutstandingBytes) maxOutstandingBytes = outstanding
        try {
          await writer.write(chunk.data, chunk.position)
          bytesWritten += chunk.data.byteLength
        } finally {
          outstanding -= chunk.data.byteLength
        }
      },
      close: closeWriter,
      abort: closeWriter,
    })
    const target = new StreamTarget(writable as ConstructorParameters<typeof StreamTarget>[0], {
      chunked: true,
      chunkSize: CHUNK_SIZE,
    })

    const release = async (): Promise<void> => {
      open.delete(key)
      await closeWriter().catch(() => undefined)
    }

    return {
      target,
      async finish(mimeType) {
        await release()
        lastStats = { bytesWritten, maxOutstandingBytes }
        const file = await blobStore.read(key)
        if (file.size === 0) throw new Error('export scratch: file is empty')
        console.info(
          `[export] streamed ${(file.size / 1024 / 1024).toFixed(1)} MB to disk; peak held in memory ${(maxOutstandingBytes / 1024 / 1024).toFixed(1)} MB`,
        )
        // slice() re-types the blob without pulling its bytes into the heap.
        const typed = file.slice(0, file.size, mimeType)
        const previous = newestFinished
        newestFinished = key
        if (previous && previous !== key) await blobStore.remove(previous).catch(() => undefined)
        return typed
      },
      async discard() {
        await release()
        await blobStore.remove(key).catch(() => undefined)
      },
      stats: () => ({ bytesWritten, maxOutstandingBytes }),
    }
  } catch (err) {
    open.delete(key)
    console.warn('[compose] export scratch unavailable, muxing in memory', err)
    await blobStore.remove(key).catch(() => undefined)
    return null
  }
}
