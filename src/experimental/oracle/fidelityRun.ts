/**
 * EXPERIMENTAL — Oracle fidelity runner (task oracle-audio-fidelity;
 * instant lane: BACKLOG P0 2026-08-25).
 *
 * Two takes, three lanes:
 *
 *  1. RENDER, single source (the historical gate, unchanged): stereo multitone
 *     through production measured-audio capture → exportRecording → decode →
 *     fidelity metrics. This is the lane every fidelity number before
 *     2026-08-26 described.
 *
 *  2. INSTANT — the file a user actually gets. The default export of an
 *     unedited take copies the COMPOSITE's packets, and no gate had ever
 *     measured that file's audio quality (the same class of hole as "every
 *     sync number was the render's", fixed for sync on 2026-08-24). So a
 *     second take is recorded WITH a live composite, production-shaped:
 *     screen + TWO audio sources, because the multi-source capture mix is a
 *     different chain (shared 0.7 gain + 12:1 compressor) from the
 *     single-source pass-through, and it is the chain Robert's real takes use.
 *     The take exports through exportByBestPath — the product's own ladder —
 *     and the report says which path actually ran, so the lane cannot pass by
 *     quietly measuring the render.
 *
 *  3. RENDER on the SAME composite take: the A/B that isolates what each
 *     path does to one take. The render mixes raw channels at 1/N (−6.0 dB
 *     for two sources, by design — see compose/audio.ts mixGainForChannels);
 *     the live mix uses a 0.7 bus (−3.1 dB). Two files a user can get from
 *     one take, measured side by side.
 *
 * Tone expectations are the SOURCE amplitudes in all three lanes — the
 * instrument reports what each path does to the signal the user's sources
 * produced, not what it does relative to its own bus gain.
 */

import { exportByBestPath, exportRecording, type ExportPath } from '@core/compose'
import { blobStore, createDurablePositionedWriter } from '@core/store'
import { canMeasureAudioCapture, startMeasuredAudioCapture } from '@core/capture/measuredAudio'
import {
  canLiveComposite,
  startLiveComposite,
  type LiveCompositeHandle,
  type LiveCompositeInputs,
} from '@core/capture/liveComposite'
import { canLiveCompositeV2, startLiveCompositeV2 } from '@core/capture/liveCompositeV2'
import { preferredCompositeEngine } from '@core/capture/engine'
import { rebasedCompositeOffsetMs } from '@core/compose/compositeTime'
import { defaultEditState } from '@core/timeline'
import { DEFAULT_EXPORT_SETTINGS } from '@core/types'
import type { ChannelRecording, CompositeRecording, Recording } from '@core/types'
import { analyzeAudioFidelity, FIDELITY_TONES, type AudioFidelityReport } from './audioFidelity'
import { sweepStaleOracleBlobs } from './rig'
import { paintLoop } from '../rigPaint'

export interface FidelityLaneReport {
  /** Which export path actually produced the analyzed file — the anti-vacuity
   *  fact. A lane that silently fell back to the render measured the thing the
   *  historical gate already measures, and proved nothing. */
  path: ExportPath
  declined: { path: ExportPath; reason: string }[]
  exportMs: number
  fidelity: AudioFidelityReport
}

