/**
 * EXPERIMENTAL — Oracle analyzer (Experiment 2, browser side).
 *
 * Decodes an exported file back into measurements:
 *  - per-frame barcode reads -> robust clock fit (offset alpha, drift beta,
 *    jitter, outliers rejected), duplicate/dropped-frame statistics;
 *  - audio onset detection -> A/V sync offset against the video clock
 *    (sign convention documented on SyncStats: positive = audio late);
 *  - optional flash detection (rig flashClick mode) -> a barcode-free,
 *    clock-fit-free second opinion on A/V sync: flashes and beeps fire at the
 *    SAME rig instants, so (audio onset - nearest flash onset) measures the
 *    same misalignment through an independent path (TD step 3d).
 *
 * SYNC VERDICT RULE (TD sync-fix review 2026-07-14):
 * Gate on flash+click ONLY. Barcode sync — even with measured beep-grid
 * correction — is demoted to drift/trim diagnostics.
 *
 * WHY GRID CORRECTION ABSORBS A CONSTANT A/V OFFSET (MEASURED):
 * The barcode path fits a video clock (alpha, beta) then matches each audio
 * onset to the nearest beep on a grid. When that grid is the MEASURED
 * AudioContext beep schedule (`beepGridRigMs`), schedule skew (100–300 ms
 * AudioContext startup stall) is removed from the residual. On the same
 * export that flash+click reported ~+172 ms (true capture-side audio lag),
 * barcode+grid reported ~−24 ms — the constant capture A/V offset was
 * absorbed into the grid/fit pairing and cancelled out of the sync residual.
 * flash+click shares no barcode clock and no beep grid, so it cannot cancel
 * that constant and remains the honest sync instrument.
 *
 * The rig canvas is 1280x720 and the export is 1080p with the same aspect
 * ratio, so contain-fit fills the frame exactly; requesting decoded canvases
 * at 1280x720 returns frames in rig pixel coordinates, and the barcode
 * geometry from fiducial.ts applies unchanged.
 */

import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny'
import {
  decodeBits,
  feedOnsetDetector,
  FID_BLOCK,
  FID_MARGIN,
  fitClock,
  frameFlowStats,
  newOnsetDetector,
  syncStats,
  type BlockReader,
  type ClockFit,
  type FrameFlowStats,
  type FrameReading,
  type SyncStats,
} from './fiducial'
import { BEEP_INTERVAL_MS, RIG_HEIGHT, RIG_WIDTH } from './rig'
import { isAliasedScheduleCorrection } from './scheduleSkew'

function blockReaderFor(data: ImageData): BlockReader {
  // Sample the central 50% of each block to dodge ringing at block edges.
  return {
    luma(i: number): number {
      const x0 = FID_MARGIN + i * FID_BLOCK + FID_BLOCK / 4
      const y0 = FID_MARGIN + FID_BLOCK / 4
      const size = FID_BLOCK / 2
      let sum = 0
      let n = 0
      for (let y = y0; y < y0 + size; y++) {
        for (let x = x0; x < x0 + size; x++) {
          const p = (Math.round(y) * data.width + Math.round(x)) * 4
          // Rec.601 luma approximation.
          sum += 0.299 * data.data[p] + 0.587 * data.data[p + 1] + 0.114 * data.data[p + 2]
          n++
        }
      }
      return n ? sum / n : 0
    },
  }
}

/** Mean luma of a mid-frame region untouched by barcode strip and moving bar. */
function backgroundLuma(data: ImageData): number {
  let sum = 0
  let n = 0
  for (let y = 300; y < 340; y += 4) {
    for (let x = 200; x < 1080; x += 8) {
      const p = (y * data.width + x) * 4
      sum += 0.299 * data.data[p] + 0.587 * data.data[p + 1] + 0.114 * data.data[p + 2]
      n++
    }
  }
  return n ? sum / n : 0
}

const FLASH_LUMA_THRESHOLD = 180

export interface FlashSync {
  flashes: number
  matchedPairs: number
  /** Same sign convention as SyncStats: positive = audio late vs video. */
  meanOffsetMs: number
  maxAbsOffsetMs: number
}

export interface AnalyzeOptions {
  /**
   * MEASURED rig times of the beeps (rig.debug.beepTrueRigMs). Without it the
   * nominal k·interval grid is used, which overstates the offset by the
   * AudioContext startup stall (100–300 ms, machine-dependent) — acceptable
   * only for relative comparisons within one session.
   */
  beepGridRigMs?: number[]
  /** Mean schedule skew (rig.debug.beepScheduleSkewMs) to correct flashSync. */
  beepScheduleSkewMeanMs?: number
  /** Mean rig-clock skew of FLASH arrivals (video-side reference). */
  flashScheduleSkewMeanMs?: number | null
}

