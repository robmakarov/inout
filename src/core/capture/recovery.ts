/**
 * Crash/refresh recovery. A pending manifest is written at record start and
 * cleared on clean stop/cancel; if the app boots and finds one, the surviving
 * channel blobs are probed and reassembled into a Recording. Independently,
 * the latest saved recording re-opens in the editor after a refresh unless
 * the user explicitly moved on ("New recording").
 */
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'
import type { ChannelKind, ChannelRecording, MediaKind, Recording } from '../types'
import { blobStore, recordingsRepo } from '@core/store'
import { crashFloorEnabled } from './crashFloor'
import { groupByRecording, selfManifestKey } from './selfManifest'

const PENDING_KEY = 'inout.pending'
const DISMISSED_KEY = 'inout.dismissed'

export interface PendingChannel {
  id: string
  kind: ChannelKind
  media: MediaKind
  mimeType: string
  blobKey: string
  startOffsetMs?: number
  width?: number
  height?: number
}

export interface PendingManifest {
  v: 1
  recordingId: string
  createdAt: number
  channels: PendingChannel[]
}

/**
 * H2b(a) — THE SECOND HOME OF THE MANIFEST, AND THE ONE THAT SURVIVES.
 *
 * localStorage has no commit. Chrome's storage service batches it, and H2's
 * floor probe measured what that costs: `kill -9` at 2.8 / 3.3 / 4.2 s into a
 * take and the manifest was simply NOT ON DISK — no Recording, no blobs,
 * takeCount 0, because the only pointer to files that were already written was
 * still in a buffer inside a process that had just been killed.
 *
 * An IndexedDB transaction has a real commit, and `durability: 'strict'` makes
 * it a flush rather than a promise to flush later. The localStorage write STAYS
 * and this is written beside it, additively: it is the shipped path, it is what
 * `?crashfloor=0` falls back to, and it costs nothing to keep. Whichever of the
 * two survives the crash, salvage finds one.
 *
 * ITS OWN DATABASE, NEVER A VERSION BUMP OF `inout` (see the note on
 * DB_VERSION in recordingsRepo.ts): a version bump is blocked forever by any
 * old tab still holding the previous version, and that jams every later open —
 * boot recovery included, which is this file. A database nobody has ever
 * opened has no old holders on any profile.
 */
const PENDING_DB_NAME = 'inout-pending'
const PENDING_DB_VERSION = 1
const PENDING_STORE = 'pending'
/** One row, always: the manifest is a singleton and a second one would be a bug. */
const PENDING_ROW = 'current'

let pendingDbPromise: Promise<IDBDatabase> | null = null

function openPendingDb(): Promise<IDBDatabase> {
  // A FAILED OPEN IS NOT CACHED. Holding on to the rejection would turn one
  // bad moment — storage pressure, a profile mid-eviction — into a manifest
  // that is never durable again for the life of the page.
  pendingDbPromise ??= newPendingDb().catch((err) => {
    pendingDbPromise = null
    throw err
  })
  return pendingDbPromise
}

function newPendingDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(PENDING_DB_NAME, PENDING_DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(PENDING_STORE)) {
        // OUT-OF-LINE KEY, AND THE ROW IS THE SAME JSON STRING localStorage
        // HOLDS. Two reasons, both about being readable from outside the app:
        // the two homes then hold identical bytes, and CDP's IndexedDB.requestData
        // hands back a string's VALUE while an object comes back as a preview —
        // which is what lets the crash rig read this off disk with the page's
        // scripts disabled, the one look at the crash state that is not the
        // app's own account of it.
        req.result.createObjectStore(PENDING_STORE)
      }
    }
    req.onsuccess = () => {
      req.result.onclose = () => {
        pendingDbPromise = null
      }
      req.result.onversionchange = () => {
        req.result.close()
        pendingDbPromise = null
      }
      resolve(req.result)
    }
    req.onerror = () => reject(req.error ?? new Error('pending manifest: failed to open IndexedDB'))
  })
}