export interface FidelityCompositeReport {
  /** Which live-composite engine wrote the file under test. */
  engine: string | null
  hasComposite: boolean
  instant: FidelityLaneReport | null
  render: FidelityLaneReport | null
  /**
   * THE COMPOSITE'S OWN AUDIO TRACK — the live capture mix (shared 0.7 bus +
   * 12:1 compressor), measured directly off the recorded file. Diagnostic, and
   * the one the backlog entry expected the INSTANT lane to read: it does not,
   * because exportInstant copies the composite's VIDEO packets and mixes audio
   * from the raw channels instead (instant.ts's opening comment says why —
   * "without the composite's uncertified MediaRecorder audio"). Keeping the
   * number visible is what makes that a measured fact rather than a claim, and
   * it is the lane to watch when Robert reports noises under load.
   *
   * MEASURED 2026-08-26, and it is not the 0.7 bus on its own: all four tones
   * read −2.00 dB, i.e. 1.10 dB ABOVE −3.10. Dead flat across four tones with
   * zero limiter hits, so the compressor is not compressing this fixture (its
   * −3 dB threshold sits above the mix's −5.6 dBFS peak) — what the stage
   * contributes here is a STATIC gain, not dynamics. Nothing downstream of
   * capture depends on it, because no export path carries this audio.
   */
  compositeAudio: AudioFidelityReport | null
  /**
   * ONE RAW AUDIO CHANNEL as capture wrote it, before any mix. Isolates the
   * capture path from the mix bus, so a level deviation in the lanes above can
   * be attributed to one or the other instead of guessed at.
   */
  rawChannel: { channelId: string; fidelity: AudioFidelityReport } | null
  /** Where each channel's capture began on the take's timeline — the term that
   *  decides whether the measured window sees every source (see skipSec). */
  channelStartOffsetsMs: { id: string; startOffsetMs: number; durationMs: number }[]
  /** Start of the measured window used for every lane of this take, seconds. */
  windowSkipSec: number
  /** Why a lane is missing, when it is. */
  error: string | null
}

export interface FidelityOracleReport {
  recordMs: number
  sweptStaleKeys: string[]
  exportMs: number
  fidelity: AudioFidelityReport
  /** The historical gate: the single-source RENDER lane only. The composite
   *  lanes are gated by scripts/oracle-fidelity.mjs on their own bands. */
  pass: boolean
  /** Start of this lane's measured window, seconds — past the capture start
   *  rather than a fixed 0.25 (see windowSkipSecFor). */
  windowSkipSec: number
  /** Null only when the caller disabled it ({composite:false} — the red
   *  proof for the lane gates). */
  compositeTake: FidelityCompositeReport | null
}

export interface FidelityRunOptions {
  /** Record the composite take and run the instant/render lanes (default on). */
  composite?: boolean
}

function makeStereoFidelityStream(
  audioCtx: AudioContext,
  tones: typeof FIDELITY_TONES = FIDELITY_TONES,
): {
  stream: MediaStream
  stop: () => void
} {
  const merger = audioCtx.createChannelMerger(2)
  const dest = audioCtx.createMediaStreamDestination()
  const teardowns: (() => void)[] = []

  for (const tone of tones) {
    const osc = new OscillatorNode(audioCtx, { frequency: tone.freqHz, type: 'sine' })
    const gain = new GainNode(audioCtx, { gain: tone.amp })
    osc.connect(gain)
    gain.connect(merger, 0, tone.channel === 'L' ? 0 : 1)
    osc.start()
    teardowns.push(() => {
      try {
        osc.stop()
      } catch {
        /* already */
      }
    })
  }
  merger.connect(dest)

  return {
    stream: dest.stream,
    stop: () => {
      for (const t of teardowns) t()
      try {
        merger.disconnect()
      } catch {
        /* */
      }
    },
  }
}

async function recordFidelityAudio(durationMs: number): Promise<{
  recording: Recording
  cleanup: () => Promise<void>
}> {
  if (!canMeasureAudioCapture()) {
    throw new Error('fidelity oracle requires measured audio capture (WebCodecs + worklet)')
  }
  const runId = `exp-oracle-fidelity-${Date.now()}`
  const blobKey = `${runId}_system-audio.webm`
  // Generator context is separate from capture — measuredAudio prewarms its own
  // worklet-bearing AudioContext from the track (passing ours skips addModule).
  const genCtx = new AudioContext()
  await genCtx.resume()
  await waitForAudioClock(genCtx)
  const src = makeStereoFidelityStream(genCtx)
  const epoch = performance.now()
  const writer = await createDurablePositionedWriter(blobKey)
  const handle = await startMeasuredAudioCapture({
    stream: src.stream,
    epoch,
    writer,
  })

  await new Promise((r) => setTimeout(r, durationMs))
  const result = await handle.stop()
  src.stop()
  await genCtx.close().catch(() => undefined)

  const channel: ChannelRecording = {
    id: `${runId}_sys`,
    kind: 'system-audio',
    media: 'audio',
    mimeType: handle.mimeType,
    blobKey,
    startOffsetMs: Math.round(result.startOffsetMs),
    durationMs: Math.round(result.durationMs),
  }
  const recording: Recording = {
    id: runId,
    createdAt: Date.now(),
    durationMs: channel.startOffsetMs + channel.durationMs,
    channels: [channel],
  }

  return {
    recording,
    cleanup: async () => {
      await blobStore.remove(blobKey).catch(() => undefined)
    },
  }
}

