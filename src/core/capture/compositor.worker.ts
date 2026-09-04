/**
 * O4 step 2 — the live composite, off the main thread.
 *
 * v1 (liveComposite.ts) paid for every composited frame four times: the source
 * was decoded into a <video>, the compositor read that element with drawImage
 * on the MAIN thread, canvas.captureStream re-encoded the canvas, and the
 * on-screen preview decoded the same source a second time. It also redrew on a
 * fixed 30 Hz tick whether or not anything had changed, and it had no keyframe
 * control and no way to drain the encoder at stop.
 *
 * This worker takes VideoFrames straight off MediaStreamTrackProcessor (no
 * <video>, no decode), composites them on an OffscreenCanvas, encodes with
 * VideoEncoder (hardware where the platform offers it), muxes fragmented MP4,
 * and writes it through its OWN SyncAccessHandle — so bytes land on disk as
 * they are produced and a tab kill leaves a playable prefix rather than
 * nothing. Drawing is FRAME-DRIVEN: a static screen costs one keep-alive frame
 * per second instead of thirty identical ones.
 *
 * THE PAINTER IS CHOSEN AT RUNTIME (O4, 2026-09-04): WebGPU, then WebGL2, then
 * 2D, each a complete fallback for the one above it — `painterChoice.ts` holds
 * the switch and the reasoning. The premise this file's header used to call
 * unproven is now measured (a transferred capture frame is NOT read back;
 * .ai/DECISIONS), and what WebGPU removes is the upload, 40-50 % of the paint.
 *
 * One deliberate non-goal, recorded so it is a decision and not a gap:
 *   · The audio is MIXED ON THE MAIN THREAD and arrives here as PCM. The mix
 *     graph (gain staging + the limiter that only engages on genuine pileups)
 *     is tuned and shipped; re-implementing it here would risk audible change
 *     for no benefit, because WebAudio cannot run in a worker anyway.
 */

