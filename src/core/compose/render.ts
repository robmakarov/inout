/**
 * The certified render — the export engine itself (task O5).
 *
 * This file used to BE pipeline.ts and ran on the main thread. It moved so a
 * worker could import it (export.worker.ts), which meant it had to lose every
 * `[Exposed=Window]` dependency: no AudioBuffer — audio.ts carries the PCM as
 * AudioSample now — no DOM, no document. `src/core` never imports `src/app`,
 * and this adds the tighter rule that the render never touches a Window-only
 * global either. It also stopped sleeping: `await yieldToUi()` every 8 frames
 * existed only because the render shared a thread with the UI, and in a worker
 * there is nothing to be polite to (yieldEveryFrames is 0 there, 8 in the
 * main-thread fallback, which is exactly the pre-O5 behaviour).
 *
 * WHAT O5 ASSUMED, AND WHAT MEASUREMENT SAID. The task was written on the
 * premise that this loop is "strictly serial — decode awaits draw awaits
 * encode", so pipelining the stages would buy multiples. The stage split this
 * file now keeps (RenderStats, `npm run exp -- o5`) says otherwise, on a 12 s
 * 1080p edited take:
 *
 *     decode-wait 1295 ms · draw 450 ms · encode-wait 28 ms · finalize 65 ms
 *     decode ALONE, same frames, no draw and no encode:  962 ms
 *
 * The encode was never the stall — mediabunny's encoder wrapper already keeps
 * four frames in the VideoEncoder queue and returns before they are encoded.
 * And the decode cannot be hidden behind the draw, because the expensive part
 * of "decode" is JS on this same thread: a prefetch pump that ran the decoder
 * ahead of the loop was built, measured, and removed for changing nothing.
 *
 * So the render is already overlapped as far as one JS thread allows, and its
 * floor is the cost of decoding every frame. The only lever left is to decode
 * FEWER frames — which is smart cut (O5c), not scheduling.
 */
import {
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  Output,
  type StreamTarget,
  type VideoSample,
} from 'mediabunny'
import { frameScale } from '@core/frame'
import { keyframeIntervalSec } from './keyframeInterval'
import { blobStore } from '@core/store'

/**
 * One macrotask back to the browser per this many frames.
 *
 * IT USED TO BE CONDITIONAL ON THE SIZE OF THE JOB and it is not any more (J1).
 * The old rule — yield only above 1920×1080×7200 pixels of total work — is
 * exactly the shape Robert's ruling rejects: a policy that behaves differently
 * at 2 minutes and at 2 hours. It also could not survive chunking, because a
 * five-second chunk is small by that measure however long the take is, so the
 * yield that stopped his machine freezing ("trying to export 1080 my computer
 * froze, i had to restart it manually", 2026-08-30) would have quietly switched
 * itself off on precisely the renders it exists for.
 *
 * So every render yields, at the same cadence, at every length. What it costs
 * is measured, not assumed: `npm run oracle` export throughput, 4.78× before
 * and after (baseline and chunked-off runs in the J1 handoff).
 */
const PACE_EVERY_FRAMES = 30
import {
  channelSourceTimeAt,
  isDefaultEdit,
  hasEnabledVideo,
  keptSegments,
  outputDurationMs,
  outputToRecordingMs,
  segmentJoinsMs,
  segmentOutputMs,
  segmentSpeed,
} from '@core/timeline'
import {
  DEFAULT_EXPORT_SETTINGS,
  type ChannelRecording,
  type EditState,
  type ExportOptions,
  type ExportProgress,
  type ExportResult,
} from '@core/types'
import {
  loudnessFromCaptureEnvelope,
  loudnessFromCaptureStats,
  makeStereoSample,
  makeupGainForLoudness,
  makeupGainForTargetLufs,
  measureMixEnvelope,
  busGainFor,
  openAudioMixers,
  type MixSource,
  softLimitSample,
} from './audio'
import {
  AUDIO_BITRATE,
  AUDIO_SAMPLE_RATE,
  VIDEO_BITRATE,
  pickEncodingTarget,
} from './codecs'
import { BitsAudit, formatBits } from './bits'
import { DEFAULT_TARGET_LUFS, gainForTargetLufs } from './lufs'
import { loudnessMode } from './loudnessMode'
import { drawVideoFrame, type FrameCanvas } from './layout'
import { fullColourActive, fullColourCodec, noteFullColourDeclined } from './fullColour'
import { cameraPoseAt, cameraTrackIsActive, viewportAt, viewportTrackIsActive } from '@core/timeline'
import { buildCertification, certificationComment } from './certify'
import { audioTrackGroups, separateAudioTracks } from './audioTracks'
import { noiseGateActive } from './gateFlag'
import {
  GATE_DEFAULTS,
  StreamingGate,
  noiseProfile,
  profileWindowFrames,
} from './spectralGate'
import { createExportScratch, type ExportScratch } from './scratch'
import { collectPeaks, createPeakBuffer, createWaveformRenderer } from './waveform'
import { createPaceGate } from './paceGate'
import { openVideoChannel, type VideoChannelReader } from './video'
export { openVideoChannel, type VideoChannelReader }
import { exportFileName } from './fileName'
import {
  av1QuantizerFor,
  constantQualityCodec,
  constantQualityQp,
  markConstantQuality,
  quantizerModeAccepts,
  registerConstantQualityEncoder,
} from './constantQuality'

/**
 * Half-width of the fade applied at every cut join (F1). The two sides of a
 * join are unrelated audio, so butting them together is a step discontinuity —
 * a click. Ramping to zero and back over a few ms costs nothing audible and
 * makes a join click-free regardless of what the two sides contain.
 */
const JOIN_FADE_MS = 3

/**
 * A muxer target the CALLER owns (task J1) — one render chunk's file, or the
 * one continuous audio artifact. Given one, this render bypasses the export
 * scratch entirely: the caller decides where the bytes land and publishes them
 * under whatever name it keeps them by.
 */
export interface RenderSink {
  target: StreamTarget
  /** After finalize: make the bytes visible and hand back a disk-backed view. */
  publish(mimeType: string): Promise<Blob>
  /** On any failure or abort: nothing is published. */
  discard(): Promise<void>
}