/**
 * Hold until the generator's audio clock is genuinely rendering.
 *
 * A freshly resumed AudioContext does not start immediately — rig.ts prices
 * the stall at 115-500 ms and this rig has seen 2.15 s. Every millisecond of
 * it is silence at the front of the recording, and a level metric whose window
 * lands in that silence reads a flat attenuation on every tone at once. The
 * analyzer defends itself (findProgrammeOnsetSec) but defending is second
 * best: production warms its encoder before the take for the same reason, so
 * the fixture warms its generator and the take simply starts with the tone
 * already up.
 */
async function waitForAudioClock(ctx: AudioContext, deadlineMs = 3000): Promise<number> {
  const t0 = ctx.currentTime
  const started = performance.now()
  // Advanced by a rendering quantum's worth of real time, not merely nonzero:
  // currentTime can read ahead while the graph is still stalled.
  while (ctx.currentTime - t0 < 0.15 && performance.now() - started < deadlineMs) {
    await new Promise((r) => setTimeout(r, 20))
  }
  return performance.now() - started
}

/** Moving content keeps the encoder honest (same reason as the sync rig). */
function makeMotionCanvas(): { stream: MediaStream; stop: () => void } {
  const W = 1280
  const H = 720
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext('2d')
  if (!g) throw new Error('2d context unavailable')
  const t0 = performance.now()
  const draw = (): void => {
    const t = performance.now() - t0
    g.fillStyle = `hsl(${(t / 40) % 360}, 40%, 20%)`
    g.fillRect(0, 0, W, H)
    g.fillStyle = `hsl(${(t / 4) % 360}, 80%, 60%)`
    g.fillRect(((t / 4) % (W + 160)) - 160, 560, 160, 40)
  }
  // G2: rAF stays primary; the watchdog paints only when it goes quiet.
  const loop = paintLoop(draw, 30)
  return { stream: canvas.captureStream(30), stop: loop.stop }
}

const VIDEO_MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

/**
 * The composite-bearing take (instant lane). Production-shaped: a screen
 * channel plus TWO audio sources — the L-owned tones as `mic`, the R-owned
 * tones as `system-audio` — so the live mix takes its multi-source chain
 * (shared 0.7 bus + 12:1 compressor), which a single stream bypasses
 * entirely (liveCompositeV2.ts connects one source straight to the tap).
 * Stereo placement survives the sum, so the four tones keep their nominal
 * amplitudes and channels at the mix input, and every deviation the analyzer
 * reads is the capture chain's doing.
 */