import { adoptedFrame, evenDown, frameForAspect } from '@core/frame'
import { poseToRect } from '@core/timeline/cameraTrack'
import type { CameraPose } from '@core/types'
import {
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny'
import type { PressureSignals } from '../pressure'
import { burstFramesFor } from './burstBudget'
import { LATE_TICK_MS, PressureSampler, type PressureCounters } from './pressureSampler'
import { createGLCompositor, type GLCompositor } from './compositorGL'
import { createWGPUCompositor, wgpuDevice, type WGPUCompositor } from './compositorWGPU'
import { trackProcessorCtor } from './frameIntake'
import { WallClockHold, compressPlanar } from './wallClockHold'

const ROOT_DIR = 'blobs'
/** Keyframe cadence — the smart-cut prerequisite (O5) and the salvage anchor. */
const KEYFRAME_INTERVAL_S = 2
/** Beyond this the encoder is behind; drop rather than queue (a queued frame
 * is latency the user pays for at stop). ALSO the denominator E1's bands were
 * measured against — `queueCliff` in the pressure signals is this number and
 * not the burst bound below, deliberately: see BURST_BUDGET_BYTES. */
const MAX_ENCODER_QUEUE = 6
/**
 * E2's SECOND LAYER OF DEFENCE — ABSORB THE BURST BEFORE MOVING THE PICTURE.
 *
 * Robert, 2026-09-02: the order is shed the unseen → absorb a burst in a
 * memory-bounded queue → the smallest picture step. Layer two did not exist:
 * the seventh frame behind a busy encoder was simply DROPPED, so a 200 ms hiccup
 * — a keyframe, a window drag, another tab starting — came out of the file as
 * lost frames rather than out of a buffer.
 *
 * WHAT IT IS: the drop threshold is `MAX_ENCODER_QUEUE + burstFrames` instead of
 * `MAX_ENCODER_QUEUE`. Nothing new is allocated and no second queue exists — the
 * frames sit in the VideoEncoder's own queue, which is the only place that can
 * hold them without a copy. The size is `burstBudget.ts`'s, sized in BYTES to
 * this machine and capped in frames for latency.
 *
 * MEASURED SIZES at 8 GB: 4 frames at 1080p, 2 at 3024x1964, 2 at 4K — at most
 * the 24 MB budget, whatever the geometry.
 *
 * WHY THE STRAIN DENOMINATOR STAYS AT 6: the burst allowance is the ABSORBER,
 * and using the absorber IS the pressure signal. A queue in burst territory
 * reads strain > 1.0, i.e. `critical`, which is precisely "the queue is about to
 * overflow on the next tick" — the ruling's own definition of when the picture
 * may finally move. Sizing the denominator to the burst instead would hide the
 * absorber's engagement, which is the one event that matters.
 */
/** Sized once at configure, from the geometry the encoder was opened with. */
let burstFrames = 0
/** `?burst=0` — the shipped behaviour, and the A/B control the gate is read
 *  against. Set from the start message before the encoder is configured. */
let burstEnabled = true

function sizeBurst(width: number, height: number): void {
  if (!burstEnabled) {
    burstFrames = 0
    stats.burstFrames = 0
    return
  }
  const nav = (globalThis as { navigator?: { deviceMemory?: number } }).navigator
  burstFrames = burstFramesFor(width, height, nav?.deviceMemory ?? null)
  stats.burstFrames = burstFrames
}
/** A static composition still needs a frame occasionally or the timeline
 * stalls and players show nothing between events. */
const KEEPALIVE_MS = 1000
/** How long the ticker holds off after start — see the comment where it is
 *  scheduled. Comfortably inside the ladder's own 4 s warmup, so nothing that
 *  could have acted on a reading is delayed by this. */
const PRESSURE_START_DELAY_MS = 1_000
/**
 * F13: how long the first real frame has to define the composite's shape, and
 * how long the keep-alive holds off for it. A source that never delivers (a
 * still screen — getDisplayMedia emits on change) simply keeps the caller's
 * guess when this expires, which is exactly the shape it used to always have.
 */
const ADOPT_BUDGET_MS = 700
/** The preview canvas's own pixel budget, long edge. */
const PREVIEW_LONG_EDGE = 960
/**
 * A GPU barrier after the draw, so that paint timing measures the GPU rather
 * than the enqueue. OFF by default — the barrier itself serialises the pipeline,
 * so it is an instrument, not a setting. Measured with it on, 2026-08-23: 2.05
 * and 2.84 ms of real GPU per composited frame at 1080p, which is not the wall.
 */
const PROBE_GPU = false

interface SyncAccessHandle {
  write(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number
  flush(): void
  close(): void
  getSize(): number
  truncate?(size: number): void
}

export interface CompositorStartMsg {
  cmd: 'start'
  key: string
  width: number
  height: number
  fps: number
  videoBitrate: number
  audioBitrate: number
  /** Present when the take has any audio channel. */
  sampleRate: number | null
  channelCount: number
  /**
   * F13, SECOND PASS: take the shape from the FRAMES, not from the caller.
   *
   * `width`/`height` above are the main thread's best guess, and on a phone it
   * is wrong — `track.getSettings()` reports the SENSOR (landscape) while the
   * frames that arrive are rotated to portrait, so a phone take was composited
   * into a landscape canvas and cover-cropped. Nothing else in this worker ever
   * looked at what a delivered frame actually is. With this set, the first real
   * frame decides, at `longEdge`'s pixel budget, before anything is encoded.
   */
  followSource?: boolean
  longEdge?: number
  /**
   * E2 — may the encoder's burst absorber run? The frozen rule asks every new
   * engine to keep the old one reachable at runtime, and here the old one is
   * "the seventh frame behind a busy encoder is dropped". The main thread reads
   * `?burst=0` and passes the answer in; a worker cannot see the page's URL.
   */
  burst?: boolean
  /**
   * O4 — which painter to build. Same shape as `burst` above and for the same
   * reason: a worker cannot see the page's URL, so the main thread reads the
   * flag and passes the answer in. Absent means WebGPU, and any choice this
   * machine cannot honour falls through to the next backend rather than
   * failing the take.
   */
  painter?: 'webgpu' | 'webgl2' | '2d'
  /**
   * P9 — the MAIN THREAD'S `performance.timeOrigin`, so this worker can put a
   * frame it read ITSELF on the main thread's clock.
   *
   * The composite has exactly one clock and it is the main thread's: every
   * `atMs` in every message is `performance.now()` over THERE, and the audio
   * batches carry the same. A worker's own `performance.now()` counts from a
   * different origin, so the `worker-processor` rung — the one where frames
   * never touch the main thread — would otherwise stamp its video on a clock
   * the audio is not on. `timeOrigin` is the absolute instant each context's
   * zero sits at, so `now() + (ours - theirs)` is their reading of now.
   *
   * Absent on the rungs that stamp on the main thread, where it is not needed
   * and the delta stays 0.
   */
  mainTimeOrigin?: number
}

/**
 * P9 — CAN THIS WORKER BUILD A TRACK PROCESSOR? Asked before `start`, and only
 * by a main thread that has no processor of its own, so the shipped Chromium
 * path never pays the round trip. There is no way to ask this from the outside:
 * WebKit exposes MediaStreamTrackProcessor in workers and nowhere else, and a
 * worker's globals are not visible to the page.
 */
export interface CompositorProbeMsg {
  cmd: 'probe'
}

/**
 * P9 — TAKE THIS TRACK AND READ IT YOURSELF (the `worker-processor` rung).
 *
 * The track is TRANSFERRED: after this message the main thread's handle is
 * detached, which is also why the liveness beat below exists — the page can no
 * longer read `readyState` on a track it has given away.
 */
export interface CompositorSourceMsg {
  cmd: 'source'
  kind: 'screen' | 'camera'
  track: MediaStreamTrack
}

export interface CompositorFrameMsg {
  cmd: 'frame'
  kind: 'screen' | 'camera'
  /** Main-thread wall clock at the moment the frame was read, ms since epoch
   * start. ONE clock for the whole composite — a worker's performance.now()
   * has a different time origin, so timestamps are never computed here. */
  atMs: number
  frame: VideoFrame
}

export interface CompositorAudioMsg {
  cmd: 'audio'
  /** Interleaved-by-plane Float32 (channel-major), as the PCM worklet emits. */
  planar: Float32Array
  frames: number
  channels: number
  /** Wall clock of the FIRST sample of this batch, ms since epoch start. */
  atMs: number
  /**
   * performance.now() when the MAIN THREAD received this batch. Deliberately
   * NOT derived from the audio clock like `atMs` is: this is the only stamp in
   * the message that keeps time when the audio graph does not, which is what
   * lets the timeline notice it has fallen behind (see the padding below).
   */
  recvMs: number
}

/**
 * O4-polish: the recording preview stops decoding the sources a SECOND time.
 *
 * The composite is already being painted here, once, from frames that never
 * touch a <video> element. The preview used to re-decode both sources into two
 * <video> tags on the main thread and re-create the composition in CSS — the
 * last redundant decodes in the capture path. The main thread hands over a
 * canvas instead (transferControlToOffscreen, so this worker owns it) and the
 * composite is blitted into it right after each encode.
 */
export interface CompositorPreviewMsg {
  cmd: 'preview'
  canvas: OffscreenCanvas
}

/**
 * WHERE THE CAMERA SITS, CHANGED WHILE THE TAKE RUNS (UI1).
 *
 * Fire-and-forget: no reply, because the answer is the next painted frame. Null
 * puts it back to the default corner. A take that never sends one is
 * byte-identical to a take made before this existed — the pose starts null and
 * `pipRect` falls straight through to the constants it always used.
 */
export interface CompositorPoseMsg {
  cmd: 'campose'
  pose: CameraPose | null
}

export type CompositorMsg =
  | CompositorStartMsg
  | CompositorProbeMsg
  | CompositorSourceMsg
  | CompositorFrameMsg
  | CompositorAudioMsg
  | CompositorPreviewMsg
  | CompositorPoseMsg
  | { cmd: 'stop' }
  | { cmd: 'cancel' }

export interface CompositorStats {
  framesIn: number
  framesEncoded: number
  framesDropped: number
  keepAliveFrames: number
  bytes: number
  durationMs: number
  audioFrames: number
  /**
   * Sample frames that reached this worker and were NEVER encoded, split by
   * why. A short audio track desyncs the whole take — audio is sample-counted
   * while video is wall-stamped, so every dropped frame moves the rest of the
   * audio EARLIER against the picture, for the remainder of the take. That
   * used to happen behind a bare `return` with nothing counted (Robert 2026-08-25,
   * a take beside a 4K game: "sounds go faster than video"). It is counted now.
   */
  audioDroppedNotReady: number
  audioDroppedLead: number
  /**
   * Silence inserted to hold the audio timeline against the wall clock. >0
   * means the audio graph lost real time and the take would otherwise have
   * drifted by exactly this much.
   */
  audioPaddedFrames: number
  /**
   * Frames REMOVED to walk a fast audio clock back onto the wall (Robert
   * 2026-08-29, "sound gets a little slower than screen video ... about a
   * second after one hour"). >0 means this source's audio clock ran faster
   * than the system clock and the take would otherwise have drifted late by
   * exactly this much.
   */
  audioTrimmedFrames: number
  /**
   * Longest stretch with NO frame in the file, ms. This is what a viewer sees
   * as a freeze, so it is measured rather than inferred from drop counts.
   */
  maxEncodeGapMs: number
  /** What the encoder actually negotiated — evidence, not decoration. */
  codec: string | null
  hardware: string | null
  /** Which compositor backend ran — 'webgpu', 'webgl2', or the slow '2d'. */
  backend: 'webgpu' | 'webgl2' | '2d' | null
  /**
   * THE SHAPE THIS FILE ACTUALLY IS (F13). The caller's start message is a
   * guess; with `followSource` the first arriving frame corrects it, and
   * CompositeRecording must carry what was written, not what was asked for.
   */
  outWidth: number
  outHeight: number
  /** Largest number of frames the encoder was behind at any point. */
  peakQueue: number
  /**
   * E2 — frames that were only kept because the burst absorber was there: the
   * queue was past its steady bound and under the burst bound when they were
   * submitted. Every one of these is a frame the shipped worker DROPPED, so
   * this is the absorber's own evidence and the number the E2 gate quotes.
   */
  framesBurst: number
  /** The absorber's size for this take, frames. Sized from the geometry and the
   *  machine's memory (burstFramesFor); 0 means it never applied. */
  burstFrames: number
  /**
   * E1's leading signals, accumulated here and differenced per interval by the
   * pressure tick below. peakQueue is a since-start extreme — the same shape of
   * statistic G1 threw out for reading worse the longer a take ran — so the
   * detector reads a MEAN over a window instead, which needs a sum and a count.
   */
  queueSum: number
  queueSamples: number
  /**
   * THE WORKER'S OWN SCHEDULING LATENESS. The main thread cannot answer this
   * during a take: measured on prod 2026-09-01, a hidden tab clamps a 16 ms
   * timer to ~1 Hz, so perf/mainThreadWatch.ts reads 984 ms late while idle.
   * The same ticker inside a worker of the same hidden page ran at 59 Hz with
   * 2-4 ms of lateness — and this is the thread the compositor and the video
   * encoder actually run on, so its starvation is the take's starvation.
   */
  lateTicks: number
  lateSumMs: number
  lateMaxMs: number
  /**
   * Where the bits actually went (task O11a). Owning the encoder makes this
   * free: every packet is already in hand, so the keyframe share and the
   * achieved-vs-requested bitrate are counted rather than guessed.
   */
  videoBytes: number
  audioBytes: number
  keyframeBytes: number
  keyframeCount: number
  requestedVideoBitrate: number
  /**
   * Where the per-frame time goes, accumulated in ms. The composite was
   * encoder-bound at ~10 fps and the three candidates — compositing, turning
   * the canvas into a VideoFrame, and the encode call itself — are not
   * distinguishable from the outside, so they are timed separately here.
   */
  paintMs: number
  frameMs: number
  encodeMs: number
  /** Durability barriers actually taken — one per FLUSH_INTERVAL_MS of writes. */
  flushes: number
  /**
   * THE PATH NOBODY TIMED (2026-08-23). paint/frame/encode accounted for ~1.4 ms
   * per encoded frame while the engine delivered 7.7 fps, and an isolated
   * VideoEncoder on the same machine does 150-188 fps at 1080p — so the missing
   * time is downstream of the encode CALL, in the mux and the disk barrier that
   * run inside the encoder's own output callback.
   */
  muxMs: number
  writeMs: number
  flushMs: number
  writeCalls: number
  /** Arrivals the CADENCE gate rejected (too soon after the last encode). */
  framesGated: number
  /** Arrivals stamped BEFORE the last encode — i.e. the gate was closed against
   *  frames that were already in the worker's message queue. */
  framesStale: number
  /**
   * WHICH SIDE OF THE THREAD BOUNDARY IS SLOW (2026-08-23). Everything inside
   * this worker has now been cleared by probe: a bare encoder does 169 fps
   * here, and the FULL v2 shape — transferred capture frames, the production GL
   * compositor, the same encoder, the same backpressure — does 59.7 fps with
   * zero drops (`npm run exp -- encprobe`, rows worker:transfer and
   * worker:composite). So the question is no longer "what costs so much" but
   * "is this worker even busy". handlerMs is time spent INSIDE onmessage;
   * idleMs is the wall clock between one message finishing and the next
   * arriving. CAREFUL WITH idleMs: it is "not inside onmessage", which also
   * covers the encoder's own output callbacks and every promise continuation,
   * so it is NOT proof the thread is free. outputMs is what separates them —
   * the synchronous cost of the encoder's output callback, which is where the
   * packet copy, the mux hand-off and the disk barrier all live.
   */
  handlerMs: number
  idleMs: number
  /** Longest single starve — one long main-thread task shows up here. */
  maxIdleMs: number
  /** The config the encoder was ACTUALLY configured with, after
   *  isConfigSupported normalised it. Evidence, not decoration: every probe
   *  that reaches 60 fps builds its own config by hand. */
  configJson: string | null
  /** Encoder latency: encode() call → the matching output callback. */
  encodeLatencyMs: number
  outputs: number
  /** Synchronous time spent INSIDE the encoders' output callbacks. */
  outputMs: number
  /** GPU time behind the draw, measured with a barrier rather than by timing
   *  the JS enqueue (which times nothing). Only accumulated when probing. */
  gpuMs: number
  /**
   * WHERE THIS FILE'S CLOCK STARTS, as a MAIN-THREAD performance.now() stamp
   * (every arrival is stamped there, so this is directly comparable with the
   * session epoch). Timestamp 0 in the composite is this instant — usually the
   * first audio batch, because the mix is already running when the first video
   * frame arrives. The main thread turns it into
   * CompositeRecording.startOffsetMs; without it both packet-copying export
   * paths assume 0 and ship the video early (P0-instant-sync).
   */
  originAtMs: number | null
  /** Time spent blitting the composite into the preview canvas (O4-polish).
   *  Zero when nothing asked for a preview. */
  previewMs: number
}

export type CompositorReply =
  | {
      ok: true
      cmd: 'start'
      /** Which painter was actually built. A worker's console is invisible to
       *  the page, so without this NOTHING outside the worker could say whether
       *  a take asked for WebGPU and silently got WebGL2 — and a rig that
       *  cannot tell is a rig measuring the wrong backend (O4, 2026-09-04). */
      backend: 'webgpu' | 'webgl2' | '2d'
    }
  /** Deliberately NOT sent on receipt: the reply waits for the first frame to
   *  actually reach the preview canvas, so the caller can swap away from its
   *  own preview without a blank flash in between. */
  | { ok: true; cmd: 'preview' }
  /** P9 — whether this worker can build a track processor (see CompositorProbeMsg). */
  | { ok: true; cmd: 'probe'; trackProcessor: boolean }
  | { ok: true; cmd: 'source' }
  /**
   * P9 — the `worker-processor` rung's liveness evidence. The page gave its
   * track away, so the worker is now the only thing that can see the source at
   * all; it reports arrivals and the track's own health on a beat far finer
   * than SOURCE_STALL_MS. Without this the detector would read a transferred
   * (detached) track as dead the moment the take started, which is exactly the
   * kind of silent difference between rungs this task exists to forbid.
   */
  | { event: 'source'; kind: 'screen' | 'camera'; frames: number; mediaSec: number; live: boolean }
  | { ok: true; cmd: 'stop'; stats: CompositorStats }
  | { ok: true; cmd: 'cancel' }
  | { ok: false; cmd: string; error: string }
  | { event: 'error'; error: string }
  /** Pushed once a second so the watchdog on the main thread can see the
   * encoder falling behind while there is still time to degrade. */
  | { event: 'stats'; stats: CompositorStats }
  /**
   * E1 — the leading signals for the interval just ended, four times a second.
   * The worker is the only place they exist (the encoder's queue and this
   * thread's own lateness), and the main thread is the only place the actuator
   * is (the track's constraints), so they have to cross.
   */
  | { event: 'pressure'; signals: PressureSignals }

/**
 * Baseline and Main FIRST, High last — the opposite of a quality ranking, and
 * deliberately so. isConfigSupported() says yes to High on this machine and
 * then encodes it in software at ~10 fps for 1080p; platform realtime encoders
 * (VideoToolbox here) commonly expose Baseline/Main only. A profile nobody can
 * encode in hardware is not a better file, it is a dropped-frame file.
 */
/**
 * AVC PROFILE/LEVEL CANDIDATES, IN ASCENDING CAPACITY.
 *
 * A LEVEL IS A FRAME-SIZE LIMIT, and Chrome enforces it: `isConfigSupported`
 * REFUSES a frame the level cannot hold rather than clamping it. The old list
 * stopped at 4.2 (8704 macroblocks, i.e. about 1920x1088), which was invisible
 * for as long as capture was pinned to 1080p — and became a lost channel the
 * morning native-res capture went default, because the raw channel is now
 * configured at the MONITOR's own size. Reproduced on prod:
 * `?synthetic=1&screensize=2560x1441` returns `no supported AVC VideoEncoder
 * config` and the take comes back "Missing from this take: Screen", with the
 * preview having shown the screen throughout. Every display bigger than 1080p
 * was in that hole: 1440p is 14400 macroblocks and 4K is 32400.
 *
 * 5.0 (22080 MB) covers 1440p, 5.1/5.2 (36864 MB) cover 4K, 6.0 covers what
 * comes after. APPENDED, never reordered: the loop returns the first supported
 * config, so every frame that already had one keeps exactly the encoder it had
 * — a 1080p take is untouched, which is the whole safety net.
 */
const CODEC_CANDIDATES = [
  'avc1.42E01E',
  'avc1.4D402A',
  'avc1.640028',
  'avc1.640032',
  'avc1.640033',
  'avc1.640034',
  'avc1.640040',
] as const

async function pickVideoConfig(
  width: number,
  height: number,
  bitrate: number,
  framerate: number,
): Promise<{ config: VideoEncoderConfig; hardware: string }> {
  // AN ODD SIDE IS NOT A SIZE AVC CAN ENCODE — same fix, same reason as
  // rawVideo.worker.ts, where it cost Robert's machine the hardware path on
  // 2026-08-30. The composite derives its own geometry from frameForAspect,
  // which already rounds to even, so this is the belt rather than the braces —
  // but the two workers must not disagree about what an encodable size is.
  width = evenDown(width)
  height = evenDown(height)
  // Hardware first: this is the whole point of owning the encoder. Software is
  // the honest fallback rather than a failure.
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference', 'prefer-software'] as const) {
    for (const codec of CODEC_CANDIDATES) {
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate,
        framerate,
        latencyMode: 'realtime',
        hardwareAcceleration,
        avc: { format: 'avc' },
      }
      let support: VideoEncoderSupport
      try {
        support = await VideoEncoder.isConfigSupported(config)
      } catch {
        continue
      }
      if (support.supported) {
        return { config: { ...config, ...(support.config ?? {}), width, height, codec }, hardware: hardwareAcceleration }
      }
    }
  }
  throw new Error('compositor: no supported AVC VideoEncoder config')
}