export interface ExportAnalysis {
  fileBytes: number
  frames: FrameReading[]
  fit: ClockFit | null
  flow: FrameFlowStats
  onsetsSec: number[]
  sync: SyncStats | null
  /** True when sync was computed against the measured beep grid. */
  gridCorrected: boolean
  /** Barcode-free cross-check; null unless the rig ran with flashClick. */
  flashOnsetsSec: number[]
  /** Flash onsets dated at the midpoint of the sampling interval (unbiased). */
  flashOnsetsMidSec: number[]
  flashSync: FlashSync | null
  /** flashSync with the video-quantisation and audio-window biases removed. */
  flashSyncUnbiased: FlashSync | null
  flashSyncUnbiasedCorrectedMeanMs: number | null
  /** Unbiased detection AND both reference skews measured — the honest number. */
  flashSyncSymmetricMeanMs: number | null
  /**
   * flashSync corrected for the beep schedule skew (flashes paint on the
   * nominal grid; beeps sound on the true grid). Comparable to `sync`.
   */
  flashSyncCorrectedMeanMs: number | null
  /** maxAbs of (pairOffset − scheduleSkewMean) — the gate uses this, not raw maxAbs. */
  flashSyncCorrectedMaxAbsMs: number | null
  decodeMs: number
}

export async function analyzeExport(blob: Blob, opts?: AnalyzeOptions): Promise<ExportAnalysis> {
  const t0 = performance.now()
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const frames: FrameReading[] = []
    const flashOnsetsSec: number[] = []
    const flashOnsetsMidSec: number[] = []
    const videoTrack = await input.getPrimaryVideoTrack()
    if (videoTrack && (await videoTrack.canDecode())) {
      // fit is mandatory when both dimensions are set; rig and export are both
      // 16:9 so fill/contain/cover are equivalent here.
      const sink = new CanvasSink(videoTrack, { width: RIG_WIDTH, height: RIG_HEIGHT, fit: 'fill' })
      const scratch = new OffscreenCanvas(RIG_WIDTH, RIG_HEIGHT)
      const sg = scratch.getContext('2d', { willReadFrequently: true })
      if (!sg) throw new Error('2d context unavailable')
      let prevFlash = false
      let prevTs: number | null = null
      for await (const wrapped of sink.canvases()) {
        sg.drawImage(wrapped.canvas, 0, 0)
        const data = sg.getImageData(0, 0, RIG_WIDTH, RIG_HEIGHT)
        frames.push({ outSec: wrapped.timestamp, rigMs: decodeBits(blockReaderFor(data)) })
        const flash = backgroundLuma(data) > FLASH_LUMA_THRESHOLD
        if (flash && !prevFlash) {
          flashOnsetsSec.push(wrapped.timestamp)
          // The rig flashes the canvas from a rAF loop, but the canvas is
          // sampled by captureStream(30). The true flash instant therefore lies
          // uniformly in (previous frame, this frame] — dating it at THIS
          // frame is late by half a frame interval on average (16.7 ms at
          // 30 fps), which is inside the very band O4 step 1 is chasing.
          // The midpoint is the unbiased estimator.
          flashOnsetsMidSec.push(prevTs === null ? wrapped.timestamp : (prevTs + wrapped.timestamp) / 2)
        }
        prevFlash = flash
        prevTs = wrapped.timestamp
      }
    }

    const onsets = newOnsetDetector()
    const audioTrack = await input.getPrimaryAudioTrack()
    if (audioTrack && (await audioTrack.canDecode())) {
      const sink = new AudioBufferSink(audioTrack)
      for await (const { buffer, timestamp } of sink.buffers()) {
        feedOnsetDetector(onsets, buffer.getChannelData(0), timestamp, buffer.sampleRate)
      }
    }

    const fit = fitClock(frames)
    const flashSync = flashSyncStats(onsets.onsetsSec, flashOnsetsSec)
    // Same statistic with BOTH detection biases removed — reported alongside
    // so the instrument's own contribution to the residual is visible as a
    // number instead of an assumption.
    const flashSyncUnbiased = flashSyncStats(onsets.onsetsCenteredSec, flashOnsetsMidSec)
    const skewMean = opts?.beepScheduleSkewMeanMs
    const flashSkewMean = opts?.flashScheduleSkewMeanMs
    const skewOk =
      flashSync &&
      skewMean !== undefined &&
      !isAliasedScheduleCorrection(flashSync.meanOffsetMs, skewMean)
    const correctedMean =
      skewOk && flashSync ? flashSync.meanOffsetMs - skewMean : null
    const correctedMaxAbs =
      skewOk && flashSync
        ? Math.abs(flashSync.meanOffsetMs - skewMean) +
          Math.max(0, flashSync.maxAbsOffsetMs - Math.abs(flashSync.meanOffsetMs))
        : null
    return {
      fileBytes: blob.size,
      frames,
      fit,
      flow: frameFlowStats(frames),
      onsetsSec: onsets.onsetsSec,
      sync: fit ? syncStats(onsets.onsetsSec, fit, BEEP_INTERVAL_MS, opts?.beepGridRigMs) : null,
      gridCorrected: !!opts?.beepGridRigMs?.length,
      flashOnsetsSec,
      flashOnsetsMidSec,
      flashSync,
      flashSyncUnbiased,
      flashSyncUnbiasedCorrectedMeanMs:
        skewOk && flashSyncUnbiased ? flashSyncUnbiased.meanOffsetMs - (skewMean as number) : null,
      // Symmetric correction: subtract the rig's audio-vs-video reference skew,
      // not just its audio half.
      flashSyncSymmetricMeanMs:
        skewOk && flashSyncUnbiased && flashSkewMean !== undefined && flashSkewMean !== null
          ? flashSyncUnbiased.meanOffsetMs - ((skewMean as number) - flashSkewMean)
          : null,
      flashSyncCorrectedMeanMs: correctedMean,
      flashSyncCorrectedMaxAbsMs: correctedMaxAbs,
      decodeMs: performance.now() - t0,
    }
  } finally {
    input.dispose()
  }
}

