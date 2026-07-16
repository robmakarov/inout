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

export function writePendingManifest(m: PendingManifest): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(m))
  } catch {
    /* storage unavailable — recovery degrades, recording continues */
  }
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

async function probeDurationMs(blobKey: string): Promise<number> {
  const blob = await blobStore.read(blobKey)
  if (!blob.size) return 0
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    return Math.round((await input.computeDuration()) * 1000)
  } finally {
    input.dispose()
  }
}

/** Rebuild a Recording from an interrupted session's surviving blobs. */
export async function salvagePendingRecording(): Promise<Recording | null> {
  const m = readPendingManifest()
  if (!m) return null
  // One-shot: a salvage that throws must not brick every subsequent boot.
  clearPendingManifest()
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
