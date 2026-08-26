/**
 * EXPERIMENTAL — X2 evidence, and it has to run HERE.
 *
 * X2's claim is that a caller already inside a dedicated worker can own its
 * OPFS SyncAccessHandle instead of shipping every chunk to a second worker.
 * The handle is `[Exposed=DedicatedWorker]`, so the claim is only testable from
 * a dedicated worker — the rig's own thread can never take the inline rung.
 *
 * "A/B the export and compare bytes" does NOT settle it: two exports of the
 * same take are not byte-identical anyway (measured — the video encoder is not
 * bit-reproducible run to run, which is why X4's gate says "byte-identical
 * where encoder determinism allows"). So this compares THE THING X2 CHANGED:
 * both writers are driven with one scripted sequence of positioned writes,
 * including the back-patch an mp4 finalize performs, and the two files must
 * come out byte for byte the same.
 */
import {
  blobStore,
  canOwnSyncHandle,
  createDurablePositionedWriter,
  createPositionedWriter,
  setInlinePositionedWriterEnabled,
  type PositionedDurableWriter,
} from '@core/store'

export interface WriterEquivalenceMsg {
  keyA: string
  keyB: string
  chunkBytes?: number
  chunks?: number
}

export interface WriterEquivalenceResult {
  ok: boolean
  error?: string
  /** False if this worker could not take the inline rung at all — then the
   *  comparison is worthless and says so instead of passing vacuously. */
  inlineAvailable: boolean
  inlineSize: number
  workerSize: number
  inlineHash: string
  workerHash: string
  identical: boolean
  inlineMs: number
  workerMs: number
  writes: number
  bytes: number
}

/** Deterministic pseudo-random bytes — same content for both writers. */
function fill(buf: Uint8Array, seed: number): Uint8Array {
  let x = seed >>> 0
  for (let i = 0; i < buf.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    buf[i] = x >>> 24
  }
  return buf
}

/**
 * The write pattern a muxer actually produces: a run of appends, then a
 * BACK-PATCH over bytes already on disk (mp4 rewrites its box sizes at
 * finalize), then one more append past the patch.
 */
async function script(
  writer: PositionedDurableWriter,
  chunkBytes: number,
  chunks: number,
): Promise<{ writes: number; bytes: number }> {
  let writes = 0
  let bytes = 0
  let position = 0
  for (let i = 0; i < chunks; i++) {
    // Vary the size: a real muxer's last chunk is short.
    const n = i === chunks - 1 ? Math.max(1, chunkBytes >> 2) : chunkBytes
    const data = fill(new Uint8Array(n), 0x51ed + i)
    await writer.write(data, position)
    position += n
    writes++
    bytes += n
  }
  // Back-patch the header, and one straddling rewrite in the middle.
  const header = fill(new Uint8Array(Math.min(64, chunkBytes)), 0xbeef)
  await writer.write(header, 0)
  writes++
  bytes += header.byteLength
  const patch = fill(new Uint8Array(Math.min(1024, chunkBytes)), 0xf00d)
  await writer.write(patch, Math.max(0, Math.floor(position / 2) - 7))
  writes++
  bytes += patch.byteLength
  // …and an append past everything, so the file's own length is exercised too.
  const tail = fill(new Uint8Array(Math.min(4096, chunkBytes)), 0x1234)
  await writer.write(tail, position)
  writes++
  bytes += tail.byteLength
  await writer.close()
  return { writes, bytes }
}

async function hashOf(key: string): Promise<{ hash: string; size: number }> {
  const blob = await blobStore.read(key)
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return {
    hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    size: blob.size,
  }
}

self.onmessage = async (ev: MessageEvent<WriterEquivalenceMsg>): Promise<void> => {
  const { keyA, keyB } = ev.data
  const chunkBytes = ev.data.chunkBytes ?? 4 * 1024 * 1024
  const chunks = ev.data.chunks ?? 4
  const post = (r: WriterEquivalenceResult): void => self.postMessage(r)
  try {
    // Rung 1: the inline writer, which only exists here.
    setInlinePositionedWriterEnabled(true)
    // If this thread could NOT own the handle, createPositionedWriter would
    // have fallen back and the comparison would be worker-vs-worker: it would
    // pass while proving nothing. Ask the same predicate the ladder branches on.
    const inlineAvailable = canOwnSyncHandle()
    const inline = await createPositionedWriter(keyA)
    const t0 = performance.now()
    const a = await script(inline, chunkBytes, chunks)
    const inlineMs = Math.round(performance.now() - t0)

    // Rung 2: the same script through the second writer worker, explicitly.
    const worker = await createDurablePositionedWriter(keyB)
    const t1 = performance.now()
    await script(worker, chunkBytes, chunks)
    const workerMs = Math.round(performance.now() - t1)

    const [ha, hb] = await Promise.all([hashOf(keyA), hashOf(keyB)])
    post({
      ok: true,
      inlineAvailable,
      inlineSize: ha.size,
      workerSize: hb.size,
      inlineHash: ha.hash.slice(0, 16),
      workerHash: hb.hash.slice(0, 16),
      identical: ha.hash === hb.hash && ha.size === hb.size,
      inlineMs,
      workerMs,
      writes: a.writes,
      bytes: a.bytes,
    })
  } catch (err) {
    post({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      inlineAvailable: false,
      inlineSize: 0,
      workerSize: 0,
      inlineHash: '',
      workerHash: '',
      identical: false,
      inlineMs: 0,
      workerMs: 0,
      writes: 0,
      bytes: 0,
    })
  }
}
