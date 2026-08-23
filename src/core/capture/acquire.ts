import {
  DEFAULT_EXPORT_SETTINGS,
  type CaptureConfig,
  type ChannelKind,
  type DisplaySurfaceKind,
  type MediaKind,
} from '@core/types'

export interface AcquiredChannel {
  kind: ChannelKind
  media: MediaKind
  stream: MediaStream
  /** Primary track: the video track for video kinds, the audio track for audio kinds. */
  track: MediaStreamTrack
  /** Screen channel only: which surface the picker returned. */
  surface?: DisplaySurfaceKind
}

export interface AcquireFailure {
  kind: ChannelKind
  message: string
  denied: boolean
  /** True when the attempt hit ACQUIRE_TIMEOUT_MS without resolving. */
  timedOut?: boolean
}

export interface AcquireResult {
  channels: AcquiredChannel[]
  failures: AcquireFailure[]
  /** Wall-clock timeline of each acquisition step (for hang diagnosis). */
  timeline: ArmingTimelineEntry[]
}

export type ArmingStep = 'display' | 'camera' | 'mic' | 'system-audio'

export interface ArmingTimelineEntry {
  step: ArmingStep
  status: 'start' | 'done' | 'failed' | 'timeout' | 'skipped'
  /** ms since acquireRealChannels entry. */
  tMs: number
  message?: string
}

/** Budget for a GRANTED device (no prompt can appear) — hardware spin-up only.
 * Since synchronized start (2026-07-20) EVERY device gates the take start, so
 * this ceiling is exactly how long the UI can freeze on one wedged device
 * ("stuck waiting for mic", PO 2026-07-23: the old 30s read as hung). 8s:
 * above real slow-but-alive spin-ups (5s falsely killed a granted mic on a
 * loaded Mac), far below "the app is stuck". On timeout the take starts
 * without the device + loud missing-channel warning. */
export const ACQUIRE_TIMEOUT_MS = 8_000
/** Budget when a HUMAN is in the loop (permission prompt, screen picker).
 * Never time a person: 5s here recorded takes without screen while the PO was
 * still reading Chrome's picker (2026-07-16), and the post-timeout stream
 * arrival leaked live camera/mic tracks. */
export const PROMPT_TIMEOUT_MS = 120_000

/** The channel whose readiness gates recording start (instant is law: we start
 * the moment this one is live and let slower devices late-join). */
export function primaryKindFor(config: CaptureConfig): ChannelKind | null {
  if (config.screen) return 'screen'
  if (config.camera) return 'camera'
  if (config.mic) return 'mic'
  if (config.systemAudio) return 'system-audio'
  return null
}

export interface ProgressiveHandlers {
  /** Fired per channel the moment its stream is live. */
  onChannel: (ch: AcquiredChannel) => void
  onFailure: (f: AcquireFailure) => void
  /** Non-fatal quality warning for a channel that still records. */
  onNotice?: (kind: ChannelKind, message: string) => void
  onProgress?: ArmingProgressHandler
}

export interface ProgressiveAcquire {
  /** Resolves the moment recording may begin: the primary channel is live — or,
   * when the primary failed, once every acquisition settled (degraded start,
   * same behavior as the old all-at-once arming). */
  primaryReady: Promise<void>
  /** Every requested acquisition settled (success or failure). */
  settled: Promise<void>
}

export type ArmingProgressHandler = (e: ArmingTimelineEntry) => void

