/**
 * EXPERIMENTAL — salvage regression smoke for measured-video path (task 3a).
 *
 * Records a short fiducial take (production measured video+audio), leaves blobs
 * in OPFS, writes a pending manifest, then runs salvagePendingRecording.
 * Pass = every channel recovers with duration > 0 (video mp4 must probe).
 */

import { writePendingManifest, salvagePendingRecording } from '@core/capture/recovery'
import { recordingsRepo } from '@core/store'
import { recordFiducialSession, sweepStaleOracleBlobs } from './rig'

export interface SalvageSmokeReport {
  recordMs: number
  channelCount: number
  salvagedChannelCount: number
  channels: { kind: string; media: string; mimeType: string; durationMs: number; blobKey: string }[]
  originalDurations: { kind: string; mimeType: string; durationMs: number; startOffsetMs: number }[]
  videoMime: string | null
  pass: boolean
  note: string
}

export async function runSalvageSmoke(recordMs = 3000): Promise<SalvageSmokeReport> {
  await sweepStaleOracleBlobs()
  const rig = await recordFiducialSession(recordMs, {
    flashClick: true,
    mix: { screen: true, camera: false, mic: true, systemAudio: false },
  })
  try {
    writePendingManifest({
      v: 1,
      recordingId: rig.recording.id,
      createdAt: rig.recording.createdAt,
      channels: rig.recording.channels.map((c) => ({
        id: c.id,
        kind: c.kind,
        media: c.media,
        mimeType: c.mimeType,
        blobKey: c.blobKey,
        startOffsetMs: c.startOffsetMs,
        width: c.width,
        height: c.height,
      })),
    })
    // Rig never saves to the repo; clear any stale same-id row so salvage proceeds.
    await recordingsRepo.remove(rig.recording.id).catch(() => undefined)

    const salvaged = await salvagePendingRecording()
    const channels = (salvaged?.channels ?? []).map((c) => ({
      kind: c.kind,
      media: c.media,
      mimeType: c.mimeType,
      durationMs: c.durationMs,
      blobKey: c.blobKey,
    }))
    const video = channels.find((c) => c.media === 'video')
    const audio = channels.find((c) => c.media === 'audio')
    const pass =
      !!salvaged &&
      channels.length >= 2 &&
      !!video &&
      video.durationMs > recordMs * 0.5 &&
      !!audio &&
      audio.durationMs > recordMs * 0.5 &&
      (video.mimeType.includes('mp4') || video.mimeType.includes('webm'))

    return {
      recordMs,
      channelCount: rig.recording.channels.length,
      salvagedChannelCount: channels.length,
      channels,
      originalDurations: rig.recording.channels.map((c) => ({
        kind: c.kind,
        mimeType: c.mimeType,
        durationMs: c.durationMs,
        startOffsetMs: c.startOffsetMs,
      })),
      videoMime: video?.mimeType ?? null,
      pass,
      note: pass
        ? 'salvage recovered video+audio with positive durations'
        : 'salvage missing channel or zero duration — NO-MERGE',
    }
  } finally {
    await recordingsRepo.remove(rig.recording.id).catch(() => undefined)
    await rig.cleanup()
  }
}