async function pickAudioConfig(
  sampleRate: number,
  channels: number,
  bitrate: number,
): Promise<AudioEncoderConfig> {
  const config: AudioEncoderConfig = {
    codec: 'mp4a.40.2',
    sampleRate,
    numberOfChannels: channels,
    bitrate,
  }
  const support = await AudioEncoder.isConfigSupported(config)
  if (!support.supported) throw new Error('compositor: AAC AudioEncoder unsupported')
  return { ...config, ...(support.config ?? {}) }
}

// ---------------------------------------------------------------------------

let handle: SyncAccessHandle | null = null
let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
/** Where the camera PiP has been dragged to, or null for the default corner. */
let camPose: CameraPose | null = null
/** The preview the main thread handed over, if any (O4-polish). */
let previewCtx: OffscreenCanvasRenderingContext2D | null = null
/** True until the first blit lands — the 'preview' reply is held until then. */
let previewAwaitingFirstPaint = false
/**
 * The painter. A WebGPU one also has `end()`, which the GL one does not need —
 * GL's commands are implicit, WebGPU's have to be submitted before the canvas
 * can be read — so the worker calls it optionally and neither backend grows a
 * method it has no use for.
 */
type Painter = (GLCompositor | WGPUCompositor) & { end?: () => void }
/** The chosen painter; null means the 2D fallback is in use. */
let gl: Painter | null = null
/**
 * The WebGPU device, acquired once in `start()`. Held because `adoptShape`
 * (F13) rebuilds the painter SYNCHRONOUSLY when the arrived frames disagree
 * with the guess, and an async device request there would either block a frame
 * or leave the take with no painter at all.
 */
let gpuDevice: Awaited<ReturnType<typeof wgpuDevice>> = null
let painterWanted: 'webgpu' | 'webgl2' | '2d' = 'webgpu'

/**
 * Build the best painter this machine will give, at or below what was asked
 * for. Never throws and never returns a half-built one: a caller that gets null
 * takes the 2D path, which is slow but complete.
 */