/**
 * SERIALIZED, because these are fire-and-forget from a synchronous caller.
 * writeManifest() is called several times during arming and once more 2.5 s in;
 * two unordered transactions could land out of order and leave the manifest
 * describing fewer channels than the take has. One chain, in call order.
 */
let durableChain: Promise<unknown> = Promise.resolve()

function queueDurable<T>(fn: () => Promise<T>): Promise<T | null> {
  const next = durableChain.then(fn, fn).catch(() => null)
  durableChain = next
  return next as Promise<T | null>
}

function durableTx(
  db: IDBDatabase,
  fn: (s: IDBObjectStore) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // STRICT, and it is the whole point: the default ('relaxed') lets the
    // commit event fire before the bytes are flushed, which is the property
    // localStorage was already lost to.
    const tx = db.transaction(PENDING_STORE, 'readwrite', { durability: 'strict' })
    fn(tx.objectStore(PENDING_STORE))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('pending manifest: transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('pending manifest: transaction aborted'))
  })
}

function writeDurableManifest(m: PendingManifest): Promise<null | void> {
  const json = JSON.stringify(m)
  return queueDurable(async () => {
    const db = await openPendingDb()
    await durableTx(db, (s) => s.put(json, PENDING_ROW))
  })
}

/** Awaited by salvage: the one-shot must hold for this copy too. */
export function clearDurableManifest(recordingId?: string): Promise<null | void> {
  return queueDurable(async () => {
    const db = await openPendingDb()
    if (recordingId) {
      const row = await readDurableRow(db)
      if (row && row.recordingId !== recordingId) return
    }
    await durableTx(db, (s) => s.delete(PENDING_ROW))
  })
}

function readDurableRow(db: IDBDatabase): Promise<PendingManifest | null> {
  return new Promise<PendingManifest | null>((resolve, reject) => {
    const req = db
      .transaction(PENDING_STORE, 'readonly')
      .objectStore(PENDING_STORE)
      .get(PENDING_ROW) as IDBRequest<string | undefined>
    req.onsuccess = () => {
      if (typeof req.result !== 'string') return resolve(null)
      try {
        const m = JSON.parse(req.result) as PendingManifest
        resolve(m && m.v === 1 && Array.isArray(m.channels) ? m : null)
      } catch {
        resolve(null)
      }
    }
    req.onerror = () => reject(req.error ?? new Error('pending manifest: read failed'))
  })
}

export async function readDurableManifest(): Promise<PendingManifest | null> {
  try {
    return await readDurableRow(await openPendingDb())
  } catch {
    return null
  }
}

export function writePendingManifest(m: PendingManifest): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(m))
  } catch {
    /* storage unavailable — recovery degrades, recording continues */
  }
  if (crashFloorEnabled()) void writeDurableManifest(m)
}

export function clearPendingManifest(recordingId?: string): void {
  try {
    if (recordingId) {
      const raw = localStorage.getItem(PENDING_KEY)
      if (raw && (JSON.parse(raw) as PendingManifest).recordingId !== recordingId) return
    }
    localStorage.removeItem(PENDING_KEY)
  } catch {
    /* ignore */
  }
  if (crashFloorEnabled()) void clearDurableManifest(recordingId)
}

function readPendingManifest(): PendingManifest | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (!raw) return null
    const m = JSON.parse(raw) as PendingManifest
    return m && m.v === 1 && Array.isArray(m.channels) ? m : null
  } catch {
    return null
  }
}

/**
 * The blob keys a crashed take is still hoping to be salvaged from.
 *
 * Anything reclaiming orphaned storage has to leave these alone: they are the
 * one set of unreferenced files that is unreferenced ON PURPOSE, because the
 * Recording row is written at STOP and this manifest is what stands in for it
 * until then. Deleting them would turn a recoverable take into a lost one.
 */
