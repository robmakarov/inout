/**
 * EXPERIMENTAL — Step 2/3: capture-side vs compose-side localization.
 *
 * Method. The rig's media content carries ground truth in the RIG CLOCK
 * (barcodes stamp every painted video frame; beeps fire at exact k·1000 ms rig
 * instants). Decoding the RAW per-channel webm files therefore recovers, for
 * each channel, the rig time of the file's t=0:
 *
 *     videoFileEpochRig = fit of (barcode rigMs) vs (raw file timestamp)
 *     audioFileEpochRig = k·1000 − onset file-time, k disambiguated against
 *                         the onstart-based expectation (error ≪ 500 ms)
 *
 * With those, everything decomposes exactly:
 *
 *   firstMediaLagMs(ch)  = fileEpochRig(ch) − onstartRig(ch)
 *       — how much the first actual media trails recorder.onstart.
 *   predictedSyncErrorMs = lag(video) − lag(audio)
 *       — what the CAPTURE-side bookkeeping error alone must produce in the
 *         export, because compose maps output t → local (t + gts − startOffset)
 *         and startOffset is onstart-based. (Derivation: offset =
 *         (videoEpochRig − audioEpochRig) − (assumedVideoOffset −
 *         assumedAudioOffset); epochs cancel leaving lag difference.)
 *   composeResidualMs    = measured export sync − predictedSyncErrorMs
 *       — whatever misalignment compose ADDS on top of capture bookkeeping.
 *
 * Decision rule (review step 2): predicted ≈ measured & residual ≈ 0 →
 * CAPTURE-SIDE; raw aligned (predicted ≈ 0) but export off → COMPOSE-SIDE.
 *
 * Falsification hooks (review step 3):
 *  (a) is proven if lag(video) ≫ lag(audio) AND predicted ≈ measured; it
 *      would be DISPROVEN by lag(video) ≈ lag(audio) (then raw files are
 *      aligned and the error must live downstream).
 *  (b) opus pre-skip is bounded by |lag(audio)|: any decoder-visible priming
 *      shift lands in audioFileEpochRig. |lag(audio)| ≪ error ⇒ (b) rejected.
 *  (c) compose windowing is bounded by |composeResidualMs|.
 *  (d) rig artifact: flash+click cross-check — flashes and beeps share rig
 *      instants; (audio onset − flash onset) in the export re-measures sync
 *      with no barcodes and no clock fit. Agreement within frame quantization
 *      validates the instrument itself.
 */

import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny'
import { exportRecording } from '@core/compose'
import { defaultEditState } from '@core/timeline'
import type { ChannelKind } from '@core/types'
import { readProductionBlob } from '../shared/opfs'
import { analyzeExport } from './analyze'
import {
  decodeBits,
  feedOnsetDetector,
  FID_BLOCK,
  FID_MARGIN,
  fitClock,
  newOnsetDetector,
  type BlockReader,
  type FrameReading,
} from './fiducial'
import {
  BEEP_INTERVAL_MS,
  recordFiducialSession,
  sweepStaleOracleBlobs,
  type RigDebug,
} from './rig'

// -- raw decoding ------------------------------------------------------------

function rawBlockReader(data: ImageData): BlockReader {
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
          sum += 0.299 * data.data[p] + 0.587 * data.data[p + 1] + 0.114 * data.data[p + 2]
          n++
        }
      }
      return n ? sum / n : 0
    },
  }
}

/** Barcode readings from a RAW channel webm (native resolution, no scaling). */
export async function rawVideoReadings(blob: Blob): Promise<FrameReading[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) return []
    const sink = new CanvasSink(track) // native size: barcode geometry unchanged
    const scratch = new OffscreenCanvas(
      FID_MARGIN + FID_BLOCK * 27 + 16,
      FID_MARGIN + FID_BLOCK + 16,
    )
    const g = scratch.getContext('2d', { willReadFrequently: true })
    if (!g) throw new Error('2d context unavailable')
    const readings: FrameReading[] = []
    for await (const wrapped of sink.canvases()) {
      g.drawImage(wrapped.canvas, 0, 0)
      const data = g.getImageData(0, 0, scratch.width, scratch.height)
      readings.push({ outSec: wrapped.timestamp, rigMs: decodeBits(rawBlockReader(data)) })
    }
    return readings
  } finally {
    input.dispose()
  }
}

/** Onset file-times from a RAW audio webm. */
export async function rawAudioOnsets(blob: Blob): Promise<number[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return []
    const det = newOnsetDetector()
    const sink = new AudioBufferSink(track)
    for await (const { buffer, timestamp } of sink.buffers()) {
      feedOnsetDetector(det, buffer.getChannelData(0), timestamp, buffer.sampleRate)
    }
    return det.onsetsSec
  } finally {
    input.dispose()
  }
}

