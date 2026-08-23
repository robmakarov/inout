/**
 * EXPERIMENTAL — O3a evidence: Chromium MP4/H.264 capture.
 *
 * What has to be true before the default container flips:
 *  1. the engine really accepts an mp4 video MIME for MediaRecorder;
 *  2. a take recorded that way composes and exports as before;
 *  3. CRASH SALVAGE still works — this is the risk. Salvage demuxes whatever
 *     bytes reached disk before the tab died; that works for WebM because its
 *     clusters are self-describing, and only works for MP4 if the recorder
 *     writes FRAGMENTED mp4. A truncated non-fragmented mp4 has no moov and is
 *     undecodable, which would silently trade a working feature for CPU;
 *  4. camera-only takes stop being upscaled from 720p;
 *  5. Apple WebKit is unaffected (it never had a webm option anyway).
 */

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink } from 'mediabunny'
import { isAppleWebKit } from '@core/capabilities'
import { isSyntheticMode } from '@core/capture'
import { createCaptureSession } from '@core/capture/session'
import { hintTrackContent } from '@core/capture/acquire'
import { setVideoContainerPreference } from '@core/capture/session'
import { blobStore, recordingsRepo } from '@core/store'
import type { CaptureConfig, Recording } from '@core/types'

const CANDIDATES = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

async function recordTake(config: CaptureConfig, ms: number): Promise<Recording> {
  const session = await createCaptureSession(config)
  session.start()
  await new Promise((r) => setTimeout(r, ms))
  return session.stop()
}

/**
 * The REAL crash test. Truncating a finished file is not one: MediaRecorder may
 * buffer the whole mp4 and emit it at stop, in which case a tab kill leaves
 * nothing on disk at all — and the finished-file truncation would still look
 * fine. So record a take and, halfway through, read what has actually been
 * written to OPFS so far. That snapshot IS what a crash leaves behind.
 */
async function recordWithMidTakeSnapshot(
  config: CaptureConfig,
  ms: number,
): Promise<{ recording: Recording; snapshots: Map<string, Blob> }> {
  const before = new Set(await blobStore.listKeys())
  const session = await createCaptureSession(config)
  session.start()
  await new Promise((r) => setTimeout(r, Math.floor(ms / 2)))
  const snapshots = new Map<string, Blob>()
  for (const key of await blobStore.listKeys()) {
    if (before.has(key)) continue
    try {
      const live = await blobStore.read(key)
      // Copy out of the growing file so later writes cannot change it.
      snapshots.set(key, new Blob([await live.arrayBuffer()], { type: live.type }))
    } catch {
      /* file may not exist yet */
    }
  }
  await new Promise((r) => setTimeout(r, Math.ceil(ms / 2)))
  return { recording: await session.stop(), snapshots }
}

interface ChannelFacts {
  kind: string
  mimeType: string
  width?: number
  height?: number
  durationMs: number
  bytes: number
  bytesPerSec: number
  /** Demuxed from the actual file, not from what the recorder claimed. */
  codec: string | null
  decodable: boolean
}

async function describeChannels(recording: Recording): Promise<ChannelFacts[]> {
  const out: ChannelFacts[] = []
  for (const c of recording.channels) {
    if (c.media !== 'video') continue
    const blob = await blobStore.read(c.blobKey)
    let codec: string | null = null
    let decodable = false
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    try {
      const track = await input.getPrimaryVideoTrack()
      codec = track?.codec ?? null
      decodable = !!track && (await track.canDecode())
    } catch {
      /* reported as undecodable */
    } finally {
      input.dispose()
    }
    out.push({
      kind: c.kind,
      mimeType: c.mimeType,
      width: c.width,
      height: c.height,
      durationMs: c.durationMs,
      bytes: blob.size,
      bytesPerSec: Math.round(blob.size / Math.max(0.001, c.durationMs / 1000)),
      codec,
      decodable,
    })
  }
  return out
}

export interface SalvageProbe {
  kind: string
  mimeType: string
  fullBytes: number
  truncatedBytes: number
  /** Duration the container DECLARES for the truncated bytes, ms. */
  declaredMs: number | null
  /**
   * Timestamp of the last packet actually readable from the truncated bytes.
   * This is the number that matters: a fast-start mp4 declares the full
   * duration in a moov the truncation left intact while the frames it points
   * at are gone, so `declaredMs` alone would report a salvage that isn't one.
   */
  lastPacketMs: number | null
  /** A real decode at the far end of the readable range. */
  decodedAtTail: boolean
  fullMs: number | null
  /** Frames actually recoverable, as a fraction of what was recorded. */
  recoveredFraction: number | null
  salvaged: boolean
  error?: string
}

async function declaredDurationMs(b: Blob): Promise<number | null> {
  const input = new Input({ source: new BlobSource(b), formats: ALL_FORMATS })
  try {
    return Math.round((await input.computeDuration()) * 1000)
  } catch {
    return null
  } finally {
    input.dispose()
  }
}

/**
 * What can actually be recovered from `cut` — the bytes a crash would leave —
 * measured against `blob`, the take as it finished.
 */
