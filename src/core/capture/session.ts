import { newId } from '@core/id'
import { isAppleWebKit } from '@core/capabilities'
import { blobStore, createDurablePositionedWriter, recordingsRepo } from '@core/store'
import type {
  CaptureConfig,
  CaptureEvent,
  CaptureSession,
  CaptureState,
  ChannelKind,
  ChannelRecording,
  CompositeRecording,
  DisplaySurfaceKind,
  MediaKind,
  Recording,
} from '@core/types'
import { CaptureError, MAX_RECORDING_MS } from '@core/types'
import type {
  AcquiredChannel,
  AcquireFailure,
  ArmingProgressHandler,
  ProgressiveAcquire,
} from './acquire'
import { acquireChannelsProgressive, withTimeout } from './acquire'
import {
  canMeasureAudioCapture,
  prewarmMeasuredAudio,
  startMeasuredAudioCapture,
  type MeasuredAudioHandle,
} from './measuredAudio'
import { canLiveComposite, startLiveComposite, type LiveCompositeHandle } from './liveComposite'
import { drainRecorder } from './recorderDrain'
import { canLiveCompositeV2, startLiveCompositeV2 } from './liveCompositeV2'
import { preferredCompositeEngine } from './engine'
import { MixLoudnessAccumulator } from './loudnessAccumulator'
import { clearPendingManifest, writePendingManifest } from './recovery'
import { createSyntheticChannelsProgressive, isSyntheticMode } from './synthetic'

export type { ArmingProgressHandler, ArmingTimelineEntry, ArmingStep } from './acquire'

// WebM (Chromium/Firefox) first; MP4/H.264/AAC for Apple WebKit, whose
// MediaRecorder rejects every WebM type — forcing one there threw NotSupported
// and killed the take (no Safari recording at all). Demux is container-agnostic
// (compose opens blobs with mediabunny ALL_FORMATS), so a mixed-format take composes fine.
//
// O3a MEASURED AND REJECTED (2026-08-23): preferring MP4/H.264 on Chromium
// would move the raw channels from software VP8/VP9 to the hardware H.264
// encoder — but Chrome's MediaRecorder does NOT stream MP4. Halfway through an
// 8 s take only 753 bytes (the init box) had reached disk, against 1.09 MB of
// decodable WebM; the whole file arrives at stop. A tab kill would therefore
// lose the ENTIRE take instead of salvaging it, so the CPU win costs a shipped
// feature. The hardware encode belongs to O4, which muxes fragmented MP4
// through our own positioned writer and keeps the bytes on disk as they land.
// Re-check with `npm run exp -- o3a` if Chrome ever streams MP4.
const MP4_VIDEO_MIMES = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
]
const WEBM_VIDEO_MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
const VIDEO_MIMES = [...WEBM_VIDEO_MIMES, ...MP4_VIDEO_MIMES]
const AUDIO_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
]
const TICK_MS = 250
const TIMESLICE_MS = 1000
/**
 * TAIL DRAIN for the RAW channels (task P0-tail-raw). An EDITED take is
 * rendered from these, so their ending is the ending of every take the instant
 * path cannot serve — and under load they were losing it.
 *
 * MEASURED 2026-08-23, `npm run exp -- p0tailraw`, 4K source with the live
 * composite running alongside (tail = the lane's own length minus its last
 * decodable frame):
 *     shipped: requestData() + stop(), 1000 ms slice     1344 ms missing
 *     the same at a 250 ms timeslice                     1222 ms
 *     end the TRACK, drain, then stop                     622 ms
 *     drop the source to 1 fps, drain, then stop           59 ms   ← shipped
 *
 * The interesting loser is the third one, because it is the composite's own fix
 * ported over literally, and it does not work here: the rig reports
 * selfStoppedOnTrackEnd, i.e. Chrome stops a MediaRecorder whose stream has
 * gone inactive, and it takes the backlog with it. So the source is STARVED
 * rather than ended — the recorder stays alive with almost nothing new to
 * encode, and the same probe drain the composite uses recovers the rest.
 */
const TAIL_THROTTLE_FPS = 1
/** applyConstraints on a wedged device must not hold the take open. */
const THROTTLE_BUDGET_MS = 400
/**
 * Deadlines on the stop path, for the same reason arming has them (note 3): a
 * recorder that never answers must not be able to freeze a finished take.
 */
const STOP_BUDGET_MS = 8000
const COMPOSITE_START_BUDGET_MS = 4000
/**
 * Hard ceilings on arming. ACQUIRE/PROMPT timeouts bound each device; these
 * bound the WAIT ITSELF, so a step that never settles cannot freeze the take.
 * Generous enough to sit above the 120 s permission-prompt budget plus slack —
 * this is a deadlock breaker, not a device budget.
 */
const SETTLE_BUDGET_MS = 130_000
const ARM_BUDGET_MS = 15_000

/** A/B hook for the O3a evidence run (kept so the MP4 rejection stays
 *  re-testable). Production stays on 'auto'. */
type ContainerPreference = 'auto' | 'mp4' | 'webm'
let containerPreference: ContainerPreference = 'auto'

export function setVideoContainerPreference(pref: ContainerPreference): void {
  containerPreference = pref
}

/** First MIME this browser's MediaRecorder accepts, or '' to let it choose its
 * own default (never force an unsupported type — that throws at construction). */