/**
 * Pair audio onsets with flash onsets (same rig instants) and report
 * audio-minus-flash. Positive = audio late, matching SyncStats.
 *
 * Greedy nearest-within-±500ms aliases when a flash/onset is missing or
 * spurious (same bug class as schedule-stall index aliasing). Fix: one-to-one
 * sequential pairing across candidate first-flash alignments, keep the
 * lowest-variance alignment, then drop outliers >120ms from that mean.
 */
export function flashSyncStats(audioOnsetsSec: number[], flashOnsetsSec: number[]): FlashSync | null {
  if (flashOnsetsSec.length === 0 || audioOnsetsSec.length === 0) return null
  const audio = [...audioOnsetsSec].sort((a, b) => a - b)
  const flashes = [...flashOnsetsSec].sort((a, b) => a - b)
  const half = BEEP_INTERVAL_MS / 2
  const outlierMs = 120

  let bestOffsets: number[] | null = null
  let bestVar = Infinity

  for (let fStart = 0; fStart < flashes.length; fStart++) {
    const offsets: number[] = []
    let fi = fStart
    for (const a of audio) {
      if (fi >= flashes.length) break
      // Advance to the flash nearest this onset without rewinding (one-to-one).
      while (
        fi + 1 < flashes.length &&
        Math.abs(a - flashes[fi + 1]!) <= Math.abs(a - flashes[fi]!)
      ) {
        fi++
      }
      const d = (a - flashes[fi]!) * 1000
      if (Math.abs(d) <= half) {
        offsets.push(d)
        fi++
      }
    }
    if (offsets.length < 1) continue
    const mean = offsets.reduce((s, x) => s + x, 0) / offsets.length
    const variance = offsets.reduce((s, x) => s + (x - mean) ** 2, 0) / offsets.length
    if (
      !bestOffsets ||
      offsets.length > bestOffsets.length ||
      (offsets.length === bestOffsets.length && variance < bestVar)
    ) {
      bestOffsets = offsets
      bestVar = variance
    }
  }

  if (!bestOffsets || bestOffsets.length === 0) return null

  // Median consensus, then drop outliers — a spurious onset must not drag the mean.
  const sorted = [...bestOffsets].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const kept = bestOffsets.filter((d) => Math.abs(d - median) <= outlierMs)
  const use = kept.length >= 1 ? kept : bestOffsets
  const meanOffsetMs = use.reduce((s, x) => s + x, 0) / use.length
  const maxAbsOffsetMs = Math.max(...use.map((d) => Math.abs(d)))

  return {
    flashes: flashOnsetsSec.length,
    matchedPairs: use.length,
    meanOffsetMs,
    maxAbsOffsetMs,
  }
}
