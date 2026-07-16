/**
 * EXPERIMENTAL — Oracle rig (Experiment 2, browser side).
 *
 * Produces a Recording whose content is machine-readable:
 *  - video channels (screen and/or camera): canvas animation + barcode strip
 *    encoding the rig clock (ms since rig epoch) at every painted frame;
 *  - mic channel: 50 ms tone bursts scheduled at exact rig-clock multiples of
 *    BEEP_INTERVAL_MS;
 *  - optional system-audio channel: constant low-level tone (gain 0.045, below
 *    the 0.1 onset threshold) — exercises multi-channel mixing without
 *    polluting onset detection;
 *  - optional flash+click cross-check (TD step 3d): the SAME rig-clock instants
 *    that fire beeps also flash the video background white for ~120 ms. Flash
 *    onsets are detectable in the export without barcodes or clock fits, so
 *    they independently confirm (or falsify) barcode-derived sync numbers.
 *
 * Channels are recorded through the SAME MediaRecorder settings production
 * uses and timed with the SAME epoch/onstart heuristic as
 * src/core/capture/session.ts — deliberately, so the oracle measures the
 * production pipeline including its capture-timing assumptions. All raw
 * bookkeeping (rig epoch, session epoch, per-channel onstart, pre-normalization
 * offsets) is returned in `debug` for the localization step.
 *
 * Storage note: blobs are written through the production blobStore because
 * exportRecording reads through it. Keys are prefixed `exp-oracle` and removed
 * by cleanup(); every failure path also removes them (TD hygiene item), and
 * sweepStaleOracleBlobs() clears leftovers from crashed earlier runs.
 * recordingsRepo is never touched, so nothing ever appears in the library.
 */

import { blobStore, createDurablePositionedWriter } from '@core/store'
import { canMeasureAudioCapture, startMeasuredAudioCapture } from '@core/capture/measuredAudio'
import { canMeasureVideoCapture, startMeasuredVideoCapture } from '@core/capture/measuredVideo'
import type { ChannelKind, ChannelRecording, MediaKind, Recording } from '@core/types'
import { listProductionBlobs } from '../shared/opfs'
import { encodeBits, FID_BLOCK, FID_BLOCK_COUNT, FID_MARGIN } from './fiducial'

export const BEEP_INTERVAL_MS = 1000
export const FLASH_DURATION_MS = 120
export const RIG_WIDTH = 1280
export const RIG_HEIGHT = 720

/** Which channels the rig records (mirrors CaptureConfig shape). */
export interface RigMix {
  screen: boolean
  camera: boolean
  mic: boolean
  systemAudio: boolean
}

export const RIG_MIXES: Record<string, RigMix> = {
  'screen+mic': { screen: true, camera: false, mic: true, systemAudio: false },
  'camera+mic': { screen: false, camera: true, mic: true, systemAudio: false },
  'all-four': { screen: true, camera: true, mic: true, systemAudio: true },
  'audio-only': { screen: false, camera: false, mic: true, systemAudio: false },
}

const VIDEO_MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
const AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/webm']

function pickMime(candidates: string[]): string {
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c
  return candidates[candidates.length - 1]
}

export function drawFiducialStrip(
  g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  rigMs: number,
): void {
  const bits = encodeBits(rigMs)
  // Quiet zone behind the strip.
  g.fillStyle = '#808080'
  g.fillRect(FID_MARGIN - 8, FID_MARGIN - 8, FID_BLOCK * FID_BLOCK_COUNT + 16, FID_BLOCK + 16)
  const paint = (i: number, on: boolean): void => {
    g.fillStyle = on ? '#ffffff' : '#000000'
    g.fillRect(FID_MARGIN + i * FID_BLOCK, FID_MARGIN, FID_BLOCK, FID_BLOCK)
  }
  paint(0, true) // white reference
  paint(1, false) // black reference
  bits.forEach((b, i) => paint(2 + i, b === 1))
}

/** True while a flash window (started at a beep instant) is active. */
export function flashActiveAt(rigMs: number): boolean {
  const phase = rigMs % BEEP_INTERVAL_MS
  return rigMs >= BEEP_INTERVAL_MS && phase < FLASH_DURATION_MS
}