function pickMimeType(media: MediaKind): string {
  const video =
    containerPreference === 'mp4'
      ? MP4_VIDEO_MIMES
      : containerPreference === 'webm'
        ? WEBM_VIDEO_MIMES
        : VIDEO_MIMES
  const candidates = media === 'video' ? video : AUDIO_MIMES
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

/**
 * Raw-channel bitrates. The camera one is conditional (task O11c):
 *
 * with a screen in the take the camera is a PiP at ~24 % of the frame width, so
 * the raw 720p channel is recorded far finer than anything the export will ever
 * show. MEASURED 2026-08-23 (`npm run exp -- o11`, one camera stream recorded
 * into two files at once): 4 → 2.5 Mbps takes 29.3 % off the raw channel on
 * disk, moves the exported file by 0.2 % (the PiP is ~8 % of the frame) and
 * leaves the PiP itself at 52.1 dB PSNR against the 4 Mbps take — the same
 * picture. What it buys is disk and write bandwidth during capture, which is
 * exactly where a long take hurts.
 *
 * A camera-only take is a different thing: the camera fills the frame and is
 * captured at 1080p (O3a), so it keeps the full rate. Keyed to the REQUESTED
 * config, exactly like O3a's capture resolution, so the resolution and the
 * bitrate can never disagree about which take this is.
 */
function recorderOptions(
  kind: ChannelKind,
  media: MediaKind,
  mimeType: string,
  cameraIsPip: boolean,
): MediaRecorderOptions {
  const videoBits =
    kind === 'screen' ? 8_000_000 : kind === 'camera' && cameraIsPip ? 2_500_000 : 4_000_000
  const bits =
    media === 'video' ? { videoBitsPerSecond: videoBits } : { audioBitsPerSecond: 128_000 }
  return mimeType ? { mimeType, ...bits } : bits
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err)
}

/** prewarmMeasuredAudio with a deadline. A context that resolves AFTER the
 * deadline is closed immediately — never leak a running AudioContext. */
function boundedPrewarm(track: MediaStreamTrack, ms: number): Promise<AudioContext> {
  return new Promise((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      reject(new Error(`audio prewarm timed out after ${ms}ms`))
    }, ms)
    prewarmMeasuredAudio(track).then(
      (ctx) => {
        if (timedOut) {
          void ctx.close().catch(() => undefined)
          return
        }
        clearTimeout(timer)
        resolve(ctx)
      },
      (err) => {
        clearTimeout(timer)
        if (!timedOut) reject(err)
      },
    )
  })
}

interface ChannelRuntime {
  id: string
  kind: ChannelKind
  media: MediaKind
  stream: MediaStream
  track: MediaStreamTrack
  /** MediaRecorder path (video, or audio fallback). */
  recorder: MediaRecorder | null
  /** Measured AudioWorklet→WebCodecs path (audio preferred). */
  measured: MeasuredAudioHandle | null
  useMeasured: boolean
  /** Pre-warmed during arm() so start() only connects the graph. */
  audioCtx: AudioContext | null
  measuredStarting: Promise<void> | null
  mimeType: string
  blobKey: string
  writer: WritableStreamDefaultWriter<Uint8Array | Blob> | null
  writeChain: Promise<void>
  writeFailed: boolean
  bytes: number
  /** Bytes the recorder has HANDED OVER, counted synchronously. `bytes` only
   *  moves once the durable write resolves, which is too late to steer the
   *  tail drain by (see recorderDrain.ts). */
  emitted: number
  recorderStarted: boolean
  ended: boolean
  startAbs?: number
  startOffsetMs?: number
  durationMs?: number
  width?: number
  height?: number
  stopped: Promise<void>
  resolveStopped: () => void
}

class Session implements CaptureSession {
  readonly config: CaptureConfig
  readonly previewStreams: Partial<Record<ChannelKind, MediaStream>> = {}
  /** Which surface the screen picker returned — see DisplaySurfaceKind. */
  displaySurface: DisplaySurfaceKind | null = null

  private stateInternal: CaptureState = 'armed'
  private readonly listeners = new Set<(e: CaptureEvent) => void>()
  private readonly channels: ChannelRuntime[] = []
  private pendingErrors: { kind: ChannelKind; message: string }[] = []
  /** Quality warnings raised during arming, emitted once the UI listens. */
  private pendingNotices: { kind: ChannelKind; message: string }[] = []
  private readonly recordingId = newId('rec')
  private epoch = 0
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private manifestTimer: ReturnType<typeof setTimeout> | null = null
  private composite: LiveCompositeHandle | null = null
  /** Filled by stopCompositeEarly, read once the raw channels have drained. */
  private compositeResult: CompositeRecording | null = null
  private compositeStarting: Promise<void> | null = null
  private compositeInvalid = false
  /** compositeInvalid AND torn down — nothing left to keep or stop. */
  private compositeHardInvalid = false
  /** Video sources frozen right now, and every one that froze at any point. */
  private readonly stalledNow = new Set<ChannelKind>()
  private readonly stalledEver = new Set<ChannelKind>()
  /** Certified-mix loudness accumulated live (O2) — created on first PCM. */
  private loudness: MixLoudnessAccumulator | null = null
  private stopPromise: Promise<Recording> | null = null
  private cancelPromise: Promise<void> | null = null
  private cancelled = false
  private disposeSynthetic: (() => void) | null = null
  /**
   * A refresh mid-take used to leave Chrome's microphone indicator lit with no
   * owner (PO-hit 2026-08-23): nothing stopped the tracks on the way out, and
   * a wedged page never reached doStop. Track stopping is synchronous, so it
   * is safe to do in pagehide — the durable writer has already flushed
   * everything it acknowledged, so the take still salvages on reload.
   */
  private unloadHandler: (() => void) | null = null
  private readonly onArming: ArmingProgressHandler | undefined
  /** Screen wake lock while recording: display sleep mid-take ends capture
   * tracks in Chrome ("after a while screen and audio stop"). Best-effort —
   * the platform auto-releases it when the tab hides; we reacquire on return. */
  private wakeLock: { release(): Promise<void> } | null = null
  private wakeLockVisHandler: (() => void) | null = null

  constructor(config: CaptureConfig, onArming?: ArmingProgressHandler) {
    this.config = { ...config }
    this.onArming = onArming
  }

  get state(): CaptureState {
    return this.stateInternal
  }