/** Packet-precise media duration of a raw channel blob, ms. */
export async function rawFileDurationMs(blob: Blob, media: 'video' | 'audio'): Promise<number | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track =
      media === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack()
    if (!track) return null
    return (await track.computeDuration()) * 1000
  } finally {
    input.dispose()
  }
}

/**
 * Rig time of audio file t=0. Beep index k for the first onset is ambiguous
 * from the file alone; disambiguate with the onstart-based expectation, whose
 * error is far below the 1000 ms grid.
 *
 * `trueGridRigMs` (rig.debug.beepTrueRigMs, index k-1 = beep k) supplies the
 * MEASURED render times of the beeps; without it the nominal grid is used and
 * the returned epoch is early by the AudioContext startup stall.
 */
export function audioFileEpochRig(
  onsetsSec: number[],
  expectedEpochRigMs: number,
  trueGridRigMs?: number[],
): number | null {
  if (onsetsSec.length === 0) return null
  const first = onsetsSec[0]
  const k0 = Math.max(1, Math.round((expectedEpochRigMs + first * 1000) / BEEP_INTERVAL_MS))
  // Median over all onsets for robustness (each onset votes with its own k).
  const epochs: number[] = []
  for (const t of onsetsSec) {
    const k = k0 + Math.round(((t - first) * 1000) / BEEP_INTERVAL_MS)
    const beepRigMs =
      trueGridRigMs && trueGridRigMs.length >= k && k >= 1
        ? trueGridRigMs[k - 1]
        : k * BEEP_INTERVAL_MS
    epochs.push(beepRigMs - t * 1000)
  }
  const sorted = [...epochs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// -- report ------------------------------------------------------------------

export interface ChannelTimeBase {
  kind: ChannelKind
  media: 'video' | 'audio'
  /** Rig time of raw file t=0 (measured from content). */
  fileEpochRigMs: number | null
  /** Rig time of recorder.onstart (measured wall clock). */
  onstartRigMs: number
  /** Rig time of the recorder.start() CALL (measured wall clock). */
  startCallRigMs: number
  /** fileEpochRigMs - onstartRigMs: first media trails onstart by this much. */
  firstMediaLagMs: number | null
  /** fileEpochRigMs - startCallRigMs: where file t=0 sits vs the start() call. */
  lagVsStartCallMs: number | null
  /** Packet-precise blob duration, ms. */
  fileDurationMs: number | null
  /**
   * FIX CANDIDATE PREDICTOR: epoch derived as (stop instant − file duration).
   * If ≈ fileEpochRigMs across channels, deriving start offsets this way
   * (pure wall-clock + demux, no content knowledge) removes the defect.
   */
  stopAnchoredEpochRigMs: number | null
  /** stopAnchoredEpochRigMs − fileEpochRigMs: predictor error for this channel. */
  stopAnchorErrorMs: number | null
  /** Raw-decode support: readable frames or detected onsets. */
  evidencePoints: number
}

export interface LocalizationReport {
  recordMs: number
  sweptStaleKeys: string[]
  rig: RigDebug
  channels: ChannelTimeBase[]
  /** lag(video) - lag(audio): capture-side error, predicts export sync offset. */
  predictedSyncErrorMs: number | null
  /** Residual sync predicted under the stop-anchored fix candidate. */
  predictedSyncAfterFixMs: number | null
  /** Export sync measured by the standard oracle path (barcode clock fit). */
  measuredSyncErrorMs: number | null
  measuredLeads: string | null
  /** measured - predicted: what compose adds. Hypothesis (c) bound. */
  composeResidualMs: number | null
  /** Flash+click cross-check from the export (hypothesis (d) instrument check). */
  flashSyncMs: number | null
  hypotheses: { id: string; statement: string; outcome: string }[]
}

export async function runLocalization(
  recordMs = 6000,
  opts?: { armDelayMs?: number },
): Promise<LocalizationReport> {
  const sweptStaleKeys = await sweepStaleOracleBlobs()
  const rig = await recordFiducialSession(recordMs, {
    mix: { screen: true, camera: false, mic: true, systemAudio: false },
    flashClick: true,
    armDelayMs: opts?.armDelayMs,
  })
  try {
    // ---- raw per-channel time bases ----------------------------------------
    const channels: ChannelTimeBase[] = []
    for (const ch of rig.debug.channels) {
      const blob = await readProductionBlob(ch.blobKey)
      const onstartRigMs = ch.onstartAbsMs - rig.debug.rigEpochAbsMs
      const startCallRigMs = ch.startCallAbsMs - rig.debug.rigEpochAbsMs
      let fileEpochRigMs: number | null = null
      let evidencePoints = 0
      if (ch.media === 'video') {
        const readings = await rawVideoReadings(blob)
        const fit = fitClock(readings)
        // alpha of (rigMs vs fileSec) fit = rig time at file t=0.
        fileEpochRigMs = fit ? fit.alphaMs : null
        evidencePoints = fit?.usedPoints ?? 0
      } else {
        const onsets = await rawAudioOnsets(blob)
        fileEpochRigMs = audioFileEpochRig(onsets, onstartRigMs, rig.debug.beepTrueRigMs)
        evidencePoints = onsets.length
      }
      const fileDurationMs = await rawFileDurationMs(blob, ch.media)
      const stopCallRigMs = ch.stopCallAbsMs - rig.debug.rigEpochAbsMs
      const stopAnchoredEpochRigMs = fileDurationMs === null ? null : stopCallRigMs - fileDurationMs
      channels.push({
        kind: ch.kind,
        media: ch.media,
        fileEpochRigMs,
        onstartRigMs,
        startCallRigMs,
        firstMediaLagMs: fileEpochRigMs === null ? null : fileEpochRigMs - onstartRigMs,
        lagVsStartCallMs: fileEpochRigMs === null ? null : fileEpochRigMs - startCallRigMs,
        fileDurationMs,
        stopAnchoredEpochRigMs,
        stopAnchorErrorMs:
          stopAnchoredEpochRigMs === null || fileEpochRigMs === null
            ? null
            : stopAnchoredEpochRigMs - fileEpochRigMs,
        evidencePoints,
      })
    }

    const video = channels.find((c) => c.media === 'video')
    const audio = channels.find((c) => c.media === 'audio')
    const predictedSyncErrorMs =
      video?.firstMediaLagMs != null && audio?.firstMediaLagMs != null
        ? video.firstMediaLagMs - audio.firstMediaLagMs
        : null
    // Residual sync error IF start offsets were anchored at the
    // recorder.start() CALL instead of onstart (capture-side fix candidate;
    // excludes encode-chain effects like AAC priming, measured separately by
    // codecbias). offsetAfterFix = (trueV − trueA) − (startCallV − startCallA).
    const predictedSyncAfterFixMs =
      video?.lagVsStartCallMs != null && audio?.lagVsStartCallMs != null
        ? video.lagVsStartCallMs - audio.lagVsStartCallMs
        : null

    // ---- export through the untouched production pipeline -------------------
    const skews = rig.debug.beepScheduleSkewMs
    const exported = await exportRecording({
      recording: rig.recording,
      edit: defaultEditState(rig.recording),
    })
    const analysis = await analyzeExport(exported.blob, {
      beepGridRigMs: rig.debug.beepTrueRigMs,
      beepScheduleSkewMeanMs: skews.length
        ? skews.reduce((a, b) => a + b, 0) / skews.length
        : undefined,
    })
    const measuredSyncErrorMs = analysis.sync ? analysis.sync.meanOffsetMs : null
    const composeResidualMs =
      measuredSyncErrorMs !== null && predictedSyncErrorMs !== null
        ? measuredSyncErrorMs - predictedSyncErrorMs
        : null

    const hypotheses = [
      {
        id: '(a) first-media asymmetry vs onstart heuristic',
        statement:
          'video first frame trails onstart by ~error; audio does not; min-normalization bakes it in',
        outcome:
          video?.firstMediaLagMs != null && audio?.firstMediaLagMs != null
            ? `lag(video)=${video.firstMediaLagMs.toFixed(1)}ms lag(audio)=${audio.firstMediaLagMs.toFixed(1)}ms; ` +
              `predicted=${predictedSyncErrorMs?.toFixed(1)}ms vs measured=${measuredSyncErrorMs?.toFixed(1)}ms`
            : 'insufficient raw evidence',
      },
      {
        id: '(b) opus pre-skip / audio priming',
        statement: 'audio file timestamps shifted by encoder priming',
        outcome:
          audio?.firstMediaLagMs != null
            ? `bounded by |lag(audio)|=${Math.abs(audio.firstMediaLagMs).toFixed(1)}ms`
            : 'insufficient raw evidence',
      },
      {
        id: '(c) compose audio chunk-windowing',
        statement: 'compose misplaces audio relative to what capture metadata implies',
        outcome:
          composeResidualMs !== null
            ? `bounded by |composeResidual|=${Math.abs(composeResidualMs).toFixed(1)}ms`
            : 'not computable',
      },
      {
        id: '(d) rig artifact',
        statement: 'barcode/beep instrument itself misattributes the offset',
        outcome:
          analysis.flashSync && analysis.sync
            ? `flash+click (barcode-free) says ${analysis.flashSync.meanOffsetMs.toFixed(1)}ms vs barcode ${analysis.sync.meanOffsetMs.toFixed(1)}ms (agreement within frame quantization validates instrument)`
            : 'flash cross-check unavailable',
      },
    ]

    return {
      recordMs,
      sweptStaleKeys,
      rig: rig.debug,
      channels,
      predictedSyncErrorMs,
      predictedSyncAfterFixMs,
      measuredSyncErrorMs,
      measuredLeads: analysis.sync?.leads ?? null,
      composeResidualMs,
      flashSyncMs: analysis.flashSync?.meanOffsetMs ?? null,
      hypotheses,
    }
  } finally {
    await rig.cleanup()
  }
}
