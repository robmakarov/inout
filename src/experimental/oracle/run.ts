/**
 * EXPERIMENTAL — Oracle runner (Experiment 2), hardened per TD verdict item 3.
 *
 * Full loop: record a fiducial session -> export through the PRODUCTION
 * exportRecording (untouched) -> decode the export -> report numbers.
 *
 * Hardening in this revision:
 *  - trim parameter defaults to a NON-frame-aligned 1483 ms (1483/33.3 = 44.49
 *    frames; also off the 1 s audio chunk grid) — the earlier 1500 ms probe
 *    could hide rounding errors that frame alignment forgives;
 *  - maxAbsOffsetMs gated alongside |mean|;
 *  - sign convention surfaced in every verdict via SyncStats.leads
 *    (positive = audio late / video early — see fiducial.ts);
 *  - every production-storage touch wrapped so failures cannot strand
 *    exp-oracle-* keys, plus a stale-key sweep before each run.
 */

import { exportByBestPath, exportRecording, smartCutEnabled, type ExportPath } from '@core/compose'
import { getLastScratchStats } from '@core/compose/scratch'
import { defaultEditState } from '@core/timeline'
import { DEFAULT_EXPORT_SETTINGS, type EditState } from '@core/types'
import { analyzeAudioIntegrity, type AudioIntegrityReport } from './audioIntegrity'
import { analyzeExport, type ExportAnalysis } from './analyze'
import { recordFiducialSession, sweepStaleOracleBlobs, type RecordOptions } from './rig'
import { resolveScheduleSkewMeanMs } from './scheduleSkew'

export interface OracleVerdict {
  metric: string
  value: string
  pass: boolean | null
  note?: string
}

export interface OracleReport {
  recordMs: number
  trimStartMs: number
  sweptStaleKeys: string[]
  full: ExportAnalysis
  trimmed: ExportAnalysis
  audioIntegrity: AudioIntegrityReport | null
  /** alpha(trimmed) - alpha(full) - trimStartMs, ms. */
  trimErrorMs: number | null
  exportFullMs: number
  exportTrimmedMs: number
  /**
   * TAIL INTEGRITY (task O8, PO 2026-08-22: "Loom cuts last seconds — we don't
   * do that shit"). Everything needed to prove the END of the take survived:
   * the exported file's own duration against what was recorded, and the last
   * fiducial event actually present in it. A pipeline that silently drops its
   * final buffer shows up here and nowhere else.
   */
  tail: {
    recordedMs: number
    exportedMs: number
    /** exported − recorded. Negative = the end was cut off. */
    durationDeltaMs: number
    /** Output time of the last flash the export still contains, ms. */
    lastFlashMs: number | null
    /** Gap between that flash and the end of the file, ms. */
    lastFlashToEndMs: number | null
    /** Same for audio. */
    lastOnsetMs: number | null
    lastOnsetToEndMs: number | null
  }
  /**
   * Which of the three export paths actually produced the TRIMMED file (task
   * O5-flip). This is the field that stops the smart-cut gate being vacuous:
   * a run where the fast path quietly declined would otherwise measure the
   * render and pass, proving nothing about the path it was meant to gate.
   */
  trimmedPath: ExportPath
  /** Why each faster path was skipped, in order — the diagnosis when it is. */
  trimmedPathDeclined: { path: ExportPath; reason: string }[]
  /** What the trim SHOULD have taken given the flag — the anti-vacuity check. */
  expectedTrimmedPath: ExportPath
  /** Whether the rig recorded a composite at all (no composite ⇒ no fast path). */
  hasComposite: boolean
  /** A/V offset measured in the TRIMMED file, on the same flash+click metric. */
  trimmedSyncMeanMs: number | null
  trimmedSyncMaxAbsMs: number | null
  /** Same, for an UNEDITED export — i.e. the instant packet copy. Diagnostic. */
  instantPath: ExportPath | null
  instantSyncMeanMs: number | null
  instantSyncMaxAbsMs: number | null
  /** The composite's own clock: where its first frame sits, and how long it is. */
  compositeFirstPacketSec: number | null
  compositeDurationSec: number | null
  /** Export throughput: recorded ms per ms of export wall time. */
  exportRealtimeFactor: number
  /**
   * Peak OUTPUT bytes the muxer held in memory at once during the full export
   * (task O8, remainder). O1 made this O(1) by streaming to an OPFS scratch,
   * and measured it — 4.0 MB against 253.4 MB on a 30-minute take — but
   * nothing enforced it afterwards, so a future change could silently put the
   * whole file back in one ArrayBuffer and only a 30-minute take would notice.
   * Null when the scratch was unavailable and the in-memory target ran.
   */
  exportPeakOutputBytes: number | null
  verdicts: OracleVerdict[]
  /** Rig-side reference measurements (O4 step 1 residual decomposition). */
  rigDebug: {
    beepStreamArrivalsRigMs: number[]
    beepAnchorRigMs: number[]
    beepCloneArrivalsRigMs: number[]
    flashStreamArrivalsRigMs: number[]
    beepTrueRigMs: number[]
    audioSkewMeanMs: number | null
    flashSkewMeanMs: number | null
  }
}