interface RecordedChannel {
  kind: ChannelKind
  media: MediaKind
  blobKey: string
  mimeType: string
  /** performance.now() when recorder.onstart fired. */
  onstartAbsMs: number
  /** onstartAbsMs - sessionEpoch (the production heuristic, pre-normalization). */
  rawStartOffsetMs: number
  /** Wall-clock duration: stop instant - onstartAbsMs (production heuristic). */
  durationMs: number
  /** performance.now() at recorder.start() call. */
  startCallAbsMs: number
  /** performance.now() right before requestData()/stop() (capture end anchor). */
  stopCallAbsMs: number
  /** performance.now() after recorder.onstop (post-drain stop anchor). */
  stopFinishAbsMs: number
  /** ondataavailable arrivals: wall time + slice bytes (mechanism probe). */
  dataEvents: { atMs: number; bytes: number }[]
  width?: number
  height?: number
}

async function recordStream(
  stream: MediaStream,
  kind: ChannelKind,
  media: MediaKind,
  blobKey: string,
  epoch: number,
  stopSignal: Promise<void>,
): Promise<RecordedChannel> {
  // Audio: production measured path (AudioWorklet → WebCodecs → mediabunny).
  if (media === 'audio' && canMeasureAudioCapture()) {
    const startCallAbsMs = performance.now()
    const writer = await createDurablePositionedWriter(blobKey)
    const handle = await startMeasuredAudioCapture({ stream, epoch, writer })
    const firstOffset = await handle.firstOffset
    const startAbs = epoch + firstOffset
    await stopSignal
    const stopCallAbsMs = performance.now()
    const result = await handle.stop()
    const stopFinishAbsMs = performance.now()
    return {
      kind,
      media,
      blobKey,
      mimeType: handle.mimeType,
      onstartAbsMs: startAbs,
      rawStartOffsetMs: result.startOffsetMs,
      durationMs: result.durationMs,
      startCallAbsMs,
      stopCallAbsMs,
      stopFinishAbsMs,
      dataEvents: [{ atMs: startAbs, bytes: result.bytes }],
    }
  }

  // Video: production measured path (TrackProcessor → VideoEncoder → fMP4).
  if (media === 'video' && canMeasureVideoCapture()) {
    const startCallAbsMs = performance.now()
    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('rig: video stream has no track')
    const writer = await createDurablePositionedWriter(blobKey)
    const handle = await startMeasuredVideoCapture({
      track,
      kind: kind === 'camera' ? 'camera' : 'screen',
      epoch,
      writer,
    })
    const firstOffset = await handle.firstOffset
    const startAbs = epoch + firstOffset
    await stopSignal
    const stopCallAbsMs = performance.now()
    const result = await handle.stop()
    const stopFinishAbsMs = performance.now()
    return {
      kind,
      media,
      blobKey,
      mimeType: handle.mimeType,
      onstartAbsMs: startAbs,
      rawStartOffsetMs: result.startOffsetMs,
      durationMs: result.durationMs,
      startCallAbsMs,
      stopCallAbsMs,
      stopFinishAbsMs,
      dataEvents: [{ atMs: startAbs, bytes: result.bytes }],
      width: result.width || RIG_WIDTH,
      height: result.height || RIG_HEIGHT,
    }
  }

  const mimeType = pickMime(media === 'video' ? VIDEO_MIMES : AUDIO_MIMES)
  const options: MediaRecorderOptions =
    media === 'video'
      ? { mimeType, videoBitsPerSecond: kind === 'screen' ? 8_000_000 : 4_000_000 }
      : { mimeType, audioBitsPerSecond: 128_000 }
  const recorder = new MediaRecorder(stream, options)
  const writable = await blobStore.createWriteStream(blobKey)
  const writer = writable.getWriter()
  let writeChain: Promise<void> = Promise.resolve()

  let startAbs = 0
  recorder.onstart = () => {
    startAbs = performance.now()
  }
  const dataEvents: { atMs: number; bytes: number }[] = []
  recorder.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) {
      dataEvents.push({ atMs: performance.now(), bytes: ev.data.size })
      writeChain = writeChain.then(() => writer.write(ev.data)).catch(() => undefined)
    }
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })

  const startCallAbsMs = performance.now()
  recorder.start(1000)
  await stopSignal
  const stopCallAbsMs = performance.now()
  try {
    recorder.requestData()
  } catch {
    /* inactive */
  }
  recorder.stop()
  await stopped
  const stopFinishAbsMs = performance.now()
  // Video: file epoch ≈ startCall (TD measured). Audio MediaRecorder fallback
  // still uses onstart (prefer measured path above).
  const offsetAnchor = media === 'video' ? startCallAbsMs : startAbs || startCallAbsMs
  const durationMs = stopFinishAbsMs - (startAbs || startCallAbsMs)
  await writeChain
  await writer.close()

  const out: RecordedChannel = {
    kind,
    media,
    blobKey,
    mimeType: recorder.mimeType || mimeType,
    onstartAbsMs: startAbs || startCallAbsMs,
    rawStartOffsetMs: offsetAnchor - epoch,
    durationMs,
    startCallAbsMs,
    stopCallAbsMs,
    stopFinishAbsMs,
    dataEvents,
  }
  if (media === 'video') {
    out.width = RIG_WIDTH
    out.height = RIG_HEIGHT
  }
  return out
}

