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

/** Bytes a finished chunk occupies, 0 when it is not there. */
export async function chunkSize(key: string): Promise<number> {
  return blobStore.size(key).catch(() => 0)
}

/** Drop one chunk by key. Used when a chunk is unusable and must be remade. */
export async function removeChunk(key: string): Promise<void> {
  await blobStore.remove(key).catch(() => undefined)
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
 *
 * AND `keep` IS ONLY EVER THIS TAB'S (J9, 2026-09-05). Every caller on the
 * shipped path is a BOOT sweep, which by definition has no plan and passes
 * nothing — so before J9 a second tab opening (a recovery check, a second
 * window, an agent reading a take) swept with an empty keep set and could
 * delete the chunks a 90-minute export running in the FIRST tab was about to
 * concatenate. The concatenation then failed to open one, and the whole take
 * re-rendered unbroken: two full generations of picture on a machine that has
 * exactly one media engine. A live render now leaves a CLAIM on the disk and
 * this sweep stands down while one is fresh — the only statement about another
 * tab that a fresh page session can honestly read.
 */
export async function sweepChunks(keep: ReadonlySet<string> = new Set()): Promise<{
  removed: number
  freedBytes: number
  heldBytes: number
  capBytes: number
  deferred: boolean
}> {
  const now = Date.now()
  let removed = 0
  let freedBytes = 0
  const survivors: { key: string; size: number; touched: number }[] = []

  const files = await blobStore.list()
  if (await liveClaimAmong(files, now)) {
    console.info('[compose] chunk sweep stood down — an export is running (J9)')
    return { removed: 0, freedBytes: 0, heldBytes: 0, capBytes: 0, deferred: true }
  }

  for (const f of files) {
    const isPart = f.key.startsWith(CHUNK_PART_PREFIX)
    const isChunk = !isPart && f.key.startsWith(CHUNK_PREFIX)
    if (!isPart && !isChunk) continue
    if (keep.has(f.key)) {
      if (isChunk) survivors.push({ key: f.key, size: f.size, touched: Number.MAX_SAFE_INTEGER })
      continue
    }
    const touched = isChunk ? await chunkTouchedAt(f.key) : 0
    const expired = isPart
      ? now - bornAt(f.key, CHUNK_PART_PREFIX) >= PART_TTL_MS
      : now - touched >= CHUNK_TTL_MS
    if (!expired) {
      if (isChunk) survivors.push({ key: f.key, size: f.size, touched })
      continue
    }
    await blobStore.remove(f.key).then(
      () => {
        removed += 1
        freedBytes += f.size
      },
      () => undefined,
    )
  }

  /**
   * AND A CEILING, BECAUSE AN EXPIRY IS NOT A BOUND. Chunks are worth real
   * disk — they are the render, made early — but a day of takes can put a day
   * of outputs on the disk before anything expires, and this is the one cost
   * Robert has already ruled on out loud: "we must prevent junk from saving, it
   * will fuck up users disks" (2026-08-30, after one orphan of 1,138 MB).
   *
   * The cap is a SHARE OF WHAT THIS ORIGIN MAY HAVE, asked of the browser
   * rather than picked — so it is the same rule on a 128 GB laptop and on a
   * full one, and it is not a length heuristic: a two-minute take and a
   * two-hour take are held or evicted by the same arithmetic. Least recently
   * used goes first, which for a content-addressed cache is exactly "the edit
   * nobody has come back to".
   */
  const capBytes = await chunkCapBytes()
  let heldBytes = survivors.reduce((n, f) => n + f.size, 0)
  if (capBytes > 0 && heldBytes > capBytes) {
    survivors.sort((a, b) => a.touched - b.touched)
    for (const f of survivors) {
      if (heldBytes <= capBytes) break
      if (keep.has(f.key)) continue
      await blobStore.remove(f.key).then(
        () => {
          removed += 1
          freedBytes += f.size
          heldBytes -= f.size
        },
        () => undefined,
      )
    }
  }
  return { removed, freedBytes, heldBytes, capBytes, deferred: false }
}

/** A quarter of what this origin may still store, or 0 when nobody will say. */
const CHUNK_CAP_SHARE = 0.25
export async function chunkCapBytes(): Promise<number> {
  try {
    const est = await navigator.storage?.estimate?.()
    const quota = est?.quota ?? 0
    return quota > 0 ? Math.floor(quota * CHUNK_CAP_SHARE) : 0
  } catch {
    return 0
  }
}

/**
 * THE CLAIM A RUNNING EXPORT LEAVES ON THE DISK — J9.
 *
 * One file, and its NAME is the whole record: `rclaim-<base36 heartbeat>-<id>`.
 * Nothing is ever read out of it, so a beat is a rename and a sweep is a string
 * compare over the listing it already has. There is no content to corrupt, no
 * lock to leak past its own staleness, and a tab killed mid-render leaves at
 * most one file that the next sweep past CLAIM_STALE_MS removes.
 *
 * It is deliberately COARSE — it says "somebody is exporting", not which chunks
 * — because a sweep in another tab cannot act on a key list it has no way to
 * keep current, and the expensive mistake is not "kept a chunk too long", it is
 * "deleted the render in front of a user and made it twice".
 */
export const CHUNK_CLAIM_PREFIX = 'rclaim-'

/** How long a claim speaks for. Beats are far shorter, so a live render always
 *  has a fresh one and a dead tab's goes quiet inside two minutes. */
const CLAIM_STALE_MS = 2 * 60 * 1000
const CLAIM_BEAT_MS = 20 * 1000

export interface ChunkCacheClaim {
  /** Release it. Safe to call twice; never throws. */
  release(): Promise<void>
}

async function liveClaimAmong(
  files: readonly { key: string }[],
  now: number,
): Promise<boolean> {
  for (const f of files) {
    if (!f.key.startsWith(CHUNK_CLAIM_PREFIX)) continue
    if (now - bornAt(f.key, CHUNK_CLAIM_PREFIX) < CLAIM_STALE_MS) return true
    await blobStore.remove(f.key).catch(() => undefined)
  }
  return false
}

/**
 * Claim the cache for the duration of one export. Null when OPFS refuses — a
 * render that cannot claim still renders, it just loses this protection, which
 * is the same contract every other part of this file keeps.
 */
export async function claimChunkCache(): Promise<ChunkCacheClaim | null> {
  const id = newId('k')
  const nameAt = (t: number): string => `${CHUNK_CLAIM_PREFIX}${t.toString(36)}-${id}`
  let key = nameAt(Date.now())
  try {
    const w = await createPositionedWriter(key)
    await w.write(new Uint8Array(1), 0)
    await w.close()
  } catch {
    return null
  }
  let done = false
  const timer = setInterval(() => {
    void (async () => {
      if (done) return
      const next = nameAt(Date.now())
      try {
        await blobStore.move(key, next)
        key = next
      } catch {
        /* a beat that misses is a claim that ages; the next one repairs it. */
      }
    })()
  }, CLAIM_BEAT_MS)
  // A worker or a page must never be held open by a heartbeat.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return {
    async release() {
      if (done) return
      done = true
      clearInterval(timer)
      await blobStore.remove(key).catch(() => undefined)
    },
  }
}