/** Instrument gates — TD sync-fix review: flash+click is the sync verdict. */
export const MAX_SYNC_MEAN_MS = 30
export const MAX_SYNC_ABS_MS = 50
/** Barcode sync kept as drift/trim diagnostic only — not a pass/fail gate. */
export const MAX_BARCODE_SYNC_MEAN_MS = 80
export const MAX_DRIFT = 0.002 // 2ms/s
export const MAX_TRIM_ERROR_MS = 50
export const MIN_READABLE_RATIO = 0.9

/** Non-frame-aligned default (30 fps => 33.33 ms frames; 1483 ≈ 44.49 frames). */
export const DEFAULT_TRIM_MS = 1483

export interface OracleRunOptions extends RecordOptions {
  /**
   * Injection knob for the O8 tail band: export the take with this many ms
   * chopped off the end, i.e. simulate the pipeline dropping its final buffer.
   * A band nobody has seen go red is not a band.
   */
  injectTailLossMs?: number
}

export async function runOracle(
  recordMs = 6000,
  trimStartMs: number = DEFAULT_TRIM_MS,
  opts?: OracleRunOptions,
): Promise<OracleReport> {
  const sweptStaleKeys = await sweepStaleOracleBlobs()
  // flash+click is the sync gate — default on unless explicitly disabled.
  const rig = await recordFiducialSession(recordMs, {
    flashClick: true,
    // O5-flip: every real take has a composite, and without one here the two
    // packet-copying export paths cannot run — so the oracle would gate a file
    // shape the product never produces. Measured before switching on: the added
    // capture load does not move the sync band (see the O5-flip handoff).
    composite: true,
    ...opts,
    ...(opts && 'flashClick' in opts ? { flashClick: opts.flashClick } : {}),
  })
  try {
    const baseEdit = defaultEditState(rig.recording)
    const injectTailLossMs = Math.max(0, opts?.injectTailLossMs ?? 0)
    const edit: EditState = injectTailLossMs
      ? { ...baseEdit, globalTrimEndMs: Math.max(0, baseEdit.globalTrimEndMs - injectTailLossMs) }
      : baseEdit
    // Prefer MediaStream arrival skew (when beeps hit the mic track) over
    // AudioContext schedule mapping — the latter was swinging 100–400ms/run
    // and poisoning the flash+click gate after a correct capture path.
    // O4b: prefer the anchor-path beep reference. The track-processor clone
    // under-measures the delay the anchor cannot see (measured: 67 ms clone vs
    // 129 ms anchor path on the same rig), and that 60 ms gap was the bulk of
    // the "audio late" residual. Fall back to the clone when unavailable.
    const anchorArrivals = rig.debug.beepAnchorRigMs
    const streamArrivals = anchorArrivals.length
      ? anchorArrivals
      : rig.debug.beepStreamArrivalsRigMs
    const skewMean = resolveScheduleSkewMeanMs({
      streamArrivalsRigMs: streamArrivals,
      scheduleSkewSamplesMs: rig.debug.beepScheduleSkewMs,
      intervalMs: rig.debug.beepIntervalMs,
    })
    // O4 step 1: the video reference is now MEASURED too. Correcting only the
    // audio side left the rig's own rAF + captureStream(30) delay inside the
    // reported A/V offset — a systematic that no amount of engine work can
    // remove, because it never happened in the engine.
    const flashArrivals = rig.debug.flashStreamArrivalsRigMs
    const flashSkew = resolveScheduleSkewMeanMs({
      streamArrivalsRigMs: flashArrivals,
      scheduleSkewSamplesMs: [],
      intervalMs: rig.debug.beepIntervalMs,
    })
    const analyzeOpts = {
      beepGridRigMs: streamArrivals.length ? streamArrivals : rig.debug.beepTrueRigMs,
      beepScheduleSkewMeanMs: skewMean,
      flashScheduleSkewMeanMs: flashSkew,
    }

    const t0 = performance.now()
    const fullResult = await exportRecording({ recording: rig.recording, edit })
    const exportFullMs = performance.now() - t0
    const full = await analyzeExport(fullResult.blob, analyzeOpts)
    const audioIntegrity = await analyzeAudioIntegrity(fullResult.blob)

    const trimmedEdit: EditState = {
      ...edit,
      globalTrimStartMs: trimStartMs,
      globalTrimEndMs: rig.recording.durationMs,
    }
    // THE TRIMMED EXPORT GOES THROUGH THE PRODUCT'S OWN LADDER (task O5-flip).
    // It used to call exportRecording directly, so the render was the only
    // path any gate ever saw — and the render is what a user gets LAST. A
    // trim is the archetypal smart-cut edit (time-only, both boundaries off
    // the keyframe grid at 1483 ms), so this is where that path belongs.
    const t1 = performance.now()
    const trimmedChoice = await exportByBestPath({
      recording: rig.recording,
      edit: trimmedEdit,
      allowPacketCopy: true,
      settings: DEFAULT_EXPORT_SETTINGS,
    })
    const trimmedResult = trimmedChoice.result
    const exportTrimmedMs = performance.now() - t1
    const trimmed = await analyzeExport(trimmedResult.blob, analyzeOpts)

    const trimErrorMs =
      full.fit && trimmed.fit ? trimmed.fit.alphaMs - full.fit.alphaMs - trimStartMs : null

    // THE INSTANT PATH HAS NEVER BEEN MEASURED HERE, and it is the path most
    // takes actually get: an unedited export copies the composite's packets
    // wholesale. The render was the only thing this file ever gated, so if the
    // composite's own time base differs from the recording's, nothing would
    // have noticed. Diagnostic first — gated once its band is known.
    // WHERE DOES THE COMPOSITE'S CLOCK START? Both packet-copying paths assume
    // composite time IS recording time — CompositeRecording carries no offset
    // field, so nothing anywhere can express anything else. If the composite's
    // first frame is not at 0, every copied packet is shifted by that much
    // against audio mixed from the raw channels, on BOTH paths.
    let compositeFirstPacketSec: number | null = null
    let compositeDurationSec: number | null = null
    if (rig.recording.composite) {
      try {
        const { ALL_FORMATS, BlobSource, Input, EncodedPacketSink } = await import('mediabunny')
        const { blobStore } = await import('@core/store')
        const blob = await blobStore.read(rig.recording.composite.blobKey)
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
        try {
          const track = await input.getPrimaryVideoTrack()
          if (track) {
            const first = await new EncodedPacketSink(track).getFirstPacket({ metadataOnly: true })
            compositeFirstPacketSec = first ? Math.round(first.timestamp * 1e4) / 1e4 : null
          }
          compositeDurationSec = Math.round((await input.computeDuration()) * 1e4) / 1e4
        } finally {
          input.dispose()
        }
      } catch (err) {
        console.warn('[oracle] composite time-base probe failed', err)
      }
    }

    let instantSyncMeanMs: number | null = null
    let instantSyncMaxAbsMs: number | null = null
    let instantPath: ExportPath | null = null
    if (rig.recording.composite) {
      try {
        const instantChoice = await exportByBestPath({
          recording: rig.recording,
          edit: baseEdit,
          allowPacketCopy: true,
          settings: DEFAULT_EXPORT_SETTINGS,
        })
        instantPath = instantChoice.path
        const inst = await analyzeExport(instantChoice.result.blob, analyzeOpts)
        instantSyncMeanMs = inst.flashSyncCorrectedMeanMs ?? inst.flashSync?.meanOffsetMs ?? null
        instantSyncMaxAbsMs = inst.flashSyncCorrectedMaxAbsMs ?? inst.flashSync?.maxAbsOffsetMs ?? null
      } catch (err) {
        console.warn('[oracle] instant-path probe failed', err)
      }
    }

    const verdicts = buildVerdicts({
      recordMs,
      trimStartMs,
      full,
      trimmed,
      trimErrorMs,
      exportFullMs,
      audioIntegrity,
      trimmedPath: trimmedChoice.path,
      hasComposite: !!rig.recording.composite,
    })
    return {
      recordMs,
      trimStartMs,
      sweptStaleKeys,
      full,
      trimmed,
      audioIntegrity,
      trimErrorMs,
      exportFullMs,
      exportTrimmedMs,
      trimmedPath: trimmedChoice.path,
      trimmedPathDeclined: trimmedChoice.declined,
      expectedTrimmedPath: smartCutEnabled() ? 'smartcut' : 'render',
      hasComposite: !!rig.recording.composite,
      trimmedSyncMeanMs: trimmed.flashSyncCorrectedMeanMs ?? trimmed.flashSync?.meanOffsetMs ?? null,
      trimmedSyncMaxAbsMs:
        trimmed.flashSyncCorrectedMaxAbsMs ?? trimmed.flashSync?.maxAbsOffsetMs ?? null,
      instantPath,
      instantSyncMeanMs,
      instantSyncMaxAbsMs,
      compositeFirstPacketSec,
      compositeDurationSec,
      tail: (() => {
        const recordedMs = rig.recording.durationMs
        const exportedMs = full.durationSec * 1000
        const lastFlash = full.flashOnsetsSec.length
          ? full.flashOnsetsSec[full.flashOnsetsSec.length - 1]! * 1000
          : null
        const lastOnset = full.onsetsSec.length
          ? full.onsetsSec[full.onsetsSec.length - 1]! * 1000
          : null
        return {
          recordedMs: Math.round(recordedMs),
          exportedMs: Math.round(exportedMs),
          durationDeltaMs: Math.round(exportedMs - recordedMs),
          lastFlashMs: lastFlash === null ? null : Math.round(lastFlash),
          lastFlashToEndMs: lastFlash === null ? null : Math.round(exportedMs - lastFlash),
          lastOnsetMs: lastOnset === null ? null : Math.round(lastOnset),
          lastOnsetToEndMs: lastOnset === null ? null : Math.round(exportedMs - lastOnset),
        }
      })(),
      exportRealtimeFactor:
        exportFullMs > 0 ? Math.round((rig.recording.durationMs / exportFullMs) * 100) / 100 : 0,
      exportPeakOutputBytes: getLastScratchStats()?.maxOutstandingBytes ?? null,
      verdicts,
      rigDebug: {
        beepStreamArrivalsRigMs: streamArrivals,
        beepAnchorRigMs: anchorArrivals,
        beepCloneArrivalsRigMs: rig.debug.beepStreamArrivalsRigMs,
        flashStreamArrivalsRigMs: flashArrivals,
        beepTrueRigMs: rig.debug.beepTrueRigMs,
        audioSkewMeanMs: skewMean ?? null,
        flashSkewMeanMs: flashSkew ?? null,
      },
    }
  } finally {
    await rig.cleanup()
  }
}