export async function pendingBlobKeys(): Promise<string[]> {
  const keys = new Set<string>()
  for (const c of readPendingManifest()?.channels ?? []) keys.add(c.blobKey)
  // BOTH COPIES, because either one may be the survivor (H2b): a crash inside
  // the first seconds leaves the durable manifest and no localStorage one, and
  // sweeping by the copy that did not survive would delete exactly the blobs
  // the next boot is about to salvage.
  if (crashFloorEnabled()) {
    for (const c of (await readDurableManifest())?.channels ?? []) keys.add(c.blobKey)
  }
  return [...keys]
}

export function markRecordingDismissed(id: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, id)
  } catch {
    /* ignore */
  }
}

function isRecordingDismissed(id: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === id
  } catch {
    return false
  }
}

/**
 * HOW LONG THE FILE ON DISK ACTUALLY IS. Salvage's own question, and since H5
 * the stop path's too: a channel whose stop reply missed the budget knows its
 * bytes only from the platter, and its length only from here.
 */
export async function probeDurationMs(blobKey: string): Promise<number> {
  const blob = await blobStore.read(blobKey)
  if (!blob.size) return 0
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    return Math.round((await input.computeDuration()) * 1000)
  } finally {
    input.dispose()
  }
}

/**
 * H7 — THE TAKE WITH NO MANIFEST AT ALL, rebuilt by asking the files.
 *
 * Runs only when both manifests are gone, so the shipped path is untouched: a
 * take whose manifest survives never reaches this function. Every fact comes
 * from the file itself — the take and the role from its name (selfManifest.ts),
 * the media kind, geometry and length from probing the bytes — and a key that
 * does not match H7's exact shape is left alone, so a file from before H7, a
 * composite, a chunk or a stranger is never adopted.
 *
 * WHAT IT CANNOT KNOW, and does not pretend to: the per-channel start offsets
 * lived only in the manifest. Every channel is placed at 0 and the caller's
 * usual normalisation is a no-op — the take is a few tens of milliseconds out
 * of sync at worst, which is the difference between "a take that needs nudging"
 * and "an hour of somebody's work that no longer exists".
 */
async function salvageBySelfManifest(): Promise<Recording | null> {
  let keys: string[]
  try {
    keys = await blobStore.listKeys()
  } catch {
    return null
  }
  const takes = groupByRecording(keys)
  if (takes.size === 0) return null

  // Newest first, and a take the repo already holds is not lost — skip it
  // rather than resurrect a second copy of something the user can already see.
  const saved = await recordingsRepo.list().catch(() => [])
  const known = new Set(saved.map((r) => r.id))
  for (const [recordingId, parts] of takes) {
    if (known.has(recordingId) || isRecordingDismissed(recordingId)) continue
    const channels: ChannelRecording[] = []
    for (const part of parts) {
      try {
        const key = selfManifestKey(recordingId, part.kind, part.channelId, part.ext)
        const durationMs = await probeDurationMs(key)
        if (durationMs <= 0) continue
        const shape = await probeChannelShape(key)
        if (!shape) continue
        const rec: ChannelRecording = {
          id: part.channelId,
          kind: part.kind,
          media: shape.media,
          mimeType: shape.mimeType,
          blobKey: key,
          startOffsetMs: 0,
          durationMs,
        }
        if (shape.media === 'video' && shape.width) {
          rec.width = shape.width
          rec.height = shape.height
        }
        channels.push(rec)
      } catch {
        /* one unreadable channel does not lose the others */
      }
    }
    if (channels.length === 0) continue
    const recording: Recording = {
      id: recordingId,
      createdAt: Date.now(),
      durationMs: Math.max(...channels.map((c) => c.durationMs)),
      channels,
    }
    await recordingsRepo.save(recording)
    return recording
  }
  return null
}

