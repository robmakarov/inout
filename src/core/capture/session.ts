import { newId } from '@core/id'
import { isAppleWebKit } from '@core/capabilities'
import { aspectOf, frameForAspect, sourceFrameEnabled, sourceResEnabled } from '@core/frame'
import { DEFAULT_FRAME_RATE, normalizeRate, sourceRateEnabled } from '@core/rate'
import { loadQualityStep } from '@core/qualityStep'
import { singleGenCaptureEnabled } from '@core/singleGen'
import { preemptiveRefusalAllowed, rateLadderAllowed } from './captureQuality'
import { diskVerdict } from './diskGuard'
import {
  differsMeaningfully,
  resolutionStepEnabled,
  stepVerdict,
  type SegmentGeometry,
} from './resolutionStep'
import {
  budgetVerdict,
  describePlan,
  dropCompositeVerdict,
  encoderBudgetEnabled,
  encoderCeiling,
  planOf,
  recordEncoderCollapse,
  recordEncoderSustained,
  type EncoderPlan,
  type PlannedEncoder,
} from './encoderBudget'
import { blobStore, createDurablePositionedWriter, recordingsRepo } from '@core/store'
import type {
  CaptureConfig,
  CaptureEvent,
  CaptureSession,
  CaptureState,
  ChannelAnchor,
  ChannelDiagnostics,
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
import type { DisplayStall } from './displayWedge'
import { acquireChannelsProgressive, primaryKindFor, withTimeout } from './acquire'
import { releaseAllDevices } from './deviceGuard'
import {
  canMeasureAudioCapture,
  prewarmMeasuredAudio,
  startMeasuredAudioCapture,
  type MeasuredAudioHandle,
} from './measuredAudio'
import { canLiveComposite, startLiveComposite, type LiveCompositeHandle } from './liveComposite'
import { drainRecorder } from './recorderDrain'
import {
  MEASURED_VIDEO_MIME,
  canMeasureVideoCapture,
  startMeasuredVideoCapture,
  type MeasuredVideoHandle,
} from './measuredVideo'
import { canLiveCompositeV2, startLiveCompositeV2 } from './liveCompositeV2'
import type { LadderRung } from './captureLadder'
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
 * O15: how long a take must run before it is allowed to say this machine
 * SUSTAINED its plan. 10 s clears note 6's encoder warm-up (a fresh process's
 * first VideoEncoder pays a multi-second init, and every "2-10 fps" panic in
 * this project's history was that init being measured) with room to spare, so
 * the mark is raised on throughput and never on a warm-up that had not
 * finished failing yet.
 */
const SUSTAINED_TAKE_MIN_MS = 10_000
/** B5 — how often the disk is asked how much room is left. */
const DISK_CHECK_MS = 5_000
/**
 * Deadlines on the stop path, for the same reason arming has them (note 3): a
 * recorder that never answers must not be able to freeze a finished take.
 */
const STOP_BUDGET_MS = 5000
const COMPOSITE_START_BUDGET_MS = 4000
/** The composite drains for up to 2 s and then waits on its own recorder's
 *  onstop — which, if that recorder never answers, used to be forever. */
const COMPOSITE_STOP_BUDGET_MS = 5000
/**
 * Hard ceilings on arming. ACQUIRE/PROMPT timeouts bound each device; these
 * bound the WAIT ITSELF, so a step that never settles cannot freeze the take.
 * Generous enough to sit above the 120 s permission-prompt budget plus slack —
 * this is a deadlock breaker, not a device budget.
 */
const SETTLE_BUDGET_MS = 130_000
const ARM_BUDGET_MS = 15_000
/**
 * Ceilings on TEARDOWN. Same principle as the arming budgets and the same bug
 * when they are missing: a step with no deadline in front of a device release
 * turns one wedged recorder or one slow disk into a camera light that never
 * goes out. Both sit after the devices are already off, so they only bound how
 * long the UI waits — 5 s for recorders that were told to stop, 10 s for the
 * OPFS write chain, which may still have real bytes in flight.
 */
const CANCEL_STOP_BUDGET_MS = 5_000
const WRITER_CLOSE_BUDGET_MS = 10_000

/** A/B hook for the O3a evidence run (kept so the MP4 rejection stays
 *  re-testable). Production stays on 'auto'. */
type ContainerPreference = 'auto' | 'mp4' | 'webm'
let containerPreference: ContainerPreference = 'auto'

export function setVideoContainerPreference(pref: ContainerPreference): void {
  containerPreference = pref
}

/**
 * The file extension for a recorded container. It exists so the STORED NAME and
 * the BYTES agree — `File.type` is derived from the name, and a media element
 * given the wrong one refuses the file outright on Safari.
 *
 * An empty mime means MediaRecorder was left to choose its own default, and the
 * only browsers that reach that are ones whose default is WebM (Safari always
 * matches an MP4 candidate first).
 */
export function containerExt(mime: string): 'mp4' | 'webm' {
  return mime.includes('mp4') ? 'mp4' : 'webm'
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
/**
 * The live compositor's canvas when the frame does NOT follow the source — the
 * fixed default output geometry this product shipped with. O3b's capture guard
 * compares the raw track against whatever the composite is actually going to
 * be: only at exactly that size is the compositor's contain-fit the identity.
 */
const COMPOSITE_WIDTH = 1920
const COMPOSITE_HEIGHT = 1080

function videoBitsFor(kind: ChannelKind, cameraIsPip: boolean): number {
  return kind === 'screen' ? 8_000_000 : kind === 'camera' && cameraIsPip ? 2_500_000 : 4_000_000
}

function recorderOptions(
  kind: ChannelKind,
  media: MediaKind,
  mimeType: string,
  cameraIsPip: boolean,
): MediaRecorderOptions {
  // X6 reads the SAME function for its VideoEncoder bitrate, so a raw channel
  // costs the same whichever encoder writes it and O11c's number cannot drift
  // between the two paths.
  const bits =
    media === 'video'
      ? { videoBitsPerSecond: videoBitsFor(kind, cameraIsPip) }
      : { audioBitsPerSecond: 128_000 }
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
  /**
   * The WebCodecs path for this channel — AudioWorklet→opus for audio (always
   * preferred on Chromium), MediaStreamTrackProcessor→AVC for video (X6, opt-in
   * via ?rawcodec=webcodecs). Both handles expose the same stop/cancel contract
   * on purpose, so the stop path branches on `useMeasured` and never on media.
   */
  measured: MeasuredAudioHandle | MeasuredVideoHandle | null
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
  /** The rate this channel's file is being written at (F15). Absent = 30. */
  fps?: number
  /** Capture-time witnesses from the measured path — persisted with the take. */
  diagnostics?: import('@core/types').ChannelDiagnostics
  stopped: Promise<void>
  resolveStopped: () => void
}

/**
 * B7 — CARRY THE ALIGNMENT INPUTS ONTO THE CHANNEL, WITHOUT MOVING ANYTHING.
 *
 * The measured audio path already returns them inside its diagnostics; the
 * measured video path returns them beside its stats. Both land in the same
 * place so a take's certification reads one shape, and neither is allowed to
 * touch `startOffsetMs` — this task ships instrumentation, not compensation.
 *
 * `rawAnchorMs` is recorded HERE, before buildRecording shifts every channel so
 * the earliest one is t=0. After that shift the offsets are relative to the
 * take and the device's own lateness is no longer recoverable from them.
 */
function mergeAnchor(
  ch: { diagnostics?: ChannelDiagnostics; startOffsetMs?: number },
  r: { anchor?: { rawAnchorMs?: number; firstFrameDelayMs?: number } } | Record<string, unknown>,
): void {
  const fromResult = (r as { anchor?: { rawAnchorMs?: number; firstFrameDelayMs?: number } }).anchor
  const existing = ch.diagnostics?.anchor
  const merged: ChannelAnchor = {
    // The audio lane reports its own raw anchor (pre-latency-subtraction) in
    // diagnostics; the video lane reports it here. Whichever exists wins over
    // the fallback, which is simply the offset as it stands right now.
    rawAnchorMs:
      existing?.rawAnchorMs ??
      fromResult?.rawAnchorMs ??
      (typeof ch.startOffsetMs === 'number' ? Math.round(ch.startOffsetMs * 10) / 10 : undefined),
    ...(existing?.reportedInputLatencyMs !== undefined
      ? { reportedInputLatencyMs: existing.reportedInputLatencyMs }
      : {}),
    ...(fromResult?.firstFrameDelayMs !== undefined
      ? { firstFrameDelayMs: fromResult.firstFrameDelayMs }
      : {}),
  }
  ch.diagnostics = { ...(ch.diagnostics ?? {}), anchor: merged }
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
  /** Kinds with a re-acquire in flight — a second press must not open a second
   * picker, and the UI reads this state through 'channel-late-join'/'error'. */
  private readonly resuming = new Set<ChannelKind>()
  /** EVERY stream handed to this session, recorded on arrival rather than on
   * successful arm. The only structure release can trust — see releaseMedia. */
  private readonly acquiredStreams = new Set<MediaStream>()
  private composite: LiveCompositeHandle | null = null
  /** O3b: this take deliberately has no composite. Evidence, and a guard. */
  private singleGeneration = false
  /** Filled by stopCompositeEarly, read once the raw channels have drained. */
  private compositeResult: CompositeRecording | null = null
  private compositeStarting: Promise<void> | null = null
  private compositeInvalid = false
  /** True while the recording preview is being painted BY the compositor. */
  private compositePreviewLive = false
  /** F13: the shape the composite is ACTUALLY being written at, once its engine
   *  has seen a frame and said so. The UI's preview stage follows this rather
   *  than the track settings, which lie about orientation on a phone. */
  private compositeGeometry: { width: number; height: number } | null = null
  /**
   * O15: what this take intends to open, decided at ARM TIME and before any
   * encoder exists. Held so the take's OUTCOME can be filed against the load
   * that produced it — a collapse is only worth remembering beside its size.
   */
  private encoderPlan: EncoderPlan | null = null
  /** O15: this take already told the budget it collapsed; say it once. */
  /**
   * O15 + Robert's ruling of 2026-08-30, "non max video must stop fucking app
   * record": this take's plan was over the budget this machine EARNED from its
   * own collapses, and the composite was dropped to bring it under. Set once,
   * before any encoder opens, and read by singleGenerationTake.
   */
  private budgetDroppedComposite = false
  private collapseRecorded = false
  /** O16 — when the screen's delivered size first stopped matching the size its
   *  current segment's encoder was opened at. Null while they agree. */
  private sizeDifferingSinceMs: number | null = null
  /** B5 — the disk is asked every few seconds, not every tick. */
  private lastDiskCheckMs = 0
  private diskWarned = false
  private lastResStepAtMs: number | null = null
  private resStepsTaken = 0
  /** O16 — a step is async and the tick is not; never start a second one. */
  private resStepping = false
  /** The rate this take was started at — what the ladder may climb back to. */
  private requestedRate = DEFAULT_FRAME_RATE
  /** One notice per take, on the first reduction only (see stepDisplayDown). */
  private rateNoticeSent = false
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
  /**
   * Kinds the USER turned off mid-take (setChannelActive false). The
   * persistent-connect hunt consults this through stillWanted: a mic the user
   * switched off must never be re-grabbed by a retry loop that was started
   * back when they wanted it (Robert rule: the user's choice always wins).
   */
  private readonly suspended = new Set<ChannelKind>()
  /**
   * F6 — tracks held live across a pause, so resume() opens segment N+1 on the
   * SAME device instead of acquiring one. Cleared on resume and on stop.
   */
  /** performance.now() at the pause, so resume() can discount the gap. */
  private pausedAtMs: number | null = null
  private readonly pausedTracks = new Map<
    ChannelKind,
    { stream: MediaStream; track: MediaStreamTrack; media: MediaKind }
  >()
  private disposeSynthetic: (() => void) | null = null
  /**
   * A refresh mid-take used to leave Chrome's microphone indicator lit with no
   * owner (Robert-hit 2026-08-23): nothing stopped the tracks on the way out, and
   * a wedged page never reached doStop. Track stopping is synchronous, so it
   * is safe to do in pagehide — the durable writer has already flushed
   * everything it acknowledged, so the take still salvages on reload.
   */
  private unloadHandler: (() => void) | null = null
  private readonly onArming: ArmingProgressHandler | undefined
  /** W1: the screen request is late and the user should hear why NOW, not in
   *  the post-take banner. Passed straight through to acquire. */
  private readonly onStall: DisplayStallHandler | undefined
  /** Screen wake lock while recording: display sleep mid-take ends capture
   * tracks in Chrome ("after a while screen and audio stop"). Best-effort —
   * the platform auto-releases it when the tab hides; we reacquire on return. */
  private wakeLock: { release(): Promise<void> } | null = null
  private wakeLockVisHandler: (() => void) | null = null

  constructor(
    config: CaptureConfig,
    onArming?: ArmingProgressHandler,
    onStall?: DisplayStallHandler,
  ) {
    this.config = { ...config }
    this.onArming = onArming
    this.onStall = onStall
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
      // Register BEFORE the cancelled check and before any await: from here on
      // release can find this device no matter where arming gets interrupted.
      this.acquiredStreams.add(acq.stream)
      if (this.cancelled || this.stateInternal === 'stopping' || this.stateInternal === 'stopped') {
        for (const t of acq.stream.getTracks()) t.stop()
        this.acquiredStreams.delete(acq.stream)
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
        onProgress: this.onArming,
      })
      this.disposeSynthetic = rig.dispose
      src = rig
    } else {
      src = acquireChannelsProgressive(this.config, {
        onChannel: handleAcquired,
        onFailure: handleFailure,
        onNotice: handleNotice,
        onStall: this.onStall,
        onProgress: this.onArming,
        // The persistent-connect hunt asks before every re-ask and at every
        // late delivery. True only while: the take is alive, the channel is
        // still missing, no manual resume is racing us, and the user has not
        // turned the kind off. handleAcquired stays the second line of
        // defence — it stops any stream landing in a dead session.
        stillWanted: (kind) =>
          !this.cancelled &&
          this.stateInternal !== 'stopping' &&
          this.stateInternal !== 'stopped' &&
          !this.suspended.has(kind) &&
          !this.resuming.has(kind) &&
          !this.channels.some((c) => c.kind === kind && !c.ended),
      })
    }

    // Robert 2026-07-20: every input starts together. Wait for ALL devices — every
    // permission prompt answered, every stream delivered — before arming, so
    // start() activates them at a single epoch. No primary-gated early start,
    // no late-join: all channels share one start and one length.
    //
    // BUT: waiting for all devices means ANY device can hold the take hostage.
    // Each individual step is bounded, yet a step that never settles at all —
    // wedged audio hardware, a worker that never answers, an acquisition that
    // neither resolves nor rejects — used to leave arm() awaiting forever, and
    // the UI frozen on "Waiting for microphone…" with no way out (Robert-hit
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

    // THE SCREEN NEVER CAME AND IT WAS NOT THE USER'S DOING. A timed-out
    // primary is not a degraded take, it is a failed one: the user asked to
    // record their screen, the browser took the share and never handed it
    // over, and carrying on would give them a camera-and-mic clip they did not
    // ask for — after a wait — while the camera light stayed on throughout
    // (Robert 2026-08-24: "armed +120007ms (2 channel(s))" on a screen recording).
    // Denial is left alone: that is a decision, and a user who cancels the
    // picker with camera and mic on may well still want those.
    const primaryKind = primaryKindFor(this.config)
    const wedged = failures.find((f) => f.kind === primaryKind && f.timedOut)
    if (wedged) {
      this.disposeSynthetic?.()
      this.disposeSynthetic = null
      this.releaseMedia()
      throw new CaptureError(
        wedged.kind,
        // W1: a stall that is really an ungranted macOS screen-recording
        // permission gets its OWN reason, so the UI does not spend the user's
        // one automatic refresh on it. Refreshing cannot change a TCC grant;
        // all it does is throw away the message that names the fix.
        wedged.stall === 'permission' ? 'permission' : 'wedged',
        wedged.kind === 'screen'
          ? // The UI runs the recovery ritual on the 'wedged' reason: one
            // automatic page refresh (Robert 2026-08-25: "if it happens make it
            // fixed by refresh of app page"), then this text for a wedge that
            // survived the refresh — at that point only restarting Chrome tears
            // the stuck process down (the claim lives in its browser process;
            // the page never received a track it could release). The text is
            // acquire's now (displayStallMessage), because it is the only place
            // that knows WHICH of the two failures this was and which browser
            // the user is actually sitting in.
            wedged.message
          : `${wedged.kind} never responded. Nothing was recorded — press record to try again.`,
      )
    }

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
    // O15 — the last moment anything can decide how much this take will ask of
    // the machine. start() is synchronous and opens every encoder inside it.
    await this.applyEncoderBudget()
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
    // Apple WebKit: the WebCodecs measured-audio path (AudioWorklet→opus)
    // captures only ~1s on Safari then goes silent, truncating the take. Record
    // audio with MediaRecorder (mp4/aac) there — the very path that already
    // captures Safari VIDEO full-length. Chromium keeps the measured path (sync).
    // X6: raw VIDEO channels can take the same seam — MediaStreamTrackProcessor
    // → hardware AVC → fragmented MP4 on the worker's own SyncAccessHandle,
    // instead of MediaRecorder's SOFTWARE VP8/VP9. OFF by default; the
    // capability check includes the preference (rawCodec.ts).
    const useMeasured =
      acq.media === 'audio'
        ? canMeasureAudioCapture() && !isAppleWebKit()
        : canMeasureVideoCapture()

    // THE EXTENSION FOLLOWS THE CONTAINER THE CHANNEL WILL ACTUALLY HOLD, and
    // "everything else is webm" was wrong on the one platform that matters most
    // for it: MediaRecorder on Safari has NO WebM encoder and produces MP4, so
    // every iPhone channel was an MP4 stored under a `.webm` name. `File.type`
    // comes from that name, so the blob handed to a media element claimed
    // `video/webm` and Safari — which trusts the type instead of sniffing —
    // played nothing: a silent mic and a blank camera beside a waveform drawn
    // correctly from the same bytes (Robert, 2026-08-29). Takes already recorded
    // are repaired by re-typing on read (core/store/mediaUrl.ts); this stops
    // new ones being mislabelled in the first place.
    const measuredVideo = acq.media === 'video' && useMeasured
    const recordedMime = measuredVideo
      ? MEASURED_VIDEO_MIME
      : useMeasured
        ? 'audio/webm;codecs=opus'
        : pickMimeType(acq.media)
    const blobKey = `${this.recordingId}_${id}.${containerExt(recordedMime)}`

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
      mimeType: recordedMime,
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

    if (measuredVideo) {
      // Nothing to pre-warm here: the encoder warm-up that matters is the
      // per-launch VideoEncoder init, and prearm.ts already pays it at mount
      // (note 6). The worker and its OPFS handle are opened at start().
    } else if (useMeasured) {
      try {
        // BOUNDED: AudioContext.resume() on wedged audio hardware can pend
        // forever, and arm() awaits this — an unbounded wait here froze the
        // whole start on "waiting for mic" (Robert 2026-07-23). On timeout the
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
        // B7: this lane has NO frame stamp — MediaRecorder never says when its
        // first frame arrived — so the closest thing it can offer is the
        // start()→onstart gap, and it is flagged so nobody reads it as one.
        // The measured (WebCodecs) lane, which is the default since X6, does
        // report a real first-frame delay.
        if (rt.startAbs !== undefined) {
          const gap = Math.round((performance.now() - rt.startAbs) * 10) / 10
          rt.diagnostics = {
            ...(rt.diagnostics ?? {}),
            anchor: {
              ...(rt.diagnostics?.anchor ?? {}),
              firstFrameDelayMs: gap,
              firstFrameDelayIsStartGap: true,
            },
          }
        }
        if (rt.startAbs === undefined) rt.startAbs = performance.now()
        if (rt.media === 'video') {
          const s = rt.track.getSettings()
          if (s.width) rt.width = s.width
          if (s.height) rt.height = s.height
          if (s.frameRate) rt.fps = Math.round(s.frameRate)
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
      // F15: what the source is actually delivering. Below the ceiling this is
      // 30 on every take the product has ever made, because that is what
      // displayVideoConstraints asked for as a `max`.
      if (s.frameRate) rt.fps = Math.round(s.frameRate)
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
      ch.measuredStarting =
        ch.media === 'video' ? this.startMeasuredVideo(ch, startT0) : this.startMeasured(ch, startT0)
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

  /**
   * The compositor has stopped painting, so a preview fed from it would freeze
   * on its last frame (O4-polish). Say so once, and the UI goes back to its own
   * source preview. NOT called for markCompositeUnusable: that verdict is about
   * COPYING the file — the compositor keeps running and keeps painting, and a
   * frozen SOURCE is honestly what the user should be seeing anyway.
   */
  private notePreviewLost(): void {
    if (!this.compositePreviewLive) return
    this.compositePreviewLive = false
    this.emit({ type: 'composite-preview', live: false })
  }

  private invalidateComposite(reason: string): void {
    this.compositeHardInvalid = true
    this.compositeInvalid = true
    this.notePreviewLost()
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
  /**
   * O6 — take the display track down one rung. The composite saw the
   * backpressure; the session owns the track, so the constraint is applied
   * here. Bounded, and a refusal is not fatal: a source that will not narrow
   * simply keeps the resolution it had, and the watchdog remains the backstop
   * that refuses the composite outright.
   */
  private async stepDisplayDown(
    rung: LadderRung,
    reason: string,
  ): Promise<void> {
    const ch = this.channels.find((c) => c.kind === 'screen' && !c.ended)
    if (!ch) return
    try {
      const before = ch.track.getSettings()
      // A RUNG IS A RATE AND NOTHING ELSE (captureLadder.ts). The size is never
      // touched, in either direction: the raw channel's encoder is configured
      // once at start and cannot follow a frame-size change, so the resolution
      // steps this used to apply were making Chrome UPSCALE every frame back to
      // the configured size for it — measured in Robert's own console,
      // `screen channel recorded 3024x1964 (the track said 2217x1440)`. And
      // his rule is the same rule: "if something needs to be dropped it must be
      // fps not resolution", "no screen proportion changes".
      await withTimeout(
        ch.track.applyConstraints({ frameRate: { max: rung.fps } }),
        THROTTLE_BUDGET_MS,
        `${ch.kind} to ${rung.label}`,
      )
      const after = ch.track.getSettings()
      console.info(
        `[capture] display ${before.frameRate ?? '?'} → ${after.frameRate ?? '?'} fps ` +
          `at ${after.width}×${after.height} (${reason})`,
      )
      // O15: a step DOWN is this machine saying it could not carry the plan.
      // Only downward steps count — the ladder climbs back on its own, and a
      // recovery is not evidence of anything failing.
      if (rung.fps < this.requestedRate) this.noteEncoderCollapse(`the rate ladder stepped: ${reason}`)
      // ONE NOTICE PER TAKE, AND ONLY ON THE WAY DOWN. "It has to be smooth,
      // not noticible for users and watchers" — a banner on every step of a
      // ladder that now recovers by itself would be more visible than the thing
      // it reports, and a notice that the rate fell is a lie the moment it
      // climbs back. The first reduction is worth saying once; the rest is the
      // guard doing its job.
      if (rung.fps < this.requestedRate && !this.rateNoticeSent) {
        this.rateNoticeSent = true
        this.emit({
          type: 'channel-error',
          kind: 'screen',
          message: `Recording at ${rung.label} for a moment — your machine is busy. Nothing else changes.`,
        })
      }
    } catch (err) {
      console.warn('[capture] could not change the capture rate', err)
    }
  }

  private markCompositeUnusable(reason: string): void {
    if (this.compositeInvalid) return
    this.compositeInvalid = true
    console.info(`[capture] composite unusable (${reason}) — unedited export will render`)
    // O15: the composite giving up IS the collapse this budget exists for —
    // "a composite that produces nothing in its first second never produces
    // anything". File it against the plan that produced it.
    this.noteEncoderCollapse(`the composite degraded: ${reason}`)
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

  /**
   * Does this take already hold its own default composition in ONE raw channel
   * (task O3b), so the live compositor would only re-encode a picture we
   * already have?
   *
   * ASKED BEFORE THE COMPOSITE STARTS, from facts that are settled by then:
   * `useMeasured` was decided in armChannel (capability AND preference — the
   * X6 mp4/AVC path), and the track's own dimensions were read there too.
   *
   * IT IS DELIBERATELY CONSERVATIVE, because skipping the composite is not
   * reversible mid-take. Every "no" here just records a take exactly the way it
   * has always been recorded.
   */
  private singleGenerationTake(): { yes: boolean; why: string } {
    const video = this.channels.filter((c) => c.media === 'video' && !c.ended)
    // THE BUDGET DROPPED IT — Robert, 2026-08-30: "non max video must stop
    // fucking app record". Decided in applyEncoderBudget from this machine's
    // own measured history; read here so startComposite, planEncoders and
    // compositeFrame all agree, which is the rule this method exists to keep.
    if (this.budgetDroppedComposite) return { yes: true, why: '' }
    // MAX MODE DOES NOT RECORD THE COMPOSITE, and this is the whole of how max
    // is made to work without a ladder to rescue it (Robert: "max must not have
    // ladder", 2026-08-30).
    //
    // The composite is a DOWNSCALED SECOND COPY of a picture the take already
    // has, made by its own hardware encoder. On his screen+camera take at
    // 3024x1964/60 the three encoders wanted 555 Mpx/s against the ~416 this
    // machine measures; without the composite it is 411, which fits. That is
    // the difference between a take and a slideshow, and no amount of policy
    // would have produced it — only opening fewer encoders does.
    //
    // Unlike the single-generation case below, this does NOT require one video
    // channel: with a camera there is nothing to packet-copy, so the unedited
    // export RENDERS from the raw channels instead of copying. That is the
    // price of max and it is paid at export time, where a wait costs nothing
    // but time — rather than during capture, where it costs the picture.
    if (!rateLadderAllowed()) {
      const screen = video.find((c) => c.kind === 'screen') ?? video[0]
      const frame = this.compositeFrame()
      if (screen?.width && screen.height && screen.width * screen.height >= frame.width * frame.height) {
        return { yes: true, why: '' }
      }
    }
    if (video.length !== 1) {
      return { yes: false, why: `${video.length} video channels`, }
    }
    const ch = video[0]!
    if (!ch.useMeasured) {
      return { yes: false, why: `the ${ch.kind} channel records webm through MediaRecorder, which nothing can packet-copy into an MP4` }
    }
    const frame = this.compositeFrame()
    // NATIVE RESOLUTION IS ITS OWN OPT-IN, and it does not need a second one.
    // `?sourceres=1` promises the take's own resolution, delivered by the
    // packet copy — and on a single-video take BIGGER than the composite, the
    // composite is not a different picture, it is a smaller copy of this one
    // made by a second hardware encoder running beside the first. Asking the
    // user for a separate flag to stop paying for that would mean the feature
    // does not work for the person who turned it on.
    if (
      sourceResEnabled() &&
      ch.width &&
      ch.height &&
      ch.width * ch.height > frame.width * frame.height
    ) {
      return { yes: true, why: '' }
    }
    if (!singleGenCaptureEnabled()) return { yes: false, why: 'not enabled (?singlegen=capture)' }
    if (ch.width === frame.width && ch.height === frame.height) return { yes: true, why: '' }
    // THE COMPOSITE WOULD BE A DOWNSCALE OF A PICTURE WE ALREADY HAVE (F18 +
    // O15, 2026-08-30). The original rule asked for EQUALITY, because before
    // F18 the export ladder stopped below the screen and the composite was the
    // only thing shaped like the output. With `?sourceres=1` the take's own
    // size IS an export step, delivered by the packet copy — so on a
    // single-video take that is BIGGER than the composite, the composite is not
    // a different picture, it is a smaller copy of this one, made by a second
    // hardware encoder running beside the first.
    //
    // THIS IS THE LEVER ROBERT'S FREEZE TURNS ON. Measured 2026-08-30 from his
    // configuration: 3024x1964@60 plus a composite asks for 481 Mpx/s across
    // two encoders — a whole 4K60 stream's worth, while a game renders on the
    // same GPU. Without the composite it is 356 on one. The composite is the
    // difference between impossible and merely hard.
    //
    // WHAT IS GIVEN UP is what `?singlegen=capture` always gave up and is named
    // in core/singleGen.ts: source-liveness detection, and the composited
    // preview (the raw <video> preview takes over, and measured live it carries
    // MORE pixels than the compositor's 960x540 canvas). NEW HERE: an export at
    // a step SMALLER than the take now renders instead of copying the
    // composite. That is the honest trade — a slower export on a take that
    // would otherwise have produced nothing at all.
    return {
      yes: false,
      why: `the ${ch.kind} track is ${ch.width}x${ch.height}, not ${frame.width}x${frame.height} — the compositor's contain-fit is doing real work`,
    }
  }

  /**
   * WHAT THIS TAKE INTENDS TO OPEN — task O15, and nothing like it existed
   * before. How many encoders a take opens was EMERGENT: armChannel opens one
   * per raw video channel, startComposite opens another, and no line of code
   * or console ever added them up. Robert's freeze was three of them —
   * 3024x1964 + 1280x720 + 1920x1080 with a game on the same GPU — and the
   * only place that fact appeared was in his own reading of three separate log
   * lines after the machine came back.
   *
   * Asked at ARM TIME, from the same settled facts singleGenerationTake and
   * compositeFrame are asked from, so the three can never disagree about what
   * this take is.
   *
   * A MediaRecorder channel counts too. It is software VP8/VP9 rather than a
   * hardware AVC instance, so it is not the same KIND of load — but it is a
   * whole video encoder running on this machine while the others do, and a
   * budget that pretended otherwise would be measuring the wrong take.
   */
  private planEncoders(): EncoderPlan {
    const video = this.channels.filter((c) => c.media === 'video' && !c.ended)
    const encoders: PlannedEncoder[] = video.map((c) => ({
      what: c.kind,
      width: c.width ?? 0,
      height: c.height ?? 0,
      fps: c.fps ?? DEFAULT_FRAME_RATE,
    }))
    // The composite is an encoder like any other, EXCEPT when single
    // generation is going to skip it — which is exactly the branch
    // startComposite will take, asked here from the same facts.
    if (!this.singleGenerationTake().yes) {
      const frame = this.compositeFrame()
      encoders.push({ what: 'composite', width: frame.width, height: frame.height, fps: this.compositeRate() })
    }
    return planOf(encoders)
  }

  /**
   * THE BUDGET, APPLIED BEFORE ANYTHING OPENS — task O15.
   *
   * This runs inside arm(), which is the last moment it can: `start()` is
   * synchronous by law (instant record start) and every encoder is configured
   * inside it, so a size decided any later cannot be acted on. It is also the
   * only moment that helps — the collapse this exists for is instant and
   * unrecoverable, and captureLadder.ts, which measures while the take runs,
   * arrives after the machine has already stopped answering.
   *
   * BOUNDED, AND A REFUSAL IS NOT FATAL (note 3: nothing in arming may await
   * without a deadline). A track that will not narrow simply keeps the size it
   * had, exactly as capDisplayTrack already tolerates.
   *
   * The plan is logged either way. With no flag and no history this method
   * prints one line and changes nothing, which is the point: the machine is
   * measured long before it is ever bounded.
   */
  private async applyEncoderBudget(): Promise<void> {
    const plan = this.planEncoders()
    this.encoderPlan = plan
    if (!plan.encoders.length) return
    const ceiling = encoderCeiling()
    console.info(
      `[capture] encoder plan — ${describePlan(plan)}` +
        (ceiling > 0
          ? ` against this machine's own ${(ceiling / 1e6).toFixed(1)} Mpx/s budget`
          : ' (this machine has never been seen to collapse, so there is no budget to be over)'),
    )
    // Max mode is not bounded either: it is one mode, and this is one of the
    // three things it turns off.
    if (!encoderBudgetEnabled() || !preemptiveRefusalAllowed()) return
    // THE COMPOSITE GOES FIRST, AND IT IS NOT A CLOSE CALL. The two reductions
    // available here are not comparable: dropping the composite costs NO
    // PICTURE — the raw channel already holds the same frame, larger — while
    // narrowing the screen track costs exactly the resolution the user turned
    // native-res on to get. Robert has ruled against auto-reducing quality
    // often enough that spending picture before spending a redundant second
    // encode would be the wrong order every time.
    //
    // What it costs instead, all of it paid at EXPORT rather than during
    // capture: source-liveness detection ("your screen froze" stops being
    // noticed), the preview becomes the raw one (measured SHARPER, not
    // softer), and an unedited export at a step below the take re-renders
    // instead of packet-copying. That last one used to be fatal and is why
    // this was left as Robert's ruling rather than shipped — a re-render meant
    // the GPU-process crash. It does not any more (0f8fefe): 240 s of
    // 3024x1964@60 renders to 1440p in 132 s with the GPU process intact.
    let workingPlan = plan
    const drop = dropCompositeVerdict({ plan, ceiling })
    if (drop) {
      this.budgetDroppedComposite = true
      this.encoderPlan = drop.plan
      workingPlan = drop.plan
      console.info(
        `[capture] encoder budget: the composite is NOT being recorded — ${drop.why}. ` +
          `New plan: ${describePlan(drop.plan)}. The unedited export re-renders instead of ` +
          `copying (O15, Robert 2026-08-30)`,
      )
      if (drop.plan.pixelRate <= ceiling) return
    }
    const screenCh = this.channels.find((c) => c.kind === 'screen' && c.media === 'video' && !c.ended)
    const screen = workingPlan.encoders.find((e) => e.what === 'screen') ?? null
    if (!screenCh || !screen) return
    const frame = this.compositeFrame()
    const verdict = budgetVerdict({
      plan: workingPlan,
      ceiling,
      screen,
      compositeLongEdge: Math.max(frame.width, frame.height),
    })
    if (!verdict) return
    try {
      await withTimeout(
        screenCh.track.applyConstraints({
          width: { max: verdict.screenLongEdge },
          height: { max: verdict.screenLongEdge },
        }),
        THROTTLE_BUDGET_MS,
        'applyConstraints(encoder budget)',
      )
      const after = screenCh.track.getSettings()
      // The runtime's own dimensions are what singleGenerationTake and
      // compositeFrame read, so they have to follow the track or the take
      // would be planned at one size and recorded at another.
      screenCh.width = after.width ?? screenCh.width
      screenCh.height = after.height ?? screenCh.height
      this.encoderPlan = this.planEncoders()
      console.info(
        `[capture] encoder budget: screen ${screen.width}x${screen.height} → ` +
          `${after.width}x${after.height} before any encoder opened — ${verdict.why}. ` +
          `New plan: ${describePlan(this.encoderPlan)} (O15)`,
      )
    } catch (err) {
      console.warn('[capture] could not bound the screen to the encoder budget — recording as-is', err)
    }
  }

  /** O15: this take degraded. File it against the load that produced it. */
  private noteEncoderCollapse(reason: string): void {
    if (this.collapseRecorded) return
    this.collapseRecorded = true
    if (this.encoderPlan) recordEncoderCollapse(this.encoderPlan.pixelRate, reason)
  }

  /**
   * THE COMPOSITE'S GEOMETRY FOR THIS TAKE (task F13).
   *
   * The take's own aspect at the default step's pixel budget. The ASPECT
   * follows the source — that is the whole task, and it is what stops a 9:16
   * phone camera being cropped to 31.6 % of itself — while the pixel BUDGET
   * stays the product's, so a 4K monitor does not silently turn every default
   * export into a 4K file. (The native-resolution win on such a monitor is
   * O3c's: the export step that matches the screen packet-copies the raw
   * channel and never touches this canvas.)
   *
   * Behind the flag this returns the constant it always did, exactly.
   *
   * ASKED ONCE, AT startComposite, from dimensions armChannel has already read
   * off the tracks — the same facts singleGenerationTake is decided on, so the
   * two can never disagree about what the composite is.
   */
  private compositeFrame(): { width: number; height: number } {
    if (!sourceFrameEnabled()) return { width: COMPOSITE_WIDTH, height: COMPOSITE_HEIGHT }
    const video = this.channels.filter((c) => c.media === 'video' && !c.ended)
    const chosen = video.find((c) => c.kind === 'screen') ?? video[0]
    const aspect = aspectOf(chosen?.width, chosen?.height)
    if (aspect === null) return { width: COMPOSITE_WIDTH, height: COMPOSITE_HEIGHT }
    return frameForAspect(aspect, COMPOSITE_WIDTH)
  }

  /**
   * THE COMPOSITE'S RATE FOR THIS TAKE (task F15).
   *
   * The same question `compositeFrame` asks, one field over, and answered from
   * the same facts at the same moment so the two can never disagree about what
   * the composite is. The SCREEN decides where there is one — it is the full
   * frame, and a 60 fps PiP camera over a 30 fps screen is not a 60 fps take —
   * then the camera, then the constant.
   *
   * Behind the flag this returns the 30 both engines were hardcoded to, so a
   * take recorded with it off is the take that was recorded yesterday.
   */
  private compositeRate(): number {
    if (!sourceRateEnabled()) return DEFAULT_FRAME_RATE
    const video = this.channels.filter((c) => c.media === 'video' && !c.ended)
    const chosen = video.find((c) => c.kind === 'screen') ?? video[0]
    return normalizeRate(chosen?.fps)
  }

  private startComposite(): void {
    // O3b, the CAPTURE half: a whole hardware encoder, its worker and ~18 % of
    // the take's write bandwidth, none of which run. WHAT IS GIVEN UP IS REAL
    // and is why this rung is opt-in until Robert rules: the compositor owns
    // SOURCE LIVENESS (a frozen screen stops being noticed) and the recording
    // preview can no longer render its output. Both are named in
    // core/singleGen.ts beside the flag.
    const single = this.singleGenerationTake()
    if (single.yes) {
      this.singleGeneration = true
      const copies = this.channels.filter((c) => c.media === 'video' && !c.ended).length === 1
      console.info(
        `[capture] NO LIVE COMPOSITE for this take — it would be a second encode of a picture the ` +
          `raw channel${copies ? '' : 's'} already ${copies ? 'holds' : 'hold'}, and that encoder is ` +
          `what a busy machine cannot afford. ` +
          (copies
            ? 'The unedited export packet-copies the raw channel.'
            : 'With more than one video channel there is nothing to copy, so the unedited export RENDERS.') +
          ' Source-liveness detection and the composited preview are off with it.',
      )
      return
    }
    if (singleGenCaptureEnabled()) {
      console.info(`[capture] single generation declined — ${single.why}; recording the composite`)
    }
    const screen = this.previewStreams.screen
    const camera = this.previewStreams.camera
    const audio = [this.previewStreams.mic, this.previewStreams['system-audio']].filter(
      (x): x is MediaStream => !!x,
    )
    const inputs = { screen, camera, audio }
    // F13: one answer, handed to whichever engine starts — the two must not
    // derive it separately or a fallback would change the take's shape. It is
    // a GUESS: `track.getSettings()` reports the sensor on a phone held
    // portrait, so the engines correct it from the first picture they see and
    // report back what they are actually writing.
    const frame = this.compositeFrame()
    // F15: one answer, handed to whichever engine starts, for the same reason
    // the frame is — a v2→v1 fallback must not change the take's rate.
    const rate = this.compositeRate()
    this.requestedRate = rate
    if (rate !== DEFAULT_FRAME_RATE) {
      console.info(
        `[capture] composite follows the source: ${rate} fps (F15, ?sourcefps=1)`,
      )
    }
    const followSource = sourceFrameEnabled()
    if (followSource) {
      console.info(
        `[capture] composite follows the source: starting at ${frame.width}x${frame.height}, ` +
          `the first frame decides (F13, ?sourceframe=1)`,
      )
    }
    const onGeometry = (size: { width: number; height: number }): void => {
      if (this.compositeGeometry &&
          this.compositeGeometry.width === size.width &&
          this.compositeGeometry.height === size.height) return
      this.compositeGeometry = size
      this.emit({ type: 'composite-geometry', width: size.width, height: size.height })
    }
    // Both engines write fragmented MP4; the `.webm` this was called for years
    // was never true, and a name that disagrees with the bytes is what made
    // every iPhone channel unplayable (see containerExt above).
    const key = `${this.recordingId}_composite.mp4`
    const onSourceLiveness = (kind: 'screen' | 'camera', event: 'stalled' | 'resumed'): void =>
      this.onSourceLiveness(kind, event)

    // v1 is the capability fallback and stays the whole story on Apple WebKit
    // and anywhere without MediaStreamTrackProcessor (O4 step 2).
    // The epoch is what makes the composite's own clock legible downstream
    // (P0-instant-sync): start() has already set it — startComposite runs from
    // inside the same turn — so both engines can date their file's zero.
    const epochMs = this.epoch
    const startV1 = (): Promise<LiveCompositeHandle> | null =>
      canLiveComposite(inputs)
        ? startLiveComposite(inputs, key, {
            onSourceLiveness,
            epochMs,
            width: frame.width,
            height: frame.height,
            fps: rate,
            followSource,
            longEdge: COMPOSITE_WIDTH,
            onGeometry,
          })
        : null

    const wantV2 = preferredCompositeEngine() === 'v2' && canLiveCompositeV2(inputs)
    let start: Promise<LiveCompositeHandle> | null
    if (wantV2) {
      console.info('[capture] live composite engine v2 (worker + WebCodecs)')
      start = startLiveCompositeV2(inputs, key, {
        onSourceLiveness,
        epochMs,
        width: frame.width,
        height: frame.height,
        fps: rate,
        followSource,
        longEdge: COMPOSITE_WIDTH,
        onGeometry,
        // A machine that cannot keep pace stops being copied, exactly as v1's
        // watchdog did: the take is unharmed, the unedited export renders.
        // O6: the gentler rung of the same ladder — ask the SOURCE for less
        // before giving up on the composite. Only ever fires when native-res
        // capture is on, because otherwise the track is already at the floor.
        onDegradeStep: (rung, reason) => {
          // MAX MODE DOES NOT STEP. The ladder still MEASURES — its verdict is
          // what tells the take it is behind, and O15 still files the collapse
          // against the plan — but nothing is taken away from the picture the
          // user asked for. What they get instead is dropped frames, reported
          // rather than hidden, which is the price max exists to let them pay.
          if (!rateLadderAllowed()) {
            this.noteEncoderCollapse(`the rate ladder wanted to step: ${reason}`)
            return
          }
          void this.stepDisplayDown(rung, reason)
        },
        onDegrade: (reason) => {
          this.markCompositeUnusable(`compositor v2: ${reason}`)
          // A degraded v2 stops its frame pumps, so a preview fed from it would
          // sit on its last frame for the rest of the take.
          this.notePreviewLost()
        },
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

  /**
   * A raw VIDEO channel on WebCodecs (task X6). Deliberately the smaller twin
   * of startMeasured: no worklet, no loudness tap, no pre-warmed context —
   * just the track, its own worker, and the same handle contract so every stop
   * path already written works unchanged.
   *
   * A FAILURE HERE IS NOT FATAL TO THE TAKE. The frozen rule wants the shipped
   * path as the runtime fallback, so a start failure falls back to the
   * MediaRecorder this channel was armed with — the recorder object exists
   * either way, because armChannel only skips creating it for measured AUDIO.
   */
  private async startMeasuredVideo(ch: ChannelRuntime, startT0: number): Promise<void> {
    const settings = ch.track.getSettings()
    // THE ENCODER IS CONFIGURED AT THE FRAMES' OWN SIZE, deliberately NOT
    // rounded. Evening here looks like a safety net and is the opposite: a
    // config of 1670 fed 1671-wide frames passes `isConfigSupported` and then
    // encodes NOTHING — measured on prod, `0 frames encoded of 199 in`, which
    // is a silent take instead of a loud refusal. Evenness is the TRACK's
    // business and capDisplayTrack owns it in one place.
    const width = settings.width ?? ch.width ?? 1920
    const height = settings.height ?? ch.height ?? 1080
    const fps = Math.round(settings.frameRate ?? 30)
    try {
      const handle = await startMeasuredVideoCapture({
        track: ch.track,
        key: ch.blobKey,
        epoch: this.epoch,
        width,
        height,
        fps: fps > 0 ? fps : 30,
        videoBitrate: videoBitsFor(ch.kind, this.config.screen),
        onFatal: (err) => {
          if (this.stateInternal !== 'recording') return
          this.emit({
            type: 'channel-error',
            kind: ch.kind,
            message: `${ch.kind} recording failed mid-take (${err.message}) — video saved up to this point only`,
          })
        },
      })
      ch.measured = handle
      ch.mimeType = handle.mimeType
      ch.recorderStarted = true
      ch.width = width
      ch.height = height
      ch.fps = fps > 0 ? fps : 30
      const offset = await handle.firstOffset
      ch.startOffsetMs = offset
      ch.startAbs = this.epoch + offset
      console.info(
        `[capture:arming] measured video ${ch.kind} first-frame +${(performance.now() - startT0).toFixed(0)}ms offset=${offset.toFixed(1)}ms ${width}x${height}@${fps}`,
      )
    } catch (err) {
      // Fall back to the shipped path rather than losing the channel. The
      // recorder was built during arm() and has not been started.
      console.warn('[capture] measured video unavailable, using MediaRecorder for', ch.kind, err)
      ch.useMeasured = false
      ch.measured = null
      if (ch.recorder && ch.recorder.state === 'inactive') {
        const tCall = performance.now()
        ch.startAbs = tCall
        ch.startOffsetMs = tCall - this.epoch
        try {
          ch.recorder.start(TIMESLICE_MS)
          ch.recorderStarted = true
        } catch (startErr) {
          console.error('[capture] MediaRecorder fallback also failed for', ch.kind, startErr)
          this.emit({
            type: 'channel-error',
            kind: ch.kind,
            message: `${ch.kind} could not start recording`,
          })
        }
      }
    }
  }

  private async startMeasured(ch: ChannelRuntime, startT0: number): Promise<void> {
    try {
      const writer = await createDurablePositionedWriter(ch.blobKey)
      const handle = await startMeasuredAudioCapture({
        stream: ch.stream,
        epoch: this.epoch,
        writer,
        label: ch.kind,
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
            // AUDIO channels only. A measured VIDEO channel (X6) also has
            // useMeasured set and delivers no PCM ever, so registering it would
            // make the fold wait forever for a contributor that cannot arrive.
            for (const c of this.channels) {
              if (c.useMeasured && c.media === 'audio') this.loudness.register(c.id)
            }
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

  /**
   * O4-polish: let the compositor paint the recording preview, so the UI stops
   * decoding the same sources a second time.
   *
   * Only the v2 engine can do this — it is the only one holding composited
   * frames off the main thread. v1 composites ON the main thread from the very
   * <video> elements the UI is already showing, so there is nothing to hand
   * over. FALSE means "keep your own preview", and it is a normal answer:
   * every Apple WebKit and Firefox take gets it, as does any take whose
   * compositor is still starting when the canvas mounts.
   */
  async attachCompositePreview(canvas: HTMLCanvasElement): Promise<boolean> {
    if (this.stateInternal !== 'recording') return false
    // O3b: there is no compositor to hand over from, by design. The UI's own
    // preview is the whole preview for this take — say so rather than letting
    // it look like a compositor that failed to start.
    if (this.singleGeneration) return false
    try {
      if (this.compositeStarting) {
        await withTimeout(this.compositeStarting, COMPOSITE_START_BUDGET_MS, 'composite start')
      }
    } catch {
      return false
    }
    const handle = this.composite
    if (!handle?.attachPreview || this.compositeHardInvalid) return false
    const live = await handle.attachPreview(canvas).catch(() => false)
    this.compositePreviewLive = live
    if (live) console.info('[capture] recording preview is the compositor’s own output')
    return live
  }

  /**
   * F6 — PAUSE. The difference from setChannelActive(kind, false) is the whole
   * point: nothing is released. The tracks stay live, the camera light stays
   * on, the wake lock is held, and no permission or picker is asked again on
   * resume. What ends here is each channel's current SEGMENT.
   *
   * THE COMPOSITE CANNOT REPRESENT A GAP. It is ONE continuous file whose
   * timestamps are arrival stamps, so a paused stretch would either be recorded
   * as frozen frames or leave the rest of the take sliding against the audio.
   * It is invalidated instead, and a paused take exports through the render —
   * exactly the fallback a late join already takes, and for the same reason.
   */
  pause(): void {
    if (this.stateInternal !== 'recording') return
    this.setState('paused')
    this.pausedAtMs = performance.now()
    // The composite is CANCELLED here, not merely marked: it is one continuous
    // file and cannot represent a gap, and leaving it running would spend an
    // encoder on the paused stretch as well. Cost stated plainly: a paused take
    // has no source-liveness tick until it is stopped, and it exports through
    // the render — the same fallback a late join takes.
    this.invalidateComposite('paused')
    for (const ch of this.channels) {
      if (ch.ended) continue
      this.closeSegment(ch)
    }
    this.writeManifest()
    console.info(`[capture] paused +${(performance.now() - this.epoch).toFixed(0)}ms into the take`)
  }

  /**
   * F6 — RESUME. Opens segment N+1 on the SAME tracks: no acquisition, no
   * prompt, no picker. Every kind the user has not switched off comes back.
   */
  resume(): void {
    if (this.stateInternal !== 'paused') return
    // THE PAUSE MUST NOT APPEAR IN THE TAKE. Every startOffsetMs downstream is
    // measured against the session epoch, so moving the epoch FORWARD by the
    // gap is all it takes: segments already closed keep the offsets they were
    // given, the next one lands where the last ended, and the elapsed counter
    // stops counting time nobody recorded. The alternative — keeping one epoch
    // and letting the gap through — would hand the user dead air to trim out of
    // every paused take, which is not what a pause button means.
    const now = performance.now()
    if (this.pausedAtMs !== null) this.epoch += now - this.pausedAtMs
    this.pausedAtMs = null
    this.setState('recording')
    const t0 = now
    for (const [kind, held] of this.pausedTracks) {
      if (this.suspended.has(kind)) continue
      if (held.track.readyState !== 'live') {
        // The device died while paused (unplugged, or the browser reclaimed a
        // screen share). Say so rather than silently recording nothing.
        this.emit({
          type: 'channel-error',
          kind,
          message: `${kind} was lost while paused`,
        })
        continue
      }
      void (async () => {
        try {
          const rt = await this.armChannel({
            kind,
            media: held.media,
            stream: held.stream,
            track: held.track,
          })
          if (this.stateInternal !== 'recording' || this.cancelled) {
            this.discardRuntime(rt)
            return
          }
          this.activateChannel(rt, t0)
        } catch (err) {
          this.emit({ type: 'channel-error', kind, message: errMessage(err) })
        }
      })()
    }
    this.pausedTracks.clear()
    this.writeManifest()
    console.info(`[capture] resumed +${(t0 - this.epoch).toFixed(0)}ms into the take`)
  }

  /**
   * End one channel's CURRENT segment and keep its device. The finished file
   * stays in `this.channels` (that is what makes it a segment of the take); the
   * track is remembered so resume() can open the next segment on it.
   *
   * Deliberately NOT onTrackEnded: that path stops the track, invalidates the
   * composite per channel, emits 'channel-ended' to a UI that would show the
   * channel as gone, and auto-stops the take when the last channel closes —
   * every one of which is wrong for a pause.
   */
  private closeSegment(ch: ChannelRuntime): void {
    ch.ended = true
    this.pausedTracks.set(ch.kind, { stream: ch.stream, track: ch.track, media: ch.media })
    if (ch.useMeasured && ch.measured) {
      const handle = ch.measured
      // A CLOSED SEGMENT IS FINISHED, AND NOTHING MAY STOP IT AGAIN. The
      // measured handle is NOT idempotent — its stop() terminates the worker
      // that owns the SyncAccessHandle — and stopRecorders() walks EVERY
      // channel including the ones a pause or a resolution step already closed.
      // The second call then messages a dead worker, waits out STOP_TIMEOUT_MS
      // and logs `measured stop failed` about a segment that was written
      // correctly. It was caught rather than fatal, which is why F6 shipped
      // with it; O16 makes it fire on every stepped take, so the state gets
      // represented instead of inferred.
      ch.measured = null
      void handle
        .stop()
        .then((r) => {
          ch.bytes = r.bytes
          ch.durationMs = r.durationMs
          ch.startOffsetMs = r.startOffsetMs
          if ('diagnostics' in r && r.diagnostics && Object.keys(r.diagnostics).length) {
            ch.diagnostics = r.diagnostics
          }
          mergeAnchor(ch, r)
        })
        .catch((err) => console.error('[capture] pause: measured stop failed', ch.kind, err))
        .finally(() => ch.resolveStopped())
      return
    }
    if (ch.recorder && ch.recorder.state !== 'inactive') {
      if (ch.startAbs !== undefined && ch.durationMs === undefined) {
        ch.durationMs = performance.now() - ch.startAbs
      }
      try {
        ch.recorder.requestData()
      } catch {
        /* already inactive */
      }
      try {
        ch.recorder.stop()
      } catch {
        ch.resolveStopped()
      }
      return
    }
    ch.resolveStopped()
  }

  setChannelActive(kind: ChannelKind, active: boolean): void {
    // Allowed while PAUSED too: turning a kind off during a pause is a natural
    // thing to do, and `suspended` is what resume() reads to decide which
    // segments to open.
    if (this.stateInternal !== 'recording' && this.stateInternal !== 'paused') return
    // Record the user's intent HERE, at the chokepoint, before acting on it:
    // the persistent-connect hunt reads `suspended` and must never re-grab a
    // device whose off-switch the user just pressed.
    if (active) {
      this.suspended.delete(kind)
      this.resumeChannel(kind)
    } else {
      this.suspended.add(kind)
      this.stopChannelNow(kind)
    }
  }

  private stopChannelNow(kind: ChannelKind): void {
    const ch = this.channels.find((c) => c.kind === kind && !c.ended)
    if (!ch) return
    // The preview must let go FIRST: the UI reads previewStreams to decide what
    // to paint, so leaving a dead stream here shows the user a frozen picture of
    // the very channel they just turned off — the confusion this method ends.
    delete this.previewStreams[kind]
    // track.stop() does not fire 'ended' (per spec), so drive the same teardown
    // the browser's "Stop sharing" would: duration stamped here, writer closed,
    // composite invalidated for video, auto-stop if this was the last one.
    try {
      ch.track.stop()
    } catch {
      /* already stopped */
    }
    this.onTrackEnded(ch)
  }

  /**
   * Re-acquire one kind and late-join it. Reuses the progressive acquirer with
   * a config enabling only this kind, so a resumed channel walks the exact path
   * a slow device walks at arm time — same constraints, same notices, same
   * failure reporting — rather than a second, subtly different acquisition.
   */
  private resumeChannel(kind: ChannelKind): void {
    if (this.channels.some((c) => c.kind === kind && !c.ended)) return // already live
    if (this.resuming.has(kind)) return // one attempt at a time
    this.resuming.add(kind)
    const only: CaptureConfig = {
      screen: kind === 'screen',
      camera: kind === 'camera',
      mic: kind === 'mic',
      systemAudio: kind === 'system-audio',
      cameraDeviceId: this.config.cameraDeviceId,
      micDeviceId: this.config.micDeviceId,
    }
    const onChannel = (acq: AcquiredChannel): void => {
      this.acquiredStreams.add(acq.stream)
      void (async () => {
        try {
          // The take may have ended while the picker or permission prompt was
          // open. EVERY track must be stopped, not just the one we would have
          // used: a display resume also yields a system-audio track, and a
          // device left running here holds its claim in the browser — which is
          // how the NEXT take sat on "Waiting for microphone…" (Robert 2026-08-23).
          if (this.stateInternal !== 'recording' || this.cancelled) {
            for (const t of acq.stream.getTracks()) t.stop()
            return
          }
          const rt = await this.armChannel(acq)
          if (this.stateInternal !== 'recording' || this.cancelled) this.discardRuntime(rt)
          else this.lateJoin(rt)
        } catch (err) {
          for (const t of acq.stream.getTracks()) t.stop()
          this.emit({ type: 'channel-error', kind: acq.kind, message: errMessage(err) })
        } finally {
          this.resuming.delete(kind)
        }
      })()
    }
    const onFailure = (f: AcquireFailure): void => {
      this.resuming.delete(kind)
      this.emit({ type: 'channel-error', kind: f.kind, message: f.message })
    }
    try {
      if (isSyntheticMode()) {
        createSyntheticChannelsProgressive(only, { onChannel, onFailure })
      } else {
        acquireChannelsProgressive(only, {
          onChannel,
          onFailure,
          onNotice: (k, message) => this.emit({ type: 'channel-notice', kind: k, message }),
          // Same hunt fence as at arm time, for a mid-take resume: keep asking
          // only while the take records, the kind is still missing and the
          // user has not turned it off again.
          stillWanted: (k) =>
            !this.cancelled &&
            this.stateInternal === 'recording' &&
            !this.suspended.has(k) &&
            !this.channels.some((c) => c.kind === k && !c.ended),
        })
      }
    } catch (err) {
      this.resuming.delete(kind)
      this.emit({ type: 'channel-error', kind, message: errMessage(err) })
    }
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
    const remainingMs = MAX_RECORDING_MS === null ? null : Math.max(0, MAX_RECORDING_MS - elapsedMs)
    this.emit({ type: 'tick', elapsedMs, remainingMs })
    if (remainingMs !== null && remainingMs <= 0) return this.autoStop()
    this.watchScreenSize()
    this.watchDisk(elapsedMs)
  }

  /**
   * B5 — IS THERE ROOM TO FINISH? Nothing in this product has ever asked.
   *
   * The takes got very much bigger (one of Robert's at 3024x1964@60 wrote
   * 1,138 MB before it froze) and the old 30-minute cap that bounded the damage
   * is gone. A take that hits the storage quota mid-write loses whatever the
   * writer had not acknowledged — the user gets neither the recording nor the
   * space. Stopping with room to spare gives them the recording.
   *
   * Every few seconds, not every tick: `estimate()` is a real query and the
   * answer cannot move fast enough to be worth 250 ms.
   */
  private watchDisk(elapsedMs: number): void {
    const now = performance.now()
    if (now - this.lastDiskCheckMs < DISK_CHECK_MS) return
    this.lastDiskCheckMs = now
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return
    void navigator.storage
      .estimate()
      .then((est) => {
        if (this.stateInternal !== 'recording') return
        const takeBytes = this.channels.reduce((n, c) => n + c.bytes, 0)
        const v = diskVerdict({
          usageBytes: est.usage ?? 0,
          quotaBytes: est.quota ?? 0,
          takeBytes,
          takeMs: elapsedMs,
        })
        if (!v || v.level === 'ok') return
        if (v.level === 'warn') {
          if (this.diskWarned) return
          this.diskWarned = true
          console.warn(`[capture] ${v.message}`)
          this.emit({ type: 'channel-error', kind: 'screen', message: v.message })
          return
        }
        console.warn(`[capture] ${v.message}`)
        this.emit({ type: 'channel-error', kind: 'screen', message: v.message })
        this.autoStop()
      })
      .catch(() => undefined)
  }

  /**
   * O16 — DOES THE SCREEN'S RAW CHANNEL STILL MATCH ITS SOURCE?
   *
   * Sampled on the existing tick, which is the cheapest place there is: one
   * `getSettings()` every 250 ms and, on the overwhelming majority of takes,
   * nothing else ever happens. A source that is not changing size never reaches
   * the settle clause.
   *
   * Nothing here is about LOAD. Backpressure stays captureLadder's and stays
   * rate-only, on Robert's ruling — "if something needs to be dropped it must be
   * fps not resolution". What this follows is the source's own size changing:
   * a display-mode change, or a shared window being resized.
   */
  private watchScreenSize(): void {
    if (!resolutionStepEnabled() || this.resStepping) return
    const ch = this.channels.find((c) => c.kind === 'screen' && c.media === 'video' && !c.ended)
    if (!ch || !ch.width || !ch.height) return
    const s = ch.track.getSettings()
    const observed: SegmentGeometry | null =
      s.width && s.height ? { width: s.width, height: s.height } : null
    const current: SegmentGeometry = { width: ch.width, height: ch.height }
    const now = performance.now()
    // The settle clock starts when the sizes first disagree and is cleared the
    // moment they agree again — a window being dragged emits a continuous
    // stream of sizes, and this is what turns that into ONE step at the size
    // the user let go at rather than a segment per frame.
    if (!differsMeaningfully(current, observed)) {
      this.sizeDifferingSinceMs = null
      return
    }
    if (this.sizeDifferingSinceMs === null) this.sizeDifferingSinceMs = now
    const verdict = stepVerdict({
      current,
      observed,
      nowMs: now,
      differingSinceMs: this.sizeDifferingSinceMs,
      lastStepAtMs: this.lastResStepAtMs,
      stepsTaken: this.resStepsTaken,
    })
    if (!verdict) return
    this.sizeDifferingSinceMs = null
    void this.stepScreenSegment(verdict.why)
  }

  /**
   * O16 — CLOSE THE SCREEN'S SEGMENT AND OPEN THE NEXT ONE AT THE SOURCE'S SIZE.
   *
   * The move F6 already built, without the gap. `closeSegment` ends the current
   * file and KEEPS the device; `armChannel` + `activateChannel` open segment
   * N+1 on the very same track, which by now is delivering the new size, so the
   * new encoder is configured from it with no constraint applied and nothing
   * asked of the source.
   *
   * WAITS FOR THE OLD SEGMENT TO DRAIN before opening the next. P0-tail-raw is
   * the whole reason: an encoder that is still flushing when its successor
   * starts loses whatever it had not caught up on, which is the defect that task
   * fixed for the END of a take and this one could re-introduce in the middle.
   *
   * Only the SCREEN steps. Every other channel keeps recording through it
   * untouched, and the composite is not invalidated: the track stays live
   * throughout, so the compositor never sees a break — it contain-fits whatever
   * size arrives, exactly as it does for a source that resizes today.
   */
  private async stepScreenSegment(why: string): Promise<void> {
    if (this.resStepping) return
    this.resStepping = true
    const t0 = performance.now()
    try {
      const ch = this.channels.find((c) => c.kind === 'screen' && c.media === 'video' && !c.ended)
      if (!ch) return
      const { stream, track } = ch
      const from = `${ch.width}x${ch.height}`
      this.closeSegment(ch)
      // closeSegment hands the track to pausedTracks so a resume() can reopen
      // it. There is no pause here and resume() must not find it.
      this.pausedTracks.delete('screen')
      await withTimeout(ch.stopped, STOP_BUDGET_MS, 'segment drain').catch((err) =>
        console.warn('[capture] resolution step: previous segment did not drain in budget', err),
      )
      if (this.stateInternal !== 'recording' || this.cancelled) return
      if (track.readyState !== 'live') {
        console.warn('[capture] resolution step: the screen track ended mid-step')
        return
      }
      const rt = await this.armChannel({ kind: 'screen', media: 'video', stream, track })
      if (this.stateInternal !== 'recording' || this.cancelled) {
        this.discardRuntime(rt)
        return
      }
      this.activateChannel(rt, performance.now())
      this.resStepsTaken += 1
      this.lastResStepAtMs = performance.now()
      this.writeManifest()
      console.info(
        `[capture] resolution step ${this.resStepsTaken}: screen ${from} → segment ${this.resStepsTaken + 1} ` +
          `in ${(performance.now() - t0).toFixed(0)}ms — ${why}. The take's own-resolution export ` +
          `declines from here (two segments, two geometries); the default instant export is unaffected (O16)`,
      )
    } catch (err) {
      console.error('[capture] resolution step failed — the channel keeps the size it had', err)
    } finally {
      this.resStepping = false
    }
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
          if ('diagnostics' in r && r.diagnostics && Object.keys(r.diagnostics).length) {
            rt.diagnostics = r.diagnostics
          }
          mergeAnchor(rt, r)
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

  /**
   * `only` exists for the tail drain: the AUDIO channels have to stop at the
   * press, and the VIDEO ones a drain later. Left out, this stops everything,
   * which is what cancel wants.
   */
  private stopRecorders(flush: boolean, only?: (ch: ChannelRuntime) => boolean): void {
    for (const ch of this.channels) {
      if (only && !only(ch)) continue
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
              // F13: the file's own geometry, which is not always the one the
              // track reported at arm time — a phone's settings describe the
              // sensor, the frames are rotated. Every consumer of
              // ChannelRecording.width/height (the single-generation copy, the
              // editor's PiP box) has to be told what was written.
              const st = 'stats' in r ? r.stats : null
              if (st?.outWidth && st.outHeight && (st.outWidth !== ch.width || st.outHeight !== ch.height)) {
                console.info(
                  `[capture] ${ch.kind} channel recorded ${st.outWidth}x${st.outHeight} (the track said ${ch.width}x${ch.height})`,
                )
                ch.width = st.outWidth
                ch.height = st.outHeight
              }
              if ('diagnostics' in r && r.diagnostics && Object.keys(r.diagnostics).length) {
                ch.diagnostics = r.diagnostics
              }
              mergeAnchor(ch, r)
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
      // The prewarmed AudioContext is handed to the measured capture at
      // start(), which nulls this and takes over closing it. A take that ends
      // BEFORE start — every cancelled arm — never transfers it, and nothing
      // else closed it: an AudioContext per abandoned start, each holding an
      // audio device open on some platforms, until the tab is reloaded.
      if (ch.audioCtx) {
        const ctx = ch.audioCtx
        ch.audioCtx = null
        if (ctx.state !== 'closed') void ctx.close().catch(() => undefined)
      }
    }
    // Channels only enter this.channels at the END of armChannel, after awaits
    // that can take seconds (measured-audio prewarm is bounded at 3s, the OPFS
    // write stream is unbounded). A cancel landing inside that window found an
    // empty list and released nothing, while the device was already live — the
    // macOS mic and screen-recording indicators then stayed lit with no owner
    // (Robert 2026-08-23). Every stream the session has ever been handed is
    // tracked from the instant it arrives, so release cannot miss one.
    for (const s of this.acquiredStreams) {
      for (const t of s.getTracks()) t.stop()
    }
    this.acquiredStreams.clear()
    // Last word, and the only one that cannot be out of date: the guard holds
    // every stream the platform handed this tab, registered at the
    // getUserMedia/getDisplayMedia call itself. A stream still travelling
    // between acquire.ts and this session — the gap that produced this bug
    // three times — is in there and gets stopped here.
    releaseAllDevices('session release')
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
          await withTimeout(
            this.composite?.cancel() ?? Promise.resolve(),
            COMPOSITE_STOP_BUDGET_MS,
            'composite cancel',
          )
          this.composite = null
          return
        }
        const composite = await withTimeout(
          this.composite?.stop() ?? Promise.resolve(null),
          COMPOSITE_STOP_BUDGET_MS,
          'composite stop',
        )
        if (composite) this.compositeResult = composite
      } catch (err) {
        console.warn('[capture] live composite stop failed', err)
      }
    })()
  }

  private async doStop(): Promise<Recording> {
    this.clearTick()
    this.releaseWakeLock()
    // Before anything else: leave 'recording', because that is the flag every
    // in-flight resume checks when its device finally arrives. A resume whose
    // permission prompt or picker is still open outlives this call by up to its
    // acquisition budget, and the moment it lands it must find a session that
    // is no longer recording so it stops the device instead of attaching it.
    this.setState('stopping')
    this.resuming.clear()
    const compositeStopped = this.stopCompositeEarly()
    // AUDIO ends at the press. Only the video channels need a drain, and if the
    // audio waited for one the take would end with seconds of soundtrack over a
    // motionless picture — measured before this line existed: mic 11947 ms
    // against a screen channel of 10059 ms on the same take.
    this.stopRecorders(true, (c) => c.media === 'audio')
    await this.drainRawVideo()
    this.stopRecorders(true, (c) => c.media === 'video')
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
    // DEVICES OFF HERE — after the last consumer of a track, before the disk.
    // The composite reads the very same camera/mic tracks, so it goes first;
    // its stop is internally bounded (COMPOSITE_STOP_BUDGET_MS), so it can
    // delay this but never block it, and the instant export keeps its tail.
    // The writers, by contrast, want nothing from a device and `closeWriter`
    // awaits a write chain with no deadline of its own — releasing behind THAT
    // is how a slow or stuck disk kept the camera, mic and screen running
    // after the user had pressed stop and moved on.
    await compositeStopped
    this.releaseMedia()
    try {
      await withTimeout(
        Promise.all(this.channels.map((c) => this.closeWriter(c))),
        WRITER_CLOSE_BUDGET_MS,
        'writer close',
      )
    } catch (err) {
      console.warn('[capture] a channel writer did not close in budget — using what it flushed', err)
    }

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
      // The size is already counted (every kept channel has bytes > 0); keep
      // it with the take so a copyable export step can quote the file (O3c).
      if (c.bytes > 0) rec.bytes = c.bytes
      if (c.media === 'video') {
        if (c.width) rec.width = c.width
        if (c.height) rec.height = c.height
        // F15: the rate this file was written at. Every take made before the
        // rate could move carries none, and reads back as 30 — which is what
        // it was.
        if (c.fps) rec.fps = c.fps
      }
      if (c.diagnostics) rec.diagnostics = c.diagnostics
      // B7: THE ANCHOR IS STAMPED HERE, BEFORE THE SHIFT BELOW. Every lane gets
      // one — the measured lanes have already filled in the parts only they can
      // know (the audio latency the platform reported, the video first-frame
      // delay), and this fills the frame of reference they all share. After the
      // shift, offsets are relative to the take and a device's own lateness is
      // no longer recoverable from them.
      rec.diagnostics = {
        ...(rec.diagnostics ?? {}),
        anchor: {
          ...(rec.diagnostics?.anchor ?? {}),
          rawAnchorMs: rec.diagnostics?.anchor?.rawAnchorMs ?? rec.startOffsetMs,
        },
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
      // UI1: the ceiling this take was recorded under, stamped ON the take so
      // the export ladder is capped by what was chosen for IT — see
      // Recording.qualityStep.
      qualityStep: loadQualityStep(),
    }

    /**
     * B7 — THE ALIGNMENT INPUTS, ON ONE LINE, FOR THE TAKE THAT JUST HAPPENED.
     *
     * The values are persisted (above) so a reload keeps them, but a field
     * report starts with someone looking at a console, and "mic/camera unsynch
     * in beggining" has never once arrived with a number attached. This is the
     * line that changes that. It is descriptive: nothing below it moves.
     */
    console.info(
      '[capture] B7 anchors — ' +
        channels
          .map((c) => {
            const a = c.diagnostics?.anchor
            const parts = [`${c.kind} off=${c.startOffsetMs}ms`]
            if (a?.rawAnchorMs !== undefined) parts.push(`raw=${a.rawAnchorMs}ms`)
            if (a?.reportedInputLatencyMs !== undefined) {
              parts.push(`inputLatency=${a.reportedInputLatencyMs}ms`)
            }
            if (a?.firstFrameDelayMs !== undefined) {
              parts.push(
                `${a.firstFrameDelayIsStartGap ? 'startGap' : 'firstFrame'}=${a.firstFrameDelayMs}ms`,
              )
            }
            return parts.join(' ')
          })
          .join(' · '),
    )

    // O15: THIS MACHINE CARRIED THIS PLAN. Only a take that ran long enough to
    // mean it, and only one where nothing degraded — the ladder never stepped
    // and the composite never gave up. A two-second take proves nothing about
    // sustained throughput, and note 6's encoder warm-up lives inside exactly
    // that window, so a short take could otherwise raise the mark on the back
    // of an encoder that had not started working yet.
    if (
      !this.collapseRecorded &&
      this.encoderPlan &&
      recording.durationMs >= SUSTAINED_TAKE_MIN_MS
    ) {
      recordEncoderSustained(this.encoderPlan.pixelRate)
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
        // The window grid is anchored on the SESSION timeline; the channels
        // above were just rebased so the earliest one sits at t=0, so the
        // envelope takes the same shift or it would describe the wrong instants.
        const shift = Number.isFinite(minOffset) ? minOffset : 0
        const startMs = (acc.originFrame / acc.sampleRate) * 1000 - shift
        recording.loudness = {
          channelIds: acc.channelIds,
          peak: acc.peak,
          // The statistic the makeup gain actually bounds on. It was measured
          // here from the day it existed and then dropped on the way to the
          // Recording, so every real take fell back to the wide pre-statistic
          // licence — the exact regression the statistic was built to end.
          peakRobust: acc.peakRobust,
          loudRms: acc.loudRms,
          floorRms: acc.floorRms,
          frames: acc.frames,
          ...(acc.windowRms.length > 0
            ? {
                envelope: {
                  windowRms: acc.windowRms,
                  windowPeak: acc.windowPeak,
                  windowMs: acc.windowMs,
                  startMs,
                },
              }
            : {}),
        }
        console.info(
          `[capture] mix loudness measured live: peak ${acc.peak.toFixed(3)} p99win ${acc.peakRobust.toFixed(3)} ` +
            `p90rms ${acc.loudRms.toFixed(4)} ` +
            `p20rms ${acc.floorRms.toFixed(4)} over ${acc.frames} frames${acc.degraded ? ' (degraded alignment)' : ''}` +
            ` — envelope ${acc.windowRms.length} windows from ${Math.round(startMs)} ms`,
        )
      } else {
        console.info(
          `[capture] mix loudness discarded: measured [${acc.channelIds.join(',')}] but take kept [${keptAudio.join(',')}]`,
        )
      }
    }

    await compositeStopped
    if (this.compositeResult) {
      const composite = this.compositeResult
      // The composite sits on the SAME timeline as the channels, so it takes
      // the same rebase (P0-instant-sync). Clamped at 0 because a composite
      // that reads a few ms EARLIER than the earliest channel is measurement
      // noise between two first-arrival stamps, not content before the take.
      if (composite.startOffsetMs !== undefined && Number.isFinite(minOffset) && minOffset !== 0) {
        composite.startOffsetMs = Math.max(0, composite.startOffsetMs - minOffset)
      } else if (composite.startOffsetMs !== undefined) {
        composite.startOffsetMs = Math.max(0, composite.startOffsetMs)
      }
      recording.composite = composite
    }

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
    this.resuming.clear()
    this.clearTick()
    this.releaseWakeLock()
    // DEVICES OFF FIRST — before a single await. A cancel throws the take away,
    // so nothing downstream (a recorder that never fires onstop, an
    // AudioWorklet that never delivers a first sample, an OPFS writer that
    // wedges) has any claim on keeping the camera, mic or screen running while
    // it finishes. Releasing used to sit AFTER `await Promise.all(stopped)`
    // with no deadline, so any one of those hanging kept every device live —
    // and left the record button stuck on "Cancelling…", because
    // createCaptureSession awaits this before it rethrows. That is the
    // "I press record again to stop it and the indicator is still there" bug.
    this.releaseMedia()
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
    // Bounded for the same reason doStop's join is: a recorder that never
    // answers must not be able to hold a discarded take open forever. Nothing
    // here gates a device any more (they went off above) — this only decides
    // how long we wait before deleting the scratch files.
    try {
      await withTimeout(
        Promise.all(this.channels.map((c) => c.stopped)),
        CANCEL_STOP_BUDGET_MS,
        'cancel recorder stop',
      )
    } catch (err) {
      console.warn('[capture] a recorder did not stop in budget on cancel — discarding anyway', err)
    }
    // Devices are already off; this sweeps anything that armed while we waited.
    this.releaseMedia()
    // Deleting scratch files is housekeeping, and cancel() is what the record
    // button is waiting on to become pressable again — createCaptureSession
    // awaits it before it rethrows, so an OPFS write chain that never settles
    // here left the UI on "Cancelling…" with no way forward. Bounded; on
    // expiry the cleanup carries on in the background and the user gets their
    // button back. Orphaned scratch blobs are collected on the next launch.
    const cleanup = Promise.all(
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
    try {
      await withTimeout(cleanup, WRITER_CLOSE_BUDGET_MS, 'cancel cleanup')
    } catch (err) {
      console.warn('[capture] cancel cleanup exceeded budget — finishing in the background', err)
      void cleanup.catch(() => undefined)
    }
    this.setState('stopped')
  }
}

/** W1 item 3 — see ProgressiveHandlers.onStall. */
export type DisplayStallHandler = (message: string, stall: DisplayStall) => void

export interface CreateCaptureSessionOptions {
  /** Fired for each permission / device step during arming (UI pending state). */
  onArming?: ArmingProgressHandler
  /**
   * The screen request has been outstanding for DISPLAY_STALL_NOTICE_MS and is
   * STILL RUNNING. Fires at most once per take. The UI shows it as a sticky
   * notice: when the cause is an ungranted macOS permission, Chrome has the
   * real answer on screen and the app used to say nothing for 30 s (W1).
   */
  onStall?: DisplayStallHandler
  /**
   * Abort arming. Until this existed the user had no way out of a slow or
   * wedged device: the record button is disabled while arming, so a step that
   * never returned read as "the app is frozen" (Robert-hit 2026-08-23). Aborting
   * releases every device the attempt had already taken.
   */
  signal?: AbortSignal
}

export async function createCaptureSession(
  config: CaptureConfig,
  opts?: CreateCaptureSessionOptions,
): Promise<CaptureSession> {
  const session = new Session(config, opts?.onArming, opts?.onStall)
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
    // Whether arm() failed or the user cancelled, nothing may keep a device —
    // and cancel() turns them all off SYNCHRONOUSLY, before its first await,
    // so the guarantee holds without waiting for the promise. What remains in
    // there is scratch-file cleanup, and holding the record button hostage to
    // a slow disk is how "Cancelling…" became its own stuck state.
    void session.cancel().catch(() => undefined)
    throw err
  }
  if (signal.aborted) {
    void session.cancel().catch(() => undefined)
    throw new DOMException('Recording start cancelled', 'AbortError')
  }
  return session
}
