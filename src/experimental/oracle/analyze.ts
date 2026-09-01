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
 *    same misalignment through an independent path (review step 3d).
 *
 * SYNC VERDICT RULE (sync-fix review 2026-07-14):
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
import { isAliasedScheduleCorrection, isAliasedSymmetricCorrection } from './scheduleSkew'

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
  /**
   * THE PER-SAMPLE OFFSETS THE TWO SUMMARY NUMBERS ARE MADE OF (task G1,
   * 2026-09-01). Every sync verdict this repo has ever argued about was argued
   * from `meanOffsetMs` and `maxAbsOffsetMs` — a mean and an EXTREME, with no
   * way to tell a wide scatter from a steady ramp, and those two have opposite
   * verdicts: one is the instrument, the other is the file. Both are here now,
   * with the flash time of each pair, so the distribution is data instead of a
   * reconstruction from three failing runs.
   */
  offsetsMs: number[]
  /** Export-timeline second of the FLASH in each kept pair, same index order. */
  pairSec: number[]
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
  /** Decoded duration of the exported file, seconds. */
  durationSec: number
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
  flashSyncSymmetricMaxAbsMs: number | null
  /**
   * flashSync corrected for the beep schedule skew (flashes paint on the
   * nominal grid; beeps sound on the true grid). Comparable to `sync`.
   */
  flashSyncCorrectedMeanMs: number | null
  /** maxAbs of (pairOffset − scheduleSkewMean) — the gate uses this, not raw maxAbs. */
  flashSyncCorrectedMaxAbsMs: number | null
  /** The audio-side reference skew that was offered, ms. */
  beepSkewMeanMs: number | null
  /** The video-side reference skew that was offered, ms. */
  flashSkewMeanMs: number | null
  /** beepSkew − flashSkew: what the symmetric metric subtracts (GATE-alias). */
  symmetricCorrectionMs: number | null
  /** True when that correction was refused as not credible; null when none was offered. */
  symmetricCorrectionRejected: boolean | null
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
    const skewMean = opts?.beepScheduleSkewMeanMs
    const flashSkewMean = opts?.flashScheduleSkewMeanMs
    /**
     * GATE-alias: the rig measured both reference schedules before this file
     * was decoded, and their difference is where a correctly-paired export's
     * offset must land — the take's own A/V error is tens of milliseconds, the
     * stall can be hundreds. Centring the pairing window there is the
     * difference between reporting +562 and reporting −438 on the same file.
     */
    const expectedOffsetMs =
      skewMean !== undefined && flashSkewMean !== undefined && flashSkewMean !== null
        ? skewMean - flashSkewMean
        : 0
    const flashSync = flashSyncStats(onsets.onsetsSec, flashOnsetsSec, expectedOffsetMs)
    // Same statistic with BOTH detection biases removed — reported alongside
    // so the instrument's own contribution to the residual is visible as a
    // number instead of an assumption.
    const flashSyncUnbiased = flashSyncStats(
      onsets.onsetsCenteredSec,
      flashOnsetsMidSec,
      expectedOffsetMs,
    )
    const skewOk =
      flashSync &&
      skewMean !== undefined &&
      !isAliasedScheduleCorrection(flashSync.meanOffsetMs, skewMean)
    /**
     * GATE-alias: the SYMMETRIC metric is what the gate bands, and it subtracts
     * (beepSkew − flashSkew) — a different number from the one skewOk vetted.
     * Each half is clamped to ±450 ms on its own, so both can look sane while
     * their difference is 900. Vet the total that is actually applied, and when
     * it is not credible produce NO symmetric number rather than a wrong one:
     * the gate then falls back down its own documented ladder (symmetric →
     * audio-corrected → raw) and prints which rung it used.
     */
    const symmetricOk =
      skewOk &&
      flashSyncUnbiased !== null &&
      skewMean !== undefined &&
      flashSkewMean !== undefined &&
      flashSkewMean !== null &&
      !isAliasedSymmetricCorrection(flashSyncUnbiased.meanOffsetMs, skewMean, flashSkewMean)
    const correctedMean =
      skewOk && flashSync ? flashSync.meanOffsetMs - skewMean : null
    const correctedMaxAbs =
      skewOk && flashSync
        ? Math.abs(flashSync.meanOffsetMs - skewMean) +
          Math.max(0, flashSync.maxAbsOffsetMs - Math.abs(flashSync.meanOffsetMs))
        : null
    return {
      fileBytes: blob.size,
      durationSec: await input.computeDuration(),
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
        symmetricOk && flashSyncUnbiased
          ? flashSyncUnbiased.meanOffsetMs - ((skewMean as number) - (flashSkewMean as number))
          : null,
      flashSyncSymmetricMaxAbsMs:
        symmetricOk && flashSyncUnbiased
          ? Math.abs(
              flashSyncUnbiased.meanOffsetMs - ((skewMean as number) - (flashSkewMean as number)),
            ) +
            Math.max(
              0,
              flashSyncUnbiased.maxAbsOffsetMs - Math.abs(flashSyncUnbiased.meanOffsetMs),
            )
          : null,
      flashSyncCorrectedMeanMs: correctedMean,
      flashSyncCorrectedMaxAbsMs: correctedMaxAbs,
      // GATE-alias: the corrections are now IN the report. This session had to
      // re-derive them from three failing runs because nothing printed them,
      // which is the difference between diagnosing a flake in ten minutes and
      // in an hour.
      beepSkewMeanMs: skewMean ?? null,
      flashSkewMeanMs: flashSkewMean ?? null,
      symmetricCorrectionMs:
        skewMean !== undefined && flashSkewMean !== undefined && flashSkewMean !== null
          ? skewMean - flashSkewMean
          : null,
      symmetricCorrectionRejected:
        skewMean !== undefined &&
        flashSkewMean !== undefined &&
        flashSkewMean !== null &&
        flashSyncUnbiased !== null
          ? !symmetricOk
          : null,
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
export function flashSyncStats(
  audioOnsetsSec: number[],
  flashOnsetsSec: number[],
  /**
   * WHERE THE OFFSET IS EXPECTED TO SIT, ms (task GATE-alias, 2026-08-25).
   *
   * The pairing window is half the beep grid wide, so without this it is
   * centred on ZERO and an offset past ±500 ms is not merely inaccurate — it is
   * unrepresentable, and comes back as its complement against the next flash.
   * A measured cold run: the AudioContext stalled 537 ms, so the audio in that
   * export genuinely sat +562 ms behind the flashes, and the estimator could
   * only report −438. Both readings describe the same file; only one of them is
   * about the take.
   *
   * The rig knows the answer before it looks: it measures both reference
   * schedules (beep arrivals and flash arrivals), and their difference IS the
   * offset a correctly-paired export should show. Centring the window there
   * makes +562 reachable and −438 nine hundred milliseconds away. Omitted (or
   * unmeasurable) falls back to zero, i.e. exactly the old behaviour.
   */
  expectedOffsetMs = 0,
): FlashSync | null {
  if (flashOnsetsSec.length === 0 || audioOnsetsSec.length === 0) return null
  const audio = [...audioOnsetsSec].sort((a, b) => a - b)
  const flashes = [...flashOnsetsSec].sort((a, b) => a - b)
  const half = BEEP_INTERVAL_MS / 2
  const outlierMs = 120
  const expected = Number.isFinite(expectedOffsetMs) ? expectedOffsetMs : 0

  /**
   * CONSENSUS, NOT COUNT (task GATE-alias, 2026-08-25).
   *
   * The previous estimator swept the FIRST flash index and kept the alignment
   * with the MOST pairs, variance only as a tie-break. That is exactly backwards
   * on this data. Every event here is a beep and a flash fired at the same rig
   * instant on a uniform 1 s grid, so a wrong alignment is not merely worse —
   * it is a different, self-consistent story about the same file, and it wins
   * on count whenever the detectors produce a spurious extra onset or drop a
   * real one. Measured consequence, three cold runs in fifteen: a whole file
   * scored at −453, −465 and −909 ms with every pair agreeing to the decimal,
   * i.e. maxAbs == |mean| exactly, which is a constant shift and not noise.
   *
   * So: every (onset, flash) pair PROPOSES a constant offset, and the offset
   * the most events independently agree on wins. A spurious event adds one
   * candidate and no support; a missing one removes support from every
   * candidate equally. Ties go to the SMALLER |offset|, and that prior is
   * honest rather than convenient: the band under test is ±90 ms while the grid
   * is 1000, so two hypotheses with equal support that differ by a grid period
   * cannot both be about the take — and the one that says "a whole second out"
   * needs more evidence than the one that says "in band", not less.
   */
  const INLIER_MS = 60

  /** One-to-one match under a proposed constant offset; residual + its flash time. */
  const matchUnder = (offsetMs: number): { d: number; sec: number }[] => {
    const out: { d: number; sec: number }[] = []
    let fi = 0
    for (const a of audio) {
      while (fi < flashes.length && (a - flashes[fi]!) * 1000 - offsetMs > INLIER_MS) fi++
      if (fi >= flashes.length) break
      const d = (a - flashes[fi]!) * 1000
      if (Math.abs(d - offsetMs) <= INLIER_MS) {
        out.push({ d, sec: flashes[fi]! })
        fi++
      }
    }
    return out
  }

  const candidates: number[] = []
  for (const a of audio) {
    for (const f of flashes) {
      const d = (a - f) * 1000
      if (Math.abs(d - expected) <= half) candidates.push(d)
    }
  }
  if (candidates.length === 0) return null

  let bestOffsets: { d: number; sec: number }[] | null = null
  let bestScore = -1
  let bestCentre = Infinity
  for (const c of candidates) {
    const offsets = matchUnder(c)
    if (offsets.length === 0) continue
    // Distance from the EXPECTATION, not from zero: with no expectation the two
    // are the same rule, and with one it is the rule that can be right.
    const centre = Math.abs(offsets.reduce((s, x) => s + x.d, 0) / offsets.length - expected)
    if (
      offsets.length > bestScore ||
      (offsets.length === bestScore && centre < bestCentre)
    ) {
      bestOffsets = offsets
      bestScore = offsets.length
      bestCentre = centre
    }
  }

  if (!bestOffsets || bestOffsets.length === 0) return null

  // Median consensus, then drop outliers — a spurious onset must not drag the mean.
  const sorted = [...bestOffsets].map((x) => x.d).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const kept = bestOffsets.filter((x) => Math.abs(x.d - median) <= outlierMs)
  const use = kept.length >= 1 ? kept : bestOffsets
  const meanOffsetMs = use.reduce((s, x) => s + x.d, 0) / use.length
  const maxAbsOffsetMs = Math.max(...use.map((x) => Math.abs(x.d)))

  return {
    flashes: flashOnsetsSec.length,
    matchedPairs: use.length,
    meanOffsetMs,
    maxAbsOffsetMs,
    offsetsMs: use.map((x) => Math.round(x.d * 100) / 100),
    pairSec: use.map((x) => Math.round(x.sec * 1000) / 1000),
  }
}