function makePainter(w: number, h: number): { painter: Painter | null; backend: 'webgpu' | 'webgl2' | '2d' } {
  if (painterWanted === 'webgpu' && gpuDevice) {
    const p = createWGPUCompositor(gpuDevice, w, h)
    if (p) return { painter: p, backend: 'webgpu' }
    console.warn('[capture] compositor: WebGPU asked for but unavailable — WebGL2')
  }
  if (painterWanted !== '2d') {
    const p = createGLCompositor(w, h)
    if (p) return { painter: p, backend: 'webgl2' }
    console.warn('[capture] compositor: WebGL2 unavailable, falling back to 2D (slow)')
  }
  return { painter: null, backend: '2d' }
}
let output: Output | null = null
let videoSource: EncodedVideoPacketSource | null = null
let audioSource: EncodedAudioPacketSource | null = null
let videoEncoder: VideoEncoder | null = null
let audioEncoder: AudioEncoder | null = null
let muxChain: Promise<void> = Promise.resolve()
let fatal: string | null = null

let W = 1920
let H = 1080
let FPS = 30
/**
 * F13: is the canvas still allowed to take its shape from the first frame?
 * False the moment the shape is fixed — either a frame settled it, the deadline
 * passed, or something already went into the file. A file whose dimensions
 * change part-way is a file every consumer has to special-case forever, which
 * is the same rule the degradation ladder obeys (captureLadder rule 1).
 */
let followSource = false
let longEdge = 1920
let shapeSettled = true
/**
 * F13: the encoder is being reconfigured to the shape the first frame asked
 * for, and NOTHING may be encoded until it is. The reconfigure is async (it
 * probes the config), so a frame encoded meanwhile goes in at the OLD geometry
 * and the file carries two — reproduced on prod with `?camlies=1`, where the
 * raw channel came back undecodable for exactly this reason.
 */
let encoderPending = false
let startedWorkerAtMs = 0
let videoBitrate = 8_000_000
let startedAtMs: number | null = null
let lastEncodedMs = -Infinity
/**
 * When a frame was last ACTUALLY encoded, as opposed to last attempted.
 *
 * These have to be two different numbers, and conflating them is what froze
 * Robert's game takes (2026-08-25: "4k game in other tab freezes, but not all the
 * time and other inputs are fine"). `lastEncodedMs` advances even on a DROP,
 * deliberately — otherwise the next source frame a few ms later passes the
 * cadence gate and hammers a busy encoder at the source rate. But the keep-alive
 * read that same field to decide whether anything had reached the file lately,
 * so while the encoder queue stayed full every arriving frame reset the
 * keep-alive's clock, the keep-alive never fired, and NOTHING was encoded for
 * as long as the pressure lasted. Measured on a saturated take: gaps of
 * 4.0-4.6 s between consecutive frames in the composite, which is a picture
 * frozen for four seconds while the audio and the raw channels ran on fine.
 */
let lastEncodeOkMs = -Infinity
let lastEncodedTsUs = -1
let lastKeySec = -Infinity
let keepAliveTimer: ReturnType<typeof setInterval> | null = null
let statsTimer: ReturnType<typeof setInterval> | null = null
/** E1's pressure tick — see PRESSURE_TICK_MS. */
let pressureTimer: ReturnType<typeof setInterval> | null = null
let pressureStartTimer: ReturnType<typeof setTimeout> | null = null
let stopped = false

/** Newest frame per source; the composite always paints the latest of each. */
const latest: Partial<Record<'screen' | 'camera', VideoFrame>> = {}

/**
 * P9 — THE WORKER-SIDE INTAKE. Everything below this comment runs only on the
 * `worker-processor` rung; on every other rung these stay empty and nothing in
 * this file behaves differently from the day before the seam existed.
 *
 * THE WORKER NEVER BRANCHES ON THE BROWSER. It branches on the MESSAGE it was
 * sent: a `source` message means "read this track yourself", `frame` messages
 * mean "the page is reading them for you". Both end in the same `ingestFrame`,
 * so no stage after the intake can tell which rung it is serving.
 */
let clockDeltaMs = 0
const workerReaders: { cancel: () => void }[] = []
const workerTracks = new Map<'screen' | 'camera', MediaStreamTrack>()
const workerSourceStats = new Map<'screen' | 'camera', { frames: number; mediaSec: number }>()
let beatTimer: ReturnType<typeof setInterval> | null = null
/** Coarse against a frame, fine against SOURCE_STALL_MS (3000 ms). */
const SOURCE_BEAT_MS = 250

function postSourceBeats(): void {
  for (const [kind, track] of workerTracks) {
    const st = workerSourceStats.get(kind)
    post({
      event: 'source',
      kind,
      frames: st?.frames ?? 0,
      mediaSec: st?.mediaSec ?? -1,
      live: track.readyState === 'live' && !track.muted,
    })
  }
}

function attachWorkerTrack(kind: 'screen' | 'camera', track: MediaStreamTrack): void {
  const TP = trackProcessorCtor()
  if (!TP) throw new Error('compositor: no track processor in this worker')
  workerTracks.set(kind, track)
  workerSourceStats.set(kind, { frames: 0, mediaSec: -1 })
  if (beatTimer === null) beatTimer = setInterval(postSourceBeats, SOURCE_BEAT_MS)
  const reader = new TP({ track }).readable.getReader()
  workerReaders.push({ cancel: () => void reader.cancel().catch(() => undefined) })
  void (async () => {
    for (;;) {
      let result: ReadableStreamReadResult<VideoFrame>
      try {
        result = await reader.read()
      } catch {
        break
      }
      const { value, done } = result
      if (done || stopped || fatal) {
        value?.close()
        break
      }
      const st = workerSourceStats.get(kind)
      if (st) {
        st.frames++
        st.mediaSec = value.timestamp / 1e6
      }
      // The MAIN thread's clock, which is the composite's only clock.
      ingestFrame(kind, value, performance.now() + clockDeltaMs)
    }
  })()
}

function releaseWorkerTracks(): void {
  if (beatTimer !== null) {
    clearInterval(beatTimer)
    beatTimer = null
  }
  for (const r of workerReaders) r.cancel()
  workerReaders.length = 0
  // These are CLONES and stopping them is this worker's job. The main thread
  // transferred a clone, never the take's own track: the same MediaStream feeds
  // the raw channel recorder and the preview, and a transferred track is
  // detached from the page that gave it away. The clone dies here; the original
  // dies when the session releases the source, as it always has.
  for (const track of workerTracks.values()) {
    try {
      track.stop()
    } catch {
      /* already gone */
    }
  }
  workerTracks.clear()
}

/**
 * ONE DOOR FOR A FRAME, whichever rung brought it. Lifted verbatim out of the
 * `frame` case so that the two intakes cannot drift apart: a change here is a
 * change for every rung, which is the only way "a silent difference between
 * rungs is a defect" can be more than a wish.
 */
function ingestFrame(kind: 'screen' | 'camera', frame: VideoFrame, atMs: number): void {
  noteOrigin(atMs)
  if (stopped || fatal) {
    frame.close()
    return
  }
  stats.framesIn++
  // F13: the FIRST frame decides the shape, before anything is encoded.
  if (!shapeSettled) adoptShape(frame)
  latest[kind]?.close()
  latest[kind] = frame
  // Frame-driven, capped at the output rate: two sources delivering 60 fps
  // must not encode 120 composites.
  if (atMs - lastEncodedMs >= 1000 / FPS - 1) encodeComposite(atMs, false)
  else {
    stats.framesGated++
    if (atMs < lastEncodedMs) stats.framesStale++
  }
}
let audioFramesTotal = 0
let audioSampleRate = 48000
let audioStartAtMs: number | null = null
/** Leading samples that predate the composite timeline; trimmed, not shifted. */
let audioSkipFrames = 0

/**
 * THE AUDIO TIMELINE IS HELD AGAINST THE WALL CLOCK (Robert 2026-08-25: a take
 * recorded beside a 4K game, "sounds go faster than video" from ~20 s in).
 *
 * This file carries its two tracks on two different clocks — video is stamped
 * with each frame's arrival (wall), audio is sample-counted. That is fine while
 * the audio graph renders in real time, and it is NOT fine when the machine is
 * saturated: measured on a loaded 60 s take, the AudioContext rendered 56.1 s
 * of quanta in 59.2 s of wall time, so the audio track came out ~3 s short and
 * every sample after the loss sat ~3 s EARLY against the picture. Sample
 * counting cannot see this by construction: it counts what arrived, so what
 * never arrived costs nothing and the whole rest of the take slides.
 *
 * The remedy is the one the raw mic worklet already applies one level down
 * (measuredAudio.ts: "starved quanta MUST become silence, not be skipped"),
 * lifted to the batch level: when the timeline has fallen behind the wall by
 * more than a batch or so, PAD it with silence to where it should be. Audio is
 * only ever added, never removed or moved, so a healthy take is untouched and a
 * starved one carries an honest short silence where the machine choked instead
 * of a permanent offset.
 *
 * The decision lives in WallClockHold, shared with measuredAudio.ts. The
 * inline version here padded on INSTANTANEOUS lateness of `recvMs` — a stamp
 * taken at MAIN-THREAD receipt, so every main-thread stall read as lost time
 * even though the queued batches delivered every sample moments later, and the
 * spurious pad spliced silence into healthy audio and walked the rest late.
 * The hold pads only a deficit that persists across its settle window.
 */