async function recordFidelityCompositeTake(durationMs: number): Promise<{
  recording: Recording
  cleanup: () => Promise<void>
}> {
  if (!canMeasureAudioCapture()) {
    throw new Error('fidelity oracle requires measured audio capture (WebCodecs + worklet)')
  }
  const runId = `exp-oracle-fidcomp-${Date.now()}`
  const blobKeys: string[] = []
  const removeBlobs = async (): Promise<void> => {
    await Promise.all(blobKeys.map((k) => blobStore.remove(k).catch(() => undefined)))
  }

  // Warm the encoder before the take, because production does (GATE-alias,
  // note 6): a fresh process's first VideoEncoder pays a multi-second init and
  // an unwarmed composite drops the opening seconds of a 6 s take.
  if (preferredCompositeEngine() === 'v2') {
    const { warmVideoEncoder } = await import('@core/capture/encoderWarm')
    await warmVideoEncoder().catch(() => undefined)
  }

  const genCtx = new AudioContext()
  const video = makeMotionCanvas()
  let compositeHandle: LiveCompositeHandle | null = null
  try {
    await genCtx.resume()
    await waitForAudioClock(genCtx)
    const srcMic = makeStereoFidelityStream(
      genCtx,
      FIDELITY_TONES.filter((t) => t.channel === 'L'),
    )
    const srcSys = makeStereoFidelityStream(
      genCtx,
      FIDELITY_TONES.filter((t) => t.channel === 'R'),
    )

    const epoch = performance.now()
    let releaseStop!: () => void
    const stopSignal = new Promise<void>((r) => {
      releaseStop = r
    })
    const stopTimer = setTimeout(releaseStop, durationMs)

    // -- raw audio channels through the production measured path -------------
    const audioJobs = (
      [
        ['mic', srcMic.stream],
        ['system-audio', srcSys.stream],
      ] as const
    ).map(async ([kind, stream]) => {
      const blobKey = `${runId}_${kind}.webm`
      blobKeys.push(blobKey)
      const writer = await createDurablePositionedWriter(blobKey)
      const handle = await startMeasuredAudioCapture({ stream, epoch, writer })
      await stopSignal
      const result = await handle.stop()
      return { kind, blobKey, mimeType: handle.mimeType, ...result }
    })

    // -- raw screen channel (MediaRecorder, as the sync rig records video) ---
    const videoKey = `${runId}_screen.webm`
    blobKeys.push(videoKey)
    const videoJob = (async () => {
      const mimeType =
        VIDEO_MIMES.find((c) => MediaRecorder.isTypeSupported(c)) ??
        VIDEO_MIMES[VIDEO_MIMES.length - 1]!
      const recorder = new MediaRecorder(video.stream, {
        mimeType,
        videoBitsPerSecond: 8_000_000,
      })
      const writable = await blobStore.createWriteStream(videoKey)
      const writer = writable.getWriter()
      let writeChain: Promise<void> = Promise.resolve()
      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) {
          writeChain = writeChain.then(() => writer.write(ev.data)).catch(() => undefined)
        }
      }
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
      })
      const startCallAbsMs = performance.now()
      recorder.start(1000)
      await stopSignal
      try {
        recorder.requestData()
      } catch {
        /* inactive */
      }
      recorder.stop()
      await stopped
      const stopFinishAbsMs = performance.now()
      await writeChain
      await writer.close()
      return {
        kind: 'screen' as const,
        blobKey: videoKey,
        mimeType: recorder.mimeType || mimeType,
        // Video file epoch ≈ start() call (measured — see rig.ts).
        startOffsetMs: startCallAbsMs - epoch,
        durationMs: stopFinishAbsMs - startCallAbsMs,
      }
    })()

    // -- the live composite, off the SAME streams, same ladder as production --
    const compositeKey = `${runId}_composite.webm`
    const inputs: LiveCompositeInputs = {
      screen: video.stream,
      audio: [srcMic.stream, srcSys.stream],
    }
    blobKeys.push(compositeKey)
    try {
      if (preferredCompositeEngine() === 'v2' && canLiveCompositeV2(inputs)) {
        compositeHandle = await startLiveCompositeV2(inputs, compositeKey, { epochMs: epoch })
      } else if (canLiveComposite(inputs)) {
        compositeHandle = await startLiveComposite(inputs, compositeKey, { epochMs: epoch })
      }
    } catch (err) {
      // A composite that will not start is a real answer, not a rig crash: the
      // recording has none and the lane gate reports the instant path declined.
      console.warn('[fidelity] live composite unavailable', err)
      compositeHandle = null
    }

    let composite: CompositeRecording | null = null
    let audioResults: Awaited<(typeof audioJobs)[number]>[]
    let videoResult: Awaited<typeof videoJob>
    try {
      // All three recorders are already running; awaiting in sequence only
      // orders the collection, not the work.
      videoResult = await videoJob
      audioResults = await Promise.all(audioJobs)
      // Stop the composite BEFORE the sources go away: its drain needs the
      // encoder alive (P0-tail's lesson).
      if (compositeHandle) {
        composite = await compositeHandle.stop().catch((err) => {
          console.warn('[fidelity] composite stop failed', err)
          return null
        })
        compositeHandle = null
      }
    } finally {
      clearTimeout(stopTimer)
      releaseStop()
      if (compositeHandle) {
        await compositeHandle.cancel().catch(() => undefined)
        compositeHandle = null
      }
      video.stop()
      srcMic.stop()
      srcSys.stop()
      for (const t of video.stream.getTracks()) t.stop()
    }

    // Same min-normalization the production session applies at stop().
    const raw = [videoResult, ...audioResults]
    const minOffset = raw.reduce((m, c) => Math.min(m, c.startOffsetMs), Infinity)
    const channels: ChannelRecording[] = raw.map((c) => ({
      id: `${runId}_${c.kind}`,
      kind: c.kind,
      media: c.kind === 'screen' ? 'video' : 'audio',
      mimeType: c.mimeType,
      blobKey: c.blobKey,
      startOffsetMs: Math.max(0, Math.round(c.startOffsetMs - minOffset)),
      durationMs: Math.round(c.durationMs),
      ...(c.kind === 'screen' ? { width: 1280, height: 720 } : {}),
    }))
    const recording: Recording = {
      id: runId,
      createdAt: Date.now(),
      durationMs: channels.reduce((m, c) => Math.max(m, c.startOffsetMs + c.durationMs), 0),
      channels,
    }
    if (composite) {
      // Signed since B9, same as production's stop path and the sync rig's.
      if (composite.startOffsetMs !== undefined && Number.isFinite(minOffset)) {
        composite.startOffsetMs = Math.round(
          rebasedCompositeOffsetMs(composite.startOffsetMs, minOffset),
        )
      }
      recording.composite = composite
    }
    return { recording, cleanup: removeBlobs }
  } catch (err) {
    // hygiene: no stranded production-storage keys on any failure path.
    if (compositeHandle) await compositeHandle.cancel().catch(() => undefined)
    video.stop()
    await removeBlobs()
    throw err
  } finally {
    if (genCtx.state !== 'closed') await genCtx.close().catch(() => undefined)
  }
}