async function probePartial(
  kind: string,
  mimeType: string,
  blob: Blob,
  cut: Blob,
): Promise<SalvageProbe> {
  {
    const measure = declaredDurationMs
    let declaredMs: number | null = null
    let lastPacketMs: number | null = null
    let decodedAtTail = false
    let error: string | undefined
    try {
      declaredMs = await measure(cut)
      const input = new Input({ source: new BlobSource(cut), formats: ALL_FORMATS })
      try {
        const track = await input.getPrimaryVideoTrack()
        if (track) {
          const sink = new EncodedPacketSink(track)
          let last = -1
          for await (const packet of sink.packets()) {
            if (packet.timestamp > last) last = packet.timestamp
          }
          lastPacketMs = last >= 0 ? Math.round(last * 1000) : null
          if (lastPacketMs !== null) {
            const samples = new VideoSampleSink(track)
            const sample = await samples.getSample(Math.max(0, lastPacketMs / 1000 - 0.05))
            if (sample) {
              decodedAtTail = true
              sample.close()
            }
          }
        }
      } finally {
        input.dispose()
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    const fullMs = await measure(blob)
    const recoveredFraction =
      lastPacketMs !== null && fullMs ? Math.round((lastPacketMs / fullMs) * 100) / 100 : null
    return {
      kind,
      mimeType,
      fullBytes: blob.size,
      truncatedBytes: cut.size,
      declaredMs,
      lastPacketMs,
      decodedAtTail,
      fullMs,
      recoveredFraction,
      // Salvage means recoverable FRAMES, decodable at the far end.
      salvaged: decodedAtTail && recoveredFraction !== null && recoveredFraction >= 0.4,
      error,
    }
  }
}

/** Finished-file truncation (cheap sanity check on container robustness). */
async function probeTruncation(recording: Recording, fraction = 0.6): Promise<SalvageProbe[]> {
  const out: SalvageProbe[] = []
  for (const c of recording.channels) {
    if (c.media !== 'video') continue
    const blob = await blobStore.read(c.blobKey)
    out.push(
      await probePartial(c.kind, c.mimeType, blob, blob.slice(0, Math.floor(blob.size * fraction), blob.type)),
    )
  }
  return out
}

/** The real crash model: what was on disk halfway through the take. */
async function probeMidTake(
  recording: Recording,
  snapshots: Map<string, Blob>,
): Promise<SalvageProbe[]> {
  const out: SalvageProbe[] = []
  for (const c of recording.channels) {
    if (c.media !== 'video') continue
    const snap = snapshots.get(c.blobKey)
    if (!snap) continue
    out.push(await probePartial(c.kind, c.mimeType, await blobStore.read(c.blobKey), snap))
  }
  return out
}

export interface O3aReport {
  syntheticMode: boolean
  appleWebKit: boolean
  userAgent: string
  supported: Record<string, boolean>
  runs: {
    preference: 'auto' | 'mp4' | 'webm'
    config: string
    channels: ChannelFacts[]
    contentHints: Record<string, string>
    /** Bytes on disk halfway through the take — the true crash model. */
    midTakeSalvage: SalvageProbe[]
    /** Finished file cut at 60% — container-robustness sanity check. */
    truncationSalvage: SalvageProbe[]
    takeMs: number
  }[]
  cameraFull: { width?: number; height?: number; note: string } | null
  notes: string[]
}

export async function runO3aEvidence(
  opts: { takeMs?: number; preferences?: ('auto' | 'mp4' | 'webm')[] } = {},
): Promise<O3aReport> {
  const takeMs = opts.takeMs ?? 6000
  const preferences = opts.preferences ?? ['auto', 'webm']
  const supported: Record<string, boolean> = {}
  for (const c of CANDIDATES) supported[c] = MediaRecorder.isTypeSupported(c)

  const runs: O3aReport['runs'] = []
  const config: CaptureConfig = { screen: true, camera: true, mic: true, systemAudio: false }
  for (const preference of preferences) {
    setVideoContainerPreference(preference)
    try {
      const { recording, snapshots } = await recordWithMidTakeSnapshot(config, takeMs)
      try {
        // contentHint readback: synthetic mode bypasses acquire(), so prove
        // the hint on a real track the same call would receive.
        const contentHints: Record<string, string> = {}
        {
          const probe = document.createElement('canvas').captureStream(30)
          const t = probe.getVideoTracks()[0]
          for (const kind of ['screen', 'camera'] as const) {
            hintTrackContent(t, kind)
            contentHints[kind] = (t as MediaStreamTrack & { contentHint?: string }).contentHint ?? ''
          }
          for (const track of probe.getTracks()) track.stop()
        }
        runs.push({
          preference,
          config: 'screen+camera+mic',
          channels: await describeChannels(recording),
          contentHints,
          midTakeSalvage: await probeMidTake(recording, snapshots),
          truncationSalvage: await probeTruncation(recording),
          takeMs: recording.durationMs,
        })
      } finally {
        await recordingsRepo.remove(recording.id).catch(() => undefined)
      }
    } finally {
      setVideoContainerPreference('auto')
    }
  }

  // Camera-only take: the camera fills the frame, so it must not be 720p.
  let cameraFull: O3aReport['cameraFull'] = null
  {
    const recording = await recordTake(
      { screen: false, camera: true, mic: true, systemAudio: false },
      3000,
    )
    try {
      const cam = recording.channels.find((c) => c.kind === 'camera')
      cameraFull = {
        width: cam?.width,
        height: cam?.height,
        note: 'camera-only take fills the output frame; 1280x720 here means the export upscales',
      }
    } finally {
      await recordingsRepo.remove(recording.id).catch(() => undefined)
    }
  }

  return {
    syntheticMode: isSyntheticMode(),
    appleWebKit: isAppleWebKit(),
    userAgent: navigator.userAgent,
    supported,
    runs,
    cameraFull,
    notes: [
      'salvage probe truncates each channel file to 60% — the state a mid-take tab kill leaves on disk',
      'synthetic mode drives canvas/oscillator sources, so the ENCODER is real but the scene is not a desktop',
    ],
  }
}