export interface RenderOptions extends ExportOptions {
  /**
   * Yield to the event loop every N frames. 0 (the worker) never yields —
   * nothing shares the thread. The main-thread fallback passes 8, which is what
   * this render did everywhere before O5.
   */
  yieldEveryFrames?: number
  /**
   * J1 — RENDER ONLY THESE OUTPUT FRAMES, [startFrame, endFrame).
   *
   * The frames are sampled at their GLOBAL output instants (so a chunk draws
   * exactly what the unbroken render draws at that moment) and written at
   * WINDOW-LOCAL timestamps (so the file stands on its own and concatenating it
   * is a rebase, never a re-encode). Absent = the whole output, which is every
   * caller that existed before J1.
   */
  window?: { startFrame: number; endFrame: number }
  /**
   * J1 — which tracks this call writes. 'both' is the unbroken render. The
   * chunked path splits them: 'video' per chunk, 'audio' once for the take,
   * because audio carries encoder priming and cannot be spliced at a chunk
   * boundary without a click (chunkPlan.ts says why at length).
   */
  tracks?: 'both' | 'video' | 'audio'
  /** J1 — see RenderSink. Absent = the export scratch, as before. */
  sink?: RenderSink | null
  /**
   * J1 — video readers the CALLER opened and owns. A chunked render opens one
   * set per contiguous run of missing chunks and walks it forward through them;
   * opening a set per chunk would re-demux the take hundreds of times, and
   * reusing one across a gap of cache hits would decode the gap. Absent = this
   * render opens and disposes its own, as before.
   */
  readers?: VideoChannelReader[] | null
  /**
   * J1 — force the container/codec decision to match the file the chunks will
   * be concatenated into. The ladder consults `needAudio` (codecs.ts), so a
   * video-only chunk would be free to pick a different rung than the final
   * file, and one avcC cannot describe two. Absent = derived, as before.
   */
  targetNeedsAudio?: boolean
}

/**
 * Where the render's wall clock actually went (task O5).
 *
 * O5 was written on the premise that the loop is "strictly serial — decode
 * awaits draw awaits encode". Measurement killed half of it: mediabunny's
 * encoder wrapper already keeps 4 frames in the VideoEncoder queue and only
 * blocks when that queue is full or the writer pushes back, so `await
 * source.add()` was never the stall it was assumed to be. Rather than argue
 * about which stage is the wall, the render now counts all of them. Costs two
 * performance.now() calls per stage per frame.
 *
 * The three video stages are wall clock AS THE LOOP EXPERIENCES IT, so they
 * sum to roughly the render's own duration: `encodeMs` is time the loop spent
 * WAITING on add(), not time the encoder spent working — a fast encoder that
 * never makes the loop wait reads near zero, which is the correct answer to
 * "what is holding this up".
 */
export interface RenderStats {
  frames: number
  /** Waiting for decoded source samples. */
  decodeMs: number
  /** Compositing onto the canvas (the only synchronous stage). */
  drawMs: number
  /** Waiting for the encoder/muxer to accept the frame. */
  encodeMs: number
  /** Mixing + encoding audio chunks. */
  audioMs: number
  /** Everything before the first frame: opening channels, loudness, probes. */
  prepareMs: number
  /** finalize() — the muxer flushing and patching the file. */
  finalizeMs: number
  /**
   * J7: publishing the finished bytes — `sink.publish()` / `scratch.finish()`.
   * It runs AFTER finalize() and was inside no stage at all, so on a short
   * export it was time that totalMs charged and no line accounted for.
   */
  publishMs: number
  /**
   * J7 — WHERE prepareMs GOES. Every field is ms of the same wall clock
   * prepareMs measures, and together with a small unattributed remainder they
   * sum to it. THIS IS THE SHORT-EDIT FLOOR: none of these scale with the
   * length of the take, so on a 30 s edit they are the export, and a chunked
   * export pays the lot ONCE PER CHUNK.
   */
  prep: {
    /** Opening video channel readers + audio mixers (demux, seek). */
    open: number
    /** The loudness probe — a second full decode. 0 when the envelope answered. */
    probe: number
    /** The codec ladder's `isConfigSupported` walk (`pickEncodingTarget`). */
    target: number
    /** The constant-quality codec probe, when quantizer mode is asked for. */
    cq: number
    /** O9(b)'s 4:4:4 probe. 0 unless `?colour=all`. */
    colour: number
    /** Opening the OPFS scratch file. */
    scratch: number
    /** `out.start()` — muxer header + encoder configure/warm. */
    start: number
  }
  totalMs: number
  /** Audio MIXERS opened purely to MEASURE loudness — a second full decode of
   *  the take (one mixer per channel × kept span). 0 when the capture envelope
   *  answered instead (X1); this is the number that gate counts. */
  probeDecodes: number
  /** O10(a): BS.1770 integrated loudness of the mix, when a probe measured it. */
  integratedLufs?: number | null
  /** What R128 targeting ASKED for, before the peak/floor bounds cut it. */
  r128AskedGain?: number
}

let lastStats: RenderStats | null = null

/** Stage split of the most recent render (evidence; O5/O8 bands). */
export function getLastRenderStats(): RenderStats | null {
  return lastStats
}

export function setLastRenderStats(s: RenderStats | null): void {
  lastStats = s
}

function formatStats(s: RenderStats): string {
  const pct = (ms: number): string => `${((100 * ms) / Math.max(1, s.totalMs)).toFixed(0)}%`
  return (
    `[export] ${s.frames} frames in ${Math.round(s.totalMs)}ms — ` +
    `prepare ${Math.round(s.prepareMs)}ms (${pct(s.prepareMs)}) · ` +
    `decode ${Math.round(s.decodeMs)}ms (${pct(s.decodeMs)}) · ` +
    `draw ${Math.round(s.drawMs)}ms (${pct(s.drawMs)}) · ` +
    `encode-wait ${Math.round(s.encodeMs)}ms (${pct(s.encodeMs)}) · ` +
    `audio ${Math.round(s.audioMs)}ms (${pct(s.audioMs)}) · ` +
    `finalize ${Math.round(s.finalizeMs)}ms (${pct(s.finalizeMs)}) · ` +
    `publish ${Math.round(s.publishMs)}ms (${pct(s.publishMs)})` +
    `\n${formatPrep(s)}`
  )
}

/**
 * J7: prepare's own split, printed beside it. `prepareMs` has been logged on
 * every export since O5 and it never said WHAT it was, so nobody read it: on a
 * short edit it is most of the export and every millisecond of it is fixed.
 */
export function formatPrep(s: RenderStats): string {
  const p = s.prep
  const named = p.open + p.probe + p.target + p.cq + p.colour + p.scratch + p.start
  const r = (ms: number): number => Math.round(ms)
  return (
    `[export] prepare ${r(s.prepareMs)}ms = open ${r(p.open)} · ` +
    `loudness ${r(p.probe)}${s.probeDecodes ? ` (${s.probeDecodes} probe decodes)` : ' (no probe)'} · ` +
    `ladder ${r(p.target)} · cq ${r(p.cq)} · colour ${r(p.colour)} · ` +
    `scratch ${r(p.scratch)} · encoder-start ${r(p.start)} · rest ${r(s.prepareMs - named)}`
  )
}

const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** How often a BACKGROUND render re-reads its brake inside a chunk (F16b).
 *  Distinct from PACE_EVERY_FRAMES above, which is O5's macrotask yield. */
const BRAKE_EVERY_FRAMES = 10