let audioHold: WallClockHold | null = null
/** Last sample per channel of the previous batch — the fade-out needs a value. */
let lastAudioSample: Float32Array | null = null
/** ~1.3 ms, the same ramp the PCM worklet uses on its own silence splices. */
const AUDIO_PAD_FADE = 64

const stats: CompositorStats = {
  framesIn: 0,
  framesEncoded: 0,
  framesDropped: 0,
  keepAliveFrames: 0,
  bytes: 0,
  durationMs: 0,
  audioFrames: 0,
  audioDroppedNotReady: 0,
  audioDroppedLead: 0,
  audioPaddedFrames: 0,
  audioTrimmedFrames: 0,
  maxEncodeGapMs: 0,
  codec: null,
  hardware: null,
  backend: null,
  outWidth: 0,
  outHeight: 0,
  peakQueue: 0,
  framesBurst: 0,
  burstFrames: 0,
  queueSum: 0,
  queueSamples: 0,
  lateTicks: 0,
  lateSumMs: 0,
  lateMaxMs: 0,
  videoBytes: 0,
  audioBytes: 0,
  keyframeBytes: 0,
  keyframeCount: 0,
  requestedVideoBitrate: 0,
  paintMs: 0,
  frameMs: 0,
  encodeMs: 0,
  flushes: 0,
  muxMs: 0,
  writeMs: 0,
  flushMs: 0,
  writeCalls: 0,
  framesGated: 0,
  handlerMs: 0,
  idleMs: 0,
  maxIdleMs: 0,
  configJson: null,
  encodeLatencyMs: 0,
  outputs: 0,
  outputMs: 0,
  gpuMs: 0,
  framesStale: 0,
  originAtMs: null,
  previewMs: 0,
}

function post(reply: CompositorReply): void {
  self.postMessage(reply)
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (!fatal) {
    fatal = message
    post({ event: 'error', error: message })
  }
}

function releaseLatest(): void {
  for (const kind of ['screen', 'camera'] as const) {
    latest[kind]?.close()
    delete latest[kind]
  }
}

function roundedRectPath(
  c: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  c.beginPath()
  if (typeof c.roundRect === 'function') {
    c.roundRect(x, y, w, h, r)
    return
  }
  const radius = Math.min(r, w / 2, h / 2)
  c.moveTo(x + radius, y)
  c.arcTo(x + w, y, x + w, y + h, radius)
  c.arcTo(x + w, y + h, x, y + h, radius)
  c.arcTo(x, y + h, x, y, radius)
  c.arcTo(x, y, x + w, y, radius)
  c.closePath()
}

/** The PiP rect, shared by both backends so they cannot drift apart. */
function pipRect(camera: VideoFrame): { x: number; y: number; w: number; h: number; r: number; border: number } {
  // F13: the layout's authored-at-1920 scale, keyed to the LONG edge so a
  // portrait composite draws the same border and radius as a landscape one.
  // Identical to W / 1920 on every landscape frame.
  const scale = Math.max(W, H) / 1920
  const aspect =
    camera.displayWidth && camera.displayHeight ? camera.displayWidth / camera.displayHeight : 4 / 3
  const chrome = { r: 16 * scale, border: 1.5 * scale }
  // UI1: dragged during the take. `poseToRect` is the SAME function the editor
  // positions its PiP with and the same one compose/layout.ts renders from, so
  // a pose set here, previewed here, and re-opened in the editor is one number
  // through three renderers rather than three implementations of a corner.
  if (camPose) {
    const rect = poseToRect(camPose, { frameAspect: W / H, cameraAspect: aspect })
    return {
      x: rect.leftFrac * W,
      y: rect.topFrac * H,
      w: rect.widthFrac * W,
      h: rect.heightFrac * H,
      ...chrome,
    }
  }
  const w = 0.24 * W
  const h = w / aspect
  const margin = 24 * scale
  return { x: W - w - margin, y: H - h - margin, w, h, ...chrome }
}

/**
 * The DEFAULT composition, and it must stay pixel-identical to
 * compose/layout.ts — an unedited export packet-copies this file, so any
 * disagreement between the two is a visible jump on the way to the editor.
 */
function paint(): void {
  const screen = latest.screen
  const camera = latest.camera
  if (gl) {
    gl.begin(!!screen)
    if (screen) {
      const s = Math.min(W / screen.displayWidth, H / screen.displayHeight)
      const dw = screen.displayWidth * s
      const dh = screen.displayHeight * s
      gl.draw(screen, (W - dw) / 2, (H - dh) / 2, dw, dh, 0, 0)
      if (camera) {
        const p = pipRect(camera)
        gl.draw(camera, p.x, p.y, p.w, p.h, p.r, p.border)
      }
    } else if (camera) {
      const s = Math.max(W / camera.displayWidth, H / camera.displayHeight)
      const dw = camera.displayWidth * s
      const dh = camera.displayHeight * s
      gl.draw(camera, (W - dw) / 2, (H - dh) / 2, dw, dh, 0, 0)
    }
    return
  }
  const c = ctx
  if (!c) return
  c.fillStyle = '#0a0a0c'
  c.fillRect(0, 0, W, H)
  if (screen) {
    c.fillStyle = '#000000'
    c.fillRect(0, 0, W, H)
    const s = Math.min(W / screen.displayWidth, H / screen.displayHeight)
    const dw = screen.displayWidth * s
    const dh = screen.displayHeight * s
    c.drawImage(screen, (W - dw) / 2, (H - dh) / 2, dw, dh)
    if (camera) paintPip(c, camera)
  } else if (camera) {
    const s = Math.max(W / camera.displayWidth, H / camera.displayHeight)
    const dw = camera.displayWidth * s
    const dh = camera.displayHeight * s
    c.drawImage(camera, (W - dw) / 2, (H - dh) / 2, dw, dh)
  }
}

function paintPip(c: OffscreenCanvasRenderingContext2D, camera: VideoFrame): void {
  const { x, y, w: pipW, h: pipH, r, border } = pipRect(camera)
  c.save()
  roundedRectPath(c, x, y, pipW, pipH, r)
  c.clip()
  c.drawImage(camera, x, y, pipW, pipH)
  c.restore()
  roundedRectPath(c, x, y, pipW, pipH, r)
  c.strokeStyle = 'rgba(255,255,255,0.25)'
  c.lineWidth = border
  c.stroke()
}

/**
 * Show the frame that was just composited. Same task as the draw — the GL
 * backend does not preserve its drawing buffer (that is the readback it exists
 * to avoid), so this has to happen before the task yields, exactly like the
 * VideoFrame construction above it.
 */
/**
 * THE PREVIEW CANVAS TAKES THE COMPOSITE'S SHAPE.
 *
 * `blitPreview` draws the composite 1:1 into whatever bitmap the main thread
 * handed over, so a preview canvas of a different aspect is a stretched picture
 * — and the stage box on screen already carries the composite's aspect, so the
 * mismatch shows as bars around a distorted frame. UI1 found exactly that on a
 * 1728x1117 screen: the composite was 1726x1116 and the preview bitmap was
 * still the 960x540 the main thread created it at.
 *
 * It USED to be resized in one place only — `adoptShape`, the F13 path that
 * runs when the arrived frames disagree with the initial guess. That path is
 * the exception, not the rule: with the frame following the take, the composite
 * is normally built at the right shape from the start and `adoptShape` never
 * runs. So the sizing belongs wherever the two can first disagree, which is all
 * three of: the composite being created, its shape being adopted, and a preview
 * canvas arriving.
 *
 * Safe to call at any time: the worker owns this bitmap (it was transferred),
 * and writing a size it already has costs nothing.
 */
function sizePreviewToComposite(): void {
  const p = previewCtx
  if (!p || !canvas || !(canvas.width > 0) || !(canvas.height > 0)) return
  const box = frameForAspect(canvas.width / canvas.height, PREVIEW_LONG_EDGE)
  if (p.canvas.width === box.width && p.canvas.height === box.height) return
  p.canvas.width = box.width
  p.canvas.height = box.height
}

function blitPreview(): void {
  const p = previewCtx
  if (!p || !canvas) return
  const t0 = performance.now()
  try {
    p.drawImage(canvas, 0, 0, p.canvas.width, p.canvas.height)
  } catch {
    // A preview that cannot be painted must never cost the take its encoder.
    previewCtx = null
    return
  }
  stats.previewMs += performance.now() - t0
  if (previewAwaitingFirstPaint) {
    previewAwaitingFirstPaint = false
    post({ ok: true, cmd: 'preview' })
  }
}

