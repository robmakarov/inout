/**
 * EXPERIMENTAL — F7 evidence: the export quality slider.
 *
 * Mirrors EditorScreen's export decision exactly (default tier + unedited +
 * composite ⇒ instant packet copy; anything else ⇒ full render at the tier's
 * settings) and checks the four things that make the slider trustworthy:
 * the size estimate is honest, the default tier is still instant, every tier
 * produces a file that decodes, and the choice survives a reload.
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { readCertification } from '@core/compose/certify'
import { createCaptureSession } from '@core/capture/session'
import { exportInstant } from '@core/compose/instant'
import { exportRecording } from '@core/compose'
import {
  QUALITY_TIERS,
  estimateExportBytes,
  isDefaultTier,
  loadQualityTier,
  saveQualityTier,
  settingsForTier,
} from '@core/compose/quality'
import { recordingsRepo } from '@core/store'
import { defaultEditState, outputDurationMs } from '@core/timeline'
import type { CaptureConfig, Recording } from '@core/types'

async function probe(blob: Blob): Promise<{
  width: number | null
  height: number | null
  durationSec: number
  decodedFrames: number
  certified: ReturnType<typeof readCertification>
}> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    const duration = await input.computeDuration()
    let decodedFrames = 0
    if (video) {
      const sink = new VideoSampleSink(video)
      for (const t of [0, duration / 2, Math.max(0, duration - 0.2)]) {
        const s = await sink.getSample(t)
        if (s) {
          decodedFrames++
          s.close()
        }
      }
    }
    const tags = await input.getMetadataTags()
    return {
      width: video?.displayWidth ?? null,
      height: video?.displayHeight ?? null,
      durationSec: Math.round(duration * 1000) / 1000,
      decodedFrames,
      certified: readCertification(tags.comment),
    }
  } finally {
    input.dispose()
  }
}

export interface TierResult {
  tier: string
  path: 'instant' | 'render'
  estimatedBytes: number
  actualBytes: number
  errorPct: number
  withinBand: boolean
  wallMs: number
  width: number | null
  height: number | null
  durationSec: number
  decodedFrames: number
  plays: boolean
  certified: ReturnType<typeof readCertification>
}

export interface F7Report {
  takeMs: number
  compositeBytes: number | null
  estimateFromSource: boolean
  tiers: TierResult[]
  prefs: { saved: string; reloaded: string; persisted: boolean }
  notes: string[]
}

export async function runQualityTiers(opts: { takeMs?: number } = {}): Promise<F7Report> {
  const takeMs = opts.takeMs ?? 6000
  const config: CaptureConfig = { screen: true, camera: true, mic: true, systemAudio: false }
  const session = await createCaptureSession(config)
  session.start()
  await new Promise((r) => setTimeout(r, takeMs))
  const recording: Recording = await session.stop()

  const tiers: TierResult[] = []
  try {
    const edit = defaultEditState(recording)
    const durMs = outputDurationMs(edit)
    for (const tier of QUALITY_TIERS) {
      const est = estimateExportBytes(recording, tier, durMs)
      const useInstant = isDefaultTier(tier) && !!recording.composite
      const t0 = performance.now()
      const result = useInstant
        ? await exportInstant({ recording, edit })
        : await exportRecording({ recording, edit, settings: settingsForTier(tier) })
      const wallMs = Math.round(performance.now() - t0)
      const p = await probe(result.blob)
      const errorPct =
        est.bytes > 0 ? Math.round(((result.blob.size - est.bytes) / est.bytes) * 1000) / 10 : 0
      tiers.push({
        tier: tier.id,
        path: useInstant ? 'instant' : 'render',
        estimatedBytes: est.bytes,
        actualBytes: result.blob.size,
        errorPct,
        withinBand: Math.abs(errorPct) <= 20,
        wallMs,
        ...p,
        plays: p.decodedFrames === 3,
      })
    }
  } finally {
    await recordingsRepo.remove(recording.id).catch(() => undefined)
  }

  // Persistence: save a non-default tier and read it back the way a reload would.
  const pick = QUALITY_TIERS.find((t) => !isDefaultTier(t))!
  saveQualityTier(pick)
  const reloaded = loadQualityTier()

  return {
    takeMs: recording.durationMs,
    compositeBytes: recording.composite?.bytes ?? null,
    estimateFromSource: estimateExportBytes(recording, QUALITY_TIERS[1]!, recording.durationMs)
      .fromSource,
    tiers,
    prefs: { saved: pick.id, reloaded: reloaded.id, persisted: reloaded.id === pick.id },
    notes: [
      'synthetic canvas content compresses far better than a real screen, so absolute sizes here are small — what is being tested is whether the ESTIMATE tracks the actual',
      'the default tier must report path=instant; any other path there means the packet-copy shortcut was lost',
    ],
  }
}