interface ActiveWindow {
  /** [outStartMs, outEndMs) — where the channel is active on the output timeline. */
  outStartMs: number
  outEndMs: number
  /** Channel-local end of the kept region, ms. */
  localEndMs: number
  /** channel-local ms = output ms + this. Differs per kept segment. Only
   *  meaningful at speed 1 — a sped span is not an affine shift of output time
   *  onto source time with slope 1, and its audio goes through SpeedSpanMixer. */
  localOffsetMs: number
}

/**
 * Interval form of the types.ts time model (per-frame lookups use
 * channelSourceTimeAt). One entry per KEPT SEGMENT the channel overlaps: with
 * mid-take cuts (F1) a channel's material is no longer one contiguous span of
 * the output, and each piece maps to source with its own offset.
 */
export function activeOutputWindowsMs(edit: EditState, channel: ChannelRecording): ActiveWindow[] {
  const ce = edit.channels.find((c) => c.channelId === channel.id)
  if (!ce || !ce.enabled) return []
  const localStartMs = Math.max(0, ce.trimStartMs)
  const localEndMs = Math.min(channel.durationMs, ce.trimEndMs)
  // The channel's kept material on the RECORDING timeline.
  const recStart = channel.startOffsetMs + localStartMs
  const recEnd = channel.startOffsetMs + localEndMs
  const out: ActiveWindow[] = []
  let outCursor = 0
  for (const seg of keptSegments(edit)) {
    const speed = segmentSpeed(seg)
    const segOutLen = segmentOutputMs(seg)
    const from = Math.max(recStart, seg.startMs)
    const to = Math.min(recEnd, seg.endMs)
    if (to > from) {
      out.push({
        outStartMs: outCursor + (from - seg.startMs) / speed,
        outEndMs: outCursor + (to - seg.startMs) / speed,
        localEndMs,
        // localSec = outSec + localOffsetSec, per segment.
        localOffsetMs: seg.startMs - outCursor - channel.startOffsetMs,
      })
    }
    outCursor += segOutLen
  }
  return out
}