/**
 * F13 — TAKE THE SHAPE FROM THE PICTURE THAT ARRIVED.
 *
 * Runs at most once, before a single frame has gone into the file, so nothing
 * downstream ever sees dimensions change mid-stream. The muxer is not told a
 * size at all (`addVideoTrack` takes only a frame rate — the geometry reaches
 * the file through the encoder's own SPS), so the whole correction is the
 * canvas plus one `configure()` on an encoder that has not encoded yet.
 *
 * WHY IT EXISTS: `track.getSettings()` reports the SENSOR on a phone held
 * portrait — landscape — while the frames delivered are rotated to portrait.
 * The first pass of F13 believed the settings, so a phone take was composited
 * into a landscape canvas and cover-cropped, and the editor then cropped the
 * raw portrait channel a second time into the same landscape stage. Nothing in
 * this worker had ever looked at what a delivered frame actually is.
 */
function settleShape(): void {
  shapeSettled = true
  // Only now is this the answer: the host reports the composite's geometry off
  // these two fields, and reporting the GUESS would put the wrong aspect on the
  // recording preview for exactly as long as it took the first frame to arrive.
  stats.outWidth = W
  stats.outHeight = H
}

function adoptShape(frame: VideoFrame): void {
  const w = frame.displayWidth
  const h = frame.displayHeight
  const want = adoptedFrame({ width: W, height: H }, { width: w, height: h }, longEdge)
  if (!want) {
    settleShape()
    return
  }
  // Anything already in the file makes this a mid-stream resize, which is the
  // one thing it may never be. Bail loudly rather than quietly.
  if (stats.framesEncoded > 0 || lastEncodeOkMs !== -Infinity) {
    console.warn(
      `[capture] compositor: first frame is ${w}x${h} but ${W}x${H} is already in the file — keeping it`,
    )
    settleShape()
    return
  }
  const from = `${W}x${H}`
  W = want.width
  H = want.height
  if (gl) {
    gl.dispose()
    gl = null
  }
  const rebuilt = makePainter(W, H)
  gl = rebuilt.painter
  stats.backend = rebuilt.backend
  if (gl) {
    canvas = gl.canvas
    ctx = null
  } else {
    canvas = new OffscreenCanvas(W, H)
    ctx = canvas.getContext('2d', { alpha: false })
  }
  // The preview is blitted 1:1 into whatever the main thread handed over, so it
  // has to turn with the composite or the picture is stretched on screen.
  sizePreviewToComposite()
  settleShape()
  console.info(
    `[capture] compositor: the frames are ${w}x${h} — composing ${W}x${H}, not ${from} (F13)`,
  )
  encoderPending = true
  void reconfigureEncoder()
}

async function reconfigureEncoder(): Promise<void> {
  const enc = videoEncoder
  try {
    if (!enc || stopped || fatal) return
    const { config, hardware } = await pickVideoConfig(W, H, videoBitrate, FPS)
    if (stopped || fatal || enc.state === 'closed') return
    enc.configure(config)
    // F13 changes the geometry, so the absorber is re-sized with it: four 1080p
    // frames and four 4K frames are not the same promise about memory.
    sizeBurst(config.width, config.height)
    stats.codec = config.codec
    stats.hardware = hardware
    stats.configJson = JSON.stringify(config)
  } catch (err) {
    fail(err)
  } finally {
    encoderPending = false
  }
}

function encodeComposite(atMs: number, keepAlive: boolean): void {
  const enc = videoEncoder
  if (!enc || stopped || fatal || enc.state !== 'configured' || !canvas) return
  // F13: mid-reconfigure. One frame at the old geometry is a second SPS in the
  // file, and the whole composite stops decoding.
  if (encoderPending) return
  if (startedAtMs === null) {
    startedAtMs = atMs
    stats.originAtMs = atMs
  }
  // Never queue behind a slow encoder: a backlog at stop is exactly the tail
  // the product promises not to lose.
  //
  // lastEncodedMs advances even on a drop, and that matters: without it the
  // next source frame (a few ms later at 60 fps) passes the cadence gate and
  // attempts again, so a busy encoder gets hammered at the SOURCE rate and the
  // drop counter reports a catastrophe that is really just a spin.
  if (enc.encodeQueueSize >= MAX_ENCODER_QUEUE + burstFrames) {
    stats.framesDropped++
    lastEncodedMs = atMs
    return
  }
  // E2's absorber. Past the steady bound the frame is KEPT — the encoder holds
  // it — and the fact is counted, because a frame that only survived because
  // the buffer was there is the evidence that the buffer is load-bearing.
  if (enc.encodeQueueSize >= MAX_ENCODER_QUEUE) stats.framesBurst++
  if (enc.encodeQueueSize > stats.peakQueue) stats.peakQueue = enc.encodeQueueSize
  // E1: sampled at SUBMIT, which is the only moment the depth means
  // "distance to the drop above" — the drop is `>= MAX_ENCODER_QUEUE` on this
  // very line's condition, so this number is literally how close this frame
  // came to being the one that was lost.
  stats.queueSum += enc.encodeQueueSize
  stats.queueSamples++
  const relMs = Math.max(0, atMs - startedAtMs)
  const timestampUs = Math.max(lastEncodedTsUs + 1, Math.round(relMs * 1000))
  lastEncodedTsUs = timestampUs
  lastEncodedMs = atMs
  const tSec = timestampUs / 1e6
  const keyFrame = tSec - lastKeySec >= KEYFRAME_INTERVAL_S
  if (keyFrame) lastKeySec = tSec

  const tPaint = performance.now()
  paint()
  // WebGPU records into a command buffer; nothing is on the canvas until the
  // pass is ended and submitted, and the VideoFrame below reads that canvas.
  // A no-op on WebGL2, whose commands are implicit.
  gl?.end?.()
  if (PROBE_GPU) gl?.finish()
  const tFrame = performance.now()
  if (PROBE_GPU) stats.gpuMs += tFrame - tPaint
  stats.paintMs += tFrame - tPaint
  const frame = new VideoFrame(canvas, {
    timestamp: timestampUs,
    duration: Math.round(1e6 / FPS),
  })
  const tEncode = performance.now()
  stats.frameMs += tEncode - tFrame
  try {
    submittedAt.push(performance.now())
    enc.encode(frame, { keyFrame })
    // Only here, and never on the drop path above: this is what the keep-alive
    // trusts to tell whether the FILE has had a frame lately.
    const gapMs = lastEncodeOkMs === -Infinity ? 0 : atMs - lastEncodeOkMs
    if (gapMs > stats.maxEncodeGapMs) stats.maxEncodeGapMs = gapMs
    lastEncodeOkMs = atMs
    if (keepAlive) stats.keepAliveFrames++
  } catch (err) {
    fail(err)
  } finally {
    frame.close()
    stats.encodeMs += performance.now() - tEncode
  }
  // LAST, and counted on its own: the preview must never inflate paintMs,
  // frameMs or encodeMs — an added cost that quietly lands inside an existing
  // metric is how a rig starts lying (note 10). Still the same task as the
  // draw, which is what the GL backend requires.
  blitPreview()
}

