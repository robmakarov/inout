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
import type {
  ChannelKind,
  ChannelRecording,
  CompositeRecording,
  MediaKind,
  Recording,
} from '@core/types'
import {
  canLiveComposite,
  startLiveComposite,
  type LiveCompositeHandle,
  type LiveCompositeInputs,
} from '@core/capture/liveComposite'
import { canLiveCompositeV2, startLiveCompositeV2 } from '@core/capture/liveCompositeV2'
import { preferredCompositeEngine } from '@core/capture/engine'
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
  /** Measured-audio only: beep onsets placed on the session timeline by the
   *  production anchor — the reference that shares the anchor's blind spot. */
  anchorOnsetSessionMs?: number[]
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
    // Beep onsets read off the PRODUCTION capture path itself (O4b). The old
    // reference watched a track-processor CLONE, which is a shorter path than
    // the one the anchor sees — so it under-measured the delay the anchor
    // cannot observe, and the difference surfaced as "audio late" in every
    // sync number. Measuring on the same path removes the rig from the result.
    const onsetFrames: number[] = []
    let prevEnv = 0
    let refractoryUntil = -Infinity
    let pcmRate = 48_000
    const handle = await startMeasuredAudioCapture({
      stream,
      epoch,
      writer,
      onPcm: (left, _right, startFrame, _off, rate) => {
        pcmRate = rate
        const ENV = 128
        const REFRACTORY = 0.2 * rate
        for (let i = 0; i < left.length; i += ENV) {
          const end = Math.min(left.length, i + ENV)
          let peak = 0
          for (let k = i; k < end; k++) {
            const a = Math.abs(left[k]!)
            if (a > peak) peak = a
          }
          const frame = startFrame + i
          if (peak > 0.1 && prevEnv <= 0.1 && frame >= refractoryUntil) {
            onsetFrames.push(frame)
            refractoryUntil = frame + REFRACTORY
          }
          prevEnv = peak
        }
      },
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
      // Where each beep sits on the SESSION timeline according to the anchor.
      anchorOnsetSessionMs: onsetFrames.map(
        (f) => result.startOffsetMs + (f / pcmRate) * 1000,
      ),
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
  /**
   * Beep onsets as the PRODUCTION ANCHOR places them, on the rig clock. Unlike
   * beepStreamArrivalsRigMs (a track-processor clone — a shorter path) this
   * shares the anchor's blind spot, so subtracting it removes the rig's own
   * transport delay instead of a smaller proxy for it.
   */
  beepAnchorRigMs: number[]
  /**
   * Rig-clock times at which each FLASH actually surfaced on the video track.
   * The audio equivalent has always been measured; assuming this one lands on
   * the nominal grid folds the rAF + captureStream sampling delay straight
   * into the reported A/V offset.
   */
  flashStreamArrivalsRigMs: number[]
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

interface VideoTrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> }
}

/**
 * Video-side twin of probeBeepArrivals (task O4 step 1).
 *
 * The audio reference has always been MEASURED (when beep samples actually
 * surface on the track); the video reference was ASSUMED to be the nominal rig
 * instant. It is not: the rig paints from a rAF loop and the canvas is sampled
 * by captureStream(30), so a flash surfaces on the track up to a rAF plus a
 * frame interval after the instant it nominally belongs to. Correcting only
 * the audio side leaves that whole delay inside the reported A/V offset.
 *
 * So watch a CLONE of the video track and record the wall (rig) time at which
 * each flash actually arrives, exactly as the audio probe does.
 */