export interface RigChannelDebug {
  kind: ChannelKind
  media: MediaKind
  blobKey: string
  onstartAbsMs: number
  rawStartOffsetMs: number
  normalizedStartOffsetMs: number
  durationMs: number
  startCallAbsMs: number
  stopCallAbsMs: number
  dataEvents: { atMs: number; bytes: number }[]
}

export interface RigDebug {
  /** performance.now() at rig-clock zero (barcode/beep time base). */
  rigEpochAbsMs: number
  /** performance.now() at session epoch (production start() analogue). */
  sessionEpochAbsMs: number
  /** min-normalization applied at stop (same rule as session.ts doStop). */
  minOffsetMs: number
  beepIntervalMs: number
  flashClick: boolean
  /**
   * Rig honesty probe: wall (rig-clock) times at which each beep's samples
   * ACTUALLY arrived on the mic MediaStreamTrack, measured by a
   * MediaStreamTrackProcessor on a cloned track — independent of the
   * AudioContext clock mapping used for scheduling. If these differ from the
   * nominal k·interval grid, the SOURCE is late, not the pipeline.
   */
  beepStreamArrivalsRigMs: number[]
  /** Continuously sampled (rigMs, audioCtx.currentTime) pairs. */
  clockPairs: { rigMs: number; ctxSec: number }[]
  /** Scheduled beep positions on the AudioContext clock, seconds. */
  beepCtxSecs: number[]
  /**
   * TRUE beep render times on the rig clock: scheduled ctx positions mapped
   * through the measured (rigMs, currentTime) pairs. THIS is the ground-truth
   * grid all sync metrics must use — the nominal k·interval grid is wrong by
   * the AudioContext startup stall (measured 100–300 ms, machine-dependent).
   */
  beepTrueRigMs: number[]
  /** beepTrueRigMs[k] − k·interval: the startup-stall artifact, per beep. */
  beepScheduleSkewMs: number[]
  channels: RigChannelDebug[]
}

/** Map an AudioContext time to rig time via sampled clock pairs (interpolated). */
export function ctxSecToRigMs(pairs: { rigMs: number; ctxSec: number }[], ctxSec: number): number | null {
  if (pairs.length < 2) return null
  // pairs are appended in time order.
  if (ctxSec <= pairs[0].ctxSec) {
    const a = pairs[0]
    const b = pairs[1]
    return a.rigMs + ((ctxSec - a.ctxSec) / (b.ctxSec - a.ctxSec)) * (b.rigMs - a.rigMs)
  }
  for (let i = 1; i < pairs.length; i++) {
    if (ctxSec <= pairs[i].ctxSec) {
      const a = pairs[i - 1]
      const b = pairs[i]
      if (b.ctxSec === a.ctxSec) return b.rigMs
      return a.rigMs + ((ctxSec - a.ctxSec) / (b.ctxSec - a.ctxSec)) * (b.rigMs - a.rigMs)
    }
  }
  const a = pairs[pairs.length - 2]
  const b = pairs[pairs.length - 1]
  if (b.ctxSec === a.ctxSec) return b.rigMs
  return a.rigMs + ((ctxSec - a.ctxSec) / (b.ctxSec - a.ctxSec)) * (b.rigMs - a.rigMs)
}

export interface OracleRig {
  recording: Recording
  debug: RigDebug
  cleanup(): Promise<void>
}

interface VideoRig {
  stream: MediaStream
  stop: () => void
}

/** Minimal typing for the Chromium-only audio-track processor (probe only). */
interface AudioTrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<AudioData> }
}