async function start(msg: CompositorStartMsg): Promise<void> {
  W = msg.width
  H = msg.height
  FPS = msg.fps
  // P9: frames this worker reads itself are stamped on the MAIN thread's clock.
  clockDeltaMs = msg.mainTimeOrigin === undefined ? 0 : performance.timeOrigin - msg.mainTimeOrigin
  videoBitrate = msg.videoBitrate
  followSource = msg.followSource === true
  burstEnabled = msg.burst !== false
  longEdge = msg.longEdge && msg.longEdge > 0 ? msg.longEdge : Math.max(W, H)
  startedWorkerAtMs = performance.now()
  shapeSettled = false
  if (!followSource) settleShape()

  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(ROOT_DIR, { create: true })
  const file = await dir.getFileHandle(msg.key, { create: true })
  handle = await (
    file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> }
  ).createSyncAccessHandle()
  handle.truncate?.(0)

  // THE PAINTER (O4). WebGPU binds the capture frame's planes where they are;
  // WebGL2 uploads them into an RGBA texture first; 2D drags them back across
  // the bus every frame (~150 ms per 1080p frame, i.e. 6.7 fps — compositorGL.ts).
  // The device is requested BEFORE the first frame can arrive, so no take is
  // ever painted by a backend that was still being negotiated.
  painterWanted = msg.painter ?? 'webgpu'
  if (painterWanted === 'webgpu') gpuDevice = await wgpuDevice()
  const built = makePainter(W, H)
  gl = built.painter
  stats.backend = built.backend
  // SAID OUT LOUD, because a backend that falls back silently is a rig
  // measuring the wrong thing: an oracle run asked for WebGPU and given WebGL2
  // would pass and prove nothing. Also the black box's answer to "which painter
  // painted this take".
  console.info(
    `[capture] compositor: painter ${built.backend}` +
      (painterWanted !== built.backend ? ` (asked for ${painterWanted})` : ''),
  )
  if (gl) {
    canvas = gl.canvas
  } else {
    canvas = new OffscreenCanvas(W, H)
    ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('compositor: no GPU painter and no OffscreenCanvas 2d')
  }

  // …and the preview, if one was handed over before the composite existed.
  sizePreviewToComposite()

  const { config, hardware } = await pickVideoConfig(W, H, msg.videoBitrate, msg.fps)
  stats.codec = config.codec
  stats.hardware = hardware
  stats.configJson = JSON.stringify(config)

  /**
   * Every chunk is written AND FLUSHED where the muxer says it goes, so a tab
   * kill leaves a file whose fragments are complete up to the last write.
   *
   * Batching the flush on a 250 ms timer was tried, on the theory that a
   * synchronous disk barrier per chunk was throttling the encoder. It was not:
   * batching measured no better (6.5 fps against 10.5 on the per-chunk build,
   * inside this machine's run-to-run spread). So the barrier stays per chunk,
   * where it buys the strongest salvage guarantee this engine can offer.
   */
  const sink = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      const h = handle
      if (!h) return
      const t0 = performance.now()
      const written = h.write(chunk.data, { at: chunk.position })
      const t1 = performance.now()
      h.flush()
      const t2 = performance.now()
      stats.writeMs += t1 - t0
      stats.flushMs += t2 - t1
      stats.writeCalls++
      stats.flushes++
      stats.bytes = Math.max(stats.bytes, chunk.position + written)
    },
  })

  output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
    target: new StreamTarget(sink),
  })
  videoSource = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(videoSource, { frameRate: msg.fps })
  if (msg.sampleRate) {
    audioSampleRate = msg.sampleRate
    audioHold = new WallClockHold({ sampleRate: msg.sampleRate })
    audioSource = new EncodedAudioPacketSource('aac')
    output.addAudioTrack(audioSource)
  }
  await output.start()

  stats.requestedVideoBitrate = msg.videoBitrate
  videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      const tOut = performance.now()
      stats.framesEncoded++
      stats.outputs++
      const submitted = submittedAt.shift()
      if (submitted !== undefined) stats.encodeLatencyMs += tOut - submitted
      stats.videoBytes += chunk.byteLength
      if (chunk.type === 'key') {
        stats.keyframeCount++
        stats.keyframeBytes += chunk.byteLength
      }
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      muxChain = muxChain
        .then(async () => {
          const t0 = performance.now()
          await videoSource?.add(packet, meta)
          stats.muxMs += performance.now() - t0
        })
        .catch(fail)
      stats.outputMs += performance.now() - tOut
    },
    error: fail,
  })
  videoEncoder.configure(config)
  // E2's absorber is sized here and only here: the geometry the encoder was
  // opened with is the geometry every queued frame will have, and it cannot
  // change afterwards (a frame size cannot move mid-file — see captureLadder's
  // rule 1). One computation per take.
  sizeBurst(config.width, config.height)

  if (msg.sampleRate) {
    const audioConfig = await pickAudioConfig(msg.sampleRate, msg.channelCount, msg.audioBitrate)
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        stats.audioBytes += chunk.byteLength
        const packet = EncodedPacket.fromEncodedChunk(chunk)
        muxChain = muxChain
          .then(async () => {
            const t0 = performance.now()
            await audioSource?.add(packet, meta)
            stats.muxMs += performance.now() - t0
          })
          .catch(fail)
      },
      error: fail,
    })
    audioEncoder.configure(audioConfig)
  }

  // Push stats so the main-thread watchdog can see the encoder falling behind
  // while degrading is still possible, rather than discovering it at stop.
  statsTimer = setInterval(() => {
    if (!stopped) post({ event: 'stats', stats: { ...stats } })
  }, 1000)

  // ---- E1: the pressure tick ----------------------------------------------
  // ONE timer does two jobs, and it has to be one: the lateness is measured by
  // how late this very timer is, so a coarse 250 ms timer could not resolve a
  // stall shorter than a quarter second, and a second fast timer would be a
  // second thing to keep alive. It ticks at a 60 fps frame budget and posts
  // every sixteenth tick.
  //
  // AND IT DOES NOT START WITH THE TAKE. Nothing may ACT on a pressure reading
  // before the ladder's own warmup (rule 2, 4 s after first output) — every
  // "2-10 fps" panic in this project's history was an encoder's init being
  // measured — so a ticker running through the encoder's configuration buys
  // nothing and lands 60 wakeups a second on this thread at the one moment in a
  // take that is most sensitive to them. NOT PROVEN TO HAVE COST ANYTHING: what
  // is measured is that the v2 oracle went red twice in nine runs with this
  // ticker starting at t=0, both times with the composite's first frame at
  // 733 and 1167 ms against 200-333 ms on every green run, and 7/7 green on the
  // same machine without it. The delay costs nothing that could be wanted, and
  // it removes the only window in which the instrument could be the subject.
  pressureStartTimer = setTimeout(() => {
  // M1 — the sampler is core/capture/pressureSampler.ts now, shared with
  // rawVideo.worker.ts, because max opens no composite and the emergency floor
  // has to read the same instrument rather than a second one that agrees by
  // coincidence. The formulas are unchanged and pinned by pressureSampler.test.ts.
  sampler = new PressureSampler(performance.now(), countersForPressure())
  pressureTimer = setInterval(() => {
    if (stopped || !sampler) return
    const now = performance.now()
    const { lateMs, due } = sampler.tick(now)
    stats.lateTicks++
    stats.lateSumMs += lateMs
    if (lateMs > stats.lateMaxMs) stats.lateMaxMs = lateMs
    if (!due) return
    post({
      event: 'pressure',
      signals: sampler.read(now, countersForPressure(), FPS, MAX_ENCODER_QUEUE, PROBE_GPU),
    })
  }, LATE_TICK_MS)
  }, PRESSURE_START_DELAY_MS)

  // Keep-alive: a composition nobody is changing still needs a frame per
  // second. Cheap by construction — it repaints the same latest frames.
  keepAliveTimer = setInterval(() => {
    if (stopped || fatal || startedAtMs === null) return
    const nowMain = performance.now() - performanceOriginOffset
    // Against the last frame that actually REACHED the encoder — see
    // lastEncodeOkMs. Reading lastEncodedMs here meant a busy encoder silently
    // suppressed the keep-alive it exists to trigger.
    // F13: never write the first frame of the file before the shape is
    // decided — one keep-alive at the guessed size would freeze the wrong
    // geometry into the take for good. Bounded, so a source that delivers
    // nothing at all still gets its keep-alive.
    if (!shapeSettled) {
      if (performance.now() - startedWorkerAtMs < ADOPT_BUDGET_MS) return
      settleShape()
    }
    if (nowMain - lastEncodeOkMs >= KEEPALIVE_MS) encodeComposite(nowMain, true)
  }, KEEPALIVE_MS / 2)
}

/**
 * The main thread owns the clock, but the keep-alive fires here, so the worker
 * needs to express its own now() on the main thread's timeline. Every frame
 * message carries the main thread's wall reading; the difference against this
 * worker's own performance.now() at that moment is the (constant) offset
 * between the two time origins.
 */
let performanceOriginOffset = 0
let originSamples = 0

function noteOrigin(mainMs: number): void {
  const delta = performance.now() - mainMs
  // Min-filter: message delivery can only make the worker's reading LATE
  // relative to the main thread's stamp, never early.
  if (originSamples === 0 || delta < performanceOriginOffset) performanceOriginOffset = delta
  originSamples++
}

async function stop(): Promise<CompositorStats> {
  stopped = true
  releaseWorkerTracks()
  if (keepAliveTimer) clearInterval(keepAliveTimer)
  if (statsTimer) clearInterval(statsTimer)
  if (pressureStartTimer) clearTimeout(pressureStartTimer)
  if (pressureTimer) clearInterval(pressureTimer)
  keepAliveTimer = null
  statsTimer = null
  pressureTimer = null
  pressureStartTimer = null
  // DRAIN, in order: this is the tail the product promises. flush() returns
  // only once every queued frame has been encoded and handed to the muxer.
  try {
    if (videoEncoder && videoEncoder.state === 'configured') await videoEncoder.flush()
    if (audioEncoder && audioEncoder.state === 'configured') await audioEncoder.flush()
  } catch (err) {
    fail(err)
  }
  await muxChain.catch(() => undefined)
  try {
    videoEncoder?.close()
    audioEncoder?.close()
  } catch {
    /* already closed */
  }
  try {
    await output?.finalize()
  } catch (err) {
    fail(err)
  }
  await muxChain.catch(() => undefined)
  releaseLatest()
  gl?.dispose()
  gl = null
  try {
    handle?.flush()
    handle?.close()
  } catch {
    /* already closed */
  }
  handle = null
  stats.durationMs = lastEncodedTsUs >= 0 ? Math.round(lastEncodedTsUs / 1000) : 0
  return stats
}