/**
 * MAKE ROOM BEFORE THE RENDER, NOT AFTER IT FAILS — J9.
 *
 * `sweepChunks` is a BOOT sweep and runs nowhere else, so an export that needs
 * more than the cap holds has never had anything to ask. This is that ask:
 * evict least-recently-used chunks that THIS plan does not need, until what is
 * held plus what this export is about to write fits under the cap.
 *
 * It reports honestly rather than promising: `fits` false means the take is
 * bigger than the cache can ever hold, and the caller's job is then to decide
 * that up front instead of discovering it an hour in.
 */
export async function makeRoomForChunks(
  wantBytes: number,
  keep: ReadonlySet<string>,
): Promise<{ fits: boolean; capBytes: number; heldBytes: number; freedBytes: number }> {
  const capBytes = await chunkCapBytes()
  const files = await blobStore.list()
  let heldBytes = 0
  const evictable: { key: string; size: number; touched: number }[] = []
  for (const f of files) {
    if (!f.key.startsWith(CHUNK_PREFIX)) continue
    heldBytes += f.size
    if (keep.has(f.key)) continue
    evictable.push({ key: f.key, size: f.size, touched: await chunkTouchedAt(f.key) })
  }
  // Nobody will say what the quota is: keep today's behaviour exactly.
  if (capBytes <= 0) return { fits: true, capBytes: 0, heldBytes, freedBytes: 0 }

  let freedBytes = 0
  if (heldBytes + wantBytes > capBytes) {
    evictable.sort((a, b) => a.touched - b.touched)
    for (const f of evictable) {
      if (heldBytes + wantBytes <= capBytes) break
      await blobStore.remove(f.key).then(
        () => {
          freedBytes += f.size
          heldBytes -= f.size
        },
        () => undefined,
      )
    }
  }
  return { fits: heldBytes + wantBytes <= capBytes, capBytes, heldBytes, freedBytes }
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
