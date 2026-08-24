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
  type VideoSample,
} from 'mediabunny'
import { blobStore } from '@core/store'
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
  loudnessFromCaptureStats,
  makeStereoSample,
  makeupGainForLoudness,
  measureMixLoudness,
  busGainFor,
  openAudioMixers,
  type MixSource,
  softLimitSample,
} from './audio'
import {
  AUDIO_BITRATE,
  AUDIO_SAMPLE_RATE,
  KEYFRAME_INTERVAL_SEC,
  VIDEO_BITRATE,
  pickEncodingTarget,
} from './codecs'
import { BitsAudit, formatBits } from './bits'
import { drawVideoFrame, type FrameCanvas } from './layout'
import { cameraPoseAt, cameraTrackIsActive, viewportAt, viewportTrackIsActive } from '@core/timeline'
import { buildCertification, certificationComment } from './certify'
import { createExportScratch, type ExportScratch } from './scratch'
import { collectPeaks, createPeakBuffer, createWaveformRenderer } from './waveform'
import { openVideoChannel, type VideoChannelReader } from './video'

/**
 * Half-width of the fade applied at every cut join (F1). The two sides of a
 * join are unrelated audio, so butting them together is a step discontinuity —
 * a click. Ramping to zero and back over a few ms costs nothing audible and
 * makes a join click-free regardless of what the two sides contain.
 */
const JOIN_FADE_MS = 3

export interface RenderOptions extends ExportOptions {
  /**
   * Yield to the event loop every N frames. 0 (the worker) never yields —
   * nothing shares the thread. The main-thread fallback passes 8, which is what
   * this render did everywhere before O5.
   */
  yieldEveryFrames?: number
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
  totalMs: number
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
    `finalize ${Math.round(s.finalizeMs)}ms (${pct(s.finalizeMs)})`
  )
}