function buildVerdicts(args: {
  recordMs: number
  trimStartMs: number
  full: ExportAnalysis
  trimmed: ExportAnalysis
  trimErrorMs: number | null
  exportFullMs: number
  audioIntegrity: AudioIntegrityReport | null
  trimmedPath: ExportPath
  hasComposite: boolean
}): OracleVerdict[] {
  const {
    recordMs,
    trimStartMs,
    full,
    trimmed,
    trimErrorMs,
    exportFullMs,
    audioIntegrity,
    trimmedPath,
    hasComposite,
  } = args
  const verdicts: OracleVerdict[] = []
  const readableRatio = full.flow.frames ? full.flow.readable / full.flow.frames : 0
  verdicts.push({
    metric: 'fiducial readability',
    value: `${(readableRatio * 100).toFixed(1)}% of ${full.flow.frames} frames (${full.fit?.rejectedPoints ?? 0} fit outliers rejected)`,
    pass: readableRatio >= MIN_READABLE_RATIO,
    note: 'below threshold the remaining metrics lose confidence',
  })
  verdicts.push({
    metric: 'A/V sync barcode+grid (diagnostic only)',
    value: full.sync
      ? `${full.sync.meanOffsetMs.toFixed(1)}ms over ${full.sync.matched} beeps — ${full.sync.leads}`
      : 'n/a',
    pass: null,
    note:
      'NOT a sync gate — measured grid absorbs constant A/V offset (see analyze.ts). Use for drift/trim only. ' +
      `beep grid: ${full.gridCorrected ? 'measured' : 'NOMINAL'}`,
  })
  if (full.flashSync) {
    const flashMean = full.flashSyncCorrectedMeanMs ?? full.flashSync.meanOffsetMs
    const flashMax =
      full.flashSyncCorrectedMaxAbsMs ?? full.flashSync.maxAbsOffsetMs
    const skewNote =
      full.flashSyncCorrectedMeanMs !== null ? ' (schedule-skew corrected)' : ''
    verdicts.push({
      metric: 'A/V sync (flash+click mean) — GATE',
      value: `${flashMean.toFixed(1)}ms over ${full.flashSync.matchedPairs} pairs${skewNote}`,
      pass: Math.abs(flashMean) <= MAX_SYNC_MEAN_MS,
      note: 'barcode-free; sole sync acceptance gate (|mean|≤30ms)',
    })
    verdicts.push({
      metric: 'A/V sync (flash+click max abs) — GATE',
      value: `${flashMax.toFixed(1)}ms${skewNote}`,
      pass: flashMax <= MAX_SYNC_ABS_MS,
      note: 'sole sync acceptance gate (maxAbs≤50ms)',
    })
  } else {
    verdicts.push({
      metric: 'A/V sync (flash+click) — GATE',
      value: 'n/a — enable flashClick',
      pass: false,
      note: 'sync gate requires flash+click; barcode alone is insufficient',
    })
  }
  if (audioIntegrity) {
    verdicts.push({
      metric: 'audio integrity (chunk-boundary jumps)',
      value: `max |Δ|=${audioIntegrity.maxBoundaryJump.toFixed(4)} over ${audioIntegrity.boundaryJumps.length} seams`,
      pass: audioIntegrity.boundaryPass,
      note: 'Task 3b gate: discontinuities >0.1 at 1s mix seams = click/buzz',
    })
    verdicts.push({
      metric: 'audio integrity (spurious spectrum)',
      value:
        audioIntegrity.spurPeakDb === null
          ? 'n/a'
          : `${audioIntegrity.spurPeakDb.toFixed(1)} dB vs tone`,
      pass: audioIntegrity.spectrumPass,
      note: 'Task 3b gate: content outside beep freq must be ≤ −40 dB',
    })
  }
  verdicts.push({
    metric: 'clock drift (beta-1)',
    value: full.fit ? `${((full.fit.beta - 1) * 1000).toFixed(3)}ms/s` : 'n/a',
    pass: full.fit ? Math.abs(full.fit.beta - 1) <= MAX_DRIFT : null,
  })
  verdicts.push({
    metric: 'frame timing jitter (rms)',
    value: full.fit ? `${full.fit.rmsMs.toFixed(1)}ms` : 'n/a',
    pass: null,
    note: 'informational — encoder frame reuse shows up here',
  })
  verdicts.push({
    metric: 'frame flow',
    value: `${full.flow.duplicates} dups, ${full.flow.gaps} gaps, median Δ ${full.flow.medianDeltaMs.toFixed(1)}ms`,
    pass: null,
    note: 'informational — synthetic source is rAF-driven',
  })
  verdicts.push({
    metric: 'trim accuracy (non-frame-aligned probe)',
    value:
      trimErrorMs === null ? 'n/a' : `${trimErrorMs.toFixed(1)}ms error at ${trimStartMs}ms trim`,
    pass: trimErrorMs === null ? null : Math.abs(trimErrorMs) <= MAX_TRIM_ERROR_MS,
  })
  // O5-flip: the trimmed file is the one a user gets after trimming, and since
  // it may now be assembled from COPIED packets plus a re-encoded boundary, its
  // A/V offset is a separate claim from the render's. Gated on the same band.
  const trimmedFlashMean =
    trimmed.flashSyncCorrectedMeanMs ?? trimmed.flashSync?.meanOffsetMs ?? null
  const trimmedFlashMax =
    trimmed.flashSyncCorrectedMaxAbsMs ?? trimmed.flashSync?.maxAbsOffsetMs ?? null
  verdicts.push({
    metric: `A/V sync of the TRIMMED export via '${trimmedPath}' (flash+click) — GATE`,
    value:
      trimmedFlashMean === null
        ? 'n/a'
        : `mean ${trimmedFlashMean.toFixed(1)}ms, maxAbs ${(trimmedFlashMax ?? 0).toFixed(1)}ms over ${trimmed.flashSync?.matchedPairs ?? 0} pairs`,
    pass:
      trimmedFlashMean === null
        ? null
        : Math.abs(trimmedFlashMean) <= MAX_SYNC_MEAN_MS &&
          (trimmedFlashMax ?? 0) <= MAX_SYNC_ABS_MS,
    note: 'the path a trimmed take actually takes — not the render it falls back to',
  })
  // Never let the gate above be vacuous: with a composite present and the flag
  // on, the trim MUST have taken smart cut. If it silently fell through to the
  // render, the run measured the thing that was already gated and the new gate
  // proved nothing — which is a failure, not a pass.
  verdicts.push({
    metric: 'trimmed export took the expected path',
    value: `${trimmedPath}${hasComposite ? '' : ' (rig recorded no composite)'}`,
    pass: !hasComposite ? null : trimmedPath === (smartCutEnabled() ? 'smartcut' : 'render'),
    note: hasComposite
      ? 'a fast path that quietly declines makes the sync gate above measure the wrong file'
      : 'informational — without a composite no packet-copying path can run',
  })
  verdicts.push({
    metric: 'export speed',
    value: `${(recordMs / exportFullMs).toFixed(2)}x realtime (${Math.round(exportFullMs)}ms for ${recordMs}ms)`,
    pass: null,
    note: 'baseline for streaming-export comparison (Experiment 5)',
  })
  return verdicts
}