async function cancel(): Promise<void> {
  stopped = true
  releaseWorkerTracks()
  if (keepAliveTimer) clearInterval(keepAliveTimer)
  if (statsTimer) clearInterval(statsTimer)
  if (pressureStartTimer) clearTimeout(pressureStartTimer)
  if (pressureTimer) clearInterval(pressureTimer)
  keepAliveTimer = null
  statsTimer = null
  pressureTimer = null
  pressureStartTimer = null
  releaseLatest()
  try {
    videoEncoder?.close()
    audioEncoder?.close()
  } catch {
    /* already closed */
  }
  try {
    handle?.close()
  } catch {
    /* already closed */
  }
  handle = null
}

/** When the previous message handler finished — the other end of an idle gap. */
let lastHandlerEndedAt = 0
/** When each submitted frame entered the encoder, FIFO — paired with outputs. */
const submittedAt: number[] = []

// ---- E1 pressure state ----------------------------------------------------
/** M1 — the ticker's period and the post cadence live with the sampler now, so
 *  the two workers cannot drift apart on the one number that decides how fast a
 *  stall can be seen. */
let sampler: PressureSampler | null = null

/** This worker's counters, in the sampler's vocabulary. `workMs` is the whole
 *  cost of a frame here — paint, transfer and encode — because all three happen
 *  on this thread and a frame the compositor cannot afford is a frame however
 *  the cost splits. */
function countersForPressure(): PressureCounters {
  return {
    framesIn: stats.framesIn,
    framesEncoded: stats.framesEncoded,
    framesDropped: stats.framesDropped,
    framesStale: stats.framesStale,
    gpuMs: stats.gpuMs,
    framesBurst: stats.framesBurst,
    queueSum: stats.queueSum,
    queueSamples: stats.queueSamples,
    encodeLatencyMs: stats.encodeLatencyMs,
    outputs: stats.outputs,
    workMs: stats.paintMs + stats.frameMs + stats.encodeMs,
  }
}

self.onmessage = async (ev: MessageEvent<CompositorMsg>) => {
  const msg = ev.data
  const handlerStart = performance.now()
  if (lastHandlerEndedAt > 0) {
    const idle = handlerStart - lastHandlerEndedAt
    stats.idleMs += idle
    if (idle > stats.maxIdleMs) stats.maxIdleMs = idle
  }
  try {
    switch (msg.cmd) {
      case 'start':
        await start(msg)
        post({ ok: true, cmd: 'start', backend: stats.backend ?? '2d' })
        break
      case 'frame':
        ingestFrame(msg.kind, msg.frame, msg.atMs)
        break
      case 'probe':
        post({ ok: true, cmd: 'probe', trackProcessor: trackProcessorCtor() !== null })
        break
      case 'source':
        attachWorkerTrack(msg.kind, msg.track)
        post({ ok: true, cmd: 'source' })
        break
      case 'audio': {
        noteOrigin(msg.atMs)
        if (stopped || fatal || !audioEncoder || audioEncoder.state !== 'configured') {
          // Count what is being thrown away. Silence here is how a take loses
          // seconds of its audio timeline without a single line of evidence.
          if (!stopped && !fatal) stats.audioDroppedNotReady += msg.frames
          return
        }
        if (audioStartAtMs === null) {
          audioStartAtMs = msg.atMs
          if (startedAtMs === null) {
            startedAtMs = msg.atMs
            stats.originAtMs = msg.atMs
          }
          // The mix is usually already running when the first VIDEO frame
          // arrives, so the audio genuinely begins before the composite's
          // timeline does. That lead cannot be placed on a timeline that starts
          // at the first frame — and emitting it anyway is a negative timestamp,
          // which the muxer rightly refuses. Trim it: the audio that remains
          // still starts exactly at t0, so nothing desyncs.
          const leadMs = startedAtMs - audioStartAtMs
          if (leadMs > 0) audioSkipFrames = Math.round((leadMs / 1000) * audioSampleRate)
        }
        let { planar, frames } = msg
        if (audioSkipFrames > 0) {
          const skip = Math.min(audioSkipFrames, frames)
          audioSkipFrames -= skip
          stats.audioDroppedLead += skip
          if (skip >= frames) break
          const kept = frames - skip
          const trimmed = new Float32Array(msg.channels * kept)
          for (let c = 0; c < msg.channels; c++) {
            trimmed.set(planar.subarray(c * frames + skip, (c + 1) * frames), c * kept)
          }
          planar = trimmed
          frames = kept
        }
        // HOLD THE TIMELINE AGAINST THE WALL before placing this batch. Sample
        // counting is the ruler between batches; it just cannot see time that
        // never arrived, so the wall stamp gets a say about WHERE the ruler is.
        // See the WallClockHold note above for why only a PERSISTENT deficit
        // may pad — recvMs reads late on every main-thread stall.
        if (typeof msg.recvMs === 'number' && audioHold) {
          const correction = audioHold.correctionFramesFor(msg.recvMs, audioFramesTotal, frames)
          if (correction < 0) {
            // The timeline has walked AHEAD of the wall — this source's audio
            // clock is fast, which a listener hears as the sound falling behind
            // the picture across a long take. Walk it back by resampling the
            // batch very slightly shorter (rate-limited to 0.2 %, no splice, so
            // nothing to click) rather than cutting samples out of it.
            const drop = -correction
            planar = compressPlanar(planar, msg.channels, frames, drop)
            frames -= drop
            stats.audioTrimmedFrames += drop
          }
          const padFrames = Math.max(0, correction)
          if (padFrames > 0) {
            // A step from the last sample straight to zero is a click, and this
            // codebase has paid for that lesson once already (the PCM worklet
            // fades every silence splice). Ramp out of the signal and back into
            // it, so the gap is heard as a gap and not as a pop at each end.
            const padData = new Float32Array(msg.channels * padFrames)
            const head = Math.min(AUDIO_PAD_FADE, padFrames)
            for (let c = 0; c < msg.channels; c++) {
              const from = lastAudioSample?.[c] ?? 0
              if (from !== 0) {
                const base = c * padFrames
                for (let i = 0; i < head; i++) padData[base + i] = from * (1 - i / head)
              }
            }
            const pad = new AudioData({
              format: 'f32-planar',
              sampleRate: audioSampleRate,
              numberOfFrames: padFrames,
              numberOfChannels: msg.channels,
              timestamp: Math.round((audioFramesTotal / audioSampleRate) * 1e6),
              data: padData as unknown as BufferSource,
            })
            try {
              audioEncoder.encode(pad)
              audioFramesTotal += padFrames
              stats.audioPaddedFrames += padFrames
              stats.audioFrames = audioFramesTotal
            } finally {
              pad.close()
            }
            // …and fade the resuming signal in, the other half of the splice.
            const tail = Math.min(AUDIO_PAD_FADE, frames)
            for (let c = 0; c < msg.channels; c++) {
              const base = c * frames
              for (let i = 0; i < tail; i++) planar[base + i] *= i / tail
            }
          }
        }
        if (msg.channels > 0 && frames > 0) {
          lastAudioSample ??= new Float32Array(msg.channels)
          for (let c = 0; c < msg.channels && c < lastAudioSample.length; c++) {
            lastAudioSample[c] = planar[c * frames + frames - 1] ?? 0
          }
        }
        // Sample-counted from here: between batches the ruler is exact, and the
        // wall only ever moves it FORWARD, above.
        const timestampUs = Math.max(
          0,
          Math.round((audioFramesTotal / audioSampleRate) * 1e6),
        )
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate: audioSampleRate,
          numberOfFrames: frames,
          numberOfChannels: msg.channels,
          timestamp: timestampUs,
          // The transferred view is always a plain ArrayBuffer here; TS widens
          // it to ArrayBufferLike because a SharedArrayBuffer is conceivable.
          data: planar as unknown as BufferSource,
        })
        try {
          audioEncoder.encode(data)
          audioFramesTotal += frames
          stats.audioFrames = audioFramesTotal
        } finally {
          data.close()
        }
        break
      }
      case 'preview': {
        const c = msg.canvas.getContext('2d', { alpha: false })
        if (!c) {
          post({ ok: false, cmd: 'preview', error: 'no 2d context on the preview canvas' })
          break
        }
        previewCtx = c
        // The composite usually already exists by the time a preview is handed
        // over — take its shape now rather than waiting for a disagreement that
        // will never come.
        sizePreviewToComposite()
        previewAwaitingFirstPaint = true
        // No reply here: blitPreview() sends it once something is actually on
        // screen. If nothing ever paints, the caller's own deadline decides.
        break
      }
      case 'campose':
        // No reply: the answer is the next painted frame.
        camPose = msg.pose
        break
      case 'stop':
        post({ ok: true, cmd: 'stop', stats: await stop() })
        break
      case 'cancel':
        await cancel()
        post({ ok: true, cmd: 'cancel' })
        break
    }
  } catch (err) {
    post({ ok: false, cmd: msg.cmd, error: err instanceof Error ? err.message : String(err) })
  } finally {
    const end = performance.now()
    stats.handlerMs += end - handlerStart
    lastHandlerEndedAt = end
  }
}