const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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
function activeOutputWindowsMs(edit: EditState, channel: ChannelRecording): ActiveWindow[] {
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

function exportFileName(createdAt: number, fileExtension: string): string {
  const d = new Date(createdAt)
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `inout-${date}-${time}${fileExtension}`
}

export async function renderExport(opts: RenderOptions): Promise<ExportResult> {
  const { recording, edit, settings = DEFAULT_EXPORT_SETTINGS, onProgress, signal } = opts
  const yieldEveryFrames = opts.yieldEveryFrames ?? 0
  const { width, height, fps } = settings
  const videoBitrate = settings.videoBitrate ?? VIDEO_BITRATE
  const gopSec = settings.keyFrameIntervalSec ?? KEYFRAME_INTERVAL_SEC

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
    totalMs: 0,
  }
  const t0 = performance.now()
  setLastRenderStats(null)

  report('preparing', 0)
  throwIfAborted()

  const durationMs = outputDurationMs(edit)
  if (durationMs <= 0) throw new Error('Export window is empty')
  const durationSec = durationMs / 1000

  const waveformMode = !hasEnabledVideo(recording, edit)
  const videoReaders: VideoChannelReader[] = []
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
    for (const channel of recording.channels) {
      if (channel.media !== 'video' || waveformMode) continue
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

    audioMixers.push(...(await openAudioMixers(recording, edit, throwIfAborted)))
    const needAudio = audioMixers.length > 0
    const totalAudioFrames = Math.round(durationSec * AUDIO_SAMPLE_RATE)
    // Headroom for the render sum: a single source stays full-scale (gain 1,
    // never limited); multiple sources (mic + system audio) mix equal-power so
    // their sum does not clip into softLimitSample. Unity summing here was the
    // pervasive-noise cause after the composite export path was removed.
    const baseGain = busGainFor(audioMixers)
    for (const m of audioMixers) m.gain = baseGain

    // Loudness normalize: quiet captures (real case: PO's take had voice at
    // −25 dB window-RMS under a 0.77 transient peak) export near-inaudible.
    // Measure SPEECH loudness (p90 window RMS) on a throwaway mixer set — the
    // render streams forward and can't rewind — and drive it to target. Peak
    // targeting was defeated by a single mic bump; percentile loudness isn't.
    // No-op for a healthy mix, so the fidelity oracle is untouched.
    if (needAudio) {
      // O2: an UNEDITED window is exactly the mix capture measured, so the
      // probe pass can be skipped here too. Any trim changes the mix — those
      // render paths still probe.
      const stored = isDefaultEdit(recording, edit)
        ? loudnessFromCaptureStats(
            recording.loudness,
            audioMixers.map((m) => m.channelId),
            baseGain,
          )
        : null
      if (stored) {
        const makeup = makeupGainForLoudness(stored)
        if (makeup !== 1) for (const m of audioMixers) m.gain = baseGain * makeup
        certified = { makeup, loudRms: stored.loudRms, peak: stored.peak, fromCaptureStats: true }
        console.info(
          `compose: audio loudness from capture stats p90rms ${stored.loudRms.toFixed(4)} peak ${stored.peak.toFixed(3)} → makeup ${makeup.toFixed(2)}× (no probe decode)`,
        )
      } else {
        const probe = await openAudioMixers(recording, edit, throwIfAborted)
        try {
          const loud = await measureMixLoudness(probe, baseGain, totalAudioFrames, throwIfAborted, (r) =>
            report('preparing', 0.04 * r),
          )
          const makeup = makeupGainForLoudness(loud)
          if (makeup !== 1) for (const m of audioMixers) m.gain = baseGain * makeup
          certified = { makeup, loudRms: loud.loudRms, peak: loud.peak, fromCaptureStats: false }
          console.info(
            `compose: audio loudness p90rms ${loud.loudRms.toFixed(4)} peak ${loud.peak.toFixed(3)} → makeup ${makeup.toFixed(2)}×`,
          )
        } finally {
          for (const m of probe) m.dispose()
        }
      }
    }
    // Layout slot is decided once for the whole export: camera only fills the
    // frame when no screen channel contributes anywhere in the output window.
    const cameraFull = !videoReaders.some((r) => r.kind === 'screen')
    // Zero cost when the track is absent: no per-frame pose work at all.
    const cameraMoves = !cameraFull && cameraTrackIsActive(edit.camera)
    // F2: same zero-cost rule as the camera track — no track, no per-frame work.
    const viewportMoves = viewportTrackIsActive(edit.viewport)
    const target = await pickEncodingTarget(width, height, needAudio, videoBitrate)
    throwIfAborted()

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    const frame: FrameCanvas = { ctx, width, height, scale: width / 1920 }

    // O(1) memory: mux straight to an OPFS scratch file. BufferTarget stays as
    // the fallback for platforms where the scratch can't be opened.
    scratch = await createExportScratch()
    const bufferTarget = scratch ? null : new BufferTarget()
    const out = new Output({
      format: target.format,
      target: scratch ? scratch.target : bufferTarget!,
    })
    output = out
    // Certified-export metadata (O8): how this file was actually made.
    out.setMetadataTags({
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
            video: target.videoCodec,
            audio: needAudio ? target.audioCodec : undefined,
            gopSec,
            rung: target.rung,
          },
        }),
      ),
    })
    // O11a: every encoded packet is handed back anyway — count it. Costs one
    // addition per packet and turns "where do the bytes go" into a number.
    const bits = new BitsAudit(videoBitrate, gopSec)
    const videoSource = new CanvasSource(canvas, {
      codec: target.videoCodec,
      bitrate: videoBitrate,
      keyFrameInterval: gopSec,
      ...target.encoderOptions,
      onEncodedPacket: (p) => bits.video(p.byteLength, p.type),
    })
    out.addVideoTrack(videoSource, { frameRate: fps })
    let audioSource: AudioSampleSource | null = null
    if (needAudio) {
      audioSource = new AudioSampleSource({
        codec: target.audioCodec,
        bitrate: AUDIO_BITRATE,
        onEncodedPacket: (p) => bits.audio(p.byteLength),
      })
      out.addAudioTrack(audioSource)
    }
    await out.start()
    report('preparing', 0.05)

    // Output-timeline frame index of every cut join, for the seam fade.
    const joinFrames = segmentJoinsMs(edit).map((ms) =>
      Math.round((ms / 1000) * AUDIO_SAMPLE_RATE),
    )
    const totalFrames = Math.max(1, Math.ceil(durationSec * fps - 1e-9))
    const audioChunks = Math.ceil(totalAudioFrames / AUDIO_SAMPLE_RATE)
    const peaks = createPeakBuffer(waveformMode ? durationSec : 0)
    stats.prepareMs = performance.now() - t0

    const writeAudioChunk = async (chunkIndex: number): Promise<void> => {
      if (!audioSource) return
      const tAudio = performance.now()
      const startFrame = chunkIndex * AUDIO_SAMPLE_RATE
      const frames = Math.min(AUDIO_SAMPLE_RATE, totalAudioFrames - startFrame)
      if (frames <= 0) return
      const left = new Float32Array(frames)
      const right = new Float32Array(frames)
      const chunkOutStartSec = startFrame / AUDIO_SAMPLE_RATE
      for (const mixer of audioMixers) await mixer.mixInto(left, right, chunkOutStartSec)
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
      if (waveformMode) collectPeaks(peaks, left, right, startFrame, AUDIO_SAMPLE_RATE)
      const sample = makeStereoSample(left, right, chunkOutStartSec)
      try {
        await audioSource.add(sample)
      } finally {
        sample.close()
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
      await videoSource.add(tSec, 1 / fps)
      stats.encodeMs += performance.now() - tEncode
      stats.frames++
    }

    if (waveformMode) {
      // Audio pass first: the mixed peaks drive every waveform frame.
      if (audioSource) {
        for (let c = 0; c < audioChunks; c++) {
          throwIfAborted()
          await writeAudioChunk(c)
          report('rendering', 0.05 + 0.45 * ((c + 1) / audioChunks))
          if (yieldEveryFrames) await yieldToUi()
        }
        audioSource.close()
      }
      const base = audioSource ? 0.5 : 0.05
      const drawWaveform = createWaveformRenderer(frame, peaks)
      for (let f = 0; f < totalFrames; f++) {
        throwIfAborted()
        await renderFrame(f, drawWaveform)
        report('rendering', base + (0.95 - base) * ((f + 1) / totalFrames))
        if (yieldEveryFrames && f % yieldEveryFrames === 0) await yieldToUi()
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
          if (yieldEveryFrames && frameIndex % yieldEveryFrames === 0) await yieldToUi()
        }
      }
      // Float-rounding safety: never drop trailing frames.
      for (; frameIndex < totalFrames; frameIndex++) {
        throwIfAborted()
        await renderFrame(frameIndex, null)
      }
      audioSource?.close()
    }
    videoSource.close()

    report('finalizing', 0.95)
    const tFinalize = performance.now()
    await out.finalize()
    stats.finalizeMs = performance.now() - tFinalize
    console.info(formatBits(bits.summarize(durationSec), `render ${width}×${height} ${target.videoCodec}`))
    let blob: Blob
    if (scratch) {
      blob = await scratch.finish(target.mimeType)
    } else {
      const buffer = bufferTarget?.buffer
      if (!buffer) throw new Error('Muxer produced no output')
      blob = new Blob([buffer], { type: target.mimeType })
    }
    report('finalizing', 1)
    stats.totalMs = performance.now() - t0
    setLastRenderStats(stats)
    console.info(formatStats(stats))

    return {
      blob,
      mimeType: target.mimeType,
      fileName: exportFileName(recording.createdAt, target.fileExtension),
      durationMs: Math.round(durationMs),
      width,
      height,
    }
  } catch (err) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => undefined)
    }
    // Aborted or failed export leaves nothing behind on disk.
    await scratch?.discard().catch(() => undefined)
    throw err
  } finally {
    for (const reader of videoReaders) reader.dispose()
    for (const mixer of audioMixers) mixer.dispose()
  }
}