function probeFlashArrivals(
  track: MediaStreamTrack,
  rigEpoch: number,
): { stop: () => Promise<number[]>; dispose: () => void } {
  const Ctor = (globalThis as Record<string, unknown>).MediaStreamTrackProcessor as
    | VideoTrackProcessorCtor
    | undefined
  const onsets: number[] = []
  if (typeof Ctor !== 'function') {
    return { stop: () => Promise.resolve(onsets), dispose: () => undefined }
  }
  const clone = track.clone()
  const reader = new Ctor({ track: clone }).readable.getReader()
  // Same background region analyze.ts reads, at a size cheap enough to pull
  // off every frame: away from the fiducial strip and the moving bar.
  const RECT = { x: 400, y: 300, width: 32, height: 16 }
  const buf = new Uint8Array(RECT.width * RECT.height * 4)
  let above = false
  let running = true
  const loop = (async () => {
    try {
      while (running) {
        const { value, done } = await reader.read()
        if (done || !value) break
        const nowRig = performance.now() - rigEpoch
        let luma = 0
        try {
          await value.copyTo(buf, {
            rect: RECT,
            format: 'RGBA',
            colorSpace: 'srgb',
          } as VideoFrameCopyToOptions)
          let sum = 0
          for (let p = 0; p < buf.length; p += 4) {
            sum += 0.299 * buf[p]! + 0.587 * buf[p + 1]! + 0.114 * buf[p + 2]!
          }
          luma = sum / (buf.length / 4)
        } catch {
          /* copyTo unsupported for this frame format — leave luma 0 */
        }
        const bright = luma > 180
        if (bright && !above) onsets.push(nowRig)
        above = bright
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
  const g = canvas.getContext('2d')
  if (!g) throw new Error('2d context unavailable')
  let raf = 0
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
    raf = requestAnimationFrame(draw)
  }
  draw()
  return { stream: canvas.captureStream(30), stop: () => cancelAnimationFrame(raf) }
}

export interface RecordOptions {
  mix?: RigMix
  /** Enable the flash+click cross-check content (step 3d). */
  flashClick?: boolean
  /**
   * Record a LIVE COMPOSITE alongside the channels, exactly as production does
   * (task O5-flip).
   *
   * Every real take has one; this rig never made one, so `recording.composite`
   * was always absent and the two packet-copying export paths — instant, and
   * now smart cut — could not run here at all. The sync band therefore only
   * ever measured the full render, which is the path a user gets LAST. Without
   * this, routing the oracle's trim through the export ladder would look green
   * while proving nothing, because it would fall straight through to the
   * render it already measured.
   *
   * Off by default so the historical numbers stay comparable; `npm run oracle`
   * turns it on (see scripts/oracle.mjs) after the A/B below showed the added
   * capture load does not move the sync band.
   */
  composite?: boolean
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
    // Symmetric video-side probe: the flash reference must be measured too,
    // not assumed to land on the nominal grid (O4 step 1).
    let flashProbe: { stop: () => Promise<number[]>; dispose: () => void } | null = null
    if (flashClick && videoRigs.length) {
      const vt = videoRigs[0]!.rig.stream.getVideoTracks()[0]
      if (vt) flashProbe = probeFlashArrivals(vt, rigEpoch)
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
      const key = `${runId}_${kind}.webm`
      blobKeys.push(key)
      jobs.push(recordStream(stream, kind, media, key, epoch, stopSignal))
    }
    for (const v of videoRigs) enqueue(v.rig.stream, v.kind, 'video')
    if (micStream) enqueue(micStream, 'mic', 'audio')
    if (sysStream) enqueue(sysStream, 'system-audio', 'audio')
    if (jobs.length === 0) throw new Error('rig: empty mix')

    // The composite starts with the recorders and off the SAME streams, which
    // is what session.startComposite does. The engine choice mirrors it too:
    // v2 when the platform and the preference allow, v1 as the capability
    // fallback — anything else would gate a composite the product never makes.
    let compositeHandle: LiveCompositeHandle | null = null
    const compositeKey = `${runId}_composite.webm`
    if (opts?.composite) {
      const inputs: LiveCompositeInputs = {
        screen: videoRigs.find((v) => v.kind === 'screen')?.rig.stream,
        camera: videoRigs.find((v) => v.kind === 'camera')?.rig.stream,
        audio: [micStream, sysStream].filter((s): s is MediaStream => !!s),
      }
      blobKeys.push(compositeKey)
      try {
        // The epoch goes in for the same reason production passes it: the
        // composite's clock does not start when the take does, and a file that
        // cannot say so is copied into the wrong place (P0-instant-sync).
        if (preferredCompositeEngine() === 'v2' && canLiveCompositeV2(inputs)) {
          compositeHandle = await startLiveCompositeV2(inputs, compositeKey, { epochMs: epoch })
        } else if (canLiveComposite(inputs)) {
          compositeHandle = await startLiveComposite(inputs, compositeKey, { epochMs: epoch })
        }
      } catch (err) {
        // A composite that will not start is a real answer, not a rig crash:
        // the recording simply has none and the export ladder falls back —
        // which the oracle's own path gate will then report as such.
        console.warn('[rig] live composite unavailable', err)
        compositeHandle = null
      }
    }

    let recorded: RecordedChannel[]
    let composite: CompositeRecording | null = null
    let beepStreamArrivalsRigMs: number[] = []
    let flashStreamArrivalsRigMs: number[] = []
    try {
      recorded = await Promise.all(jobs)
      // Stop the composite BEFORE the sources are torn down below: its own
      // drain needs the encoder alive, and P0-tail's whole lesson is that
      // killing the stream first takes the backlog with it.
      if (compositeHandle) {
        composite = await compositeHandle.stop().catch((err) => {
          console.warn('[rig] composite stop failed', err)
          return null
        })
        compositeHandle = null
      }
    } finally {
      clearTimeout(stopTimer)
      releaseStop()
      if (compositeHandle) await compositeHandle.cancel().catch(() => undefined)
      if (beepProbe) {
        beepStreamArrivalsRigMs = await beepProbe.stop()
        beepProbe.dispose()
      }
      if (flashProbe) {
        flashStreamArrivalsRigMs = await flashProbe.stop()
        flashProbe.dispose()
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
    if (composite) {
      // The composite takes the same rebase as the channels — it is on the
      // same timeline (P0-instant-sync); production does this in session.ts.
      if (composite.startOffsetMs !== undefined && Number.isFinite(minOffset)) {
        composite.startOffsetMs = Math.max(0, Math.round(composite.startOffsetMs - minOffset))
      }
      recording.composite = composite
    }

    const debug: RigDebug = {
      rigEpochAbsMs: rigEpoch,
      sessionEpochAbsMs: epoch,
      minOffsetMs: minOffset,
      beepIntervalMs: BEEP_INTERVAL_MS,
      flashClick,
      beepStreamArrivalsRigMs,
      beepAnchorRigMs: (() => {
        const mic = recorded.find((c) => c.kind === 'mic')
        if (!mic?.anchorOnsetSessionMs?.length) return []
        // session ms → rig ms (both are performance.now() based).
        return mic.anchorOnsetSessionMs.map((ms) => epoch + ms - rigEpoch)
      })(),
      flashStreamArrivalsRigMs,
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