/**
 * Watch a CLONE of the mic track and record the wall (rig) time at which each
 * beep's samples actually arrive on the MediaStream — independent of the
 * AudioContext scheduling clock. Returns a stop function resolving to onsets.
 */
function probeBeepArrivals(
  track: MediaStreamTrack,
  rigEpoch: number,
): { stop: () => Promise<number[]>; dispose: () => void } {
  const Ctor = (globalThis as Record<string, unknown>).MediaStreamTrackProcessor as
    | AudioTrackProcessorCtor
    | undefined
  const onsets: number[] = []
  if (typeof Ctor !== 'function') {
    return { stop: () => Promise.resolve(onsets), dispose: () => undefined }
  }
  const clone = track.clone()
  const reader = new Ctor({ track: clone }).readable.getReader()
  let above = false
  let running = true
  const loop = (async () => {
    try {
      while (running) {
        const { value, done } = await reader.read()
        if (done || !value) break
        const n = value.numberOfFrames
        const buf = new Float32Array(n)
        value.copyTo(buf, { planeIndex: 0 })
        let peak = 0
        for (let i = 0; i < n; i++) {
          const a = Math.abs(buf[i])
          if (a > peak) peak = a
        }
        const nowRig = performance.now() - rigEpoch
        if (peak > 0.1 && !above) onsets.push(nowRig)
        above = peak > 0.1
        value.close()
      }
    } catch {
      /* track ended */
    }
  })()
  return {
    stop: async () => {
      running = false
      await reader.cancel().catch(() => undefined)
      await loop
      return onsets
    },
    dispose: () => clone.stop(),
  }
}

function makeFiducialCanvas(kind: 'screen' | 'camera', rigEpoch: number, flashClick: boolean): VideoRig {
  const canvas = document.createElement('canvas')
  canvas.width = RIG_WIDTH
  canvas.height = RIG_HEIGHT
  // Headless captureStream emits almost no frames for detached canvases.
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:16px;height:9px;opacity:0.01;pointer-events:none'
  document.body.appendChild(canvas)
  const g = canvas.getContext('2d', { willReadFrequently: false })
  if (!g) throw new Error('2d context unavailable')
  // setInterval not rAF: headless Chrome throttles rAF to ~1–3fps.
  const draw = (): void => {
    const rigMs = performance.now() - rigEpoch
    if (flashClick && flashActiveAt(rigMs)) {
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, RIG_WIDTH, RIG_HEIGHT)
    } else {
      const hue = (rigMs / 40 + (kind === 'camera' ? 120 : 0)) % 360
      g.fillStyle = `hsl(${hue}, 40%, ${kind === 'camera' ? 26 : 18}%)`
      g.fillRect(0, 0, RIG_WIDTH, RIG_HEIGHT)
    }
    // Moving bar keeps the encoder honest (avoids static-frame shortcuts).
    g.fillStyle = `hsl(${(rigMs / 4) % 360}, 80%, 60%)`
    g.fillRect(((rigMs / 4) % (RIG_WIDTH + 160)) - 160, 560, 160, 40)
    drawFiducialStrip(g, rigMs)
  }
  // captureStream(0) + requestFrame: explicit 30fps drive. captureStream(30)
  // under-delivers to MediaStreamTrackProcessor (~8fps → short measured mp4).
  const stream = canvas.captureStream(0)
  const track = stream.getVideoTracks()[0]!
  const tick = (): void => {
    draw()
    try {
      ;(track as MediaStreamTrack & { requestFrame?: () => void }).requestFrame?.()
    } catch {
      /* requestFrame optional on some builds */
    }
  }
  tick()
  const timer = setInterval(tick, 1000 / 60)
  return {
    stream,
    stop: () => {
      clearInterval(timer)
      canvas.remove()
    },
  }
}

export interface RecordOptions {
  mix?: RigMix
  /** Enable the flash+click cross-check content (step 3d). */
  flashClick?: boolean
  /**
   * Hold the streams live for this long BEFORE starting the recorders —
   * models production's arm→start gap (preview can run for seconds). Used to
   * falsify "audio file t=0 tracks stream creation (pre-start audio leaks
   * into the recording)" vs "t=0 tracks the start() call".
   */
  armDelayMs?: number
}

