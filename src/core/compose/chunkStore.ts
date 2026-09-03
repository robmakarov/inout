/**
 * WHERE THE RENDER'S MEMORY LIVES — the chunk cache (task J1).
 *
 * CONTENT-ADDRESSED, AND THAT IS THE WHOLE MECHANISM. A chunk's file name is
 * the hash of what it contains (chunkPlan.ts builds the descriptor). Three
 * things fall out of that and none of them needed inventing:
 *
 *  · THE CACHE IS THE RESUME CURSOR. A killed tab resumes at the last complete
 *    chunk because a complete chunk is a file that exists under its own content
 *    name. There is no journal to corrupt, no cursor to keep in sync with the
 *    disk, and nothing to reconcile after a crash — the disk IS the cursor.
 *  · THE CACHE IS THE SHIPPING CURSOR. An uploader reads the same list: chunk
 *    files, in output order, each finished and immutable. Multi-device and
 *    instant-link want exactly that and get it for free.
 *  · A SUPERSEDED EDIT RESUMES NOTHING THAT CHANGED AND EVERYTHING THAT DID
 *    NOT, with no bookkeeping: the changed chunks simply have different names.
 *    An UNDO is a cache hit, which is the behaviour a person expects and which
 *    no invalidation scheme built out of timestamps would ever give them.
 *
 * A KEY THAT EXISTS MEANS BYTES THAT ARE COMPLETE. Everything is written to a
 * staging name and moved into place only after the muxer finalized, so a chunk
 * interrupted at any instant leaves either nothing or a whole file. Without
 * that this cache would turn one killed tab into a permanently corrupt export.
 */
import { StreamTarget } from 'mediabunny'
import { newId } from '@core/id'
import { blobStore, createPositionedWriter } from '@core/store'

/** Finished chunks. Immutable, named by their content. */
export const CHUNK_PREFIX = 'rchunk-'
/** In-flight chunks. Named by nothing; swept by age. */
export const CHUNK_PART_PREFIX = 'rchunkpart-'
/** Muxer writes coalesce into chunks of this size before hitting disk (as O1). */
const WRITE_CHUNK_SIZE = 1 * 1024 * 1024

/**
 * How long a staging file may sit before it is garbage. A part file is only
 * ever live while one render writes it; anything older than this belongs to a
 * page session that is gone.
 */
const PART_TTL_MS = 6 * 60 * 60 * 1000

/**
 * How long a FINISHED chunk survives without being used. Chunks are the render
 * made early — they are worth real disk — but a take the user never exports
 * again must not hold that disk forever. Matches the export jobs' own 24 h
 * expiry, which J1's gates require unchanged.
 */
const CHUNK_TTL_MS = 24 * 60 * 60 * 1000

/**
 * SHA-256 of the descriptor, hex. `crypto.subtle` exists in a dedicated worker,
 * which is where the render runs; the FNV fallback is for a context without it
 * (no secure origin, an old test environment) and is only ever a cache name —
 * a collision costs a wrong hit, so the fallback carries the length as well,
 * and KEY_VERSION means a bad name can be retired by bumping one constant.
 */
export async function hashDescriptor(descriptor: string): Promise<string> {
  const bytes = new TextEncoder().encode(descriptor)
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes)
    const view = new Uint8Array(digest)
    let hex = ''
    for (const b of view) hex += b.toString(16).padStart(2, '0')
    return hex
  }
  let h = 0x811c9dc5
  for (const b of bytes) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `f${h.toString(16).padStart(8, '0')}${bytes.length.toString(36)}`
}

export function chunkKeyFor(hash: string): string {
  return `${CHUNK_PREFIX}${hash}`
}

/** Every finished chunk on disk, by key. One directory pass, not one per chunk. */
export async function listChunkKeys(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const f of await blobStore.list()) {
    if (f.key.startsWith(CHUNK_PREFIX) && f.size > 0) out.set(f.key, f.size)
  }
  return out
}

/**
 * A `RenderSink` (render.ts): the render writes into it and publishes through
 * it, and never learns that its file is content-addressed or cached at all.
 */
export interface ChunkWriter {
  /** Pass as `new Output({ target })`. */
  target: StreamTarget
  /** After output.finalize(): publish under the content key, and hand back a
   *  disk-backed view of the published file. */
  publish(mimeType: string): Promise<Blob>
  /** On any failure or abort: the staging file goes, and nothing is published. */
  discard(): Promise<void>
}

/**
 * Open a staging file for one chunk. Null when OPFS refuses — the caller then
 * falls back to the unbroken render, which is what the product did before J1
 * and must always still be able to do.
 */
