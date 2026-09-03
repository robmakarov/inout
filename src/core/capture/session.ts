import { newId } from '@core/id'
import { isAppleWebKit } from '@core/capabilities'
import { aspectOf, frameForAspect, sourceFrameEnabled, sourceResEnabled } from '@core/frame'
import { DEFAULT_FRAME_RATE, normalizeRate, sourceRateEnabled } from '@core/rate'
import { loadQualityStep } from '@core/qualityStep'
import { noteTakeActive } from '@core/backgroundWork'
import { startElasticLog, takeElasticLog } from '@core/elasticLog'
import {
  armDoor,
  constrainThroughDoor,
  measuredFromSettings,
  openDoor,
  passDoor,
  takeDoorLog,
} from '@core/door'
import { rebasedCompositeOffsetMs } from '@core/compose/compositeTime'
import { singleGenCaptureEnabled } from '@core/singleGen'
import { captureQualityMode, preemptiveRefusalAllowed, rateLadderAllowed } from './captureQuality'
import {
  FLOOR_FPS,
  emergencyFloorEnabled,
  floorLongEdge,
  type FloorRung,
  type FloorState,
} from './emergencyFloor'
import { FloorController } from './floorController'
import type { PressureSignals } from '@core/pressure'
import { AUDIO_BITS, videoBitsFor } from './captureBitrate'
import { diskVerdict } from './diskGuard'
import {
  differsMeaningfully,
  resolutionStepEnabled,
  stepVerdict,
  type SegmentGeometry,
} from './resolutionStep'
import { containVerdict, exhaustedWhy, type ContainCause } from './segmentContain'
import { faultDelayMs, slowStopMs } from './faultInject'
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
  CameraPose,
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
import { DRAIN_BUDGET_MS, drainRecorder } from './recorderDrain'
import {
  MEASURED_VIDEO_MIME,
  canMeasureVideoCapture,
  startMeasuredVideoCapture,
  type MeasuredVideoHandle,
} from './measuredVideo'
import { canLiveCompositeV2, startLiveCompositeV2 } from './liveCompositeV2'
import type { LadderRung, LadderStepMeta } from './captureLadder'
import { preferredCompositeEngine } from './engine'
import { MixLoudnessAccumulator } from './loudnessAccumulator'
import { clearPendingManifest, probeDurationMs, writePendingManifest } from './recovery'
import { crashFloorEnabled, EARLY_FRAGMENT_S } from './crashFloor'
import { keepChannel } from './keptOnDisk'
import { releaseEncoderWarmYield, yieldEncoderWarmToTake } from './encoderWarmYield'
import { armSyntheticDeaths, createSyntheticChannelsProgressive, isSyntheticMode } from './synthetic'
import type { LivenessEvent } from './sourceLiveness'

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
 * M1 — how often the platform-adaptation witness looks at a track. One second,
 * and it is a witness rather than a control loop: nothing acts on what it sees,
 * so looking faster would only cost the take. Chrome's own adaptation is not a
 * transient either — a surface it narrowed stays narrow.
 */
const ADAPT_CHECK_MS = 1_000
/**
 * Deadlines on the stop path, for the same reason arming has them (note 3): a
 * recorder that never answers must not be able to freeze a finished take.
 */
const STOP_BUDGET_MS = 5000
/**
 * H4/B4 — HOW LONG STOP WAITS FOR A CHANNEL'S START TO SETTLE.
 *
 * `measuredStarting` for a video channel resolves only after its FIRST FRAME
 * (session.startMeasuredVideo awaits `handle.firstOffset` to stamp the offset),
 * so a source that never delivers one leaves it pending for the life of the
 * take. Stop awaited it unbounded, which is B4's "times the recorder stop out
 * after 5 s" verbatim — measured on prod 2026-09-01 with `?dead=camera`:
 * `a recorder did not stop in budget`, 6.4 s to the editor, while the healthy
 * screen channel beside it returned its stats normally.
 *
 * The handle is built and assigned BEFORE that await, so by the time stop runs
 * there is an encoder to stop whether or not a frame ever arrived. This wait is
 * only for the case where the handle itself is still being constructed, which
 * takes milliseconds. When it expires, stop proceeds with whatever exists — the
 * outer STOP_BUDGET_MS is still there for anything genuinely stuck.
 */
const MEASURED_START_SETTLE_MS = 1000
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
/**
 * H5 — how long the take may spend asking the FILE how long it is, for a
 * channel whose stop reply never came. It is a demux of an index that is
 * already on disk, so it is fast; the deadline exists because a truncated
 * fragmented MP4 is exactly the kind of file a reader can get lost in, and a
 * take that is otherwise finished must never wait on one.
 */