export async function recordFiducialSession(durationMs: number, opts?: RecordOptions): Promise<OracleRig> {
  const mix = opts?.mix ?? RIG_MIXES['screen+mic']
  const flashClick = opts?.flashClick ?? false
  const runId = `exp-oracle-${Date.now()}`
  const teardowns: (() => void)[] = []
  const blobKeys: string[] = []
  const removeBlobs = async (): Promise<void> => {
    await Promise.all(blobKeys.map((k) => blobStore.remove(k).catch(() => undefined)))
  }

  let audioCtx: AudioContext | null = null
  try {
    const rigEpoch = performance.now()

    // -- video sources ---------------------------------------------------------
    const videoRigs: { kind: 'screen' | 'camera'; rig: VideoRig }[] = []
    if (mix.screen) videoRigs.push({ kind: 'screen', rig: makeFiducialCanvas('screen', rigEpoch, flashClick) })
    if (mix.camera) videoRigs.push({ kind: 'camera', rig: makeFiducialCanvas('camera', rigEpoch, flashClick) })
    for (const v of videoRigs) teardowns.push(v.rig.stop)

    // -- audio sources ---------------------------------------------------------
    let micStream: MediaStream | null = null
    let sysStream: MediaStream | null = null
    let beepCtxSecs: number[] = []
    const clockPairs: { rigMs: number; ctxSec: number }[] = []
    if (mix.mic || mix.systemAudio) {
      audioCtx = new AudioContext()
      await audioCtx.resume()
      // Initial mapping only for SCHEDULING; the true rig time of every beep
      // is recovered afterwards from continuously sampled clock pairs, so a
      // skewed early currentTime cannot masquerade as a pipeline offset.
      const rigNowMs = performance.now() - rigEpoch
      const ctxNowSec = audioCtx.currentTime
      const ctx = audioCtx
      clockPairs.push({ rigMs: performance.now() - rigEpoch, ctxSec: ctx.currentTime })
      const pairTimer = setInterval(() => {
        clockPairs.push({ rigMs: performance.now() - rigEpoch, ctxSec: ctx.currentTime })
      }, 47)
      teardowns.push(() => clearInterval(pairTimer))

      if (mix.mic) {
        const dest = audioCtx.createMediaStreamDestination()
        const osc = new OscillatorNode(audioCtx, { frequency: 880 })
        const gain = new GainNode(audioCtx, { gain: 0 })
        osc.connect(gain).connect(dest)
        osc.start()
        const beepCount = Math.ceil(durationMs / BEEP_INTERVAL_MS) + 2
        for (let k = 1; k <= beepCount; k++) {
          const beepCtxSec = ctxNowSec + (k * BEEP_INTERVAL_MS - rigNowMs) / 1000
          if (beepCtxSec <= ctxNowSec) continue
          gain.gain.setValueAtTime(0.6, beepCtxSec)
          gain.gain.setValueAtTime(0, beepCtxSec + 0.05)
          beepCtxSecs.push(beepCtxSec)
        }
        micStream = dest.stream
        teardowns.push(() => osc.stop())
      }
      if (mix.systemAudio) {
        const dest = audioCtx.createMediaStreamDestination()
        // Constant tone below the 0.1 onset threshold: exercises mixing
        // without adding onsets.
        const osc = new OscillatorNode(audioCtx, { frequency: 220 })
        const gain = new GainNode(audioCtx, { gain: 0.045 })
        osc.connect(gain).connect(dest)
        osc.start()
        sysStream = dest.stream
        teardowns.push(() => osc.stop())
      }
    }

    // Beep-arrival honesty probe on a mic-track clone (independent of the
    // AudioContext clock the beeps were scheduled with).
    let beepProbe: { stop: () => Promise<number[]>; dispose: () => void } | null = null
    if (micStream) {
      beepProbe = probeBeepArrivals(micStream.getAudioTracks()[0], rigEpoch)
    }

    // -- record all channels with the production epoch heuristic ----------------
    if (opts?.armDelayMs) await new Promise((r) => setTimeout(r, opts.armDelayMs))
    const epoch = performance.now()
    let releaseStop!: () => void
    const stopSignal = new Promise<void>((r) => {
      releaseStop = r
    })
    const stopTimer = setTimeout(releaseStop, durationMs)

    const jobs: Promise<RecordedChannel>[] = []
    const enqueue = (stream: MediaStream, kind: ChannelKind, media: MediaKind): void => {
      const ext =
        media === 'video' && canMeasureVideoCapture()
          ? 'mp4'
          : media === 'audio' && canMeasureAudioCapture()
            ? 'webm'
            : 'webm'
      const key = `${runId}_${kind}.${ext}`
      blobKeys.push(key)
      jobs.push(recordStream(stream, kind, media, key, epoch, stopSignal))
    }
    for (const v of videoRigs) enqueue(v.rig.stream, v.kind, 'video')
    if (micStream) enqueue(micStream, 'mic', 'audio')
    if (sysStream) enqueue(sysStream, 'system-audio', 'audio')
    if (jobs.length === 0) throw new Error('rig: empty mix')

    let recorded: RecordedChannel[]
    let beepStreamArrivalsRigMs: number[] = []
    try {
      recorded = await Promise.all(jobs)
    } finally {
      clearTimeout(stopTimer)
      releaseStop()
      if (beepProbe) {
        beepStreamArrivalsRigMs = await beepProbe.stop()
        beepProbe.dispose()
      }
      for (const t of teardowns) {
        try {
          t()
        } catch {
          /* already stopped */
        }
      }
      for (const v of videoRigs) for (const t of v.rig.stream.getTracks()) t.stop()
      for (const s of [micStream, sysStream]) if (s) for (const t of s.getTracks()) t.stop()
      if (audioCtx && audioCtx.state !== 'closed') await audioCtx.close().catch(() => undefined)
    }

    // Same normalization the production session applies at stop().
    // (Rejected f251f5f probe/heuristic offsets — MediaRecorder exposes no capture epoch.)
    const minOffset = recorded.reduce((m, c) => Math.min(m, c.rawStartOffsetMs), Infinity)
    const channels: ChannelRecording[] = recorded.map((c, i) => {
      const rec: ChannelRecording = {
        id: `oracle_${c.kind}_${i}`,
        kind: c.kind,
        media: c.media,
        mimeType: c.mimeType,
        blobKey: c.blobKey,
        startOffsetMs: Math.max(0, Math.round(c.rawStartOffsetMs - minOffset)),
        durationMs: Math.round(c.durationMs),
      }
      if (c.width) rec.width = c.width
      if (c.height) rec.height = c.height
      return rec
    })

    const recording: Recording = {
      id: runId,
      createdAt: Date.now(),
      durationMs: channels.reduce((m, c) => Math.max(m, c.startOffsetMs + c.durationMs), 0),
      channels,
    }

    const debug: RigDebug = {
      rigEpochAbsMs: rigEpoch,
      sessionEpochAbsMs: epoch,
      minOffsetMs: minOffset,
      beepIntervalMs: BEEP_INTERVAL_MS,
      flashClick,
      beepStreamArrivalsRigMs,
      clockPairs,
      beepCtxSecs,
      beepTrueRigMs: beepCtxSecs
        .map((s) => ctxSecToRigMs(clockPairs, s))
        .filter((x): x is number => x !== null),
      beepScheduleSkewMs: beepCtxSecs
        .map((s, k) => {
          const rig = ctxSecToRigMs(clockPairs, s)
          return rig === null ? null : rig - (k + 1) * BEEP_INTERVAL_MS
        })
        .filter((x): x is number => x !== null),
      channels: recorded.map((c, i) => ({
        kind: c.kind,
        media: c.media,
        blobKey: c.blobKey,
        onstartAbsMs: c.onstartAbsMs,
        rawStartOffsetMs: c.rawStartOffsetMs,
        normalizedStartOffsetMs: channels[i].startOffsetMs,
        durationMs: c.durationMs,
        startCallAbsMs: c.startCallAbsMs,
        stopCallAbsMs: c.stopCallAbsMs,
        dataEvents: c.dataEvents,
      })),
    }

    return { recording, debug, cleanup: removeBlobs }
  } catch (err) {
    // TD hygiene: no stranded production-storage keys on any failure path.
    await removeBlobs()
    if (audioCtx && audioCtx.state !== 'closed') await audioCtx.close().catch(() => undefined)
    throw err
  }
}

/** Remove exp-oracle-* blobs stranded by crashed earlier runs (TD hygiene). */
export async function sweepStaleOracleBlobs(): Promise<string[]> {
  const files = await listProductionBlobs()
  const stale = files.filter((f) => f.name.startsWith('exp-oracle-')).map((f) => f.name)
  await Promise.all(stale.map((k) => blobStore.remove(k).catch(() => undefined)))
  return stale
}