  /**
   * PROGRESSIVE arming (instant is law): returns the moment the primary
   * channel is armed. Remaining devices keep acquiring in the background and
   * late-join the running take via lateJoin(); a device failing after start
   * emits 'channel-error' immediately instead of queueing.
   */
  async arm(): Promise<void> {
    const armT0 = performance.now()
    // Long takes write GBs to OPFS; ask the browser never to evict us mid-take
    // (silent eviction truncates the recording). Best-effort, never blocks arming.
    try {
      void navigator.storage?.persist?.().catch(() => undefined)
    } catch {
      /* unsupported */
    }
    const failures: AcquireFailure[] = []
    const armPromises: Promise<void>[] = []

    const handleAcquired = (acq: AcquiredChannel): void => {
      if (this.cancelled || this.stateInternal === 'stopping' || this.stateInternal === 'stopped') {
        for (const t of acq.stream.getTracks()) t.stop()
        return
      }
      armPromises.push(
        (async () => {
          try {
            const rt = await this.armChannel(acq)
            if (this.cancelled || this.stateInternal === 'stopping' || this.stateInternal === 'stopped') {
              this.discardRuntime(rt)
            } else if (this.stateInternal === 'recording') {
              this.lateJoin(rt)
            }
          } catch (err) {
            for (const t of acq.stream.getTracks()) t.stop()
            const f = { kind: acq.kind, message: errMessage(err), denied: false } satisfies AcquireFailure
            if (this.stateInternal === 'recording') {
              this.emit({ type: 'channel-error', kind: f.kind, message: f.message })
            } else {
              failures.push(f)
            }
          }
        })(),
      )
    }
    const handleFailure = (f: AcquireFailure): void => {
      if (this.stateInternal === 'recording') {
        this.emit({ type: 'channel-error', kind: f.kind, message: f.message })
      } else {
        failures.push(f)
      }
    }
    const handleNotice = (kind: ChannelKind, message: string): void => {
      if (this.stateInternal === 'recording') {
        this.emit({ type: 'channel-notice', kind, message })
      } else {
        this.pendingNotices.push({ kind, message })
      }
    }

    let src: ProgressiveAcquire
    if (isSyntheticMode()) {
      const rig = createSyntheticChannelsProgressive(this.config, {
        onChannel: handleAcquired,
        onFailure: handleFailure,
      })
      this.disposeSynthetic = rig.dispose
      src = rig
    } else {
      src = acquireChannelsProgressive(this.config, {
        onChannel: handleAcquired,
        onFailure: handleFailure,
        onNotice: handleNotice,
        onProgress: this.onArming,
      })
    }

    // PO 2026-07-20: every input starts together. Wait for ALL devices — every
    // permission prompt answered, every stream delivered — before arming, so
    // start() activates them at a single epoch. No primary-gated early start,
    // no late-join: all channels share one start and one length.
    //
    // BUT: waiting for all devices means ANY device can hold the take hostage.
    // Each individual step is bounded, yet a step that never settles at all —
    // wedged audio hardware, a worker that never answers, an acquisition that
    // neither resolves nor rejects — used to leave arm() awaiting forever, and
    // the UI frozen on "Waiting for microphone…" with no way out (PO-hit
    // 2026-08-23). Nothing may await without a deadline here. On expiry the
    // take starts with whatever IS ready; the rest is reported as missing.
    try {
      await withTimeout(src.settled, SETTLE_BUDGET_MS, 'device acquisition')
    } catch (err) {
      // No synthetic failure entry needed: requested-but-absent channels are
      // already reported through Recording.missing at stop.
      console.warn('[capture] acquisition did not settle in budget — arming with what is ready', err)
    }
    try {
      await withTimeout(Promise.all([...armPromises]), ARM_BUDGET_MS, 'channel arm')
    } catch (err) {
      console.warn('[capture] channel arming exceeded budget — starting without the slow ones', err)
    }

    console.info(
      `[capture:arming] armed +${(performance.now() - armT0).toFixed(0)}ms ` +
        `(${this.channels.length} channel(s), all start together)`,
    )

    if (this.channels.length === 0) {
      this.disposeSynthetic?.()
      this.disposeSynthetic = null
      const allDenied = failures.length > 0 && failures.every((f) => f.denied)
      const detail = failures.map((f) => `${f.kind}: ${f.message}`).join('; ') || 'no channels requested'
      throw new CaptureError(
        'none',
        allDenied ? 'denied' : 'no-channels',
        `No capture channels available. ${detail}`,
      )
    }

    this.pendingErrors = failures.map((f) => ({ kind: f.kind, message: f.message }))
    // Devices are live from here on — guarantee they are released even if the
    // page goes away without reaching stop()/cancel().
    this.installUnloadGuard()
  }

  /** A channel armed after stop/cancel raced the take end: release everything it holds. */
  private discardRuntime(rt: ChannelRuntime): void {
    for (const t of rt.stream.getTracks()) t.stop()
    if (rt.audioCtx && rt.audioCtx.state !== 'closed') void rt.audioCtx.close().catch(() => undefined)
    if (rt.writer) {
      void rt.writer.abort().catch(() => undefined)
      void blobStore.remove(rt.blobKey).catch(() => undefined)
    }
    rt.ended = true
    rt.resolveStopped()
  }