export async function renderExport(opts: RenderOptions): Promise<ExportResult> {
  const { recording, edit, settings = DEFAULT_EXPORT_SETTINGS, onProgress, signal } = opts
  const yieldEveryFrames = opts.yieldEveryFrames ?? 0
  /**
   * F16b — THE ELASTIC BRAKE, and it is present only for a background job.
   * A user-visible export has no pace source and this is null, so the loop
   * below is byte-for-byte the loop that shipped: one null check per chunk.
   */
  const pace = opts.pace
    ? createPaceGate(opts.pace, {
        signal,
        onGiveUp: (pausedMs) =>
          console.info(
            `[compose] background render gave up after ${(pausedMs / 1000).toFixed(0)}s fully shed — ` +
              'the export will render on demand (F16b)',
          ),
      })
    : null
  const { width, height, fps } = settings
  const videoBitrate = settings.videoBitrate ?? VIDEO_BITRATE
  const gopSec = settings.keyFrameIntervalSec ?? keyframeIntervalSec()

  const report = (phase: ExportProgress['phase'], ratio: number): void => {
    onProgress?.({ phase, ratio: Math.min(1, Math.max(0, ratio)) })
  }
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError')
  }

  const stats: RenderStats = {
    frames: 0,
    decodeMs: 0,
    drawMs: 0,
    encodeMs: 0,
    audioMs: 0,
    prepareMs: 0,
    finalizeMs: 0,
    publishMs: 0,
    prep: { open: 0, probe: 0, target: 0, cq: 0, colour: 0, scratch: 0, start: 0 },
    totalMs: 0,
    probeDecodes: 0,
  }
  const t0 = performance.now()
  /** J7: one clock, read around each fixed stage. `since(t)` is ms elapsed. */
  const since = (t: number): number => performance.now() - t
  setLastRenderStats(null)

  report('preparing', 0)
  throwIfAborted()

  const durationMs = outputDurationMs(edit)
  if (durationMs <= 0) throw new Error('Export window is empty')
  const durationSec = durationMs / 1000

  const waveformMode = !hasEnabledVideo(recording, edit)
  // J1: which tracks this call is responsible for. 'both' is every caller that
  // existed before the chunked path, and every branch below reads exactly as it
  // did for them.
  const tracks = opts.tracks ?? 'both'
  const wantVideo = tracks !== 'audio'
  const wantAudio = tracks !== 'video'
  const sink = opts.sink ?? null
  /** Chunk files are internal and thrown away by the concatenation — they do not
   *  carry certification tags, size summaries or a stats line of their own. */
  const quiet = sink !== null
  const borrowedReaders = opts.readers ?? null
  const videoReaders: VideoChannelReader[] = borrowedReaders ? [...borrowedReaders] : []
  const audioMixers: MixSource[] = []
  let output: Output | null = null
  let scratch: ExportScratch | null = null
  let certified: {
    makeup: number
    loudRms: number
    peak: number
    fromCaptureStats: boolean
  } | null = null

  try {
    const tOpen = performance.now()
    for (const channel of recording.channels) {
      if (channel.media !== 'video' || waveformMode) continue
      // J1: the caller brought its own, already positioned at this window.
      if (borrowedReaders || !wantVideo) continue
      throwIfAborted()
      // Video is sampled per frame through channelSourceTimeAt, which already
      // understands cuts — the reader only needs the channel's last kept
      // source instant, which is the same across segments.
      const windows = activeOutputWindowsMs(edit, channel)
      if (windows.length === 0) continue
      const blob = await blobStore.read(channel.blobKey)
      const reader = await openVideoChannel(
        blob,
        channel.id,
        channel.kind,
        windows[windows.length - 1]!.localEndMs / 1000,
      )
      if (reader) videoReaders.push(reader)
    }

    if (wantAudio) audioMixers.push(...(await openAudioMixers(recording, edit, throwIfAborted)))
    stats.prep.open = since(tOpen)
    const needAudio = audioMixers.length > 0
    /**
     * J1: the ladder's rung must be the FINAL FILE'S rung, not this call's. A
     * video-only chunk asked with needAudio=false could land on a chain the
     * final file (which has audio) would have skipped, and a track carries one
     * avcC — half the file would then decode to garbage. Told, never guessed.
     */
    const targetNeedsAudio = opts.targetNeedsAudio ?? needAudio
    const totalAudioFrames = Math.round(durationSec * AUDIO_SAMPLE_RATE)
    // Headroom for the render sum: a single source stays full-scale (gain 1,
    // never limited); multiple sources (mic + system audio) mix equal-power so
    // their sum does not clip into softLimitSample. Unity summing here was the
    // pervasive-noise cause after the composite export path was removed.
    const baseGain = busGainFor(audioMixers)
    for (const m of audioMixers) m.gain = baseGain

    // Loudness normalize: quiet captures (real case: Robert's take had voice at
    // −25 dB window-RMS under a 0.77 transient peak) export near-inaudible.
    // Measure SPEECH loudness (p90 window RMS) on a throwaway mixer set — the
    // render streams forward and can't rewind — and drive it to target. Peak
    // targeting was defeated by a single mic bump; percentile loudness isn't.
    // No-op for a healthy mix, so the fidelity oracle is untouched.
    if (needAudio) {
      const tProbe = performance.now()
      // O2: an UNEDITED window is exactly the mix capture measured, so the
      // probe pass can be skipped here too. Any trim changes the mix — those
      // render paths still probe.
      // X1: an EDITED window is a SELECTION of the windows capture measured, so
      // it does not need the probe either — the envelope is kept in time order
      // and the kept spans pick out of it. Same shortcut, one rung wider.
      const mixedIds = audioMixers.flatMap((m) => m.channelIds)
      // O10(a): R128 CANNOT take the capture-envelope shortcut. The envelope is
      // unweighted window RMS, and K-weighting has to see the actual signal —
      // so this mode always probes. That is the honest cost of the mode and the
      // reason it is not free the way X1's shortcut is.
      const wantR128 = loudnessMode() === 'r128'
      const stored = wantR128
        ? null
        : isDefaultEdit(recording, edit)
          ? loudnessFromCaptureStats(recording.loudness, mixedIds, baseGain)
          : loudnessFromCaptureEnvelope(recording.loudness, recording, edit, mixedIds, baseGain)
      if (stored) {
        const makeup = makeupGainForLoudness(stored)
        if (makeup !== 1) for (const m of audioMixers) m.gain = baseGain * makeup
        certified = { makeup, loudRms: stored.loudRms, peak: stored.peak, fromCaptureStats: true }
        console.info(
          `compose: audio loudness from capture stats p90rms ${stored.loudRms.toFixed(4)} peak ${stored.peak.toFixed(3)} → makeup ${makeup.toFixed(2)}× (no probe decode)`,
        )
      } else {
        const probe = await openAudioMixers(recording, edit, throwIfAborted)
        stats.probeDecodes = probe.length
        try {
          const env = await measureMixEnvelope(probe, baseGain, totalAudioFrames, throwIfAborted, (r) =>
            report('preparing', 0.04 * r),
          )
          const loud = { peak: env.peak, peakRobust: env.peakRobust, loudRms: env.loudRms, floorRms: env.floorRms }
          stats.integratedLufs = env.integratedLufs
          let makeup: number
          if (wantR128) {
            const asked = gainForTargetLufs(env.integratedLufs)
            makeup = makeupGainForTargetLufs(loud, asked)
            stats.r128AskedGain = Math.round(asked * 1000) / 1000
            console.info(
              `compose: audio R128 integrated ${env.integratedLufs ?? 'n/a'} LUFS → target ${DEFAULT_TARGET_LUFS} ` +
                `wants ${asked.toFixed(3)}× → applied ${makeup.toFixed(3)}× (peak/floor bounded)`,
            )
          } else {
            makeup = makeupGainForLoudness(loud)
            console.info(
              `compose: audio loudness p90rms ${loud.loudRms.toFixed(4)} peak ${loud.peak.toFixed(3)} → makeup ${makeup.toFixed(2)}× (integrated ${env.integratedLufs ?? 'n/a'} LUFS)`,
            )
          }
          if (makeup !== 1) for (const m of audioMixers) m.gain = baseGain * makeup
          certified = { makeup, loudRms: loud.loudRms, peak: loud.peak, fromCaptureStats: false }
        } finally {
          for (const m of probe) m.dispose()
        }
      }
      stats.prep.probe = since(tProbe)
    }
    // Layout slot is decided once for the whole export: camera only fills the
    // frame when no screen channel contributes anywhere in the output window.
    const cameraFull = !videoReaders.some((r) => r.kind === 'screen')
    // Zero cost when the track is absent: no per-frame pose work at all.
    const cameraMoves = !cameraFull && cameraTrackIsActive(edit.camera)
    // F2: same zero-cost rule as the camera track — no track, no per-frame work.
    const viewportMoves = viewportTrackIsActive(edit.viewport)
    const tTarget = performance.now()
    const target = await pickEncodingTarget(width, height, targetNeedsAudio, videoBitrate)
    stats.prep.target = since(tTarget)
    throwIfAborted()

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    /**
     * O9(a) WAS MEASURED HERE AND REFUSED, 2026-09-04 — recorded so no session
     * builds it a second time. A supersampled draw (compose the frame at 2x and
     * reduce it in one aligned step) was built, shipped behind `?ss=`, measured
     * with `node scripts/o9-colour.mjs`, and removed: THIS DRAW IS NOT WHERE
     * THE COLOUR GOES. A 1:1 draw of a 3024-wide source into 1080p keeps 99.8 %
     * of the green with no encoder anywhere, and drawing it at 2x moved the
     * finished 4:2:0 file from 78.2 % to 78.2-78.7 % — inside run variance —
     * while raising the glyph fringe 3.21 → 3.59 and the export's wall clock
     * 8 %. The loss is 4:2:0 subsampling at the delivery size, once per encode
     * generation, and the only lever that reaches it is fullColour.ts.
     */
    const frame: FrameCanvas = { ctx, width, height, scale: frameScale(width, height) }

    /**
     * O9(b) — KEEP EVERY COLOUR, resolved FIRST (the order moved in J9).
     *
     * It used to be resolved after constant quality, which was fine while the
     * two could not both be on: `constantQualityCodec` answered only for avc,
     * so a 4:4:4 export never carried a cq string and was the last encode in
     * this product still driven by a bitrate. They CAN both be on now, and the
     * dependency runs this way — the 4:4:4 codec string is what quantizer mode
     * has to be probed against, because probing one string and encoding
     * another is exactly how constant quality first reported itself
     * unsupported on hardware that supports it.
     *
     * Probed on THIS frame size and PINNED; a machine that cannot encode it
     * takes today's rung with nothing else changed, and the decline goes
     * through the door rather than into silence.
     */
    const want444 = wantVideo && fullColourActive()
    const tColour = performance.now()
    const codec444 = want444 ? await fullColourCodec(width, height, videoBitrate) : null
    stats.prep.colour = since(tColour)
    if (want444 && !codec444) {
      noteFullColourDeclined('no AV1 4:4:4 encoder config at this frame size', {
        width,
        height,
        bitrate: videoBitrate,
      })
      console.info(
        `[compose] O9(b) full colour asked for but this machine has no 4:4:4 encoder at ${width}x${height} — ${target.rung} kept`,
      )
    } else if (codec444) {
      console.info(
        `[compose] O9(b) FULL COLOUR: ${codec444} (4:4:4, software) replaces ${target.rung} — every pixel keeps its own colour, and the file is bigger and slower to make`,
      )
    }

    // CONSTANT QUALITY, when this browser honours it (Robert 2026-08-29, "more
    // quality and much less size"). Resolved BEFORE the output so the file's
    // own certification can say which way it was encoded — a size report from
    // the field is unattributable otherwise. The bitrate stays in the config as
    // the fallback's target and as what the size estimate is built from; the
    // custom encoder drops it and drives the QP instead. A browser without
    // quantizer mode never marks the config and encodes exactly as before.
    //
    // J9: the 4:4:4 rung takes the same dial. Its string is already pinned, so
    // there is no ladder to walk — only quantizer mode to ask for, in software,
    // which is the only way that rung encodes at all.
    const wantQp = constantQualityQp()
    const tCq = performance.now()
    const cqCodec =
      wantQp === null
        ? null
        : codec444
          ? (await quantizerModeAccepts(codec444, width, height, 'prefer-software'))
            ? codec444
            : null
          : await constantQualityCodec(target.videoCodec, width, height)
    stats.prep.cq = since(tCq)
    /** The dial is H.264's; AV1 has its own scale and its own measured rung. */
    const qp = cqCodec === null ? null : codec444 ? av1QuantizerFor(wantQp!) : wantQp
    if (qp !== null) registerConstantQualityEncoder()
    else if (wantQp !== null) {
      console.info(
        `[compose] constant quality asked for but unsupported here${
          codec444 ? ' for the 4:4:4 rung' : ''
        } — bitrate target kept`,
      )
    }
    if (codec444 && qp !== null) {
      console.info(
        `[compose] J9 the 4:4:4 rung is on a QUALITY target: ?cq=${wantQp} → AV1 quantizer ${qp}`,
      )
    }

    const effectiveVideoCodec = codec444 ? ('av1' as const) : target.videoCodec
    const effectiveRung = codec444
      ? `${target.rung}→av1-444-sw${qp === null ? '' : `-q${qp}`}`
      : target.rung

    // O(1) memory: mux straight to an OPFS scratch file. BufferTarget stays as
    // the fallback for platforms where the scratch can't be opened.
    // J1: the caller's sink wins — a chunk file, or the audio artifact. Nobody
    // else has one, so the scratch stays exactly what it was for every export.
    const tScratch = performance.now()
    if (!sink) scratch = await createExportScratch()
    stats.prep.scratch = since(tScratch)
    const bufferTarget = sink || scratch ? null : new BufferTarget()
    const out = new Output({
      format: target.format,
      target: sink ? sink.target : scratch ? scratch.target : bufferTarget!,
    })
    output = out
    // Certified-export metadata (O8): how this file was actually made. A J1
    // chunk carries none: it is an internal file whose tags the concatenation
    // discards, and writing them 1,400 times would only cost bytes and time.
    if (!quiet) out.setMetadataTags({
      title: 'INOUT recording',
      comment: certificationComment(
        buildCertification({
          recording,
          path: 'render',
          settings: { width, height, fps, videoBitrate },
          audioChannels: audioMixers.length,
          makeup: certified?.makeup,
          loudRms: certified?.loudRms,
          peak: certified?.peak,
          fromCaptureStats: certified?.fromCaptureStats,
          cuts: Math.max(0, keptSegments(edit).length - 1),
          codec: {
            container: target.mimeType,
            video: effectiveVideoCodec,
            audio: needAudio ? target.audioCodec : undefined,
            gopSec,
            rung: effectiveRung,
            // The DIAL, not the translated AV1 quantizer: chunkedRender writes
            // `flags.cq` for the same file and the two must not disagree. Which
            // quantizer actually ran is in the rung above.
            qp: qp === null ? undefined : (wantQp ?? undefined),
          },
        }),
      ),
    })
    // O11a: every encoded packet is handed back anyway — count it. Costs one
    // addition per packet and turns "where do the bytes go" into a number.
    const bits = new BitsAudit(videoBitrate, gopSec)
    const videoSource = wantVideo ? new CanvasSource(canvas, {
      codec: effectiveVideoCodec,
      bitrate: videoBitrate,
      keyFrameInterval: gopSec,
      ...target.encoderOptions,
      // The probed string is PINNED: probing one profile and encoding another
      // is how the first version of this reported itself unsupported on
      // hardware that supports it.
      ...(qp !== null && cqCodec
        ? { fullCodecString: cqCodec, onEncoderConfig: markConstantQuality(qp) }
        : {}),
      // AFTER the spread of `target.encoderOptions`, which asks for hardware:
      // there is no hardware AV1 4:4:4 encoder anywhere, so the preference has
      // to be overridden or the config is refused on a machine that can do it.
      ...(codec444
        ? { fullCodecString: codec444, hardwareAcceleration: 'prefer-software' as const }
        : {}),
      onEncodedPacket: (p) => bits.video(p.byteLength, p.type),
    }) : null
    if (videoSource) out.addVideoTrack(videoSource, { frameRate: fps })
    /**
     * O10b — ONE TRACK, OR ONE PER CHANNEL.
     *
     * `flat` is every export before this and stays the default: all the mixers
     * sum into one stereo track. `separate` gives each captured channel its own
     * track in the container, so mic and tab audio can be pulled apart by
     * anything that understands more than one audio track, and a player that
     * does not still plays the first one.
     *
     * THE GAINS DO NOT MOVE between the two. Every track keeps the bus gain and
     * the loudness makeup the flat mix would have applied, so summing the
     * separate tracks gives the flat mix back rather than something louder —
     * the file is a different arrangement of the same sound, not a different
     * sound.
     */
    const closeAudio = (): void => {
      audioSource?.close()
      for (const g of groupSources) g.close()
    }
    const separate = needAudio && separateAudioTracks() && audioTrackGroups(audioMixers, recording).length > 1
    const groups = separate ? audioTrackGroups(audioMixers, recording) : []
    let audioSource: AudioSampleSource | null = null
    const groupSources: AudioSampleSource[] = []
    if (needAudio && separate) {
      for (const g of groups) {
        const src = new AudioSampleSource({
          codec: target.audioCodec,
          bitrate: AUDIO_BITRATE,
          onEncodedPacket: (p) => bits.audio(p.byteLength),
        })
        groupSources.push(src)
        // The name is what a player shows in its track menu, so it is the
        // channel's own word ('mic', 'tab audio') and never an id.
        out.addAudioTrack(src, { name: g.label })
      }
      console.info(
        `[compose] audio written as ${groups.length} separate tracks: ${groups.map((g) => g.label).join(', ')}`,
      )
    } else if (needAudio) {
      audioSource = new AudioSampleSource({
        codec: target.audioCodec,
        bitrate: AUDIO_BITRATE,
        onEncodedPacket: (p) => bits.audio(p.byteLength),
      })
      out.addAudioTrack(audioSource)
    }
    const tStart = performance.now()
    await out.start()
    stats.prep.start = since(tStart)
    report('preparing', 0.05)

    // Output-timeline frame index of every cut join, for the seam fade.
    const joinFrames = segmentJoinsMs(edit).map((ms) =>
      Math.round((ms / 1000) * AUDIO_SAMPLE_RATE),
    )
    const totalFrames = Math.max(1, Math.ceil(durationSec * fps - 1e-9))
    /**
     * J1 — THE WINDOW. Frames are SAMPLED at their global output instants (a
     * chunk draws exactly what the unbroken render draws at that moment) and
     * WRITTEN at window-local timestamps (the file stands on its own, so
     * concatenating it is a rebase and never a re-encode). Without a window
     * these are 0 and totalFrames and `windowStartSec` is 0, which is the loop
     * that shipped, arithmetic included.
     */
    const windowStartFrame = Math.max(0, opts.window?.startFrame ?? 0)
    const windowEndFrame = Math.min(totalFrames, opts.window?.endFrame ?? totalFrames)
    const windowStartSec = windowStartFrame / fps
    const windowFrames = Math.max(0, windowEndFrame - windowStartFrame)
    /**
     * LET THE MACHINE BREATHE — Robert, 2026-08-30: "trying to export 1080 my
     * computer froze, i had to restart it manually".
     *
     * A 3024x1964 take at 60 fps for four minutes is FOURTEEN THOUSAND frames,
     * each a 5.9 Mpx decode and a re-encode, and driving that flat out is what
     * took his whole machine down — not the tab, the machine, to a manual
     * restart. Yielding to the macrotask queue is what lets the compositor, the
     * GPU process and everything else on the machine have a turn.
     *
     * IT USED TO BE CONDITIONAL ON THE SIZE OF THE JOB (J1 deleted that): a
     * render "big enough" yielded and a small one did not. Two things are wrong
     * with a threshold there. It is a policy that behaves differently at two
     * minutes and at two hours, which is the ruling; and once the output is cut
     * into five-second chunks, EVERY chunk is small by that measure however long
     * the take is, so the protection would have switched itself off on exactly
     * the renders it exists for. One cadence, every length.
     */
    const breathe = async (n: number): Promise<void> => {
      if (n % PACE_EVERY_FRAMES === 0) await new Promise((r) => setTimeout(r, 0))
    }
    const audioChunks = Math.ceil(totalAudioFrames / AUDIO_SAMPLE_RATE)
    const peaks = createPeakBuffer(waveformMode ? durationSec : 0)
    stats.prepareMs = performance.now() - t0

    /**
     * O10c — THE NOISE GATE, WIRED. Off by default and off in every number this
     * project has published; `?noisegate=on` is what turns it on.
     *
     * TWO THINGS MAKE THIS HARDER THAN "call gate() on the chunk", and both are
     * why an earlier attempt at this wiring was written and backed out:
     *
     * 1. THE GATE HAS LATENCY. It holds `frame - hop` = 768 samples (16 ms at
     *    48 kHz) until their windows close. Writing its output at the CURRENT
     *    chunk's own position therefore shifts the whole soundtrack 16 ms late
     *    against the video, silently, on every gated export — a sync error, and
     *    sync is Robert's. So every sample here is written AT ITS OWN ABSOLUTE
     *    POSITION (`lane.emitted`), which is the alternative the design named:
     *    what is ready goes out with its own timestamps, and the tail comes out
     *    of `flush()` at the end. Nothing is delayed, nothing is discarded, and
     *    no compensation is applied to anything.
     * 2. THE PROFILE NEEDS QUIET FRAMES BEFORE IT CAN GATE, and the render is a
     *    forward stream. So the first `PROFILE_BUDGET_SEC` of mixed audio is
     *    HELD (not written), the profile is built from it, and then that held
     *    audio is fed through the gate in order — so the opening seconds are
     *    gated by the same profile as everything else rather than escaping it.
     *
     * The profile is built from the MONO SUM of the lane: a bed sits in both
     * ears, and one profile per lane keeps a separate-track export from gating
     * the microphone against the system audio's floor.
     */
    interface GateLane {
      hold: { left: Float32Array; right: Float32Array }[]
      held: number
      left: StreamingGate | null
      right: StreamingGate | null
      /** Absolute output frame of the next sample this lane will write. */
      emitted: number
      triggers: number
      bins: number
    }
    const gateOn = wantAudio && noiseGateActive()
    const profileFrames = profileWindowFrames(AUDIO_SAMPLE_RATE)
    const gateLanes: GateLane[] = []
    const gateLane = (i: number): GateLane =>
      (gateLanes[i] ??= { hold: [], held: 0, left: null, right: null, emitted: 0, triggers: 0, bins: 0 })

    /** Build the profile out of what is held, then start the two gates. */
    const armGate = (lane: GateLane): void => {
      // EXACTLY the budget, never "whatever the chunk that crossed the line
      // happened to bring". Held audio arrives a second at a time, so taking
      // all of it would make the profile — and therefore the whole gated
      // export — depend on the chunk size, which is not a parameter of this
      // product and must not become one.
      const total = Math.min(lane.held, profileFrames)
      const mono = new Float32Array(total)
      let at = 0
      for (const piece of lane.hold) {
        for (let k = 0; k < piece.left.length && at + k < total; k++) {
          mono[at + k] = (piece.left[k]! + piece.right[k]!) / 2
        }
        at += piece.left.length
        if (at >= total) break
      }
      const profile = noiseProfile(mono)
      lane.left = new StreamingGate(profile, GATE_DEFAULTS)
      lane.right = new StreamingGate(profile, GATE_DEFAULTS)
    }

    /** Write whatever the gate has finished, each sample in its own place. */
    const emitGated = async (
      lane: GateLane,
      i: number,
      sink: AudioSampleSource,
      wantPeaks: boolean,
      left: Float32Array,
      right: Float32Array,
    ): Promise<void> => {
      if (left.length === 0) return
      if (left.length !== right.length) {
        throw new Error(
          `[compose] noise gate: lane ${i} returned ${left.length} left and ${right.length} right ` +
            'samples — the two ears must stay the same length or the file goes out of sync',
        )
      }
      const startFrame = lane.emitted
      lane.emitted += left.length
      if (waveformMode && wantPeaks) {
        collectPeaks(peaks, left, right, startFrame, AUDIO_SAMPLE_RATE)
      }
      const sample = makeStereoSample(left, right, startFrame / AUDIO_SAMPLE_RATE)
      try {
        await sink.add(sample)
      } finally {
        sample.close()
      }
    }

    /**
     * End of input: gate whatever is still held (a take shorter than the
     * profile window never armed), then hand back the gate's own tail. Without
     * this the last 16 ms of every gated export would be missing.
     */
    const finishGate = async (): Promise<void> => {
      if (!gateOn) return
      const lanes = groupSources.length
        ? groups.map((_g, i) => ({ sink: groupSources[i]!, peaks: i === 0 }))
        : audioSource
          ? [{ sink: audioSource, peaks: true }]
          : []
      for (let i = 0; i < lanes.length; i++) {
        const lane = gateLanes[i]
        if (!lane) continue
        const { sink, peaks: wantPeaks } = lanes[i]!
        if (!lane.left) {
          if (lane.held === 0) continue
          armGate(lane)
        }
        for (const piece of lane.hold) {
          await emitGated(lane, i, sink, wantPeaks, lane.left!.push(piece.left), lane.right!.push(piece.right))
        }
        lane.hold = []
        lane.held = 0
        await emitGated(lane, i, sink, wantPeaks, lane.left!.flush(), lane.right!.flush())
        lane.triggers = lane.left!.triggers + lane.right!.triggers
        lane.bins = lane.left!.bins + lane.right!.bins
      }
      const triggers = gateLanes.reduce((n, l) => n + (l?.triggers ?? 0), 0)
      const bins = gateLanes.reduce((n, l) => n + (l?.bins ?? 0), 0)
      console.info(
        `[compose] noise gate ON: ${triggers} of ${bins} bins pulled down ` +
          `(${bins ? ((100 * triggers) / bins).toFixed(3) : '0'} %), profile from the first ` +
          `${(profileFrames / AUDIO_SAMPLE_RATE).toFixed(1)}s`,
      )
    }

    const writeAudioChunk = async (chunkIndex: number): Promise<void> => {
      if (!audioSource && groupSources.length === 0) return
      const tAudio = performance.now()
      const startFrame = chunkIndex * AUDIO_SAMPLE_RATE
      const frames = Math.min(AUDIO_SAMPLE_RATE, totalAudioFrames - startFrame)
      if (frames <= 0) return
      const chunkOutStartSec = startFrame / AUDIO_SAMPLE_RATE
      // THE SAME PASS, ONE SET OF MIXERS AT A TIME. Flat is one lane holding
      // every mixer, which is exactly the loop that shipped; separate is one
      // lane per channel. Everything after the sum — the join fades, the
      // limiter, the waveform peaks — runs per lane, because a click at a cut
      // is a click on whichever track carries it.
      const lanes = groupSources.length
        ? groups.map((g, i) => ({ mixers: g.mixers, sink: groupSources[i]!, peaks: i === 0 }))
        : [{ mixers: audioMixers, sink: audioSource!, peaks: true }]
      for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
      const lane = lanes[laneIndex]!
      const left = new Float32Array(frames)
      const right = new Float32Array(frames)
      for (const mixer of lane.mixers) await mixer.mixInto(left, right, chunkOutStartSec)
      // Cut joins: fade the SUM through zero so no join can click.
      if (joinFrames.length) {
        const half = Math.max(1, Math.round((JOIN_FADE_MS / 1000) * AUDIO_SAMPLE_RATE))
        for (const joinFrame of joinFrames) {
          const from = Math.max(startFrame, joinFrame - half)
          const to = Math.min(startFrame + frames, joinFrame + half)
          for (let f = from; f < to; f++) {
            const k = f - startFrame
            const g = Math.min(1, Math.abs(f - joinFrame) / half)
            left[k] *= g
            right[k] *= g
          }
        }
      }
      for (let k = 0; k < frames; k++) {
        left[k] = softLimitSample(left[k])
        right[k] = softLimitSample(right[k])
      }
      // The waveform lane draws ONE picture, so it is fed by the first lane
      // only — a separate-track export must not draw two waveforms on top of
      // each other where a flat one drew the sum.
      if (gateOn) {
        // O10c. Held until the profile window is full, then gated and written
        // at each sample's OWN position — see the note above finishGate.
        const g = gateLane(laneIndex)
        if (!g.left) {
          g.hold.push({ left, right })
          g.held += frames
          if (g.held >= profileFrames) {
            armGate(g)
            for (const piece of g.hold) {
              await emitGated(g, laneIndex, lane.sink, lane.peaks, g.left!.push(piece.left), g.right!.push(piece.right))
            }
            g.hold = []
            g.held = 0
          }
        } else {
          await emitGated(g, laneIndex, lane.sink, lane.peaks, g.left.push(left), g.right!.push(right))
        }
        continue
      }
      if (waveformMode && lane.peaks) collectPeaks(peaks, left, right, startFrame, AUDIO_SAMPLE_RATE)
      const sample = makeStereoSample(left, right, chunkOutStartSec)
      try {
        await lane.sink.add(sample)
      } finally {
        sample.close()
      }
      }
      stats.audioMs += performance.now() - tAudio
    }

    const renderFrame = async (frameIndex: number, drawWaveform: ((t: number) => void) | null): Promise<void> => {
      const tSec = frameIndex / fps
      if (drawWaveform) {
        const tDraw = performance.now()
        drawWaveform(tSec)
        stats.drawMs += performance.now() - tDraw
      } else {
        const tDecode = performance.now()
        let screen: VideoSample | null = null
        let camera: VideoSample | null = null
        for (const reader of videoReaders) {
          const localMs = channelSourceTimeAt(recording, edit, reader.channelId, tSec * 1000)
          if (localMs === null) continue
          const sample = await reader.sampleAt(localMs / 1000)
          if (!sample) continue
          if (reader.kind === 'screen') screen = sample
          else camera = sample
        }
        stats.decodeMs += performance.now() - tDecode
        const tDraw = performance.now()
        // F4: the camera track is keyed to RECORDING time, so a cut made later
        // never drags the motion away from the moment it belongs to.
        let pose
        if (cameraMoves && camera && camera.displayWidth > 0 && camera.displayHeight > 0) {
          const recMs = outputToRecordingMs(edit, tSec * 1000)
          if (recMs !== null) {
            pose = cameraPoseAt(edit.camera, recMs, {
              frameAspect: width / height,
              cameraAspect: camera.displayWidth / camera.displayHeight,
            })
          }
        }
        let view
        if (viewportMoves) {
          const recMs = outputToRecordingMs(edit, tSec * 1000)
          if (recMs !== null) view = viewportAt(edit.viewport, recMs)
        }
        drawVideoFrame(frame, screen, camera, cameraFull, pose, edit.background, view)
        stats.drawMs += performance.now() - tDraw
      }
      // Awaited, and that is not the stall O5 assumed it was: mediabunny's
      // encoder wrapper keeps four frames in the VideoEncoder queue and only
      // blocks when that queue is full or the writer pushes back. Measured at
      // 23-45 ms out of a ~1900 ms render — 1.5 %. An extra lookahead window
      // on top of it was built, measured, and removed for buying nothing.
      const tEncode = performance.now()
      await videoSource!.add(tSec - windowStartSec, 1 / fps)
      stats.encodeMs += performance.now() - tEncode
      stats.frames++
      await breathe(stats.frames)
    }

    // A decode that failed mid-render is reported LOUDLY and by name — the
    // export finished, but part of it is a held frame and the user must be
    // told which part and why. Before this the whole render died with
    // "decoding error" and nothing else (Robert, 2026-08-30).
    for (const r of videoReaders) {
      if (!r.failure) continue
      console.error(
        `[compose] EXPORT INCOMPLETE: the ${r.kind} channel stopped decoding at ` +
          `${r.failure.atSec.toFixed(1)}s of its own timeline — everything after that is the last ` +
          `frame held. The source file is damaged from there. Reason: ${r.failure.message}`,
      )
    }

    if (waveformMode) {
      // Audio pass first: the mixed peaks drive every waveform frame.
      if (audioSource || groupSources.length) {
        for (let c = 0; c < audioChunks; c++) {
          throwIfAborted()
          await writeAudioChunk(c)
          report('rendering', 0.05 + 0.45 * ((c + 1) / audioChunks))
          if (pace) await pace.wait()
          if (yieldEveryFrames) await yieldToUi()
        }
        await finishGate()
        closeAudio()
      }
      const base = audioSource || groupSources.length ? 0.5 : 0.05
      const drawWaveform = createWaveformRenderer(frame, peaks)
      for (let f = 0; f < totalFrames; f++) {
        throwIfAborted()
        await renderFrame(f, drawWaveform)
        report('rendering', base + (0.95 - base) * ((f + 1) / totalFrames))
        if (pace && f % BRAKE_EVERY_FRAMES === 0) await pace.wait()
        if (yieldEveryFrames && f % yieldEveryFrames === 0) await yieldToUi()
      }
    } else if (!wantVideo) {
      /**
       * J1 — THE AUDIO ARTIFACT: one continuous encode of the whole output,
       * cached under its own key. It exists because AAC and opus both carry
       * encoder priming, so audio cut into chunks and spliced back together
       * clicks at every boundary. Same mixers, same loudness, same join fade as
       * the interleaved loop below — this is that loop with the video removed,
       * not a second audio path.
       */
      for (let c = 0; c < audioChunks; c++) {
        throwIfAborted()
        await writeAudioChunk(c)
        report('rendering', 0.05 + 0.9 * ((c + 1) / audioChunks))
        if (pace) await pace.wait()
        if (yieldEveryFrames) await yieldToUi()
      }
      await finishGate()
      closeAudio()
    } else if (!wantAudio) {
      /** J1 — ONE CHUNK: the window's frames, and nothing else. */
      for (let f = windowStartFrame; f < windowEndFrame; f++) {
        throwIfAborted()
        await renderFrame(f, null)
        report('rendering', 0.05 + 0.9 * ((f + 1 - windowStartFrame) / Math.max(1, windowFrames)))
        if (pace && (f - windowStartFrame) % BRAKE_EVERY_FRAMES === 0) await pace.wait()
        if (yieldEveryFrames && (f - windowStartFrame) % yieldEveryFrames === 0) await yieldToUi()
      }
    } else {
      // Alternate ~1s of audio with that second's video frames (interleaving).
      let frameIndex = 0
      const chunks = Math.max(1, Math.ceil(durationSec))
      for (let c = 0; c < chunks; c++) {
        throwIfAborted()
        await writeAudioChunk(c)
        const chunkEndSec = Math.min(durationSec, c + 1)
        while (frameIndex < totalFrames && frameIndex / fps < chunkEndSec) {
          throwIfAborted()
          await renderFrame(frameIndex, null)
          frameIndex++
          report('rendering', 0.05 + 0.9 * (frameIndex / totalFrames))
          // A CHUNK IS A WHOLE SECOND, and a brake that can only bite at the
          // end of one is up to a second late. Measured 2026-09-02 in a real
          // editor: the stall a drag beside a background render pays lands
          // 486-643 ms into the drag — inside the chunk the job was already
          // in when the hand arrived. Reading the pace every few frames costs
          // a paced job one clock read per frame and costs a user-visible
          // export nothing at all, because it has no pace to read.
          if (pace && frameIndex % BRAKE_EVERY_FRAMES === 0) await pace.wait()
          if (yieldEveryFrames && frameIndex % yieldEveryFrames === 0) await yieldToUi()
        }
        // …and once per chunk regardless, so a rest can also land where the
        // decoders and the encoder are in their settled state.
        if (pace) await pace.wait()
      }
      // Float-rounding safety: never drop trailing frames.
      for (; frameIndex < totalFrames; frameIndex++) {
        throwIfAborted()
        await renderFrame(frameIndex, null)
      }
      await finishGate()
      closeAudio()
    }
    videoSource?.close()

    // A cancel that lands during the last frames must not spend the flush:
    // finalize() cannot be interrupted once entered.
    throwIfAborted()
    report('finalizing', 0.95)
    const tFinalize = performance.now()
    await out.finalize()
    stats.finalizeMs = performance.now() - tFinalize
    if (!quiet) {
      console.info(formatBits(bits.summarize(durationSec), `render ${width}×${height} ${target.videoCodec}`))
    }
    let blob: Blob
    const tPublish = performance.now()
    if (sink) {
      blob = await sink.publish(target.mimeType)
    } else if (scratch) {
      blob = await scratch.finish(target.mimeType)
    } else {
      const buffer = bufferTarget?.buffer
      if (!buffer) throw new Error('Muxer produced no output')
      blob = new Blob([buffer], { type: target.mimeType })
    }
    stats.publishMs = since(tPublish)
    report('finalizing', 1)
    stats.totalMs = performance.now() - t0
    setLastRenderStats(stats)
    if (!quiet) console.info(formatStats(stats))

    return {
      blob,
      mimeType: target.mimeType,
      fileName: exportFileName(recording.createdAt, target.fileExtension),
      // J1: a windowed call describes ITS window; the whole output otherwise.
      durationMs: Math.round(
        wantVideo && opts.window ? (windowFrames / fps) * 1000 : durationMs,
      ),
      width,
      height,
      scratchKey: scratch?.key,
    }
  } catch (err) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => undefined)
    }
    // Aborted or failed export leaves nothing behind on disk.
    await scratch?.discard().catch(() => undefined)
    await sink?.discard().catch(() => undefined)
    throw err
  } finally {
    if (pace) {
      const rested = pace.restedMs()
      if (rested > 0) {
        console.info(`[compose] background render rested ${(rested / 1000).toFixed(1)}s of its own wall clock (F16b)`)
      }
      pace.dispose()
    }
    // J1: borrowed readers belong to the caller, which walks them on into the
    // next chunk. Disposing them here would re-demux the take per chunk.
    if (!borrowedReaders) for (const reader of videoReaders) reader.dispose()
    for (const mixer of audioMixers) mixer.dispose()
  }
}