/**
 * Where the measured window starts for a MULTI-SOURCE take: past the last
 * channel's capture start, plus the encoder-delay margin the single-source
 * default already carries. A window that begins before a source does reads
 * every tone low by the fraction it is missing — a level defect the product
 * never committed (note 10: check the instrument first).
 */
function windowSkipSecFor(recording: Recording): number {
  const lastStartMs = recording.channels
    .filter((c) => c.media === 'audio')
    .reduce((m, c) => Math.max(m, c.startOffsetMs), 0)
  return Math.round((lastStartMs / 1000 + 0.25) * 1000) / 1000
}

async function runCompositeLanes(recordMs: number): Promise<FidelityCompositeReport> {
  const { recording, cleanup } = await recordFidelityCompositeTake(recordMs)
  try {
    const skipSec = windowSkipSecFor(recording)
    const analyzeOpts = { skipSec }
    const report: FidelityCompositeReport = {
      engine: recording.composite?.engine ?? null,
      hasComposite: !!recording.composite,
      instant: null,
      render: null,
      compositeAudio: null,
      rawChannel: null,
      channelStartOffsetsMs: recording.channels.map((c) => ({
        id: c.id,
        startOffsetMs: c.startOffsetMs,
        durationMs: c.durationMs,
      })),
      windowSkipSec: skipSec,
      error: null,
    }
    const edit = defaultEditState(recording)

    // The live mix as capture wrote it, and one raw channel before any mix.
    // Both read files already on disk — no extra recording, no extra export.
    if (recording.composite) {
      try {
        const blob = await blobStore.read(recording.composite.blobKey)
        report.compositeAudio = await analyzeAudioFidelity(blob, analyzeOpts)
      } catch (err) {
        console.warn('[fidelity] composite-audio lane failed', err)
      }
    }
    // The MIC channel specifically: it carries the L-owned tones, including the
    // 440 Hz fundamental the THD estimate is built on. It is measured against
    // ITS OWN tones — the R-owned pair lives on the other channel, and asking
    // this file for them would read digital silence as a −320 dB level defect.
    const rawAudio = recording.channels.find((c) => c.kind === 'mic')
    if (rawAudio) {
      try {
        const blob = await blobStore.read(rawAudio.blobKey)
        report.rawChannel = {
          channelId: rawAudio.id,
          fidelity: await analyzeAudioFidelity(blob, {
            ...analyzeOpts,
            tones: FIDELITY_TONES.filter((t) => t.channel === 'L'),
          }),
        }
      } catch (err) {
        console.warn('[fidelity] raw-channel lane failed', err)
      }
    }

    // INSTANT — the product's own ladder, packet copy allowed. Which path ran
    // is reported, not assumed.
    try {
      const t0 = performance.now()
      const choice = await exportByBestPath({
        recording,
        edit,
        allowPacketCopy: true,
        settings: DEFAULT_EXPORT_SETTINGS,
      })
      const exportMs = performance.now() - t0
      report.instant = {
        path: choice.path,
        declined: choice.declined,
        exportMs,
        fidelity: await analyzeAudioFidelity(choice.result.blob, analyzeOpts),
      }
    } catch (err) {
      report.error = `instant lane: ${err instanceof Error ? err.message : String(err)}`
    }

    // RENDER on the same take — the A/B against the file above.
    try {
      const t1 = performance.now()
      const rendered = await exportRecording({ recording, edit })
      const exportMs = performance.now() - t1
      report.render = {
        path: 'render',
        declined: [],
        exportMs,
        fidelity: await analyzeAudioFidelity(rendered.blob, analyzeOpts),
      }
    } catch (err) {
      report.error = [report.error, `render lane: ${err instanceof Error ? err.message : String(err)}`]
        .filter(Boolean)
        .join('; ')
    }
    return report
  } finally {
    await cleanup()
  }
}