function toFailure(kind: ChannelKind, err: unknown, timedOut = false): AcquireFailure {
  const denied =
    !timedOut &&
    err instanceof DOMException &&
    (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
  const message = timedOut
    ? 'Device did not respond in time'
    : err instanceof Error
      ? err.message || err.name
      : String(err)
  return { kind, message, denied, timedOut }
}

async function isGranted(name: 'camera' | 'microphone'): Promise<boolean> {
  try {
    const st = await navigator.permissions.query({ name: name as PermissionName })
    return st.state === 'granted'
  } catch {
    return false
  }
}

/** Timeout that can NEVER leak a live device: if the media promise resolves
 * after the deadline already fired (user answered a prompt late), the stream's
 * tracks are stopped immediately — otherwise the camera/mic light stays on
 * with no owner (PO-hit 2026-07-16). Exported for tests. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      reject(new DOMException(`${label} timed out after ${ms}ms`, 'TimeoutError'))
    }, ms)
    promise.then(
      (v) => {
        if (timedOut) {
          if (v instanceof MediaStream) for (const t of v.getTracks()) t.stop()
          return
        }
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        if (!timedOut) reject(err)
      },
    )
  })
}

/** Below 32 kHz the capture is HFP narrowband/wideband — telephone quality
 * (4–8 kHz audio ceiling). Full-band devices report 44.1/48 kHz. */
export function isNarrowband(track: MediaStreamTrack | undefined): boolean {
  const rate = track?.getSettings().sampleRate
  return typeof rate === 'number' && rate > 0 && rate < 32_000
}

/**
 * CAPTURE CEILING — never pull more pixels than the product can ever emit.
 *
 * Everything downstream is 1920×1080@30: the live composite canvas, the editor
 * stage, and BOTH export paths (DEFAULT_EXPORT_SETTINGS). Capturing a 4K
 * surface therefore buys nothing and is paid for four times over, all on the
 * one GPU that is also drawing the shared surface:
 *   1. Chrome's capture pipeline reads back 3840×2160 frames (~12 MB each)
 *   2. the raw screen MediaRecorder H.264-encodes them at 8 Mbps (≈0.03 bpp)
 *   3. the live composite decodes them into a <video> and downscales to 1080p
 *      on every one of its 30 ticks per second
 *   4. the on-screen preview decodes the same 4K stream a second time
 * Saturate that and Chrome's frame-sink capturer runs out of in-flight buffers
 * and simply stops delivering — the take is a frozen picture with a live clock
 * (PO 2026-08-22: shared a Chrome tab rendering a 4K game, "video freezes").
 *
 * Capping at the export size makes the whole chain 1:1 and costs nothing in
 * quality: the 4K frames were being thrown away at export anyway.
 */
export const CAPTURE_MAX_WIDTH = DEFAULT_EXPORT_SETTINGS.width
export const CAPTURE_MAX_HEIGHT = DEFAULT_EXPORT_SETTINGS.height
export const CAPTURE_MAX_FPS = DEFAULT_EXPORT_SETTINGS.fps

/** Upper bounds only — a smaller surface satisfies them untouched, so this can
 * never overconstrain a source and cost the user their screen capture. */
export function displayVideoConstraints(): MediaTrackConstraints {
  return {
    width: { max: CAPTURE_MAX_WIDTH },
    height: { max: CAPTURE_MAX_HEIGHT },
    // max, not just ideal: a 60 fps game tab hands over 60 fps otherwise, and
    // every frame above 30 is encoded twice and then dropped at export.
    frameRate: { ideal: CAPTURE_MAX_FPS, max: CAPTURE_MAX_FPS },
    // displaySurface is a HINT, not a constraint: it opens Chrome's picker
    // on the Entire-Screen pane instead of the tab list, so the default
    // choice records everything the user does. Any surface stays pickable.
    displaySurface: 'monitor',
  } as MediaTrackConstraints
}

/**
 * Tell the encoder what it is looking at (task O3a). A screen is mostly static
 * with sharp glyph edges — 'text' asks for the sharpness-preserving tuning
 * instead of the motion tuning a camera wants. Purely advisory: an engine that
 * ignores contentHint records exactly as before.
 */
export function hintTrackContent(track: MediaStreamTrack | undefined, kind: ChannelKind): void {
  if (!track) return
  try {
    const hint = kind === 'screen' ? 'text' : 'motion'
    ;(track as MediaStreamTrack & { contentHint: string }).contentHint = hint
  } catch {
    /* unsupported — advisory only */
  }
}

/**
 * Camera constraints. A camera-only take fills the whole frame (the camera-full
 * rule), so 720p was being upscaled to a 1080p export — visibly soft. Ask for
 * 1080p when there is no screen channel; when the camera is only a PiP at 24 %
 * of the width, 720p is already more than the output needs and the smaller
 * frame is cheaper to encode.
 */
export function cameraVideoConstraints(config: CaptureConfig): MediaTrackConstraints {
  return config.screen
    ? { width: { ideal: 1280 }, height: { ideal: 720 } }
    : { width: { ideal: CAPTURE_MAX_WIDTH }, height: { ideal: CAPTURE_MAX_HEIGHT } }
}

export function exceedsCaptureCeiling(s: MediaTrackSettings): boolean {
  return (
    (s.width ?? 0) > CAPTURE_MAX_WIDTH ||
    (s.height ?? 0) > CAPTURE_MAX_HEIGHT ||
    // +1 fps slack: capturers report 30.000001 / 29.97 style values.
    (s.frameRate ?? 0) > CAPTURE_MAX_FPS + 1
  )
}

/**
 * Second line of defence for the ceiling: a browser may ignore the constraints
 * passed to getDisplayMedia (they are advisory for display surfaces in some
 * engines), and a tab can grow mid-pick. Applied BEFORE the channel is
 * delivered — i.e. before its MediaRecorder exists — because a resolution
 * change after recorder.start() reinitialises the encoder mid-file.
 * Bounded and failure-tolerant: an oversized take beats no take.
 */
export async function capDisplayTrack(track: MediaStreamTrack | undefined): Promise<void> {
  if (!track) return
  const before = track.getSettings()
  if (!exceedsCaptureCeiling(before)) return
  try {
    await withTimeout(
      track.applyConstraints({
        width: { max: CAPTURE_MAX_WIDTH },
        height: { max: CAPTURE_MAX_HEIGHT },
        frameRate: { max: CAPTURE_MAX_FPS },
      }),
      1500,
      'applyConstraints(display)',
    )
    const after = track.getSettings()
    console.info(
      `[capture] display capped ${before.width}×${before.height}@${before.frameRate ?? '?'} → ` +
        `${after.width}×${after.height}@${after.frameRate ?? '?'}`,
    )
  } catch (err) {
    console.warn('[capture] display cap failed — recording at source resolution', err)
  }
}

/**
 * Chromium DisplayMedia options that prevent capturing our own tab
 * (hall-of-mirrors) and keep surface-switch UX. Not yet in all TS DOM libs.
 */
type DisplayMediaOptions = DisplayMediaStreamOptions & {
  selfBrowserSurface?: 'include' | 'exclude'
  surfaceSwitching?: 'include' | 'exclude'
  systemAudio?: 'include' | 'exclude'
}

/** What the user actually picked in the screen picker. Not in every TS DOM lib. */
type DisplaySurface = DisplaySurfaceKind
function displaySurfaceOf(track: MediaStreamTrack | undefined): DisplaySurface | undefined {
  const s = track?.getSettings() as (MediaTrackSettings & { displaySurface?: string }) | undefined
  const v = s?.displaySurface
  return v === 'monitor' || v === 'window' || v === 'browser' ? v : undefined
}

/**
 * Anything but a whole monitor records ONE surface: switch to another tab or
 * app and the file keeps showing the surface that was shared — which reads as
 * "nothing was recorded, just a frozen frame" (PO 2026-08-06). Say it up front;
 * the picker's own indicator is easy to miss.
 */
export function surfaceNotice(surface: DisplaySurface | undefined): string | null {
  if (surface === 'browser') {
    return 'Heads-up: you shared ONE browser tab. Other tabs, apps and your desktop will not appear — switch to sharing your whole screen to record them.'
  }
  if (surface === 'window') {
    return 'Heads-up: you shared ONE app window. Anything outside it will not appear, and if that window gets hidden or another app goes full-screen the picture freezes.'
  }
  return null
}

export function acquireChannelsProgressive(
  config: CaptureConfig,
  handlers: ProgressiveHandlers,
): ProgressiveAcquire {
  const timeline: ArmingTimelineEntry[] = []
  const t0 = performance.now()
  const primary = primaryKindFor(config)
  let primaryResolve!: () => void
  const primaryReady = new Promise<void>((r) => {
    primaryResolve = r
  })
  let channelCount = 0
  let failureCount = 0

  const deliver = (ch: AcquiredChannel): void => {
    channelCount++
    handlers.onChannel(ch)
    if (ch.kind === primary) primaryResolve()
  }
  const fail = (f: AcquireFailure): void => {
    failureCount++
    handlers.onFailure(f)
  }
  const onProgress = handlers.onProgress

  const mark = (
    step: ArmingStep,
    status: ArmingTimelineEntry['status'],
    message?: string,
  ): void => {
    const entry: ArmingTimelineEntry = { step, status, tMs: performance.now() - t0, message }
    timeline.push(entry)
    onProgress?.(entry)
    console.info(
      `[capture:arming] ${step} ${status} +${entry.tMs.toFixed(0)}ms` +
        (message ? ` — ${message}` : ''),
    )
  }

  const startCamera = async (granted: boolean): Promise<void> => {
    mark('camera', 'start')
    try {
      const video = cameraVideoConstraints(config)
      if (config.cameraDeviceId) video.deviceId = config.cameraDeviceId
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ video }),
        granted ? ACQUIRE_TIMEOUT_MS : PROMPT_TIMEOUT_MS,
        'getUserMedia(camera)',
      )
      hintTrackContent(stream.getVideoTracks()[0], 'camera')
      deliver({ kind: 'camera', media: 'video', stream, track: stream.getVideoTracks()[0] })
      mark('camera', 'done', stream.getVideoTracks()[0]?.label)
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      fail(toFailure('camera', err, timedOut))
      mark('camera', timedOut ? 'timeout' : 'failed', err instanceof Error ? err.message : String(err))
    }
  }

  const startMic = async (granted: boolean): Promise<void> => {
    mark('mic', 'start')
    try {
      const audio: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        // Ask for full-band capture; a device stuck in telephone mode ignores
        // this, which is exactly what the narrowband rescue below detects.
        sampleRate: { ideal: 48000 },
      }
      if (config.micDeviceId) audio.deviceId = config.micDeviceId
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio }),
        granted ? ACQUIRE_TIMEOUT_MS : PROMPT_TIMEOUT_MS,
        'getUserMedia(mic)',
      )
      // NARROWBAND WARNING only (PO rule 2026-07-21: never override the user's
      // device — an earlier auto-swap to the built-in mic broke AirPods takes).
      // A Bluetooth headset mic in HFP mode captures 8–16 kHz telephone
      // quality (measured on a real take: 99.7% of energy below 4 kHz).
      // The take records exactly as the user chose; we just say so.
      if (isNarrowband(stream.getAudioTracks()[0])) {
        handlers.onNotice?.(
          'mic',
          'Heads-up: this mic is in Bluetooth phone-quality mode. Recording continues — for full quality choose the built-in or a wired mic in system sound settings.',
        )
      }
      deliver({ kind: 'mic', media: 'audio', stream, track: stream.getAudioTracks()[0] })
      mark('mic', 'done', stream.getAudioTracks()[0]?.label)
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      fail(toFailure('mic', err, timedOut))
      mark('mic', timedOut ? 'timeout' : 'failed', err instanceof Error ? err.message : String(err))
    }
  }

  // Devices are touched ONLY after the record click (product decision — no
  // idle camera/mic). When permission is already granted (no prompt can
  // appear), camera/mic start CONCURRENTLY with the screen picker and resolve
  // while the user is choosing a surface: instant start without idle access.
  // Without permission they run after the picker so prompts never hide.
  const run = async (): Promise<void> => {
  // getDisplayMedia MUST be dispatched synchronously inside the user gesture:
  // WebKit consumes the click's transient activation on the first await, so any
  // await before this (e.g. probing permissions) made Safari reject the call
  // with NotAllowedError and show NO picker at all. Fire it first, await later.
  let displayPromise: Promise<MediaStream> | null = null
  const canDisplay = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  if (config.screen) {
    mark('display', 'start')
    if (!canDisplay) {
      // iOS/iPadOS: Apple exposes no screen capture to any browser (native-only,
      // via ReplayKit). Fail loud instead of hanging on an undefined call.
      const msg = 'Screen recording is not available in this browser'
      fail({ kind: 'screen', message: msg, denied: false })
      mark('display', 'failed', 'getDisplayMedia unavailable')
      if (config.systemAudio) {
        fail({ kind: 'system-audio', message: msg, denied: false })
        mark('system-audio', 'failed', 'getDisplayMedia unavailable')
      }
    } else {
      const opts: DisplayMediaOptions = {
        video: displayVideoConstraints(),
        // Chromium defaults AEC/NS/AGC ON for display audio — voice processing
        // mangles music into warble and downmixes to mono. Capture it raw.
        audio: config.systemAudio
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          : false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: config.systemAudio ? 'include' : 'exclude',
      }
      // The picker is a human interaction — human budget, never device budget.
      displayPromise = withTimeout(
        navigator.mediaDevices.getDisplayMedia(opts),
        PROMPT_TIMEOUT_MS,
        'getDisplayMedia',
      )
    }
  } else if (config.systemAudio) {
    fail({ kind: 'system-audio', message: 'System audio requires screen sharing', denied: false })
    mark('system-audio', 'skipped', 'requires screen sharing')
  }

  // The granted-concurrent-with-picker optimization only helps while a picker
  // is open. With no screen there's nothing to overlap, and probing
  // permissions.query adds await hops that are unreliable on Safari — so skip
  // straight to acquisition below.
  const early: Promise<void>[] = []
  let camEarly = false
  let micEarly = false
  if (displayPromise) {
    if (config.camera && (await isGranted('camera'))) {
      camEarly = true
      early.push(startCamera(true))
    }
    if (config.mic && (await isGranted('microphone'))) {
      micEarly = true
      early.push(startMic(true))
    }
  }

  if (displayPromise) {
    try {
      const display = await displayPromise
      const video = display.getVideoTracks()[0]
      if (config.systemAudio) {
        const audio = display.getAudioTracks()[0]
        if (audio) {
          deliver({
            kind: 'system-audio',
            media: 'audio',
            stream: new MediaStream([audio]),
            track: audio,
          })
          mark('system-audio', 'done')
        } else {
          fail({
            kind: 'system-audio',
            message:
              'System audio was not shared — tick “Also share system audio” in the screen picker',
            denied: false,
          })
          mark('system-audio', 'failed', 'System audio was not shared')
        }
      }
      const surface = displaySurfaceOf(video)
      const notice = surfaceNotice(surface)
      if (notice) handlers.onNotice?.('screen', notice)
      // Enforce the capture ceiling before anything consumes the track (see
      // capDisplayTrack): a few ms here, and only when the surface is oversized.
      await capDisplayTrack(video)
      hintTrackContent(video, 'screen')
      // Screen delivered LAST from the display result: it is the primary, and
      // delivering it resolves primaryReady — system audio must already be in.
      if (video) {
        deliver({
          kind: 'screen',
          media: 'video',
          stream: new MediaStream([video]),
          track: video,
          surface,
        })
      }
      mark(
        'display',
        'done',
        video ? `surface=${surface ?? 'unknown'} track=${video.label || video.id}` : 'no video track',
      )
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      fail(toFailure('screen', err, timedOut))
      if (config.systemAudio) fail(toFailure('system-audio', err, timedOut))
      mark('display', timedOut ? 'timeout' : 'failed', err instanceof Error ? err.message : String(err))
      if (config.systemAudio) {
        mark('system-audio', timedOut ? 'timeout' : 'failed')
      }
    }
  }

  // Not pre-granted → a permission prompt will appear → human budget.
  const parallel: Promise<void>[] = [...early]
  if (config.camera && !camEarly) parallel.push(startCamera(false))
  if (config.mic && !micEarly) parallel.push(startMic(false))

  if (parallel.length) await Promise.all(parallel)

  console.info(
    `[capture:arming] acquire settled +${(performance.now() - t0).toFixed(0)}ms — ` +
      `${channelCount} channel(s), ${failureCount} failure(s)`,
    { timeline },
  )
  }

  const settled = run()
  // Primary failed or was never requested: recording may start (degraded) only
  // once everything settled — the old all-at-once behavior.
  void settled.then(() => primaryResolve())
  return { primaryReady, settled }
}

/** Legacy all-at-once acquisition — collects the progressive stream. */
export async function acquireRealChannels(
  config: CaptureConfig,
  onProgress?: ArmingProgressHandler,
): Promise<AcquireResult> {
  const channels: AcquiredChannel[] = []
  const failures: AcquireFailure[] = []
  const timeline: ArmingTimelineEntry[] = []
  const acq = acquireChannelsProgressive(config, {
    onChannel: (ch) => channels.push(ch),
    onFailure: (f) => failures.push(f),
    onProgress: (e) => {
      timeline.push(e)
      onProgress?.(e)
    },
  })
  await acq.settled
  return { channels, failures, timeline }
}
