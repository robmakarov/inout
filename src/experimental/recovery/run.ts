/**
 * EXPERIMENTAL — Recovery experiment runner (Experiment 3).
 *
 * KEY FINDING THIS RUNNER DEMONSTRATES: the production blob write path
 * (FileSystemDirectoryHandle.createWritable) stages writes in a swap file
 * that only commits on close(). A hard crash mid-recording therefore loses
 * the MEDIA BYTES, not just the metadata row. True crash durability needs
 * FileSystemSyncAccessHandle.flush() in a worker. The durability A/B below
 * proves both halves empirically, simulating a crash by terminating the
 * writer (worker) without close().
 *
 * The runner also exercises: journal write/read, orphan scan against real
 * production state (read-only), and a salvage pass over a deliberately
 * created orphan blob (cleaned up afterwards).
 */

import { blobStore } from '@core/store'
import { createCaptureSession, isSyntheticMode } from '@core/capture'
import { recordingsRepo } from '@core/store'
import { expReadFile, expRemove } from '../shared/opfs'
import { attachJournal, clearJournal, readJournal, type JournalEntry } from './journal'
import { findOrphanBlobs, groupOrphansByRecording, salvageOrphans, type SalvageReport } from './salvage'

export interface DurabilityResult {
  path: string
  bytesWritten: number
  bytesRecoveredAfterCrash: number
  survives: boolean
}

export interface RecoveryReport {
  journalDuringRecording: JournalEntry | null
  journalAfterStop: JournalEntry | null
  durability: DurabilityResult[]
  realOrphans: { recordingId: string; keys: string[] }[]
  salvage: {
    probed: number
    decodable: number
    durationsMs: (number | null)[]
    rebuiltDurationMs: number | null
  } | null
}

const PAYLOAD_BYTES = 1 << 20 // 1 MiB

async function durabilityViaCreateWritable(): Promise<DurabilityResult> {
  const name = 'exp-durability-writable.bin'
  await expRemove(name)
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('experimental', { create: true })
  const file = await dir.getFileHandle(name, { create: true })
  const w = await file.createWritable()
  await w.write(new Uint8Array(PAYLOAD_BYTES))
  // CRASH SIMULATION: never call w.close(); drop the stream on the floor.
  let recovered = 0
  try {
    recovered = (await expReadFile(name)).size
  } catch {
    recovered = 0
  }
  await w.abort().catch(() => undefined)
  await expRemove(name)
  return {
    path: 'createWritable (production blobStore path)',
    bytesWritten: PAYLOAD_BYTES,
    bytesRecoveredAfterCrash: recovered,
    survives: recovered === PAYLOAD_BYTES,
  }
}

async function durabilityViaSyncHandle(): Promise<DurabilityResult> {
  const name = 'exp-durability-sync.bin'
  await expRemove(name)
  const worker = new Worker(new URL('./durable-worker.ts', import.meta.url), { type: 'module' })
  const call = (msg: object, transfer: Transferable[] = []): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      worker.onmessage = (ev) => {
        const d = ev.data as { ok: boolean; error?: string }
        d.ok ? resolve(ev.data as Record<string, unknown>) : reject(new Error(d.error))
      }
      worker.postMessage(msg, transfer)
    })

  await call({ cmd: 'open', name })
  const payload = new Uint8Array(PAYLOAD_BYTES)
  await call({ cmd: 'write', bytes: payload.buffer }, [payload.buffer])
  // CRASH SIMULATION: kill the writer without close(). Terminating the worker
  // releases the sync-handle lock without any graceful shutdown path running.
  worker.terminate()
  // Give the browser a beat to release the lock.
  await new Promise((r) => setTimeout(r, 100))
  let recovered = 0
  try {
    recovered = (await expReadFile(name)).size
  } catch {
    recovered = 0
  }
  await expRemove(name)
  return {
    path: 'SyncAccessHandle+flush in worker (proposed durable path)',
    bytesWritten: PAYLOAD_BYTES,
    bytesRecoveredAfterCrash: recovered,
    survives: recovered === PAYLOAD_BYTES,
  }
}

/** Record a short real webm into production blobStore WITHOUT a Recording row. */
async function createDeliberateOrphan(): Promise<string> {
  const key = `rec_exporphan_ch_${Date.now().toString(36)}.webm`
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 240
  const g = canvas.getContext('2d')
  if (!g) throw new Error('2d context unavailable')
  let raf = 0
  const draw = (): void => {
    g.fillStyle = `hsl(${(performance.now() / 10) % 360}, 60%, 50%)`
    g.fillRect(0, 0, 320, 240)
    raf = requestAnimationFrame(draw)
  }
  draw()
  const stream = canvas.captureStream(15)
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' })
  const writable = await blobStore.createWriteStream(key)
  const writer = writable.getWriter()
  let chain: Promise<void> = Promise.resolve()
  recorder.ondataavailable = (ev) => {
    if (ev.data?.size) chain = chain.then(() => writer.write(ev.data)).catch(() => undefined)
  }
  const stopped = new Promise<void>((r) => (recorder.onstop = () => r()))
  recorder.start(250)
  await new Promise((r) => setTimeout(r, 1500))
  recorder.stop()
  await stopped
  await chain
  await writer.close()
  cancelAnimationFrame(raf)
  for (const t of stream.getTracks()) t.stop()
  return key
}

export async function runRecoveryExperiment(): Promise<RecoveryReport> {
  // 1. Journal: observe a short synthetic session (requires ?synthetic=1).
  let journalDuring: JournalEntry | null = null
  let journalAfter: JournalEntry | null = null
  if (isSyntheticMode()) {
    clearJournal()
    const session = await createCaptureSession({ screen: true, camera: false, mic: true, systemAudio: false })
    const detach = attachJournal(session, `exp-journal-${Date.now()}`)
    session.start()
    await new Promise((r) => setTimeout(r, 1200))
    journalDuring = readJournal()
    const recording = await session.stop()
    journalAfter = readJournal()
    detach()
    clearJournal()
    await recordingsRepo.remove(recording.id).catch(() => undefined)
  }

  // 2. Durability A/B.
  const durability = [await durabilityViaCreateWritable(), await durabilityViaSyncHandle()]

  // 3. Deliberate orphan -> scan -> salvage -> cleanup.
  const orphanKey = await createDeliberateOrphan()
  let salvage: SalvageReport | null = null
  let realOrphans: { recordingId: string; keys: string[] }[] = []
  try {
    const orphans = await findOrphanBlobs()
    const groups = groupOrphansByRecording(orphans)
    realOrphans = [...groups.entries()].map(([recordingId, blobs]) => ({
      recordingId,
      keys: blobs.map((b) => b.key),
    }))
    const target = groups.get('rec_exporphan')
    if (target) salvage = await salvageOrphans('rec_exporphan', target)
  } finally {
    await blobStore.remove(orphanKey).catch(() => undefined)
  }

  return {
    journalDuringRecording: journalDuring,
    journalAfterStop: journalAfter,
    durability,
    realOrphans,
    salvage: salvage
      ? {
          probed: salvage.channels.length,
          decodable: salvage.channels.filter((c) => c.decodable).length,
          durationsMs: salvage.channels.map((c) => c.durationMs),
          rebuiltDurationMs: salvage.recording?.durationMs ?? null,
        }
      : null,
  }
}