export async function openChunkWriter(hash: string): Promise<ChunkWriter | null> {
  const partKey = `${CHUNK_PART_PREFIX}${Date.now().toString(36)}-${newId('c')}`
  try {
    const writer = await createPositionedWriter(partKey)
    let closed = false
    const closeWriter = async (): Promise<void> => {
      if (closed) return
      closed = true
      await writer.close()
    }
    const writable = new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
      async write(part) {
        await writer.write(part.data, part.position)
      },
      close: closeWriter,
      abort: closeWriter,
    })
    const target = new StreamTarget(writable as ConstructorParameters<typeof StreamTarget>[0], {
      chunked: true,
      chunkSize: WRITE_CHUNK_SIZE,
    })
    return {
      target,
      async publish(mimeType: string) {
        await closeWriter()
        const size = await blobStore.size(partKey)
        if (size === 0) {
          await blobStore.remove(partKey).catch(() => undefined)
          throw new Error('chunk store: the muxer wrote nothing')
        }
        /**
         * FIRST WRITER WINS, and it matters because exports run in PARALLEL
         * (export jobs, 2026-08-30): two of them can render the same chunk at
         * the same time, and the bytes are identical by construction — the name
         * IS the content. Moving over a file another export may already have
         * open for the concatenation is the one way that could go wrong, so the
         * loser drops its own copy instead.
         */
        const key = chunkKeyFor(hash)
        if ((await blobStore.size(key).catch(() => 0)) > 0) {
          await blobStore.remove(partKey).catch(() => undefined)
        } else {
          await blobStore.move(partKey, key)
        }
        touchChunk(key)
        const file = await blobStore.read(key)
        // slice() re-types without pulling the bytes into the heap (as O1).
        return file.slice(0, file.size, mimeType)
      },
      async discard() {
        await closeWriter().catch(() => undefined)
        await blobStore.remove(partKey).catch(() => undefined)
      },
    }
  } catch (err) {
    console.warn('[compose] chunk cache unavailable, rendering unbroken', err)
    await blobStore.remove(partKey).catch(() => undefined)
    return null
  }
}

export async function readChunk(hash: string): Promise<Blob> {
  return blobStore.read(chunkKeyFor(hash))
}

function bornAt(key: string, prefix: string): number {
  const stamp = key.slice(prefix.length).split('-')[0]
  const t = parseInt(stamp ?? '', 36)
  return Number.isFinite(t) ? t : 0
}

/**
 * Boot sweep. Two rules, both age-based, because age is the only thing a fresh
 * page session honestly knows about a file another session wrote:
 *  · a STAGING file older than its TTL was abandoned by a dead page session;
 *  · a FINISHED chunk older than its TTL is a take nobody came back to.
 *
 * `keep` holds the keys a live plan is about to use, so a sweep that lands
 * beside a running export cannot delete the work in front of it.
 */
export async function sweepChunks(keep: ReadonlySet<string> = new Set()): Promise<{
  removed: number
  freedBytes: number
}> {
  const now = Date.now()
  let removed = 0
  let freedBytes = 0
  for (const f of await blobStore.list()) {
    const isPart = f.key.startsWith(CHUNK_PART_PREFIX)
    const isChunk = !isPart && f.key.startsWith(CHUNK_PREFIX)
    if (!isPart && !isChunk) continue
    if (keep.has(f.key)) continue
    if (isPart && now - bornAt(f.key, CHUNK_PART_PREFIX) < PART_TTL_MS) continue
    if (isChunk && now - (await chunkTouchedAt(f.key)) < CHUNK_TTL_MS) continue
    await blobStore.remove(f.key).then(
      () => {
        removed += 1
        freedBytes += f.size
      },
      () => undefined,
    )
  }
  return { removed, freedBytes }
}

/**
 * When a chunk was last useful. OPFS keeps a modification time and nothing
 * else, and a cache HIT does not rewrite the file — so a chunk reused every day
 * would still expire on its birthday. Touching it on a hit would mean writing
 * hundreds of files per export, so instead a hit records the time in memory and
 * the sweep prefers that when it has it. Cheap, honest, and wrong only in the
 * direction of keeping a file slightly longer than it earned.
 */
const touched = new Map<string, number>()
export function touchChunk(key: string): void {
  touched.set(key, Date.now())
}
async function chunkTouchedAt(key: string): Promise<number> {
  const seen = touched.get(key)
  if (seen) return seen
  // blobStore.read hands back the OPFS File, which carries the modification
  // time; the Blob type it is declared as does not, so ask the File.
  const file = (await blobStore.read(key).catch(() => null)) as File | null
  return file && typeof file.lastModified === 'number' ? file.lastModified : 0
}

/** Test seam — module state outlives test cases. */
export function resetChunkStoreForTests(): void {
  touched.clear()
}