export async function runOracleFidelity(
  recordMs = 6000,
  opts?: FidelityRunOptions,
): Promise<FidelityOracleReport> {
  const sweptStaleKeys = await sweepStaleOracleBlobs()
  const { recording, cleanup } = await recordFidelityAudio(recordMs)
  let base: Omit<FidelityOracleReport, 'compositeTake'>
  try {
    const edit = defaultEditState(recording)
    const t0 = performance.now()
    const exported = await exportRecording({ recording, edit })
    const exportMs = performance.now() - t0
    // Past this take's own capture start, not a fixed 0.25 s. A cold
    // AudioContext stalls 115-500 ms (rig.ts documents the range), and when it
    // stalls far enough the fixed window opens on the silence BEFORE the tone:
    // observed 2026-08-26 as a 30.2 dB "tone error" and 26.7 dB "separation"
    // on a build whose next run read 0.02 dB. The gate was failing green code.
    const skipSec = windowSkipSecFor(recording)
    const fidelity = await analyzeAudioFidelity(exported.blob, { skipSec })
    base = {
      recordMs,
      sweptStaleKeys,
      exportMs,
      fidelity,
      pass: fidelity.pass,
      windowSkipSec: skipSec,
    }
  } finally {
    await cleanup()
  }

  if (opts?.composite === false) return { ...base, compositeTake: null }
  // A take that cannot be recorded is a gate FAILURE with a reason, not a
  // stack trace that reaches the runner as "cdp-run exited 1". The lane gate
  // reads `error` and says which half of the report is missing and why.
  let compositeTake: FidelityCompositeReport
  try {
    compositeTake = await runCompositeLanes(recordMs)
  } catch (err) {
    compositeTake = {
      engine: null,
      hasComposite: false,
      instant: null,
      render: null,
      compositeAudio: null,
      rawChannel: null,
      channelStartOffsetsMs: [],
      windowSkipSec: 0,
      error: `composite take: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  return { ...base, compositeTake }
}