  private async armChannel(acq: AcquiredChannel): Promise<ChannelRuntime> {
    const id = newId('ch')
    const blobKey = `${this.recordingId}_${id}.webm`
    // Apple WebKit: the WebCodecs measured-audio path (AudioWorklet→opus)
    // captures only ~1s on Safari then goes silent, truncating the take. Record
    // audio with MediaRecorder (mp4/aac) there — the very path that already
    // captures Safari VIDEO full-length. Chromium keeps the measured path (sync).
    const useMeasured = acq.media === 'audio' && canMeasureAudioCapture() && !isAppleWebKit()

    let resolveStopped!: () => void
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve
    })

    const rt: ChannelRuntime = {
      id,
      kind: acq.kind,
      media: acq.media,
      stream: acq.stream,
      track: acq.track,
      recorder: null,
      measured: null,
      useMeasured,
      audioCtx: null,
      measuredStarting: null,
      mimeType: useMeasured ? 'audio/webm;codecs=opus' : pickMimeType(acq.media),
      blobKey,
      writer: null,
      writeChain: Promise.resolve(),
      writeFailed: false,
      bytes: 0,
      emitted: 0,
      recorderStarted: false,
      ended: false,
      stopped,
      resolveStopped,
    }

    if (useMeasured) {
      try {
        // BOUNDED: AudioContext.resume() on wedged audio hardware can pend
        // forever, and arm() awaits this — an unbounded wait here froze the
        // whole start on "waiting for mic" (PO 2026-07-23). On timeout the
        // channel still records: startMeasured brings its own context.
        rt.audioCtx = await boundedPrewarm(acq.track, 3000)
      } catch (err) {
        console.warn('[capture] measured audio prewarm failed, will init at start', err)
      }
    } else {
      const writable = await blobStore.createWriteStream(blobKey)
      const writer = writable.getWriter()
      rt.writer = writer
      let recorder: MediaRecorder
      try {
        recorder = new MediaRecorder(
          acq.stream,
          recorderOptions(acq.kind, acq.media, rt.mimeType, this.config.screen),
        )
      } catch (err) {
        void writer.abort().catch(() => undefined)
        void blobStore.remove(blobKey).catch(() => undefined)
        throw err
      }
      rt.recorder = recorder
      rt.mimeType = recorder.mimeType || rt.mimeType

      recorder.onstart = () => {
        // Duration anchor only — startOffset was set at start() from startCall
        // for video (file epoch ≈ startCall). Do not overwrite startOffsetMs.
        if (rt.startAbs === undefined) rt.startAbs = performance.now()
        if (rt.media === 'video') {
          const s = rt.track.getSettings()
          if (s.width) rt.width = s.width
          if (s.height) rt.height = s.height
        }
      }

      recorder.ondataavailable = (ev: BlobEvent) => {
        const data = ev.data
        if (!data || data.size === 0) return
        rt.emitted += data.size
        rt.writeChain = rt.writeChain.then(async () => {
          if (rt.writeFailed || !rt.writer) return
          try {
            await rt.writer.write(data)
            rt.bytes += data.size
          } catch (err) {
            rt.writeFailed = true
            console.error('[capture] blob write failed for', rt.kind, err)
            // Storage died mid-take: every later chunk would be lost while the
            // UI keeps counting — the take would silently "stop after a while".
            // End this channel loudly; what's on disk stays salvageable.
            this.emit({
              type: 'channel-error',
              kind: rt.kind,
              message: `Recording storage failed — ${rt.kind} saved up to this point only`,
            })
            this.onTrackEnded(rt)
          }
        })
      }

      recorder.onstop = () => {
        if (rt.startAbs !== undefined && rt.durationMs === undefined) {
          rt.durationMs = performance.now() - rt.startAbs
        }
        rt.resolveStopped()
      }

      recorder.addEventListener('error', (ev) => {
        const message = (ev as unknown as { error?: DOMException }).error?.message ?? 'recorder error'
        console.error('[capture] recorder error on', rt.kind, message)
        this.emit({ type: 'channel-error', kind: rt.kind, message })
      })
    }

    if (rt.media === 'video') {
      const s = rt.track.getSettings()
      if (s.width) rt.width = s.width
      if (s.height) rt.height = s.height
    }

    acq.track.addEventListener('ended', () => this.onTrackEnded(rt))

    this.channels.push(rt)
    this.previewStreams[acq.kind] = acq.stream
    if (acq.kind === 'screen' && acq.surface) this.displaySurface = acq.surface
    return rt
  }

  private activateChannel(ch: ChannelRuntime, startT0: number): void {
    if (ch.ended) return
    if (ch.useMeasured) {
      ch.measuredStarting = this.startMeasured(ch, startT0)
      return
    }
    if (!ch.recorder) return
    try {
      const tCall = performance.now()
      // Video file epoch ≈ startCall (MEASURED) — not onstart. Using onstart
      // made video startOffset ~76ms late vs audio and showed up as +150ms
      // flash+click (audio late). Holds for late joins too: offset = call − epoch.
      ch.startAbs = tCall
      ch.startOffsetMs = tCall - this.epoch
      ch.recorder.start(TIMESLICE_MS)
      ch.recorderStarted = true
      console.info(
        `[capture:arming] recorder.start ${ch.kind} call +${(tCall - startT0).toFixed(0)}ms`,
      )
    } catch (err) {
      ch.ended = true
      if (this.stateInternal === 'recording') {
        this.emit({ type: 'channel-error', kind: ch.kind, message: errMessage(err) })
      } else {
        this.pendingErrors.push({ kind: ch.kind, message: errMessage(err) })
      }
    }
  }

  /** A device delivered after the take began: record it from now, flagged loudly. */
  private lateJoin(ch: ChannelRuntime): void {
    const t0 = performance.now()
    this.activateChannel(ch, t0)
    // The composite was mixed without this channel — an unedited instant export
    // would silently lack it. Correctness beats instant: fall back to render.
    this.invalidateComposite(`late join: ${ch.kind}`)
    this.writeManifest()
    this.emit({ type: 'channel-late-join', kind: ch.kind })
    console.info(`[capture:arming] late join ${ch.kind} +${(t0 - this.epoch).toFixed(0)}ms into take`)
  }

  private invalidateComposite(reason: string): void {
    this.compositeHardInvalid = true
    this.compositeInvalid = true
    console.info(`[capture] composite invalidated (${reason}) — unedited export will render`)
    const c = this.composite
    this.composite = null
    if (c) void c.cancel().catch(() => undefined)
  }

  /**
   * Same verdict as invalidateComposite — an unedited export must render
   * instead of copying the composite — but the composite keeps RUNNING so its
   * worklet tick keeps watching the sources. That tick is the only hidden-tab-
   * proof clock we have; killing it here would blind us to the source coming
   * back. doStop/doCancel cancel it.
   */
  private markCompositeUnusable(reason: string): void {
    if (this.compositeInvalid) return
    this.compositeInvalid = true
    console.info(`[capture] composite unusable (${reason}) — unedited export will render`)
  }

  /** A video source froze (or came back). The take continues — audio and the
   * other channels are unaffected — but the frozen stretch is a still image, so
   * the composite can't be copied and the user has to be told. */
  private onSourceLiveness(kind: ChannelKind, event: 'stalled' | 'resumed'): void {
    if (this.stateInternal !== 'recording') return
    if (event === 'stalled') {
      if (this.stalledNow.has(kind)) return
      this.stalledNow.add(kind)
      this.stalledEver.add(kind)
      this.markCompositeUnusable(`${kind} source stalled`)
      this.emit({ type: 'channel-stalled', kind })
    } else {
      if (!this.stalledNow.delete(kind)) return
      this.emit({ type: 'channel-resumed', kind })
    }
  }

  start(): void {
    if (this.stateInternal !== 'armed') return
    this.epoch = performance.now()
    const startT0 = performance.now()

    for (const ch of this.channels) this.activateChannel(ch, startT0)
    console.info(
      `[capture:arming] all start calls kicked +${(performance.now() - startT0).toFixed(0)}ms`,
    )
    this.setState('recording')
    const queued = this.pendingErrors
    this.pendingErrors = []
    for (const e of queued) this.emit({ type: 'channel-error', kind: e.kind, message: e.message })
    const notices = this.pendingNotices
    this.pendingNotices = []
    for (const n of notices) this.emit({ type: 'channel-notice', kind: n.kind, message: n.message })
    this.tickTimer = setInterval(() => this.onTick(), TICK_MS)
    this.startComposite()
    this.acquireWakeLock()
    this.writeManifest()
    // Offsets settle within the first seconds; refresh so a salvage keeps sync.
    this.manifestTimer = setTimeout(() => this.writeManifest(), 2500)
  }

  private acquireWakeLock(): void {
    type WakeLockNav = Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> }
    }
    const wl = (navigator as WakeLockNav).wakeLock
    if (!wl) return
    void wl
      .request('screen')
      .then((sentinel) => {
        if (this.stateInternal !== 'recording') {
          void sentinel.release().catch(() => undefined)
          return
        }
        this.wakeLock = sentinel
      })
      .catch(() => undefined)
    if (!this.wakeLockVisHandler && typeof document !== 'undefined') {
      // The lock auto-releases whenever the tab is hidden (recording another
      // app IS the normal case) — retake it the moment the user comes back.
      this.wakeLockVisHandler = () => {
        if (document.visibilityState === 'visible' && this.stateInternal === 'recording') {
          this.acquireWakeLock()
        }
      }
      document.addEventListener('visibilitychange', this.wakeLockVisHandler)
    }
  }

  private releaseWakeLock(): void {
    if (this.wakeLockVisHandler) {
      document.removeEventListener('visibilitychange', this.wakeLockVisHandler)
      this.wakeLockVisHandler = null
    }
    const s = this.wakeLock
    this.wakeLock = null
    if (s) void s.release().catch(() => undefined)
  }

  private startComposite(): void {
    const screen = this.previewStreams.screen
    const camera = this.previewStreams.camera
    const audio = [this.previewStreams.mic, this.previewStreams['system-audio']].filter(
      (x): x is MediaStream => !!x,
    )
    const inputs = { screen, camera, audio }
    const key = `${this.recordingId}_composite.webm`
    const onSourceLiveness = (kind: 'screen' | 'camera', event: 'stalled' | 'resumed'): void =>
      this.onSourceLiveness(kind, event)

    // v1 is the capability fallback and stays the whole story on Apple WebKit
    // and anywhere without MediaStreamTrackProcessor (O4 step 2).
    const startV1 = (): Promise<LiveCompositeHandle> | null =>
      canLiveComposite(inputs) ? startLiveComposite(inputs, key, { onSourceLiveness }) : null

    const wantV2 = preferredCompositeEngine() === 'v2' && canLiveCompositeV2(inputs)
    let start: Promise<LiveCompositeHandle> | null
    if (wantV2) {
      console.info('[capture] live composite engine v2 (worker + WebCodecs)')
      start = startLiveCompositeV2(inputs, key, {
        onSourceLiveness,
        // A machine that cannot keep pace stops being copied, exactly as v1's
        // watchdog did: the take is unharmed, the unedited export renders.
        onDegrade: (reason) => this.markCompositeUnusable(`compositor v2: ${reason}`),
      }).catch((err: unknown) => {
        // Could not even start (no AAC encoder, OPFS refused, worker blocked):
        // this is precisely what the fallback is for.
        console.warn('[capture] composite v2 unavailable, falling back to v1', err)
        const v1 = startV1()
        if (!v1) throw err instanceof Error ? err : new Error(String(err))
        return v1
      })
    } else {
      start = startV1()
    }
    if (!start) return
    this.compositeStarting = start
      .then((h) => {
        // Keep the handle even when the composite is already unusable: it owns
        // the source-liveness tick, and doStop/doCancel release it. A HARD
        // invalidation (late join) already tore it down — don't resurrect it.
        if (this.stateInternal === 'recording' && !this.compositeHardInvalid) this.composite = h
        else void h.cancel()
      })
      .catch((err) => {
        console.warn('[capture] live composite unavailable', err)
      })
  }

  private writeManifest(): void {
    writePendingManifest({
      v: 1,
      recordingId: this.recordingId,
      createdAt: Date.now(),
      channels: this.channels
        .filter((c) => !c.ended)
        .map((c) => ({
          id: c.id,
          kind: c.kind,
          media: c.media,
          mimeType: c.mimeType,
          blobKey: c.blobKey,
          startOffsetMs: c.startOffsetMs,
          width: c.width,
          height: c.height,
        })),
    })
  }

  private async startMeasured(ch: ChannelRuntime, startT0: number): Promise<void> {
    try {
      const writer = await createDurablePositionedWriter(ch.blobKey)
      const handle = await startMeasuredAudioCapture({
        stream: ch.stream,
        epoch: this.epoch,
        writer,
        audioCtx: ch.audioCtx ?? undefined,
        onFatal: (err) => {
          if (this.stateInternal !== 'recording') return
          this.emit({
            type: 'channel-error',
            kind: ch.kind,
            message: `${ch.kind} recording failed mid-take (${err.message}) — audio saved up to this point only`,
          })
        },
        onPcm: (left, right, startFrame, startOffsetMs, sampleRate) => {
          // The accumulator is created by whichever channel delivers first;
          // every measured channel shares it, so the statistic is taken on the
          // SUM the way the export mixes it (see loudnessAccumulator.ts).
          if (!this.loudness) {
            this.loudness = new MixLoudnessAccumulator({ sampleRate })
            // Register every measured channel up front: the fold must wait for
            // all of them from frame 0, or a slower channel's opening audio
            // would be summed after its window had already been folded.
            for (const c of this.channels) if (c.useMeasured) this.loudness.register(c.id)
          }
          const offsetFrames = Math.round((startOffsetMs * sampleRate) / 1000)
          this.loudness.add(ch.id, left, right, startFrame + offsetFrames)
        },
      })
      ch.audioCtx = null // ownership transferred; stop/cancel closes it
      ch.measured = handle
      ch.mimeType = handle.mimeType
      ch.recorderStarted = true
      const offset = await handle.firstOffset
      ch.startOffsetMs = offset
      ch.startAbs = this.epoch + offset
      console.info(
        `[capture:arming] measured audio ${ch.kind} first-sample +${(performance.now() - startT0).toFixed(0)}ms offset=${offset.toFixed(1)}ms`,
      )
    } catch (err) {
      ch.ended = true
      console.error('[capture] measured audio failed for', ch.kind, err)
      this.emit({ type: 'channel-error', kind: ch.kind, message: errMessage(err) })
      ch.resolveStopped()
    }
  }

  stop(): Promise<Recording> {
    if (this.cancelled) return Promise.reject(new Error('capture session was cancelled'))
    if (!this.stopPromise) this.stopPromise = this.doStop()
    return this.stopPromise
  }

  cancel(): Promise<void> {
    if (!this.cancelPromise) this.cancelPromise = this.doCancel()
    return this.cancelPromise
  }

  setAudioEnabled(kind: ChannelKind, enabled: boolean): void {
    if (kind !== 'mic' && kind !== 'system-audio') return
    const ch = this.channels.find((c) => c.kind === kind)
    if (ch) ch.track.enabled = enabled
  }

  on(cb: (e: CaptureEvent) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private emit(e: CaptureEvent): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(e)
      } catch (err) {
        console.error('[capture] event listener threw', err)
      }
    }
  }

  private setState(s: CaptureState): void {
    if (this.stateInternal === s) return
    this.stateInternal = s
    this.emit({ type: 'state', state: s })
  }

  private clearTick(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  private onTick(): void {
    if (this.stateInternal !== 'recording') return
    const elapsedMs = performance.now() - this.epoch
    const remainingMs = Math.max(0, MAX_RECORDING_MS - elapsedMs)
    this.emit({ type: 'tick', elapsedMs, remainingMs })
    if (remainingMs <= 0) this.autoStop()
  }

  private autoStop(): void {
    if (this.stopPromise || this.cancelled) return
    this.emit({ type: 'auto-stopped' })
    this.stop().catch((err) => console.error('[capture] auto-stop failed', err))
  }

  private onTrackEnded(rt: ChannelRuntime): void {
    if (rt.ended) return
    rt.ended = true
    // A dead VIDEO track keeps its <video> element at readyState 2 forever, so
    // the live composite goes on repainting its last frame — and an unedited
    // export would copy that still image for the whole remaining take while the
    // channel's own file correctly stopped. Render from the channels instead.
    if (rt.media === 'video' && this.stateInternal === 'recording') {
      this.markCompositeUnusable(`${rt.kind} track ended`)
      this.stalledEver.add(rt.kind)
    }
    if (rt.useMeasured && rt.measured) {
      void rt.measured
        .stop()
        .then((r) => {
          rt.bytes = r.bytes
          rt.durationMs = r.durationMs
          rt.startOffsetMs = r.startOffsetMs
        })
        .catch((err) => console.error('[capture] measured stop failed', rt.kind, err))
        // resolveStopped must run even on failure or doStop() hangs forever.
        .finally(() => rt.resolveStopped())
    } else if (rt.recorder) {
      if (rt.startAbs !== undefined && rt.durationMs === undefined) {
        rt.durationMs = performance.now() - rt.startAbs
      }
      if (rt.recorder.state !== 'inactive') {
        try {
          rt.recorder.requestData()
        } catch {
          /* recorder already inactive */
        }
        try {
          rt.recorder.stop()
        } catch {
          rt.resolveStopped()
        }
      }
    } else {
      rt.resolveStopped()
    }
    if (this.stateInternal === 'armed' || this.stateInternal === 'recording') {
      this.emit({ type: 'channel-ended', kind: rt.kind })
    }
    if (this.stateInternal === 'recording' && this.channels.every((c) => c.ended)) {
      this.autoStop()
    }
  }

  private stopRecorders(flush: boolean): void {
    for (const ch of this.channels) {
      if (ch.useMeasured) {
        if (this.cancelled) continue
        void (async () => {
          try {
            if (ch.measuredStarting) await ch.measuredStarting
            if (ch.measured) {
              const r = await ch.measured.stop()
              ch.bytes = r.bytes
              ch.durationMs = r.durationMs
              ch.startOffsetMs = r.startOffsetMs
            }
          } catch (err) {
            console.error('[capture] measured stop failed', ch.kind, err)
          } finally {
            ch.resolveStopped()
          }
        })()
        continue
      }
      if (ch.recorder && ch.recorder.state !== 'inactive') {
        if (flush) {
          try {
            ch.recorder.requestData()
          } catch {
            /* already inactive */
          }
        }
        try {
          ch.recorder.stop()
        } catch {
          ch.resolveStopped()
        }
      } else if (!ch.recorderStarted) {
        ch.resolveStopped()
      }
    }
  }

  private installUnloadGuard(): void {
    if (this.unloadHandler || typeof window === 'undefined') return
    this.unloadHandler = () => {
      try {
        this.releaseMedia()
      } catch {
        /* teardown is best-effort on the way out */
      }
    }
    window.addEventListener('pagehide', this.unloadHandler)
  }

  private removeUnloadGuard(): void {
    if (!this.unloadHandler || typeof window === 'undefined') return
    window.removeEventListener('pagehide', this.unloadHandler)
    this.unloadHandler = null
  }

  private releaseMedia(): void {
    this.removeUnloadGuard()
    for (const ch of this.channels) {
      for (const t of ch.stream.getTracks()) t.stop()
    }
    if (this.disposeSynthetic) {
      this.disposeSynthetic()
      this.disposeSynthetic = null
    }
  }

  private async closeWriter(ch: ChannelRuntime): Promise<void> {
    if (ch.useMeasured) return // measured path closes its own file writable
    await ch.writeChain
    if (!ch.writer) return
    try {
      await ch.writer.close()
    } catch (err) {
      if (!ch.writeFailed) console.error('[capture] writer close failed for', ch.kind, err)
    }
  }

  /**
   * Starve a raw video channel's source and let its encoder catch up before
   * anything asks it to stop (task P0-tail-raw — the table is at TAIL_THROTTLE_FPS).
   * A channel whose source refuses the constraint simply keeps the old path.
   */
  private async drainRawVideo(): Promise<void> {
    const lanes = this.channels.filter(
      (c) =>
        c.media === 'video' &&
        !c.ended &&
        c.recorderStarted &&
        c.recorder !== null &&
        c.recorder.state === 'recording',
    )
    if (lanes.length === 0) return
    await Promise.all(
      lanes.map(async (ch) => {
        const recorder = ch.recorder
        if (!recorder) return
        // Pin the channel's LENGTH here, at the last live frame — not at
        // whenever the recorder finally answers. The drain must lengthen the
        // file, never the timeline: a duration inflated by the wait would slide
        // every other channel against this one.
        if (ch.startAbs !== undefined && ch.durationMs === undefined) {
          ch.durationMs = performance.now() - ch.startAbs
        }
        const settings = ch.track.getSettings()
        let throttled = false
        for (const t of ch.stream.getVideoTracks()) {
          try {
            // Keep the frame SIZE exactly as it is — only the rate drops.
            // Re-constraining the resolution mid-file would change it mid-file.
            await withTimeout(
              t.applyConstraints({
                ...(settings.width ? { width: { max: settings.width } } : {}),
                ...(settings.height ? { height: { max: settings.height } } : {}),
                frameRate: { max: TAIL_THROTTLE_FPS },
              }),
              THROTTLE_BUDGET_MS,
              `${ch.kind} tail throttle`,
            )
            throttled = true
          } catch (err) {
            console.warn('[capture] could not throttle', ch.kind, 'for the tail drain', err)
          }
        }
        if (!throttled) return
        const stats = await drainRecorder(recorder, () => ch.emitted)
        const level = stats.timedOut ? console.warn : console.info
        level(
          `[capture] ${ch.kind} drained in ${stats.drainMs}ms (+${stats.drainedBytes} B)` +
            `${stats.timedOut ? ' — TIMED OUT, the end of this channel is missing' : ''}`,
        )
      }),
    )
  }

  /**
   * The composite's own stop, started EARLY. Its teardown kills painting before
   * it does anything else, so kicking it off first means the frames it encodes
   * while the raw channels drain are not a second and a half of a source that
   * has been throttled to 1 fps. Both encoders then drain at once — which is
   * also how `npm run exp -- p0tailraw` measured them.
   */
  private stopCompositeEarly(): Promise<void> {
    return (async () => {
      try {
        if (this.compositeStarting) {
          await withTimeout(this.compositeStarting, COMPOSITE_START_BUDGET_MS, 'composite start')
        }
        if (this.compositeInvalid) {
          // Unusable but still running (it was holding the liveness tick):
          // release the encoder, audio context and orphan blob.
          await this.composite?.cancel()
          this.composite = null
          return
        }
        const composite = await this.composite?.stop()
        if (composite) this.compositeResult = composite
      } catch (err) {
        console.warn('[capture] live composite stop failed', err)
      }
    })()
  }

  private async doStop(): Promise<Recording> {
    this.clearTick()
    this.releaseWakeLock()
    this.setState('stopping')
    const compositeStopped = this.stopCompositeEarly()
    await this.drainRawVideo()
    this.stopRecorders(true)
    // Bounded, for the same reason arming's joins are (note 3): a recorder that
    // never fires onstop must not be able to hold a finished take open. What is
    // already on disk is kept — a channel that never answered simply reports
    // the length it had when its source stopped.
    try {
      await withTimeout(
        Promise.all(this.channels.map((c) => c.stopped)),
        STOP_BUDGET_MS,
        'recorder stop',
      )
    } catch (err) {
      console.warn('[capture] a recorder did not stop in budget — keeping what reached disk', err)
    }
    await Promise.all(this.channels.map((c) => this.closeWriter(c)))
    this.releaseMedia()

    const kept = this.channels.filter((c) => c.bytes > 0)
    for (const c of this.channels) {
      if (c.bytes === 0) void blobStore.remove(c.blobKey).catch(() => undefined)
    }

    const channels: ChannelRecording[] = kept.map((c) => {
      const rec: ChannelRecording = {
        id: c.id,
        kind: c.kind,
        media: c.media,
        mimeType: c.mimeType,
        blobKey: c.blobKey,
        // Allow negative pre-normalize (measured first-sample may precede epoch
        // by a few ms); min-offset shift below makes the earliest channel t=0.
        startOffsetMs: Math.round(c.startOffsetMs ?? 0),
        durationMs: Math.max(0, Math.round(c.durationMs ?? 0)),
      }
      if (c.media === 'video') {
        if (c.width) rec.width = c.width
        if (c.height) rec.height = c.height
      }
      return rec
    })

    // Shift timeline so t=0 is the first media anywhere; relative alignment preserved.
    const minOffset = channels.reduce((m, c) => Math.min(m, c.startOffsetMs), Infinity)
    if (Number.isFinite(minOffset) && minOffset !== 0) {
      for (const c of channels) c.startOffsetMs -= minOffset
    }

    const recording: Recording = {
      id: this.recordingId,
      createdAt: Date.now(),
      durationMs: channels.reduce((m, c) => Math.max(m, c.startOffsetMs + c.durationMs), 0),
      channels,
    }

    // Requested channels that never delivered media — the UI must say so
    // loudly; a silently mic-less take is how trust dies.
    const requested: ChannelKind[] = []
    if (this.config.screen) requested.push('screen')
    if (this.config.camera) requested.push('camera')
    if (this.config.mic) requested.push('mic')
    if (this.config.systemAudio) requested.push('system-audio')
    const keptKinds = new Set(channels.map((c) => c.kind))
    const missing = requested.filter((k) => !keptKinds.has(k))
    if (missing.length) recording.missing = missing

    if (this.stalledEver.size) recording.stalled = [...this.stalledEver]

    // Capture-time loudness (O2): only valid when the stats cover EXACTLY the
    // audio channels the export will mix — otherwise the sum is a different
    // signal and export must fall back to its probe pass.
    const acc = this.loudness?.finish()
    if (acc && acc.frames > 0) {
      const keptAudio = channels.filter((c) => c.media === 'audio').map((c) => c.id)
      const same =
        keptAudio.length === acc.channelIds.length && keptAudio.every((id) => acc.channelIds.includes(id))
      if (same) {
        recording.loudness = {
          channelIds: acc.channelIds,
          peak: acc.peak,
          loudRms: acc.loudRms,
          floorRms: acc.floorRms,
          frames: acc.frames,
        }
        console.info(
          `[capture] mix loudness measured live: peak ${acc.peak.toFixed(3)} p90rms ${acc.loudRms.toFixed(4)} ` +
            `p20rms ${acc.floorRms.toFixed(4)} over ${acc.frames} frames${acc.degraded ? ' (degraded alignment)' : ''}`,
        )
      } else {
        console.info(
          `[capture] mix loudness discarded: measured [${acc.channelIds.join(',')}] but take kept [${keptAudio.join(',')}]`,
        )
      }
    }

    await compositeStopped
    if (this.compositeResult) recording.composite = this.compositeResult

    await recordingsRepo.save(recording)
    if (this.manifestTimer) clearTimeout(this.manifestTimer)
    clearPendingManifest(this.recordingId)
    this.setState('stopped')
    return recording
  }

  private async doCancel(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise.catch(() => undefined)
      return
    }
    this.cancelled = true
    this.clearTick()
    this.releaseWakeLock()
    if (this.manifestTimer) clearTimeout(this.manifestTimer)
    clearPendingManifest(this.recordingId)
    void (async () => {
      if (this.compositeStarting) await this.compositeStarting
      await this.composite?.cancel()
    })().catch(() => undefined)
    this.setState('stopping')
    for (const ch of this.channels) {
      if (ch.useMeasured) {
        void (async () => {
          try {
            if (ch.measuredStarting) await ch.measuredStarting
            if (ch.measured) await ch.measured.cancel()
          } catch {
            /* discarding */
          } finally {
            ch.resolveStopped()
          }
        })()
      }
    }
    this.stopRecorders(false)
    await Promise.all(this.channels.map((c) => c.stopped))
    this.releaseMedia()
    await Promise.all(
      this.channels.map(async (ch) => {
        if (ch.writer) {
          await ch.writeChain
          try {
            await ch.writer.close()
          } catch {
            /* discarding anyway */
          }
        }
        await blobStore.remove(ch.blobKey).catch(() => undefined)
      }),
    )
    this.setState('stopped')
  }
}

export interface CreateCaptureSessionOptions {
  /** Fired for each permission / device step during arming (UI pending state). */
  onArming?: ArmingProgressHandler
  /**
   * Abort arming. Until this existed the user had no way out of a slow or
   * wedged device: the record button is disabled while arming, so a step that
   * never returned read as "the app is frozen" (PO-hit 2026-08-23). Aborting
   * releases every device the attempt had already taken.
   */
  signal?: AbortSignal
}

export async function createCaptureSession(
  config: CaptureConfig,
  opts?: CreateCaptureSessionOptions,
): Promise<CaptureSession> {
  const session = new Session(config, opts?.onArming)
  const signal = opts?.signal
  if (!signal) {
    await session.arm()
    return session
  }
  if (signal.aborted) throw new DOMException('Recording start cancelled', 'AbortError')
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('Recording start cancelled', 'AbortError')),
      { once: true },
    )
  })
  try {
    await Promise.race([session.arm(), aborted])
  } catch (err) {
    // Whether arm() failed or the user cancelled, nothing may keep a device.
    await session.cancel().catch(() => undefined)
    throw err
  }
  if (signal.aborted) {
    await session.cancel().catch(() => undefined)
    throw new DOMException('Recording start cancelled', 'AbortError')
  }
  return session
}
