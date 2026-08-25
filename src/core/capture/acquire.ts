import {
  DEFAULT_EXPORT_SETTINGS,
  type CaptureConfig,
  type ChannelKind,
  type DisplaySurfaceKind,
  type MediaKind,
} from '@core/types'
import { analytics } from '@core/analytics'
import { guardStream } from './deviceGuard'
import {
  displayWedgeCount,
  isDisplayConservative,
  rememberDisplaySuccess,
  rememberDisplayWedge,
} from './displayWedge'
import { knownGranted, rememberGrant } from './grants'

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

/**
 * How long the screen may take to arrive AFTER the human is out of the loop.
 *
 * PO 2026-08-24, with the log that proves it: `display start +0ms` … `display
 * timeout +120004ms`. getDisplayMedia neither resolved nor rejected — for two
 * full minutes — while Chrome's indicator showed the screen as shared. The
 * picker had been answered seconds in; everything after that was the app
 * sitting on a promise the browser was never going to settle, holding the
 * camera and the microphone the whole time, and then arming a take with no
 * screen in it.
 *
 * "Never time a person" (2026-07-16) is still right, and this does not break
 * it: a person is only in the loop while the picker is OPEN, and an open
 * picker takes focus away from the page. The clock below starts when focus
 * comes BACK — i.e. when the picker has closed and the answer is already the
 * browser's to deliver. Eight seconds after that is not deliberation, it is a
 * wedge, and the honest thing is to say so and let go of the devices.
 */
export const PICKER_SETTLE_MS = 8_000

/**
 * ABSOLUTE ceiling on getDisplayMedia, focus tricks or no focus tricks.
 *
 * The 8 s post-picker deadline above is the fast path, and it depends on the
 * page seeing focus leave and come back. On macOS Chrome now delegates the
 * picker to the system (the menu-bar sharing pill), and the page may observe
 * NO focus change at all — PO 2026-08-24, fresh Chrome, first take: wedged
 * again, "stuck in waiting", and the fast path never engaged. When detection
 * fails, the old code fell back to the 120 s human budget, which in practice
 * meant two minutes of lit indicators and then quitting Chrome.
 *
 * So the display request gets its own hard total budget. 30 s is 6× the
 * incident that created the never-time-a-person rule (5 s cut off a real user
 * reading the picker, 2026-07-16) — nobody spends half a minute choosing a
 * screen. And the cost of being wrong has changed shape: back then, timeout
 * meant silently recording WITHOUT the screen; now it means failing the whole
 * take loudly, releasing every device, and inviting a retry. An impatient
 * ceiling with an honest failure beats a patient one that takes hostages.
 *
 * Camera and mic prompts keep the full PROMPT_TIMEOUT_MS: those are in-page
 * permission bubbles, humans do read them, and they do not wedge this way.
 */
export const DISPLAY_TOTAL_BUDGET_MS = 30_000

/**
 * Resolves once the screen picker is judged closed: focus left the page and
 * then came back. Never resolves if focus was never lost (a picker that does
 * not take focus, or an engine that reports focus differently) — deliberately,
 * because that leaves PROMPT_TIMEOUT_MS as the only ceiling and a human is
 * never timed on a guess. Also never resolves while the user is away in
 * another app, which is exactly right: that is still their time, not a wedge.
 */