const DISK_TRUTH_BUDGET_MS = 5_000

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
      : { audioBitsPerSecond: AUDIO_BITS }
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
  /**
   * M1 — WHAT THIS TRACK LAST LOOKED LIKE WHEN SOMEBODY LOOKED ON PURPOSE.
   *
   * Chrome adapts a capture source on its own — it narrows a display surface or
   * drops a camera's rate under load, and nothing asks us. That decision cannot
   * be OWNED (it is the browser's), so the door's answer is to DETECT it: this
   * is the last settings any decision of ours produced, and a difference from
   * it at tick time is the platform having moved something. Undefined until the
   * channel is activated.
   */
  seen?: { width?: number; height?: number; frameRate?: number }
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
    // B13. The companion to the line above, and it must travel WITH it: the
    // reported latency alone cannot say whether it was subtracted, so a take
    // recorded under `?looplat=0` and one recorded normally would persist an
    // identical anchor block. This merge rebuilds the anchor field by field,
    // so a field not named here is a field the take never carries.
    ...(existing?.inputLatencyApplied !== undefined
      ? { inputLatencyApplied: existing.inputLatencyApplied }
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
  /** S1 — the first thing this take gave up, kept so the report card can name
   *  it. `collapseRecorded` is a latch and says only THAT something did. */
  private collapseWhy: string | null = null
  /** S1 — the last storage sample the disk guard took while this take ran.
   *  Kept rather than discarded; nothing extra is asked of the machine. */
  private lastStorage: { usageBytes: number; quotaBytes: number } | null = null
  /** O16 — when the screen's delivered size first stopped matching the size its
   *  current segment's encoder was opened at. Null while they agree. */
  private sizeDifferingSinceMs: number | null = null
  /** B5 — the disk is asked every few seconds, not every tick. */
  private lastDiskCheckMs = 0
  /** M1 — the platform-adaptation witness's own clock (see watchPlatformAdaptation). */
  private lastAdaptCheckMs = 0
  /**
   * M1 — THE EMERGENCY FLOOR. Null on every take that is not max with `?floor=1`,
   * which is every take until Robert flips it.
   */
  private floor: FloorController | null = null
  /** What the floor has actually spent, on the take's own terms. */
  private floorScreenFps = 0
  private floorCameraFps: number | null = null
  private floorScreenLongEdge: number | null = null
  private floorRequestedLongEdge: number | null = null
  private floorCameraRequestedFps: number | null = null
  /** One rung at a time: an application in flight is not a reason to start a
   *  second (the ladder's settle rule assumes the step landed). */
  private floorApplying = false
  /** B5 — the origin's storage usage at this take's FIRST sample, and when it
   *  was taken. The growth since is what this take has actually consumed. */
  private diskBaseline: { usageBytes: number; atMs: number } | null = null
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
  /**
   * H4 — THE LOSS LEDGER. One entry per channel that stopped being a source
   * while the take ran: its track ended, or it never delivered a frame at all.
   * Timestamped on the session clock here and rebased with the channels at
   * stop, so `Recording.lost` reads on the same timeline as the files.
   * FIRST WRITE WINS: a camera that is unplugged after it was already certified
   * dead lost nothing new at that instant.
   */
  private readonly losses = new Map<ChannelKind, { atMs: number; reason: 'ended' | 'never-delivered' }>()
  /** H4 harness (`?die=`): cancels the scheduled synthetic track deaths. */
  private cancelDeaths: (() => void) | null = null
  /**
   * H1 — THE SEAM LEDGER. One entry per contained component death: the segment
   * that died, the one that replaced it, and the hole between them. Stamped on
   * the session clock here and rebased with the channels at stop, exactly as
   * `losses` is, so `Recording.seams` reads on the same timeline as the files.
   */
  private readonly seams: { kind: ChannelKind; atMs: number; gapMs: number; cause: ContainCause }[] =
    []
  /** H1 — contains spent per kind, against segmentContain's MAX_PER_CHANNEL. */
  private readonly containsTaken = new Map<ChannelKind, number>()
  /** H1 — when each kind was last contained, against the cooldown. */
  private readonly lastContainAtMs = new Map<ChannelKind, number>()
  /** H1 — kinds mid-contain. One reopen at a time per kind, like resStepping. */
  private readonly containing = new Set<ChannelKind>()
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
    // M1 — THE DOOR OPENS WITH THE ARM, NOT WITH THE PRESS. The two most
    // consequential decisions this engine makes about a take are taken before
    // it has a clock: O15's encoder budget narrows the screen, and F15's rate
    // budget holds the frame rate down, both inside this method. They read as
    // negative milliseconds in the take's ledger, which is what they are.
    armDoor()
    // H6 — THE WARM STANDS DOWN, HERE, SYNCHRONOUSLY, BEFORE ANY AWAIT.
    // encoderWarm.ts pays the process's first-VideoEncoder cost at mount so a
    // take does not; press record while it is still paying and the two fight
    // over the same hardware instead, which is how a take pressed at app load
    // ended up with no picture on disk at all for six seconds. This costs a
    // boolean and it is the earliest instant a take is committed.
    yieldEncoderWarmToTake()
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
        wedged.stall === 'permission'
          ? 'permission'
          : wedged.stall === 'stale'
            ? 'stale'
            : wedged.stall === 'busy'
              ? 'busy'
              : 'wedged',
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
        // H1 — the fallback lane gets the same containment as the measured
        // ones. Before this, a MediaRecorder that errored mid-take produced a
        // toast and a channel that was over; the device it was reading is
        // untouched by its own recorder failing.
        if (this.stateInternal === 'recording') void this.containSegment(rt, 'recorder-error')
        else this.emit({ type: 'channel-error', kind: rt.kind, message })
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
    step: LadderStepMeta,
    /** M1 — WHO ASKED. The ladder is one caller; the emergency floor is the
     *  other, and a take that reads `[floor]` against a step is a take that can
     *  be told apart from one the composite's ladder moved. */
    decidedBy: 'ladder' | 'floor' = 'ladder',
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
      //
      // M1 — AND IT GOES THROUGH THE DOOR, which is where the elastic ledger's
      // picture line is now written: at the act, with the outcome, instead of
      // at the verdict (liveCompositeV2's note on `onDegradeStep`).
      const after = await passDoor(
        {
          dial: 'rate',
          decidedBy,
          layer: 'picture',
          action: step.direction === 'down' ? 'shed' : 'restore',
          what: `${step.previousFps} → ${rung.fps} fps`,
          why: reason,
          ...(step.block ? { block: step.block } : null),
          ...(step.level ? { level: step.level } : null),
          measured: measuredFromSettings(before),
        },
        async (ticket) => {
          await withTimeout(
            constrainThroughDoor(ticket, ch.track, { frameRate: { max: rung.fps } }),
            THROTTLE_BUDGET_MS,
            `${ch.kind} to ${rung.label}`,
          )
          const settings = ch.track.getSettings()
          // WHAT THE PLATFORM ACTUALLY GAVE, not what was asked for. Chrome
          // agrees to a constraint and then hands back something else often
          // enough that this is the difference between a ledger and a wish.
          ticket.note({ fpsAfter: settings.frameRate ?? null })
          return settings
        },
      )
      // M1 — this is OUR change, so the platform-adaptation witness must not
      // report it as Chrome's a second later.
      ch.seen = { width: after.width, height: after.height, frameRate: after.frameRate }
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

  // ---- M1: THE EMERGENCY FLOOR ---------------------------------------------
  /**
   * IS THE FLOOR ARMED? Max, and the flag, and nothing else. Off, every line
   * below is unreachable and max is the max that shipped — the raw worker is
   * not even asked to sample, so there is no ticker and no counters.
   */
  private floorArmed(): boolean {
    return captureQualityMode() === 'max' && emergencyFloorEnabled()
  }

  /** What the floor has to work with, read fresh: a channel can end mid-take. */
  private floorState(): FloorState {
    const camera = this.channels.find((c) => c.kind === 'camera' && c.media === 'video' && !c.ended)
    return {
      cameraFps: camera ? this.floorCameraFps : null,
      cameraRequestedFps: camera ? this.floorCameraRequestedFps : null,
      screenFps: this.floorScreenFps || this.requestedRate,
      screenRequestedFps: this.requestedRate,
      screenLongEdge: this.floorScreenLongEdge,
      screenRequestedLongEdge: this.floorRequestedLongEdge,
    }
  }

  /**
   * ONE READING FROM THE SCREEN'S ENCODER. Four a second, from the worker that
   * is doing the encoding — the thread whose contention is the thing that
   * starves a max take (core/pressure.ts's probe: the page's own main thread is
   * clamped to 1 Hz while a take runs, and cannot see any of this).
   */
  private onFloorPressure(signals: PressureSignals): void {
    if (this.stateInternal !== 'recording') return
    const now = performance.now()
    if (!this.floor) {
      const screen = this.channels.find((c) => c.kind === 'screen' && c.media === 'video' && !c.ended)
      const camera = this.channels.find((c) => c.kind === 'camera' && c.media === 'video' && !c.ended)
      this.floorScreenFps = screen?.fps ?? this.requestedRate
      this.floorScreenLongEdge = screen ? Math.max(screen.width ?? 0, screen.height ?? 0) : null
      this.floorRequestedLongEdge = this.floorScreenLongEdge
      this.floorCameraFps = camera?.fps ?? null
      this.floorCameraRequestedFps = this.floorCameraFps
      this.floor = new FloorController({ startedAtMs: this.epoch, requestedFps: this.requestedRate })
    }
    const tick = this.floor.tick(now, signals, this.floorState())
    if (!tick.action || this.floorApplying) return
    this.floorApplying = true
    void this.applyFloorRung(tick.action.rung, tick.action.direction, tick.action.reason, tick.action.step)
      .then(() => {
        this.floor?.noteApplied(performance.now(), tick.action!.direction)
      })
      .finally(() => {
        this.floorApplying = false
      })
  }

  /**
   * SPEND (or GIVE BACK) ONE RUNG, through the door like everything else.
   *
   * AUDIO IS NOT REACHABLE FROM HERE. There is no branch for it, in either
   * direction, and emergencyFloor.ts's order has no name for it — the ruling is
   * that audio is never sacrificed, and the way to keep a ruling is to make the
   * code that would break it not exist.
   */
  private async applyFloorRung(
    rung: FloorRung,
    direction: 'down' | 'up',
    reason: string,
    step: LadderStepMeta,
  ): Promise<void> {
    if (rung === 'screen-fps') {
      const target = direction === 'down' ? FLOOR_FPS : this.requestedRate
      await this.stepDisplayDown({ label: `${target} fps`, fps: target }, reason, step, 'floor')
      this.floorScreenFps = target
      return
    }
    if (rung === 'camera-fps') {
      const ch = this.channels.find((c) => c.kind === 'camera' && c.media === 'video' && !c.ended)
      if (!ch) return
      const target = direction === 'down' ? FLOOR_FPS : (this.floorCameraRequestedFps ?? this.requestedRate)
      const before = ch.track.getSettings()
      try {
        await passDoor(
          {
            dial: 'rate',
            decidedBy: 'floor',
            layer: 'picture',
            action: direction === 'down' ? 'shed' : 'restore',
            what: `camera ${step.previousFps} → ${target} fps`,
            why: reason,
            ...(step.block ? { block: step.block } : null),
            ...(step.level ? { level: step.level } : null),
            measured: measuredFromSettings(before),
          },
          async (ticket) => {
            await withTimeout(
              constrainThroughDoor(ticket, ch.track, { frameRate: { max: target } }),
              THROTTLE_BUDGET_MS,
              `camera to ${target} fps`,
            )
            const after = ch.track.getSettings()
            ticket.note({ fpsAfter: after.frameRate ?? null })
            ch.seen = { width: after.width, height: after.height, frameRate: after.frameRate }
          },
        )
        this.floorCameraFps = target
      } catch (err) {
        console.warn('[capture] the floor could not move the camera rate', err)
      }
      return
    }
    // RESOLUTION, LAST, and it is the only rung that costs a seam: the raw
    // encoder is configured once and cannot follow a frame-size change, so the
    // segment has to close and reopen (O16 — 30 ms step, 69 ms seam). That is
    // why it sits below both rate rungs and why it is spent once.
    const ch = this.channels.find((c) => c.kind === 'screen' && c.media === 'video' && !c.ended)
    if (!ch) return
    const current = Math.max(ch.width ?? 0, ch.height ?? 0)
    const target = direction === 'down' ? floorLongEdge(current) : this.floorRequestedLongEdge
    if (!target) return
    const before = ch.track.getSettings()
    try {
      await passDoor(
        {
          dial: 'resolution',
          decidedBy: 'floor',
          layer: 'picture',
          action: direction === 'down' ? 'shed' : 'restore',
          what: `screen long edge ${current} → ${target}`,
          why: `${reason} — the rate rungs are spent, so the size moves (LAST)`,
          ...(step.block ? { block: step.block } : null),
          ...(step.level ? { level: step.level } : null),
          measured: measuredFromSettings(before),
        },
        async (ticket) => {
          await withTimeout(
            constrainThroughDoor(ticket, ch.track, {
              width: { max: target },
              height: { max: target },
            }),
            THROTTLE_BUDGET_MS,
            `screen to a ${target} long edge`,
          )
          const after = ch.track.getSettings()
          ticket.note({ widthAfter: after.width ?? null, heightAfter: after.height ?? null })
          ch.seen = { width: after.width, height: after.height, frameRate: after.frameRate }
        },
      )
      // The file cannot change size mid-segment, so close this one and open the
      // next at the size the source is now delivering — the move O16 built.
      await this.stepScreenSegment(`the emergency floor stepped the size: ${reason}`)
      const now = this.channels.find((c) => c.kind === 'screen' && c.media === 'video' && !c.ended)
      this.floorScreenLongEdge = now ? Math.max(now.width ?? 0, now.height ?? 0) : target
    } catch (err) {
      console.warn('[capture] the floor could not move the screen size', err)
    }
  }

  /**
   * @param blameEncoder O15's budget files a permanent "this machine collapsed
   * at N Mpx/s" mark against the plan, so an equal or larger take is bounded
   * before it starts. That is right when the COMPOSITE gave up — "a composite
   * that produces nothing in its first second never produces anything" — and
   * wrong when a DEVICE died. Measured on prod 2026-09-01: a camera that
   * delivered no frames filed `this machine collapsed at 99.1 Mpx/s`, and a
   * shut laptop lid would have bounded every later take on that machine. The
   * composite is still unusable either way (there is no picture to copy); it
   * simply is not evidence about the encoder.
   */
  private markCompositeUnusable(reason: string, blameEncoder = true): void {
    if (this.compositeInvalid) return
    this.compositeInvalid = true
    // M1, AUDIT ITEM (d) — SILENCE ONLY. Robert's split of 2026-09-02: this
    // behaviour is CORRECT (the take is unharmed, the unedited export renders
    // instead of copying), and what was wrong was that it happened with no
    // flag, no grade and no line anywhere a take could be read from. So it is
    // not changed, it is announced — through the door, like everything else.
    passDoor(
      {
        dial: 'channels',
        decidedBy: blameEncoder ? 'watchdog' : 'device',
        action: 'shed',
        what: 'the live composite stopped being recorded',
        why: reason,
        measured: { blamedOnTheEncoder: blameEncoder },
      },
      () => undefined,
    )
    console.info(`[capture] composite unusable (${reason}) — unedited export will render`)
    if (blameEncoder) this.noteEncoderCollapse(`the composite degraded: ${reason}`)
    else console.info(`[capture] not an encoder collapse (${reason}) — the budget is untouched`)
  }

  /**
   * H4 — file one channel's death, once, on the session clock. `stalledEver`
   * has always recorded WHICH channel; this records WHEN, which is the half
   * that makes a take readable afterwards: a mic lost at minute 40 of an hour
   * and one lost at second 3 are different takes and the files look the same.
   */
  private noteLoss(kind: ChannelKind, reason: 'ended' | 'never-delivered'): void {
    if (this.losses.has(kind)) return
    const atMs = reason === 'never-delivered' ? 0 : Math.max(0, performance.now() - this.epoch)
    this.losses.set(kind, { atMs, reason })
    console.warn(`[capture] ${kind} lost at +${Math.round(atMs)}ms (${reason}) — the take continues`)
  }

  /** A video source froze (or came back). The take continues — audio and the
   * other channels are unaffected — but the frozen stretch is a still image, so
   * the composite can't be copied and the user has to be told. */
  private onSourceLiveness(kind: ChannelKind, event: LivenessEvent): void {
    if (this.stateInternal !== 'recording') return
    // A CHANNEL THAT HAS ENDED IS NOT FROZEN, AND SAYING SO SENDS THE USER TO
    // THE WRONG FIX. Measured on prod 2026-09-01 with ?die=camera:14000: the
    // track ends, `readyState` stops being 'live', the frozen-source rule reads
    // that as a sick source and three seconds later the band says "Camera
    // frozen — re-share your whole screen to fix it" over an unplugged camera.
    // The end is already certified with its instant; the freeze rule has
    // nothing left to add about a source that is gone.
    if (this.channels.some((c) => c.kind === kind && c.ended)) return
    if (event === 'dead') {
      // H4/B4: live, unmuted, correctly negotiated — and not one frame. The
      // take goes on (the other channels are fine and this one was never
      // giving anything up), but it is certified from here and said on screen.
      if (this.stalledNow.has(kind)) return
      this.stalledNow.add(kind)
      // NOT `stalledEver`. That set means "froze mid-take — those stretches are
      // a still image", which the report card says in those words; a source
      // that never delivered one frame did not freeze and has no still image
      // in the file. The loss ledger is what carries this one.
      this.noteLoss(kind, 'never-delivered')
      this.markCompositeUnusable(`${kind} never delivered a frame`, false)
      this.emit({ type: 'channel-dead', kind })
      return
    }
    if (event === 'stalled') {
      if (this.stalledNow.has(kind)) return
      this.stalledNow.add(kind)
      this.stalledEver.add(kind)
      this.markCompositeUnusable(`${kind} source stalled`, false)
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
    // E2 — the take's elastic ledger opens with the take, on the take's own
    // clock, so every shed and every recovery is stamped relative to a press
    // rather than to a page load.
    startElasticLog(this.epoch)
    // M1 — and the door takes the same clock, so an arming decision reads
    // negative against the press and a step at minute 40 reads +2,400,000.
    openDoor(this.epoch)

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
    // H4 harness (`?die=`): the deaths are scheduled from the PRESS, not the
    // arm, so a death at +20 s lands inside the take instead of during arming.
    if (isSyntheticMode()) this.cancelDeaths = armSyntheticDeaths(this.channels)
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
      // M1 — THROUGH THE DOOR. This one is taken before the take has a clock and
      // was invisible in every ledger the product had: a machine that once
      // collapsed silently stopped recording a whole channel on every later
      // take, and the only trace was one console line nobody reads.
      passDoor(
        {
          dial: 'channels',
          decidedBy: 'budget',
          action: 'shed',
          what: 'the live composite is not opened at all on this take',
          why: drop.why,
          measured: {
            ceilingMpxPerS: ceiling / 1e6,
            plannedMpxPerS: plan.pixelRate / 1e6,
            newPlanMpxPerS: drop.plan.pixelRate / 1e6,
          },
        },
        () => undefined,
      )
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
      const before = screenCh.track.getSettings()
      const after = await passDoor(
        {
          dial: 'resolution',
          decidedBy: 'budget',
          action: 'shed',
          what: `screen ${screen.width}x${screen.height} → long edge ${verdict.screenLongEdge}`,
          why: verdict.why,
          measured: {
            ...measuredFromSettings(before),
            ceilingMpxPerS: ceiling / 1e6,
            plannedMpxPerS: workingPlan.pixelRate / 1e6,
          },
        },
        async (ticket) => {
          await withTimeout(
            constrainThroughDoor(ticket, screenCh.track, {
              width: { max: verdict.screenLongEdge },
              height: { max: verdict.screenLongEdge },
            }),
            THROTTLE_BUDGET_MS,
            'applyConstraints(encoder budget)',
          )
          const settings = screenCh.track.getSettings()
          ticket.note({ widthAfter: settings.width ?? null, heightAfter: settings.height ?? null })
          return settings
        },
      )
      // The runtime's own dimensions are what singleGenerationTake and
      // compositeFrame read, so they have to follow the track or the take
      // would be planned at one size and recorded at another.
      screenCh.width = after.width ?? screenCh.width
      screenCh.height = after.height ?? screenCh.height
      // M1 — ours, not the platform's (watchPlatformAdaptation).
      screenCh.seen = { width: after.width, height: after.height, frameRate: after.frameRate }
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
    this.collapseWhy = reason
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
    const onSourceLiveness = (kind: 'screen' | 'camera', event: LivenessEvent): void =>
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
        onDegradeStep: (rung, reason, from, step) => {
          // MAX MODE DOES NOT STEP. The ladder still MEASURES — its verdict is
          // what tells the take it is behind, and O15 still files the collapse
          // against the plan — but nothing is taken away from the picture the
          // user asked for. What they get instead is dropped frames, reported
          // rather than hidden, which is the price max exists to let them pay.
          if (!rateLadderAllowed()) {
            // M1 — A REFUSAL IS A DECISION. It used to be silent here while the
            // elastic ledger, written one function earlier, said the picture
            // had stepped: every loaded max take claimed a shed that never
            // happened. Now the take says the ladder asked and max said no.
            passDoor(
              {
                dial: 'rate',
                decidedBy: 'ladder',
                layer: 'picture',
                action: step.direction === 'down' ? 'shed' : 'restore',
                what: `${step.previousFps} → ${rung.fps} fps (${from})`,
                why: reason,
                ...(step.block ? { block: step.block } : null),
                ...(step.level ? { level: step.level } : null),
              },
              (ticket) =>
                ticket.refuse(
                  'max mode: nothing steps down in max (Robert 2026-08-30, "max must not have ladder")',
                ),
            )
            this.noteEncoderCollapse(`the rate ladder wanted to step: ${reason}`)
            return
          }
          void this.stepDisplayDown(rung, reason, step)
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
        // H1 harness: only ever a number when a URL flag named this kind, and
        // only on the segment whose window the named instant falls inside.
        killEncoderInMs: faultDelayMs(ch.kind, 'killenc', performance.now() - this.epoch) ?? undefined,
        killWorkerInMs: faultDelayMs(ch.kind, 'killworker', performance.now() - this.epoch) ?? undefined,
        // H2b(b): the first fragment closes at 1 s instead of at the 2 s GOP,
        // so a crash in the first seconds leaves decodable picture rather than
        // audio alone. `?crashfloor=0` restores the shipped cadence.
        earlyFragmentSec: crashFloorEnabled() ? EARLY_FRAGMENT_S : undefined,
        /**
         * H1 — THE SEGMENT IS CONTAINED, NOT MOURNED. This used to be one
         * toast and a channel that quietly stopped writing while the take ran
         * on for another forty minutes. The track is still live — nothing
         * about a dead encoder killed the camera — so close this segment and
         * open the next one on it.
         */
        onFatal: (err, cause) => {
          if (this.stateInternal !== 'recording') return
          console.error(`[capture] ${ch.kind} ${cause}: ${err.message}`)
          void this.containSegment(ch, cause)
        },
        // M1 — THE EMERGENCY FLOOR'S INSTRUMENT, on the screen channel only and
        // only when the floor is armed (max, `?floor=1`, OFF by default). The
        // screen is the encoder that decides whether a max take survives; the
        // camera is an inset. With the floor off this is `undefined` and the
        // worker never starts a ticker.
        ...(this.floorArmed() && ch.kind === 'screen'
          ? {
              pressure: true,
              onPressure: (signals: PressureSignals) => this.onFloorPressure(signals),
            }
          : null),
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
        // B13. Tab / system audio is an internal loopback: no microphone, no
        // device buffer, nothing physical to be late by. Descriptive unless
        // `?looplat=0` is set — see measuredAudio.subtractsInputLatency.
        loopback: ch.kind === 'system-audio',
        audioCtx: ch.audioCtx ?? undefined,
        // H1 harness. An audio channel has no worker, so only `?killenc=`.
        killEncoderInMs: faultDelayMs(ch.kind, 'killenc', performance.now() - this.epoch) ?? undefined,
        /** H1 — contained exactly as a video encoder death is (see there). */
        onFatal: (err) => {
          if (this.stateInternal !== 'recording') return
          console.error(`[capture] ${ch.kind} encoder-error: ${err.message}`)
          void this.containSegment(ch, 'encoder-error')
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

  /** UI1: where the camera PiP has been dragged to during this take. */
  private cameraPose: CameraPose | null = null

  setCameraPose(pose: CameraPose | null): void {
    this.cameraPose = pose
    this.composite?.setCameraPose?.(pose)
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
    /**
     * F16b — TELL BACKGROUND WORK A TAKE IS HAPPENING.
     *
     * The pressure readings say how hard the machine is breathing; this says
     * whether anything is at stake. They are separate facts and the broker
     * needs both: a reading that stops arriving during a take is blind (shed),
     * where the same silence with no take running is simply idle (full speed).
     * `paused` counts as active — the devices are still held and the take is
     * still coming back.
     */
    noteTakeActive(s === 'recording' || s === 'paused' || s === 'stopping')
    this.emit({ type: 'state', state: s })
  }

  private clearTick(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    // H4 harness: a take that stops before a scheduled death takes its timers
    // with it, so nothing kills a track belonging to the next take.
    this.cancelDeaths?.()
    this.cancelDeaths = null
  }

  private onTick(): void {
    if (this.stateInternal !== 'recording') return
    const elapsedMs = performance.now() - this.epoch
    const remainingMs = MAX_RECORDING_MS === null ? null : Math.max(0, MAX_RECORDING_MS - elapsedMs)
    this.emit({ type: 'tick', elapsedMs, remainingMs })
    if (remainingMs !== null && remainingMs <= 0) return this.autoStop()
    this.watchScreenSize()
    this.watchPlatformAdaptation()
    this.watchDisk()
  }

  /**
   * M1 — CHROME'S OWN CAPTURE ADAPTATION: DETECTED, BECAUSE IT CANNOT BE OWNED.
   *
   * The audit of 2026-09-02 counted seven adaptive systems and this is the
   * seventh: the browser narrows or slows a capture source on its own
   * (acquire.ts:467 and 614 are the two places the code already knows it
   * happens), and no ladder, budget or watchdog of ours is involved. There is
   * no door to route it through — nobody here decides it. What there can be is
   * a witness, so that "the take was recorded at 24 fps" stops being a mystery
   * in the numbers and becomes a line saying WHO did it.
   *
   * The comparison is against what OUR OWN last decision produced (`ch.seen`,
   * written by every door application that touches this track), so a rate step
   * we asked for is never reported as the platform's.
   *
   * ONE getSettings() PER VIDEO CHANNEL PER SECOND, on a tick that already runs
   * four times a second for the timer. It is a dictionary copy, it happens on
   * the thread that is NOT encoding, and it is the whole cost of the detector.
   */
  private watchPlatformAdaptation(): void {
    const now = performance.now()
    if (now - this.lastAdaptCheckMs < ADAPT_CHECK_MS) return
    this.lastAdaptCheckMs = now
    for (const ch of this.channels) {
      if (ch.media !== 'video' || ch.ended) continue
      const s = ch.track.getSettings()
      const seen = ch.seen
      if (!seen) {
        ch.seen = { width: s.width, height: s.height, frameRate: s.frameRate }
        continue
      }
      const sizeMoved =
        (s.width !== undefined && seen.width !== undefined && s.width !== seen.width) ||
        (s.height !== undefined && seen.height !== undefined && s.height !== seen.height)
      // A frame rate is a float that wobbles; only a real step is a step.
      const rateMoved =
        s.frameRate !== undefined &&
        seen.frameRate !== undefined &&
        Math.abs(s.frameRate - seen.frameRate) > 1
      if (!sizeMoved && !rateMoved) continue
      const smaller = sizeMoved
        ? (s.width ?? 0) * (s.height ?? 0) < (seen.width ?? 0) * (seen.height ?? 0)
        : (s.frameRate ?? 0) < (seen.frameRate ?? 0)
      passDoor(
        {
          dial: sizeMoved ? 'resolution' : 'rate',
          decidedBy: 'chrome',
          action: smaller ? 'shed' : 'restore',
          what:
            `${ch.kind} track moved on its own: ${seen.width ?? '?'}×${seen.height ?? '?'}` +
            `@${seen.frameRate ?? '?'} → ${s.width ?? '?'}×${s.height ?? '?'}@${s.frameRate ?? '?'}`,
          why: 'the platform changed the source without being asked — detected, not decided',
          measured: {
            widthBefore: seen.width ?? null,
            heightBefore: seen.height ?? null,
            fpsBefore: seen.frameRate ?? null,
            ...measuredFromSettings(s),
          },
          nowMs: now,
        },
        () => undefined,
      )
      ch.seen = { width: s.width, height: s.height, frameRate: s.frameRate }
    }
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
  private watchDisk(): void {
    const now = performance.now()
    if (now - this.lastDiskCheckMs < DISK_CHECK_MS) return
    this.lastDiskCheckMs = now
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return
    void navigator.storage
      .estimate()
      .then((est) => {
        if (this.stateInternal !== 'recording') return
        const usage = est.usage ?? 0
        // S1: the answer is already here — keep it for the report card instead
        // of throwing it away after the verdict below.
        this.lastStorage = { usageBytes: usage, quotaBytes: est.quota ?? 0 }
        const baseline = (this.diskBaseline ??= { usageBytes: usage, atMs: now })
        /**
         * WHAT THIS TAKE HAS ACTUALLY WRITTEN — and the channel counters alone
         * cannot say (found while gating B5, 2026-09-01).
         *
         * `rt.bytes` is accumulated in `ondataavailable`, which is the
         * MediaRecorder path. The DEFAULT path has not been that for months:
         * measured audio and X6's raw video both write through their own
         * workers and report their size only when the handle STOPS. So on a
         * normal take the sum below is zero or near it, `diskVerdict` refuses
         * to judge a take with no rate, and this guard has been silently blind
         * on the very takes it was built for — Robert's 1,138 MB one included.
         * The composite was never counted on any path.
         *
         * The origin's own usage growth sees all of it, whoever wrote it. A
         * parallel export writing OPFS scratch inflates it and the message then
         * misattributes the rate — but the headroom it computes is still the
         * true one, because that disk really is filling that fast. Erring
         * toward "less room than you think" is the safe direction for a guard
         * whose failure mode is a lost take.
         */
        const grown = Math.max(0, usage - baseline.usageBytes)
        const counted = this.channels.reduce((n, c) => n + c.bytes, 0)
        const takeBytes = Math.max(grown, counted)
        const v = diskVerdict({
          usageBytes: usage,
          quotaBytes: est.quota ?? 0,
          takeBytes,
          takeMs: now - baseline.atMs,
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

  /**
   * H1 — A COMPONENT DEATH IS A SEAM, NOT A DEAD TAKE.
   *
   * The encoder failed, or the worker died, or the recorder errored. Until this
   * method the answer was one toast — "saved up to this point only" — and a
   * channel that stopped writing while the take went on believing it was
   * recording. The answer now is O16's move with a different trigger: close the
   * segment, keep the DEVICE (which is still perfectly alive — nothing about a
   * dead encoder killed the camera), open segment N+1 on the same track, and
   * write down the hole.
   *
   * WHY THIS IS SAFE TO GENERALISE FROM O16, WHICH ONLY EVER STEPPED THE SCREEN:
   * `core/types.ts` has said since 08-23 that a kind may appear as several
   * non-overlapping segments, every consumer resolves by id and window, and
   * `armChannel` is already kind-agnostic — it is the same call the progressive
   * acquirer makes at arm time and the same one `resumeChannel` makes mid-take.
   * The one thing that was NOT kind-agnostic is the loudness fold, which waits
   * on every registered audio contributor and would have been held at a closed
   * segment's last sample for the rest of the take; `retire` is that fix.
   *
   * THE DRAIN IS NOT OPTIONAL, and it is P0-tail-raw's reason again: an encoder
   * still flushing when its successor opens loses whatever it had not caught up
   * on. A dying encoder is exactly the one most likely to be behind, so the
   * budget is waited out here even though the seam pays for it.
   *
   * WHAT IT REFUSES: `segmentContain.containVerdict`. A channel whose encoder
   * dies on every open would otherwise spin, and an hour of that is a take made
   * of rubble. Past the budget the channel is given up the way a dead device is
   * given up — device released, H4's ledger stamped, the take running on with
   * everything else — which is still containment, with the loser named.
   */
  private async containSegment(ch: ChannelRuntime, cause: ContainCause): Promise<void> {
    const kind = ch.kind
    if (this.stateInternal !== 'recording' || this.cancelled) return
    // Already closed by a track end, a pause, a stop or an earlier contain of
    // the same failure — two entry points can report one death (a worker that
    // dies after posting a fatal reports through both), and the second must not
    // spend a budget or open a third segment.
    if (ch.ended) return
    if (this.containing.has(kind)) return
    // The user's own off-switch is never a failure (the same fence onTrackEnded
    // keeps), and neither is a paused take.
    if (this.suspended.has(kind)) return

    const taken = this.containsTaken.get(kind) ?? 0
    const verdict = containVerdict({
      kind,
      cause,
      nowMs: performance.now(),
      lastContainAtMs: this.lastContainAtMs.get(kind) ?? null,
      containsTaken: taken,
    })
    if (!verdict) {
      console.warn(`[capture] ${exhaustedWhy(kind, cause)}`)
      this.emit({
        type: 'channel-error',
        kind,
        message: `${kind} recording failed repeatedly (${cause}) — the take continues without it`,
      })
      // The same teardown a dead device gets: preview dropped, device released
      // (the camera light going out is the honest signal that nothing is being
      // recorded from it), H4's ledger stamped with the instant, auto-stop if
      // this was the last channel standing.
      this.stopChannelNow(kind)
      return
    }

    this.containing.add(kind)
    const t0 = performance.now()
    try {
      const { stream, track, media } = ch
      this.closeSegment(ch)
      // closeSegment hands the track to pausedTracks so a resume() can reopen
      // it. There is no pause here and resume() must not find it.
      this.pausedTracks.delete(kind)
      // A closed AUDIO segment is a finished contributor, not a slow one: leave
      // it registered and the fold stalls at its last sample for the whole take.
      if (media === 'audio' && this.loudness) this.loudness.retire(ch.id)
      await withTimeout(ch.stopped, STOP_BUDGET_MS, 'segment drain').catch((err) =>
        console.warn('[capture] contain: the dead segment did not drain in budget', err),
      )
      if (this.stateInternal !== 'recording' || this.cancelled) return
      if (track.readyState !== 'live') {
        // The DEVICE went too. That is H4's story and it is already told: the
        // track's own 'ended' listener stamps the ledger. Nothing to reopen.
        console.warn(`[capture] contain: ${kind}'s track ended with its encoder — not reopening`)
        return
      }
      const rt = await this.armChannel({ kind, media, stream, track })
      if (this.stateInternal !== 'recording' || this.cancelled) {
        this.discardRuntime(rt)
        return
      }
      this.activateChannel(rt, performance.now())
      // The measured lanes settle their true first-sample offset asynchronously;
      // the seam is not measurable until they have.
      await rt.measuredStarting?.catch(() => undefined)
      this.containsTaken.set(kind, taken + 1)
      this.lastContainAtMs.set(kind, performance.now())
      const closedAt = (ch.startOffsetMs ?? 0) + (ch.durationMs ?? 0)
      const openedAt = rt.startOffsetMs ?? performance.now() - this.epoch
      const gapMs = Math.max(0, Math.round(openedAt - closedAt))
      this.seams.push({ kind, atMs: Math.max(0, closedAt), gapMs, cause })
      this.writeManifest()
      this.emit({ type: 'channel-contained', kind, cause, gapMs })
      console.warn(
        `[capture] contained ${kind} ${cause}: segment ${taken + 1} closed at ` +
          `+${Math.round(closedAt)}ms, segment ${taken + 2} open at +${Math.round(openedAt)}ms — ` +
          `${gapMs}ms seam, reopened in ${(performance.now() - t0).toFixed(0)}ms. The take continues.`,
      )
    } catch (err) {
      // The reopen itself failed. The old segment is already closed, so the
      // channel is over — say it the way a dead device is said rather than
      // leaving a kind that silently stopped halfway.
      console.error('[capture] contain failed — the channel is over', kind, err)
      this.emit({
        type: 'channel-error',
        kind,
        message: `${kind} could not be restarted after ${cause} — saved up to this point only`,
      })
      if (this.stateInternal === 'recording') this.noteLoss(kind, 'ended')
    } finally {
      this.containing.delete(kind)
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
    // H4: EVERY media kind, not only video. A Bluetooth mic that drops at
    // minute 40 ends its track exactly like an unplugged camera, and the audio
    // half of that was the half nothing recorded — the channel simply came back
    // short and no surface said why. `suspended` is the exception and it is the
    // whole exception: a channel the USER switched off mid-take arrives here
    // through stopChannelNow, and reporting that as a loss would be calling the
    // user's own button a failure.
    if (this.stateInternal === 'recording' && !this.suspended.has(rt.kind)) {
      this.noteLoss(rt.kind, 'ended')
    }
    if (rt.media === 'video' && this.stateInternal === 'recording') {
      // The composite goes on repainting a dead track's last frame forever, so
      // it can no longer be copied — that stays, and it is what keeps an
      // unedited export honest.
      this.markCompositeUnusable(`${rt.kind} track ended`, false)
      // NOT `stalledEver`, which the report card renders as "froze mid-take —
      // those stretches are a still image". There are no such stretches in
      // anything that ships: the composite this describes is exactly the file
      // the line above just disqualified, and the channel's own raw file
      // correctly stops at the death. The ledger says what happened, with its
      // instant, and does not need a second sentence contradicting the files.
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
            // H4/B4: bounded — a channel whose first frame never arrived leaves
            // this promise pending forever. See MEASURED_START_SETTLE_MS.
            if (ch.measuredStarting) {
              await withTimeout(
                ch.measuredStarting,
                MEASURED_START_SETTLE_MS,
                `${ch.kind} measured start`,
              ).catch(() => undefined)
            }
            if (ch.measured) {
              const r = await ch.measured.stop()
              /**
               * H5 HARNESS (`?slowstop=`). The file is already written and the
               * reply is already in hand; what is late is this line. That is
               * the whole failure — doStop's 5 s budget expires with `bytes`
               * still 0, and the take used to read that as "recorded nothing"
               * and delete megabytes. Held HERE rather than in the worker so
               * the disk state is identical to a healthy take's, which is what
               * makes the gate mean something.
               */
              const hold = slowStopMs(ch.kind)
              if (hold > 0) {
                console.warn(`[capture] ?slowstop — holding ${ch.kind}'s stop reply ${hold}ms`)
                await new Promise((resolve) => setTimeout(resolve, hold))
              }
              ch.bytes = r.bytes
              ch.durationMs = r.durationMs
              ch.startOffsetMs = r.startOffsetMs
              // F13: the file's own geometry, which is not always the one the
              // track reported at arm time — a phone's settings describe the
              // sensor, the frames are rotated. Every consumer of
              // ChannelRecording.width/height (the single-generation copy, the
              // editor's PiP box) has to be told what was written.
              const st = 'stats' in r ? r.stats : null
              /**
               * H4 — THE AT-STOP VERDICT, AND THE ONLY ONE THAT WORKS EVERYWHERE.
               *
               * The live detector rides the composite's liveness tick, and at
               * quality=max there IS no composite — so on the one path Robert
               * actually records at, nothing was watching. This needs no
               * threshold and no timing judgement: the encoder counted the
               * frames that reached it, and zero in is zero in. `framesIn`
               * rather than `framesEncoded`, because the raw worker synthesises
               * keep-alive frames for a static source and those are output the
               * source never produced.
               */
              if (ch.media === 'video' && st && st.framesIn === 0) {
                this.noteLoss(ch.kind, 'never-delivered')
              }
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
            // M1 — through the door: it is a rate change like any other, and a
            // ledger with a hole where the stop is cannot be read at stop.
            await passDoor(
              {
                dial: 'rate',
                decidedBy: 'drain',
                action: 'set',
                what: `${ch.kind} source throttled to ${TAIL_THROTTLE_FPS} fps for the tail drain`,
                why: 'P0-tail: a MediaRecorder backlog can only be drained if the source stops feeding it',
                measured: measuredFromSettings(settings),
              },
              (ticket) =>
                withTimeout(
                  constrainThroughDoor(ticket, t, {
                    ...(settings.width ? { width: { max: settings.width } } : {}),
                    ...(settings.height ? { height: { max: settings.height } } : {}),
                    frameRate: { max: TAIL_THROTTLE_FPS },
                  }),
                  THROTTLE_BUDGET_MS,
                  `${ch.kind} tail throttle`,
                ),
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
        // M1, AUDIT ITEM (b) — AND THIS IS THE HALF THAT WAS MISSING. The drain
        // gives up after DRAIN_BUDGET_MS = 2000, records `timedOut`, and — until
        // now — surfaced NOTHING: the take ended with the end of a channel not
        // in the file and nothing anywhere said so. The budget itself is left
        // exactly where it is (sizing it is a measurement, not a guess), but a
        // take that hit it now says so where the report card can read it.
        //
        // WHICH PATH IT IS, confirmed rather than assumed (the audit asked):
        // this drain runs ONLY on the MediaRecorder lanes — the filter above
        // requires `ch.recorder`, and the default raw/measured path (X6 video,
        // A1 audio) flushes its own encoder with no budget at all. Composite v1
        // carries its own copy of the same 2 s. So (b) is a FALLBACK-LANE
        // defect, not a default-path one.
        if (stats.timedOut) {
          passDoor(
            {
              dial: 'quality',
              decidedBy: 'drain',
              action: 'shed',
              what: `the end of the ${ch.kind} channel is missing — the tail drain ran out of budget`,
              why: `the MediaRecorder was still emitting after ${stats.drainMs} ms`,
              measured: {
                drainMs: stats.drainMs,
                drainedBytes: stats.drainedBytes,
                budgetMs: DRAIN_BUDGET_MS,
                lane: 'mediarecorder',
              },
            },
            () => undefined,
          )
        }
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

  /**
   * H5 — THE DISK IS THE WITNESS, NOT THE STOP REPLY. The rule and the reason
   * live in keptOnDisk.ts; this is the part that has to touch a platter.
   *
   * A channel whose reply beat the budget is answered from memory and costs
   * nothing. Only one that did not is asked twice — how big it is, and how long
   * — which is the case that used to end with its file deleted.
   */
  private async keepWhatReachedDisk(): Promise<ChannelRuntime[]> {
    const kept: ChannelRuntime[] = []
    for (const ch of this.channels) {
      if (ch.bytes > 0) {
        kept.push(ch)
        continue
      }
      // A REFUSAL AND A ZERO ARE KEPT APART at both steps — see
      // DiskTruth.unreadable. Zero is "there is no such file"; a throw is "the
      // disk would not answer", and nothing is deleted on the second.
      let diskBytes = 0
      let unreadable = false
      try {
        diskBytes = await blobStore.size(ch.blobKey)
      } catch {
        unreadable = true
      }
      // The probe is only ever run against bytes that exist, and it is bounded:
      // a truncated fragmented MP4 is exactly the file a reader can get lost in.
      let probedMs = 0
      if (diskBytes > 0) {
        try {
          probedMs = await withTimeout(
            probeDurationMs(ch.blobKey),
            DISK_TRUTH_BUDGET_MS,
            `${ch.kind} length probe`,
          )
        } catch {
          unreadable = true
        }
      }
      const verdict = keepChannel({
        replyBytes: ch.bytes,
        diskBytes,
        probedMs,
        unreadable,
        knownMs: ch.durationMs,
        wallClockMs: ch.startAbs !== undefined ? performance.now() - ch.startAbs : 0,
      })
      if (!verdict.keep) {
        void blobStore.remove(ch.blobKey).catch(() => undefined)
        continue
      }
      ch.bytes = verdict.bytes
      ch.durationMs = verdict.durationMs
      console.warn(
        `[capture] H5 ${ch.kind} never answered its stop, but ${(verdict.bytes / 1048576).toFixed(1)} MB ` +
          `of it is on disk — kept at ${Math.round(verdict.durationMs)} ms (${verdict.source})`,
      )
      kept.push(ch)
    }
    return kept
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
    // already on disk is kept, and since H5 that sentence is literal:
    // keepWhatReachedDisk() below reads the FILE for every channel whose reply
    // never arrived, instead of believing the byte count that reply would have
    // carried.
    try {
      await withTimeout(
        Promise.all(this.channels.map((c) => c.stopped)),
        STOP_BUDGET_MS,
        'recorder stop',
      )
    } catch (err) {
      console.warn(
        '[capture] a recorder did not stop in budget — its file is read off disk and kept if it has bytes',
        err,
      )
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

    const kept = await this.keepWhatReachedDisk()

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
      // UI1: the pose the composite was written with, so the editor opens on
      // the composition this take actually holds.
      ...(this.cameraPose ? { cameraPose: this.cameraPose } : null),
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
      // H4: and nothing DIED. A take whose camera delivered nothing ran an
      // encoder that was never fed, and the machine carrying that is not
      // evidence it can carry the plan.
      this.losses.size === 0 &&
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

    /**
     * H4 — THE LOSSES, ON THE TAKE'S OWN TIMELINE.
     *
     * The ledger was stamped on the session clock (epoch-relative); the
     * channels above have just been rebased so the earliest one sits at t=0, so
     * these take the same shift or they would name the wrong instants. A
     * 'never-delivered' channel is left at 0 — it was never there to lose at a
     * later moment — and `lostMs` is how long the take ran on without it, which
     * is the number that says whether this take is salvageable.
     */
    if (this.losses.size) {
      const shift = Number.isFinite(minOffset) ? minOffset : 0
      // THE LEDGER IS COMPLETE, INCLUDING KINDS THAT ARE ALSO `missing`. A
      // camera that stayed connected and delivered nothing writes no file at
      // all when it delivers literally zero frames, so it lands in BOTH — and
      // the two sentences are not interchangeable: `missing` says "the device
      // never connected", which is the wrong thing to tell someone whose lid
      // is shut. The editor shows the specific one and drops the generic one;
      // the report card reads both and says each once.
      recording.lost = [...this.losses.entries()].map(([kind, l]) => {
        const atMs = l.reason === 'never-delivered' ? 0 : Math.max(0, Math.round(l.atMs - shift))
        return {
          kind,
          atMs,
          reason: l.reason,
          lostMs: Math.max(0, Math.round(recording.durationMs - atMs)),
        }
      })
      {
        console.warn(
          '[capture] H4 losses — ' +
            recording.lost
              .map((l) => `${l.kind} ${l.reason} at ${l.atMs}ms (${l.lostMs}ms lost)`)
              .join(' · '),
        )
      }
    }

    /**
     * H1 — THE SEAMS, ON THE TAKE'S OWN TIMELINE. Same shift as the losses
     * above and for the same reason: these instants were stamped against the
     * session epoch and the channels have just been rebased so the earliest
     * one sits at t=0. A seam that names an instant the timeline does not have
     * is worse than no seam at all.
     */
    if (this.seams.length) {
      const shift = Number.isFinite(minOffset) ? minOffset : 0
      recording.seams = this.seams.map((sm) => ({
        kind: sm.kind,
        atMs: Math.max(0, Math.round(sm.atMs - shift)),
        gapMs: sm.gapMs,
        cause: sm.cause,
      }))
      console.warn(
        '[capture] H1 seams — ' +
          recording.seams
            .map((sm) => `${sm.kind} ${sm.cause} at ${sm.atMs}ms (${sm.gapMs}ms gap)`)
            .join(' · '),
      )
    }

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
      // the same rebase (P0-instant-sync) — SIGNED, since B9. The clamp that
      // used to sit here called a composite reading earlier than the earliest
      // channel "measurement noise"; it is a real lead of 64-198 ms on most
      // takes, and discarding it wrote the copied picture that much late.
      // `rebasedCompositeOffsetMs` (compose/compositeTime.ts) owns the reason.
      if (composite.startOffsetMs !== undefined) {
        composite.startOffsetMs = rebasedCompositeOffsetMs(composite.startOffsetMs, minOffset)
        if (composite.startOffsetMs < 0) {
          console.info(
            `[capture] B9 composite leads the earliest channel by ${-composite.startOffsetMs}ms — carried, not clamped`,
          )
        }
      }
      recording.composite = composite
    }

    /**
     * S1 — THE TAKE'S OWN STOP STATS, READ ONCE, HERE.
     *
     * Everything below is already in hand: the heap is one property read, the
     * storage numbers are the disk guard's last sample, the rate and the
     * degrade reason are this session's own state. Nothing is sampled while the
     * recorder runs and nothing here can change a capture decision — the report
     * card (core/report) reads them, and a take without them reports those
     * dimensions as unmeasured rather than passing them.
     */
    try {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } })
        .memory
      // Closes the ledger: whatever the take did is now the take's, and the
      // next press starts an empty one.
      const elastic = takeElasticLog()
      // M1 — and the door's, which is wider: every decision this take made
      // about itself, including the ones taken before the first frame and the
      // ones nobody chose (Chrome's own adaptation).
      const door = takeDoorLog()
      const stats: NonNullable<Recording['stopStats']> = {
        requestedFps: this.requestedRate,
        ...(mem?.usedJSHeapSize !== undefined ? { heapBytes: mem.usedJSHeapSize } : null),
        ...(mem?.jsHeapSizeLimit !== undefined ? { heapLimitBytes: mem.jsHeapSizeLimit } : null),
        ...(this.lastStorage
          ? {
              storageUsageBytes: this.lastStorage.usageBytes,
              storageQuotaBytes: this.lastStorage.quotaBytes,
            }
          : null),
        ...(this.collapseWhy ? { degradedWhy: this.collapseWhy } : null),
        // E2 — THE ELASTIC LEDGER. Every shed and every recovery, in order, on
        // the take's clock. `degradedWhy` above says only THAT something was
        // given up; the ruling of 2026-09-02 is about the ORDER things are
        // given up in, and an order cannot be read off one string.
        ...(elastic.events.length ? { elastic: elastic.events } : null),
        ...(elastic.droppedEvents ? { elasticDropped: elastic.droppedEvents } : null),
        // M1 — THE DOOR'S LEDGER. `elastic` above is the order of defence, three
        // layers of it; this is every change to rate, resolution, quality or
        // which channels ran, with who decided it, what it was measured on, and
        // whether it was applied, refused or failed.
        ...(door.decisions.length ? { decisions: door.decisions } : null),
        ...(door.droppedDecisions ? { decisionsDropped: door.droppedDecisions } : null),
      }
      recording.stopStats = stats
    } catch {
      /* a take is never worth losing to a statistic about it */
    }

    await recordingsRepo.save(recording)
    if (this.manifestTimer) clearTimeout(this.manifestTimer)
    clearPendingManifest(this.recordingId)
    this.setState('stopped')
    // H6: the take is over, so the encoder measurement the warm stood down for
    // can run — where it was always meant to, with nothing recording. A no-op
    // on every launch where it already ran, which is most of them.
    releaseEncoderWarmYield()
    void import('./encoderWarm').then((m) => m.runOwedEncoderMeasurement()).catch(() => undefined)
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
    // H6: a take that never happened still stood the warm down. Give it back.
    releaseEncoderWarmYield()
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
            // H4/B4: bounded, same reason as the stop path above.
            if (ch.measuredStarting) {
              await withTimeout(
                ch.measuredStarting,
                MEASURED_START_SETTLE_MS,
                `${ch.kind} measured start`,
              ).catch(() => undefined)
            }
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
