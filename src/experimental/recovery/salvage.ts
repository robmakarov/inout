/**
 * EXPERIMENTAL — Orphan detection + partial-blob salvage (Experiment 3).
 *
 * Orphan definition: a blob in the production OPFS `blobs/` directory whose
 * key is not referenced by any Recording row in IndexedDB. Today this is
 * exactly what a mid-recording crash leaves behind (session.ts persists
 * metadata only inside stop()).
 *
 * Salvage: demux each orphan with mediabunny and compute its REAL duration
 * from packet timestamps (`computeDuration`), then reassemble a Recording-
 * shaped object. An un-finalized MediaRecorder webm has no duration header —
 * but its clusters are intact up to the last flushed timeslice, which is why
 * this works at all. That property (and its limits) is what this experiment
 * measures.
 *
 * READ-ONLY by default: `salvageOrphans` never writes anything. The returned
 * plan carries an explicit `commit()` that would save the salvaged Recording
 * through the production repo — provided for the demo, gated by an explicit
 * argument, and never called by the harness automatically.
 */

import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'
import { recordingsRepo } from '@core/store'
import type { ChannelKind, ChannelRecording, MediaKind, Recording } from '@core/types'
import { listProductionBlobs, readProductionBlob } from '../shared/opfs'

export interface OrphanBlob {
  key: string
  sizeBytes: number
}

export interface SalvagedChannel {
  key: string
  sizeBytes: number
  media: MediaKind | null
  /** Packet-computed duration, ms (null = undecodable). */
  durationMs: number | null
  width?: number
  height?: number
  mimeType: string
  decodable: boolean
  error?: string
}

export interface SalvageReport {
  orphans: OrphanBlob[]
  channels: SalvagedChannel[]
  /** Reassembled recording when at least one channel is decodable. */
  recording: Recording | null
  /** Persist the salvaged recording via the production repo (demo only). */
  commit: () => Promise<void>
}

export async function findOrphanBlobs(): Promise<OrphanBlob[]> {
  const [files, recordings] = await Promise.all([listProductionBlobs(), recordingsRepo.list()])
  const referenced = new Set(recordings.flatMap((r) => r.channels.map((c) => c.blobKey)))
  return files
    .filter((f) => !referenced.has(f.name) && !f.name.startsWith('__')) // skip dev dump files
    .map((f) => ({ key: f.name, sizeBytes: f.size }))
}

/** Blob keys look like `${recordingId}_${channelId}.webm` (see session.ts). */
export function groupOrphansByRecording(orphans: OrphanBlob[]): Map<string, OrphanBlob[]> {
  const groups = new Map<string, OrphanBlob[]>()
  for (const o of orphans) {
    const m = /^(rec_[a-z0-9]+)_ch_/.exec(o.key)
    const rid = m ? m[1] : 'unknown'
    const list = groups.get(rid) ?? []
    list.push(o)
    groups.set(rid, list)
  }
  return groups
}

async function probeBlob(key: string, blob: Blob): Promise<SalvagedChannel> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (video && (await video.canDecode())) {
      const [durationSec, width, height] = await Promise.all([
        video.computeDuration(),
        video.getDisplayWidth(),
        video.getDisplayHeight(),
      ])
      return {
        key,
        sizeBytes: blob.size,
        media: 'video',
        durationMs: Math.round(durationSec * 1000),
        width,
        height,
        mimeType: blob.type || 'video/webm',
        decodable: true,
      }
    }
    const audio = await input.getPrimaryAudioTrack()
    if (audio && (await audio.canDecode())) {
      const durationSec = await audio.computeDuration()
      return {
        key,
        sizeBytes: blob.size,
        media: 'audio',
        durationMs: Math.round(durationSec * 1000),
        mimeType: blob.type || 'audio/webm',
        decodable: true,
      }
    }
    return {
      key,
      sizeBytes: blob.size,
      media: null,
      durationMs: null,
      mimeType: blob.type || 'application/octet-stream',
      decodable: false,
      error: 'no decodable track',
    }
  } catch (err) {
    return {
      key,
      sizeBytes: blob.size,
      media: null,
      durationMs: null,
      mimeType: blob.type || 'application/octet-stream',
      decodable: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    input.dispose()
  }
}

function guessKind(media: MediaKind, index: number): ChannelKind {
  // Without a journal/log the channel KIND is not recoverable from the blob —
  // documented limitation; the journal (journal.ts) closes it. Heuristic:
  // first video = screen, later video = camera; first audio = mic.
  if (media === 'video') return index === 0 ? 'screen' : 'camera'
  return index === 0 ? 'mic' : 'system-audio'
}

export async function salvageOrphans(recordingId: string, orphans: OrphanBlob[]): Promise<SalvageReport> {
  const channels: SalvagedChannel[] = []
  for (const o of orphans) {
    const blob = await readProductionBlob(o.key)
    channels.push(await probeBlob(o.key, blob))
  }

  const usable = channels.filter((c) => c.decodable && c.durationMs !== null && c.durationMs > 0)
  let videoIdx = 0
  let audioIdx = 0
  const rebuilt: ChannelRecording[] = usable.map((c, i) => {
    const media = c.media as MediaKind
    const kind = guessKind(media, media === 'video' ? videoIdx++ : audioIdx++)
    const rec: ChannelRecording = {
      id: `salvaged_${i}`,
      kind,
      media,
      mimeType: c.mimeType,
      blobKey: c.key,
      // startOffsetMs is unrecoverable without the journal/session log —
      // salvage aligns all channels at 0 (worst-case skew = recorder startup
      // spread, typically < 300ms; measured by the harness).
      startOffsetMs: 0,
      durationMs: c.durationMs as number,
    }
    if (c.width) rec.width = c.width
    if (c.height) rec.height = c.height
    return rec
  })

  const recording: Recording | null =
    rebuilt.length > 0
      ? {
          id: `${recordingId}-salvaged`,
          createdAt: Date.now(),
          durationMs: rebuilt.reduce((m, c) => Math.max(m, c.durationMs), 0),
          channels: rebuilt,
        }
      : null

  return {
    orphans,
    channels,
    recording,
    async commit(): Promise<void> {
      if (!recording) throw new Error('nothing salvageable')
      await recordingsRepo.save(recording)
    },
  }
}