export function pickerClosed(): Promise<void> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return new Promise<void>(() => {})
  }
  return new Promise<void>((resolve) => {
    let lost = !document.hasFocus()
    let timer: ReturnType<typeof setInterval> | undefined
    const done = (): void => {
      if (timer) clearInterval(timer)
      window.removeEventListener('focus', check)
      resolve()
    }
    function check(): void {
      if (!document.hasFocus()) {
        lost = true
        return
      }
      if (lost) done()
    }
    // Polled as well as evented: the page can regain focus without firing a
    // 'focus' event when the thing that took it was a browser-native dialog.
    timer = setInterval(check, 250)
    window.addEventListener('focus', check)
  })
}

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
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  /**
   * Hold the clock until this settles. A DEVICE budget measures hardware
   * spin-up, so it must not run while a HUMAN is still in the loop: the mic
   * and camera start concurrently with the screen picker, and counting their
   * 8 s against the time the user spends choosing a surface dropped the mic
   * from every take where that took longer (PO 2026-08-23, "why the fuck mic
   * dont connects"). Starting the clock when the picker closes keeps the
   * ceiling meaningful without ever timing a person.
   */
  startAfter?: Promise<unknown>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const startClock = (): void => {
      if (settledEarly) return
      timer = setTimeout(() => {
        timedOut = true
        reject(new DOMException(`${label} timed out after ${ms}ms`, 'TimeoutError'))
      }, ms)
    }
    let settledEarly = false
    if (startAfter) void startAfter.then(startClock, startClock)
    else startClock()
    promise.then(
      (v) => {
        if (timedOut) {
          if (v instanceof MediaStream) for (const t of v.getTracks()) t.stop()
          return
        }
        settledEarly = true
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        settledEarly = true
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
 * Anything but a whole monitor records ONE surface. That used to raise a
 * two-line "Heads-up:" toast on every tab/window share; PO 2026-08-23 killed
 * it ("fix it without stupid texts") and the call is right — the user picked
 * that surface a second earlier in Chrome's own picker, which shows what it
 * is, so the toast told them what they had just chosen. The failure it was
 * guarding against is covered where it actually shows: the frozen-source
 * detector raises the sticky banner if the surface really does stop
 * delivering (2026-08-06), and that fires on evidence rather than on a guess.
 *
 * Kept as a function returning null so the surface plumbing stays wired and a
 * later, better-targeted notice has somewhere to live.
 */
export function surfaceNotice(_surface: DisplaySurface | undefined): string | null {
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

  /**
   * `granted` is a PROMISE on purpose. getUserMedia is dispatched on the first
   * line — before any await — so that when this is called beside an open
   * screen picker the device starts opening immediately; awaiting a
   * permissions.query first is what silently turned the concurrent start back
   * into a serial one (see grants.ts). The answer is still awaited, just
   * afterwards, and only to choose the budget: a prompt gets the human budget,
   * a granted device the hardware one.
   */
  const startCamera = async (
    granted: Promise<boolean>,
    afterPicker?: Promise<unknown>,
  ): Promise<void> => {
    mark('camera', 'start')
    try {
      const video = cameraVideoConstraints(config)
      if (config.cameraDeviceId) video.deviceId = config.cameraDeviceId
      const raw = navigator.mediaDevices.getUserMedia({ video })
      raw.catch(() => undefined) // handled below; never an unhandled rejection
      const stream = await withTimeout(
        raw,
        (await granted) ? ACQUIRE_TIMEOUT_MS : PROMPT_TIMEOUT_MS,
        'getUserMedia(camera)',
        afterPicker,
      )
      rememberGrant('camera', true)
      guardStream(stream)
      hintTrackContent(stream.getVideoTracks()[0], 'camera')
      deliver({ kind: 'camera', media: 'video', stream, track: stream.getVideoTracks()[0] })
      mark('camera', 'done', stream.getVideoTracks()[0]?.label)
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      const f = toFailure('camera', err, timedOut)
      if (f.denied) rememberGrant('camera', false)
      fail(f)
      mark('camera', timedOut ? 'timeout' : 'failed', err instanceof Error ? err.message : String(err))
    }
  }

  /** Same shape as startCamera — see the note there on why `granted` is a promise. */
  const startMic = async (
    granted: Promise<boolean>,
    afterPicker?: Promise<unknown>,
  ): Promise<void> => {
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
      const raw = navigator.mediaDevices.getUserMedia({ audio })
      raw.catch(() => undefined) // handled below; never an unhandled rejection
      const stream = await withTimeout(
        raw,
        (await granted) ? ACQUIRE_TIMEOUT_MS : PROMPT_TIMEOUT_MS,
        'getUserMedia(mic)',
        afterPicker,
      )
      rememberGrant('microphone', true)
      guardStream(stream)
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
      const f = toFailure('mic', err, timedOut)
      if (f.denied) rememberGrant('microphone', false)
      fail(f)
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
  const conservativeDisplay = config.screen && isDisplayConservative()
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
      // A machine that wedged on the full request gets the minimal one — see
      // displayWedge.ts. Everything optional is dropped: if any of our options
      // is what the native picker chokes on, the user's next click just works.
      // The capture ceiling is unaffected (capDisplayTrack applies post-pick);
      // tab audio is skipped for the day and reported, not silently absent.
      const opts: DisplayMediaOptions = conservativeDisplay
        ? { video: { displaySurface: 'monitor' } as MediaTrackConstraints, audio: false }
        : {
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
      if (conservativeDisplay) {
        console.info(
          '[capture] display request is in safe mode (previous share never delivered) — video only',
        )
      }
      // TWO ceilings, because there are two different things that can be slow.
      // The outer one is the human at the picker and stays generous. The inner
      // one only starts once the picker has closed, and catches the failure
      // the PO actually hit: a getDisplayMedia that never settles at all while
      // Chrome shows the screen as shared. Without it the app waits out the
      // full human budget on a promise that is already dead.
      const rawDisplay = navigator.mediaDevices.getDisplayMedia(opts)
      rawDisplay.catch(() => undefined) // handled below; never unhandled
      displayPromise = withTimeout(
        withTimeout(rawDisplay, PICKER_SETTLE_MS, 'getDisplayMedia (picker closed)', pickerClosed()),
        DISPLAY_TOTAL_BUDGET_MS,
        'getDisplayMedia',
      )
    }
  } else if (config.systemAudio) {
    fail({ kind: 'system-audio', message: 'System audio requires screen sharing', denied: false })
    mark('system-audio', 'skipped', 'requires screen sharing')
  }

  // SAME TICK AS THE PICKER — this is the line the whole "why is there any
  // waiting" complaint turns on. A device that starts opening now spends the
  // seconds the user is reading Chrome's picker doing its hardware spin-up,
  // and by the time they click Share there is nothing left to wait for. That
  // only works if NOTHING is awaited in front of it: this used to be gated on
  // `await isGranted(...)`, an IPC to the very browser process that is busy
  // displaying the picker, so the answer could land only once the picker
  // closed — and then the mic's whole spin-up ran on the user's clock, after
  // the screen was already shared. The cached grant (grants.ts) answers
  // synchronously; the live probe still runs and still picks the budget.
  //
  // Their 8s ceiling is HARDWARE budget, so it may only start counting once
  // the picker is gone; otherwise the user's own deliberation kills them.
  const early: Promise<void>[] = []
  let camEarly = false
  let micEarly = false
  if (displayPromise) {
    if (config.camera && knownGranted('camera')) {
      camEarly = true
      early.push(startCamera(isGranted('camera'), displayPromise))
    }
    if (config.mic && knownGranted('microphone')) {
      micEarly = true
      early.push(startMic(isGranted('microphone'), displayPromise))
    }
  }

  if (displayPromise) {
    try {
      const display = await displayPromise
      // Before capDisplayTrack's await, before anything: from this line on the
      // screen is live and Chrome's indicator is lit, so from this line on it
      // must be releasable no matter what happens next.
      guardStream(display)
      const video = display.getVideoTracks()[0]
      const surface = displaySurfaceOf(video)
      // THE PICKER HAS ANSWERED — say so here, not eight lines and one await
      // further down. `mark('display','done')` used to sit after
      // capDisplayTrack, so up to 1.5 s of our own applyConstraints was still
      // labelled "Waiting for screen…" with Chrome already sharing. The screen
      // is not what we are waiting for any more; we are.
      mark(
        'display',
        'done',
        video ? `surface=${surface ?? 'unknown'} track=${video.label || video.id}` : 'no video track',
      )
      // Full-request success proves the machine healthy again — clears the
      // wedge mark. Conservative success keeps it (TTL is the way back).
      rememberDisplaySuccess(conservativeDisplay)
      if (conservativeDisplay && config.systemAudio) {
        // We never asked for audio this take — say that, not "you forgot to
        // tick the box". Skipped, present in Recording.missing, gone tomorrow.
        fail({
          kind: 'system-audio',
          message:
            'Tab audio was skipped this take while recovering from a stuck screen share — it comes back automatically.',
          denied: false,
        })
        mark('system-audio', 'skipped', 'safe-mode display request')
      } else if (config.systemAudio) {
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
      // Anything the picker handed back that we do NOT deliver must be stopped
      // right here. Only the first video track and (when asked for) the first
      // audio track become channels; the rest used to stay live with no owner,
      // which on macOS keeps the screen-recording indicator lit after the take
      // is gone (PO 2026-08-23: "indicators of mic and screen still there").
      const delivered = new Set<MediaStreamTrack>()
      if (video) delivered.add(video)
      // In safe mode the audio track (if an engine hands one back unasked) was
      // NOT delivered as a channel above — so it must not be exempted here.
      if (!conservativeDisplay && config.systemAudio && display.getAudioTracks()[0]) {
        delivered.add(display.getAudioTracks()[0]!)
      }
      for (const t of display.getTracks()) if (!delivered.has(t)) t.stop()

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
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      if (timedOut) {
        // The share was taken and never delivered — mark the machine so the
        // NEXT click sends the minimal request (displayWedge.ts). Counted in
        // analytics because "never happens to users" is checkable only if we
        // can see it happening.
        rememberDisplayWedge()
        analytics.track('display_wedge', {
          conservative: conservativeDisplay,
          wedgeCount: displayWedgeCount(),
        })
      }
      fail(toFailure('screen', err, timedOut))
      if (config.systemAudio) fail(toFailure('system-audio', err, timedOut))
      mark('display', timedOut ? 'timeout' : 'failed', err instanceof Error ? err.message : String(err))
      if (config.systemAudio) {
        mark('system-audio', timedOut ? 'timeout' : 'failed')
      }
    }
  }

  // Which budget the stragglers get. NOT a formality: the budget decides how
  // long the take can freeze on a device that never answers — 8 s of hardware
  // spin-up, or two minutes of "never time a human at a prompt". Assuming the
  // human budget for a device that CANNOT prompt is how an audio-only take
  // with a wedged but long-granted mic sat on "Waiting for microphone…" for
  // 120 s (PO 2026-08-24). The probe was previously skipped entirely without a
  // screen picker; the reason given — extra await hops break Safari's
  // transient activation — only applies in front of getDisplayMedia, which by
  // here has either been dispatched already or was never requested.
  const parallel: Promise<void>[] = [...early]
  if (config.camera && !camEarly) parallel.push(startCamera(isGranted('camera')))
  if (config.mic && !micEarly) parallel.push(startMic(isGranted('microphone')))

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