/** Media kind, container and geometry read off the bytes, not off a manifest. */
async function probeChannelShape(
  blobKey: string,
): Promise<{ media: MediaKind; mimeType: string; width?: number; height?: number } | null> {
  const blob = await blobStore.read(blobKey)
  if (!blob.size) return null
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (video) {
      return {
        media: 'video',
        mimeType: blob.type || 'video/mp4',
        width: video.displayWidth,
        height: video.displayHeight,
      }
    }
    const audio = await input.getPrimaryAudioTrack()
    if (audio) return { media: 'audio', mimeType: blob.type || 'audio/webm' }
    return null
  } finally {
    input.dispose()
  }
}

/** Rebuild a Recording from an interrupted session's surviving blobs. */
export async function salvagePendingRecording(): Promise<Recording | null> {
  const m = readPendingManifest() ?? (crashFloorEnabled() ? await readDurableManifest() : null)
  // H7: no manifest of either kind — ask the files themselves.
  if (!m) return await salvageBySelfManifest()
  if (!m) return null
  // One-shot: a salvage that throws must not brick every subsequent boot. The
  // durable copy is AWAITED for exactly that reason — a fire-and-forget delete
  // that loses its race with a throw two lines down would brick every boot in
  // the one place this rule exists to protect.
  clearPendingManifest()
  if (crashFloorEnabled()) await clearDurableManifest()
  // The live composite of the interrupted take is DELIBERATELY not salvaged
  // (a crash-truncated composite has an unknown tail and must never be
  // packet-copied — 2026-08-23), which used to mean its blob was simply
  // orphaned in OPFS forever. Remove it; the channels below are the take.
  // Both names: the composite is `.mp4` since the container and the extension
  // were made to agree, and takes crashed before that are still `.webm`.
  void blobStore.remove(`${m.recordingId}_composite.mp4`).catch(() => undefined)
  void blobStore.remove(`${m.recordingId}_composite.webm`).catch(() => undefined)
  if (await recordingsRepo.get(m.recordingId)) return null

  const channels: ChannelRecording[] = []
  for (const ch of m.channels) {
    try {
      const durationMs = await probeDurationMs(ch.blobKey)
      if (durationMs <= 0) continue
      const rec: ChannelRecording = {
        id: ch.id,
        kind: ch.kind,
        media: ch.media,
        mimeType: ch.mimeType,
        blobKey: ch.blobKey,
        startOffsetMs: Math.max(0, Math.round(ch.startOffsetMs ?? 0)),
        durationMs,
      }
      if (ch.media === 'video' && ch.width) {
        rec.width = ch.width
        rec.height = ch.height
      }
      channels.push(rec)
    } catch {
      /* channel blob unreadable — salvage the rest */
    }
  }
  if (channels.length === 0) return null

  const minOffset = Math.min(...channels.map((c) => c.startOffsetMs))
  for (const c of channels) c.startOffsetMs -= minOffset
  const recording: Recording = {
    id: m.recordingId,
    createdAt: m.createdAt,
    durationMs: Math.max(...channels.map((c) => c.startOffsetMs + c.durationMs)),
    channels,
  }
  await recordingsRepo.save(recording)
  return recording
}

async function doRecover(): Promise<Recording | null> {
  const salvaged = await salvagePendingRecording().catch(() => null)
  if (salvaged) return salvaged
  try {
    const latest = (await recordingsRepo.list())[0]
    if (latest && latest.channels.length > 0 && !isRecordingDismissed(latest.id)) {
      // Don't boot the editor into a take whose media is gone.
      const probe = await blobStore.read(latest.channels[0].blobKey).catch(() => null)
      if (probe && probe.size > 0) return latest
    }
  } catch {
    /* repo unavailable */
  }
  return null
}

let bootRecovery: Promise<Recording | null> | null = null

/**
 * Boot entry: salvage an interrupted session if one exists, else re-open the
 * latest recording the user hasn't dismissed. Null -> normal capture screen.
 * Single-flight: the manifest is one-shot and React StrictMode double-invokes
 * boot effects — every caller shares one recovery pass.
 */
export function recoverRecordingToEdit(): Promise<Recording | null> {
  bootRecovery ??= doRecover()
  return bootRecovery
}
