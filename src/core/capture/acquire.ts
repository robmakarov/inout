import {
  DEFAULT_EXPORT_SETTINGS,
  type CaptureConfig,
  type ChannelKind,
  type DisplaySurfaceKind,
  type MediaKind,
} from '@core/types'
import { analytics } from '@core/analytics'
import { sourceFrameEnabled } from '@core/frame'
import { captureRateCeiling, rateForSurface } from '@core/rate'
import { MAX_OUTPUT_LONG_EDGE, captureCeilingLongEdge, evenDown } from '@core/frame'
import { isAppleWebKit } from '@core/capabilities'
import { detectPlatform } from '@core/platform'
import { preemptiveRefusalAllowed } from './captureQuality'
import { measuredEncoderThroughput } from './encoderBudget'
import { guardStream } from './deviceGuard'
import { nativeResEnabled } from './nativeRes'
import {
  awaitDisplayCaptureClear,
  displayCaptureClear,
  trackDisplayCapture,
} from './displayRelease'
import {
  MAX_DISPLAY_LEVEL,
  displayRequestLevel,
  classifyDisplayStall,
  displayStallMessage,
  displayWedgeCount,
  rememberDisplayStall,
  rememberDisplaySuccess,
  rememberDisplayWedge,
  type DisplayStall,
  type DisplayRequestLevel,
} from './displayWedge'
import { displayRequestOutstanding, displayRequestPending, markDisplayRequest, unsettledDisplayRequests } from './displayInflight'
import { appendWedgeJournal } from './wedgeJournal'
import { beginDisplayForensics, describeForensics, noteScreenDelivered } from './stallForensics'
import { knownGranted, rememberGrant, type DeviceGrant } from './grants'

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
  /**
   * WHY a display request never settled — W1. 'permission' means macOS has
   * not granted this browser screen recording, which looks identical from the
   * page and must not be treated as, reported as, or escalated like Chrome's
   * wedge. Only ever set on a screen/system-audio timeout.
   */
  stall?: DisplayStall
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
 * ("stuck waiting for mic", Robert 2026-07-23: the old 30s read as hung). 8s:
 * above real slow-but-alive spin-ups (5s falsely killed a granted mic on a
 * loaded Mac), far below "the app is stuck". On timeout the take starts
 * without the device + loud missing-channel warning. */
export const ACQUIRE_TIMEOUT_MS = 8_000
/** Budget when a HUMAN is in the loop (permission prompt, screen picker).
 * Never time a person: 5s here recorded takes without screen while Robert was
 * still reading Chrome's picker (2026-07-16), and the post-timeout stream
 * arrival leaked live camera/mic tracks. */
export const PROMPT_TIMEOUT_MS = 120_000

/**
 * How long the screen may take to arrive AFTER the human is out of the loop.
 *
 * Robert 2026-08-24, with the log that proves it: `display start +0ms` … `display
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
 * NO focus change at all — Robert 2026-08-24, fresh Chrome, first take: wedged
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
 * When to TELL THE USER the screen request is late, while it is still running.
 *
 * 12 s: comfortably past a person reading Chrome's picker (the budget above is
 * set on "nobody spends half a minute choosing a screen"), and 18 s before the
 * take fails, so the message that matters is on screen for the whole time the
 * user is wondering what is wrong. Below ~10 s this would interrupt ordinary
 * deliberation with an alarm, which is its own kind of lie.
 */
export const DISPLAY_STALL_NOTICE_MS = 12_000

/**
 * The persistent-connect contract for GRANTED camera/mic (see
 * connectPersistently): this many attempts gate the synchronized start, and
 * then the take starts while the hunt keeps asking in the background. Two, not
 * one, because a device that answers the second ask still starts with
 * everyone else — one continuous channel instead of a late-joined segment.
 * Not more, because every extra foreground attempt is ~10 s the user watches
 * an arming label ("wait is too long", Robert 2026-08-25).
 */
export const CONNECT_ATTEMPTS_BEFORE_START = 2
/** Pace between asks — an instantly-rejecting device (unplugged, held by
 * another app) must not turn the hunt into a tight loop. */
export const CONNECT_RETRY_PAUSE_MS = 2_000

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

/**
 * What the press asked for, as one journal-sized word — so the next wedge says
 * whether tab audio, the camera or the mic rode in the same request. Every
 * wedge read off Robert's machine so far had all four on, and no entry could
 * say so; a wedge that only ever happens with one of them present is a
 * different bug from one that happens bare.
 */
export function askedChannels(config: CaptureConfig): string {
  return (
    [
      config.screen && 'screen',
      config.systemAudio && 'tab-audio',
      config.camera && 'camera',
      config.mic && 'mic',
    ]
      .filter(Boolean)
      .join('+') || 'none'
  )
}

export interface ProgressiveHandlers {
  /** Fired per channel the moment its stream is live. */
  onChannel: (ch: AcquiredChannel) => void
  onFailure: (f: AcquireFailure) => void
  /** Non-fatal quality warning for a channel that still records. */
  onNotice?: (kind: ChannelKind, message: string) => void
  /**
   * THE SCREEN REQUEST IS STILL OUTSTANDING AND HAS BEEN FOR A WHILE — W1
   * item 3. Fired ONCE per take, DISPLAY_STALL_NOTICE_MS after dispatch, while
   * the request is still alive. It exists because everything this app knew
   * about a stuck share used to arrive in the post-take banner, up to 30 s
   * later: Chrome is displaying the real answer (grant screen recording) the
   * whole time, and the app said nothing until it had given up. Not a failure
   * — the request keeps running, and most of the time it still lands.
   */
  onStall?: (message: string, stall: DisplayStall) => void
  onProgress?: ArmingProgressHandler
  /**
   * Consulted by the persistent-connect hunt (Robert 2026-08-25 "all input must
   * connect everytime without fails"): before every background re-ask and
   * again the instant a late stream arrives. The session answers with full
   * knowledge — take alive, channel still missing, user has not turned it off.
   * ABSENT MEANS NO BACKGROUND HUNTING: a one-shot caller (rigs, legacy
   * collectors) gets the bounded foreground attempts only, because a hunt
   * nobody can call off is a device-grabbing loop, not a feature.
   */
  stillWanted?: (kind: ChannelKind) => boolean
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

function toFailure(
  kind: ChannelKind,
  err: unknown,
  timedOut = false,
  /** Set for a DISPLAY timeout only — see classifyDisplayStall (W1). It also
   *  owns the message, because "Device did not respond in time" is the line
   *  that became "the device never connected" in the editor while the real
   *  answer (an ungranted macOS permission) was on screen in Chrome's own
   *  picker the whole time. */
  stall?: DisplayStall,
): AcquireFailure {
  const denied =
    !timedOut &&
    err instanceof DOMException &&
    (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
  const message = stall
    ? displayStallMessage(stall, detectPlatform().browser, 'failed')
    : timedOut
      ? 'Device did not respond in time'
      : err instanceof Error
        ? err.message || err.name
        : String(err)
  return { kind, message, denied, timedOut, stall }
}

/**
 * How long the permission LOOKUP may hold up connecting. The query's answer
 * only picks a timeout budget, but it used to be awaited in FRONT of that
 * timeout — so a `permissions.query` that never answers (an IPC into the same
 * browser process that just wedged a screen share) left the mic with no
 * deadline and no retry: "Waiting for microphone…" with nothing armed to end
 * it (Robert 2026-08-25, stuck-on-mic after a wedge + refresh). A query that hangs
 * falls back to the cached grant; a query that REJECTS (Safari has none for
 * camera/mic) keeps reading as not-granted, exactly as before.
 */
export const GRANT_PROBE_BUDGET_MS = 1_000

async function isGranted(name: 'camera' | 'microphone'): Promise<boolean> {
  try {
    const q = navigator.permissions.query({ name: name as PermissionName })
    q.catch(() => undefined) // handled below; never an unhandled rejection
    const st = await withTimeout(q, GRANT_PROBE_BUDGET_MS, `permissions.query(${name})`)
    return st.state === 'granted'
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') return knownGranted(name)
    return false
  }
}

/** Timeout that can NEVER leak a live device: if the media promise resolves
 * after the deadline already fired (user answered a prompt late), the stream's
 * tracks are stopped immediately — otherwise the camera/mic light stays on
 * with no owner (Robert-hit 2026-07-16). Exported for tests. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  /**
   * Hold the clock until this settles. A DEVICE budget measures hardware
   * spin-up, so it must not run while a HUMAN is still in the loop: the mic
   * and camera start concurrently with the screen picker, and counting their
   * 8 s against the time the user spends choosing a surface dropped the mic
   * from every take where that took longer (Robert 2026-08-23, "why the fuck mic
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
 * (Robert 2026-08-22: shared a Chrome tab rendering a 4K game, "video freezes").
 *
 * Capping at the export size makes the whole chain 1:1 and costs nothing in
 * quality: the 4K frames were being thrown away at export anyway.
 */
export const CAPTURE_MAX_WIDTH = DEFAULT_EXPORT_SETTINGS.width
export const CAPTURE_MAX_HEIGHT = DEFAULT_EXPORT_SETTINGS.height

/**
 * WHAT "NATIVE RESOLUTION" ACTUALLY MEANS, corrected 2026-08-29 by Robert's own
 * console: it is not "the monitor's size", it is "everything this product can
 * deliver". The largest export step INOUT offers is 1440p — 2560 on the long
 * edge — so every pixel above that was encoded, written to disk, and then
 * thrown away at export. His screen is 3024x1964: 5.9 Mpx captured, 4.25 Mpx
 * usable, and the difference paid for in a hardware encoder, disk bandwidth,
 * and a downscale on every composite tick, while a game rendered on the same
 * GPU. The take froze the whole machine.
 *
 * The 2026-08-22 cap made this argument already — "capping at the export size
 * makes the whole chain 1:1 and costs nothing in quality: the 4K frames were
 * being thrown away at export anyway" — and then capped at the DEFAULT step
 * rather than the LARGEST, which is what cost every 1440p user their detail and
 * is what native-res was invented to undo. Both were half right. This is the
 * whole rule: bound the capture by the biggest thing the export ladder can
 * make, and nothing above it is ever recorded because nothing above it can ever
 * be watched.
 *
 * A SQUARE BOX, not a landscape one, so a rotated or portrait display is bounded
 * on its own long edge instead of being crushed onto the wrong axis (F13).
 * Pinned against QUALITY_TIERS by test: if a bigger step is ever added, this
 * moves with it or the test fails.
 */
export const CAPTURE_MAX_LONG_EDGE = MAX_OUTPUT_LONG_EDGE
export const CAPTURE_MAX_FPS = DEFAULT_EXPORT_SETTINGS.fps

/**
 * THE PICKER IS THE USER'S, NOT OURS (Robert 2026-08-25, and this is now a rule,
 * not a preference): the app does not decide which surfaces Chrome offers, and
 * it does not move which pane opens. Both were changed here for a few hours on
 * a theory about where the sound checkbox lives — a whole-screen share on this
 * Mac DOES carry system audio, the theory was wrong, and it took the user's
 * Entire-Screen option away. Reverted to the 2026-08-06 behaviour below.
 *
 * NEVER add `monitorTypeSurfaces`, `preferCurrentTab`, or a conditional
 * `displaySurface` here without Robert saying so first. Removing an option from
 * Chrome's picker is a product decision, and it is not this file's to make.
 */

/**
 * Upper bounds only — a smaller surface satisfies them untouched, so this can
 * never overconstrain a source and cost the user their screen capture.
 *
 * THE SIZE BOUND IS DROPPED WHEN NATIVE-RES CAPTURE IS ON (default since
 * 2026-08-29), and it has to be dropped HERE or the flag does nothing at all:
 * `width: { max }` is a real constraint and Chrome downscales the surface to
 * satisfy it before the track is ever handed over, so capDisplayTrack's
 * native-res branch was skipping a re-cap of a track that had already been
 * capped at the source.
 *
 * THE FRAME-RATE BOUND IS THE CEILING, NOT 30 (task F15). It used to be
 * `ideal: 30, max: 30` unconditionally, justified as "every frame above 30 is
 * encoded twice and then dropped at export" — true only because the export was
 * 30, which is the same output-constant-caps-the-input shape Robert rejected in
 * F13. With `?sourcefps=1` the bound becomes a bare `max: 60`: nothing is
 * ASKED for (an `ideal: 60` would trade resolution for rate on a source with
 * several formats), the source simply stops being throttled below what it
 * already offers. Off, it is the `ideal: 30, max: 30` it always was, to the
 * field. See core/rate.ts.
 */
export function displayVideoConstraints(): MediaTrackConstraints {
  // F18: with `?sourceres=1` the ceiling is the SOURCE'S OWN SIZE, so no size
  // bound is sent at all. `{ max: Infinity }` is not a constraint — it is a
  // bug that would be accepted silently — so the branch is on finiteness and
  // the bound is omitted rather than widened.
  const ceilingLong = captureCeilingLongEdge()
  const size = nativeResEnabled()
    ? Number.isFinite(ceilingLong)
      ? { width: { max: ceilingLong }, height: { max: ceilingLong } }
      : {}
    : { width: { max: CAPTURE_MAX_WIDTH }, height: { max: CAPTURE_MAX_HEIGHT } }
  const ceiling = captureRateCeiling()
  return {
    ...size,
    // At the 30 ceiling this is `max`, not just `ideal`, on purpose: a 60 fps
    // game tab hands over 60 fps otherwise, and with a 30 fps export every one
    // of those frames is encoded twice and then dropped. Above it, the whole
    // point is to stop capping — so no `ideal` is sent at all (F15).
    frameRate:
      ceiling > CAPTURE_MAX_FPS ? { max: ceiling } : { ideal: ceiling, max: ceiling },
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
 * Which way up the device is, as a box the size of a screenless take's ask.
 *
 * F13's SECOND, SMALLER HALF: a screenless take asked the sensor for a
 * LANDSCAPE 1920x1080 — the wrong orientation, requested before anything was
 * composited, on the one kind of take a phone can make. A camera-only take
 * fills the frame, so the shape it is handed is the shape of the video.
 *
 * `ideal` is a preference, not a bound, so a sensor that cannot do this shape
 * hands over what it has and nothing is lost; what changes is which of several
 * available formats the browser's fitness distance picks.
 */
export function orientedCameraBox(): { width: number; height: number } {
  const portrait =
    typeof window !== 'undefined' &&
    window.innerHeight > 0 &&
    window.innerWidth > 0 &&
    window.innerHeight > window.innerWidth
  return portrait
    ? { width: CAPTURE_MAX_HEIGHT, height: CAPTURE_MAX_WIDTH }
    : { width: CAPTURE_MAX_WIDTH, height: CAPTURE_MAX_HEIGHT }
}

/**
 * Camera constraints. A camera-only take fills the whole frame (the camera-full
 * rule), so 720p was being upscaled to a 1080p export — visibly soft. Ask for
 * 1080p when there is no screen channel; when the camera is only a PiP at 24 %
 * of the width, 720p is already more than the output needs and the smaller
 * frame is cheaper to encode.
 *
 * F13: the screenless ask follows the DEVICE's orientation rather than naming
 * a landscape box. Behind the flag it is the landscape box it always was. The
 * PiP ask is untouched either way — a PiP is 24 % of the width in every frame
 * shape, and 1280x720 already exceeds what that slot can show.
 */
export function cameraVideoConstraints(config: CaptureConfig): MediaTrackConstraints {
  if (config.screen) return { width: { ideal: 1280 }, height: { ideal: 720 } }
  const box = sourceFrameEnabled()
    ? orientedCameraBox()
    : { width: CAPTURE_MAX_WIDTH, height: CAPTURE_MAX_HEIGHT }
  return { width: { ideal: box.width }, height: { ideal: box.height } }
}

export function exceedsCaptureCeiling(s: MediaTrackSettings): boolean {
  return (
    (s.width ?? 0) > CAPTURE_MAX_WIDTH ||
    (s.height ?? 0) > CAPTURE_MAX_HEIGHT ||
    // +1 fps slack: capturers report 30.000001 / 29.97 style values.
    (s.frameRate ?? 0) > captureRateCeiling() + 1
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
  // O6, default since 2026-08-29 (Robert's ruling): start at the source's own
  // resolution and let captureLadder.ts step DOWN on measured backpressure
  // instead of never starting high. See nativeRes.ts.
  if (nativeResEnabled()) {
    // THE EXPORT CEILING IS ENFORCED HERE TOO, because the request may not have
    // carried it: after a stuck share the wedge ladder drops to `{video: true}`
    // and sends NO video constraints at all (Robert's log: "reduced request
    // 2/2"), so a machine that has ever wedged was capturing its full monitor
    // however this flag was set. A constraint that only lives in the request is
    // a constraint the degraded path does not have.
    const long = Math.max(before.width ?? 0, before.height ?? 0)
    // F18: an infinite ceiling means the export ladder now goes as high as this
    // take does, so there is nothing above it to bound. The whole argument for
    // this cap was "those pixels can never be exported"; with the source step
    // they can, and the cap would be the constant F18 exists to remove.
    const sizeCeiling = captureCeilingLongEdge()
    if (Number.isFinite(sizeCeiling) && long > sizeCeiling) {
      try {
        await withTimeout(
          track.applyConstraints({
            width: { max: sizeCeiling },
            height: { max: sizeCeiling },
          }),
          1500,
          'applyConstraints(export ceiling)',
        )
        const capped = track.getSettings()
        console.info(
          `[capture] native-res capture: ${before.width}×${before.height} is past the largest export ` +
            `step (${sizeCeiling} long edge) — those pixels can never be exported, so ` +
            `recording ${capped.width}×${capped.height} (O6)`,
        )
      } catch (err) {
        console.warn('[capture] could not bound the surface to the export ceiling', err)
      }
    }
    // THE SIZE IS OTHERWISE KEPT; ONLY THE RATE IS BUDGETED (F15). A 60 fps ceiling is an
    // ask, not a promise the machine can keep: measured on prod, 3456x2234@60
    // encodes NOTHING and never recovers, while the same surface at 30 is
    // healthy. The ladder fires correctly on that take and cannot rescue it,
    // because the collapse is instant. See rate.ts's HIGH_RATE_PIXEL_BUDGET.
    const ceiling = captureRateCeiling()
    const now = track.getSettings()
    // MAX MODE ATTEMPTS WHAT THE SOURCE OFFERS, full stop. The measurement
    // below is a protection, and max is the mode where the user has said they
    // will pay for the picture instead of being protected from it.
    const rate = preemptiveRefusalAllowed()
      ? rateForSurface(now.width, now.height, ceiling, measuredEncoderThroughput())
      : ceiling
    if (rate < ceiling && (now.frameRate ?? 0) > rate + 1) {
      try {
        await withTimeout(
          track.applyConstraints({ frameRate: { max: rate } }),
          1500,
          'applyConstraints(display rate budget)',
        )
        const want = ((now.width ?? 0) * (now.height ?? 0) * ceiling) / 1e6
        const can = measuredEncoderThroughput() / 1e6
        console.info(
          `[capture] ${now.width}×${now.height} at ${ceiling} fps wants ${want.toFixed(0)} Mpx/s and ` +
            (can > 0
              ? `this machine's encoder measured ${can.toFixed(0)} Mpx/s — holding at ${rate} fps. ` +
                `The rate is what gives, never the resolution; the ladder puts it back as soon as the ` +
                `machine eases (F15/O15)`
              : `this machine has not been measured yet — holding at ${rate} fps on the old size rule. ` +
                `The next take on this profile decides from the measurement (F15)`),
        )
      } catch (err) {
        console.warn('[capture] could not hold the rate down — the ladder is the remaining guard', err)
      }
    } else {
      // Report what is being RECORDED, not what arrived. This read `before`,
      // so a surface that had just been capped printed the size it used to be —
      // "recording 2560x1663" followed by "leaving display at 3024x1964@60" in
      // the same take, which is how the 2026-08-30 freeze log read.
      const at = track.getSettings()
      console.info(
        `[capture] native-res capture: leaving display at ${at.width}×${at.height}@${at.frameRate ?? '?'} (O6)`,
      )
    }
  } else if (exceedsCaptureCeiling(before)) {
    try {
      await withTimeout(
        track.applyConstraints({
          width: { max: CAPTURE_MAX_WIDTH },
          height: { max: CAPTURE_MAX_HEIGHT },
          frameRate: { max: captureRateCeiling() },
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
  // EVENNESS IS LAST, AND IT IS ONE PLACE FOR EVERY BRANCH ABOVE. It has to be
  // both, and that is the lesson: the first version of this evened only the
  // native-res branch, and `?nativeres=0` — the documented escape hatch for a
  // machine that is struggling — went on producing an ODD track, because
  // capping a 3456x2234 screen into a 1920x1080 box gives 1671x1080. Aspect
  // ratio makes odd sides the NORM after a cap, not the exception.
  await ensureEvenDisplayDims(track)
}

/**
 * AVC subsamples chroma by two on both axes and cannot encode an odd side. It
 * REFUSES rather than rounding — `isConfigSupported` says no, the MediaRecorder
 * fallback fails the same way, and the take comes back "Missing from this take:
 * Screen" with the preview having shown the screen throughout, because the
 * TRACK was never the problem.
 *
 * THE FIX BELONGS TO THE TRACK AND NOWHERE ELSE, which was learned the
 * expensive way. Evening the ENCODER instead looks equivalent and is worse: a
 * config of 1670 fed 1671-wide frames is accepted by `isConfigSupported` and
 * then emits NOTHING — measured, `0 frames encoded of 199 in`. That turns a
 * loud failure into a silent one. Config and frames must be the same size, so
 * the frames are what change.
 */
async function ensureEvenDisplayDims(track: MediaStreamTrack): Promise<void> {
  const s = track.getSettings()
  if (!s.width || !s.height) return
  const even = { width: evenDown(s.width), height: evenDown(s.height) }
  if (even.width === s.width && even.height === s.height) return
  try {
    await withTimeout(
      track.applyConstraints({ width: { max: even.width }, height: { max: even.height } }),
      1500,
      'applyConstraints(display even)',
    )
    const after = track.getSettings()
    console.info(
      `[capture] ${s.width}×${s.height} has an odd side, which AVC cannot encode — asked for ` +
        `${even.width}×${even.height}, got ${after.width}×${after.height}`,
    )
  } catch (err) {
    console.warn(
      `[capture] could not even out ${s.width}×${s.height} — this screen channel may be refused by the encoder`,
      err,
    )
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

/**
 * Chromium defaults AEC/NS/AGC ON for display audio — voice processing mangles
 * music into warble and downmixes to mono. Capture it raw.
 */
const RAW_DISPLAY_AUDIO: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}

/**
 * The request for a given rung of the wedge ladder (displayWedge.ts). Pure, so
 * the exact object Chrome receives is testable without a browser.
 *
 * Every rung drops OUR options only — never the user's. `audio` is the lit Tab
 * Audio chip, so it survives all the way to the floor and Chrome keeps showing
 * its checkbox. Rung 1 also drops the explicit `systemAudio` flag, which costs
 * nothing: 'include' is its spec default. The capture ceiling is unaffected at
 * any rung — capDisplayTrack enforces it after delivery, which is exactly why
 * dropping the picker constraints is free.
 *
 * The RAW_DISPLAY_AUDIO flags ride EVERY rung, the floor included. They are
 * not "our options" in the ladder's sense: dropping them hands the user's
 * chosen channel to Chrome's voice processing, and AEC/NS/AGC turn tab music
 * into mono warble — an audible change to a channel the user chose, which is
 * exactly what safe mode is forbidden to make. (Until 2026-08-26 the floor
 * requested bare `audio: true`; a machine parked on rung 2 by the 4K-game
 * wedges then recorded every tab-audio take voice-processed for up to 24 h —
 * Robert heard it as "music from tab sounds shitty".) The wedge lives in the
 * picker/video path; three boolean audio-track constraints are advisory and
 * cannot reject or hang a request.
 */
export function displayMediaOptions(
  config: CaptureConfig,
  level: DisplayRequestLevel,
): DisplayMediaOptions {
  const audio = config.systemAudio ? RAW_DISPLAY_AUDIO : false
  // A DEGRADED RUNG DROPS THE EXOTIC OPTIONS, NOT THE BOUNDS, and that was
  // backwards until 2026-08-29. The wedge these rungs exist for is Chrome
  // hanging on `selfBrowserSurface` / `surfaceSwitching` / `systemAudio`, and
  // rung 1 was throwing the SIZE and RATE bounds out with them — so a machine
  // that had already choked once started capturing its WHOLE monitor, uncapped,
  // which is the opposite of backing off. Robert's take read "reduced request
  // 2/2 after a stuck share" and was capturing 3024x1964 with no bound in
  // sight, and no flag could reach it because the flag lives in the bounds that
  // had been removed.
  //
  // Rung 2 stays bare `{video: true}` on purpose: it is the rung for a machine
  // that wedges on ANY constraint object, and giving it one back would defeat
  // it. That rung is covered on the TRACK instead — capDisplayTrack enforces
  // the export ceiling on what actually arrives, whatever the request managed
  // to say.
  // THE NEW FLOOR (2026-08-30). Rung 2 was called "nothing of ours left to
  // drop" and that was not true: the three raw-audio flags are ours — the user
  // chose Tab Audio, nobody chose `echoCancellation: false` — and they have
  // ridden every rung since 2026-08-26 on the claim that "three boolean audio
  // constraints are advisory and cannot reject or hang a request", which was
  // asserted and never measured. Robert's machine wedged FIVE times with the
  // ladder already on rung 2, so whatever is choking is in what rung 2 still
  // sends, and this is what rung 2 still sends.
  //
  // Nothing the user chose goes missing: the flags MOVE to the delivered track
  // (repairDisplayAudio, below) instead of being dropped, so the tab music is
  // still raw. If the track refuses them we are exactly where this project was
  // before 2026-08-26, on a machine that has already wedged three times, and
  // the console says so.
  if (level >= 3) return { video: true, audio: config.systemAudio ? true : false }
  if (level >= 2) return { video: true, audio }
  if (level === 1) {
    return {
      video: { ...displayVideoConstraints(), displaySurface: 'monitor' } as MediaTrackConstraints,
      audio,
    }
  }
  return {
    video: displayVideoConstraints(),
    audio,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: config.systemAudio ? 'include' : 'exclude',
  }
}

/**
 * PUT THE RAW FLAGS BACK ON THE TRACK when the request was not allowed to carry
 * them (the floor rung, above). Chrome's voice processing turns tab music into
 * mono warble — Robert heard it in 2026-08-26 — so this is not cosmetic; it is
 * the reason the flags exist. A no-op on every other rung, where the settings
 * already came back false, so the common path does not even await.
 */
async function repairDisplayAudio(track: MediaStreamTrack): Promise<void> {
  const before = track.getSettings()
  if (
    before.echoCancellation !== true &&
    before.noiseSuppression !== true &&
    before.autoGainControl !== true
  ) {
    return
  }
  try {
    await track.applyConstraints(RAW_DISPLAY_AUDIO)
    const after = track.getSettings()
    console.info(
      `[capture] raw tab audio applied on the track: ec=${after.echoCancellation ?? '?'} ` +
        `ns=${after.noiseSuppression ?? '?'} agc=${after.autoGainControl ?? '?'}`,
    )
  } catch (err) {
    // Nothing to fall back to, and nothing is lost that was not already lost:
    // this only runs on a machine that has wedged its way to the floor.
    console.warn('[capture] the tab-audio track refused the raw flags — voice processing is on', err)
  }
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
 * two-line "Heads-up:" toast on every tab/window share; Robert 2026-08-23 killed
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

/**
 * Audio was asked for and the picker handed back none — i.e. the box in
 * Chrome's picker was there and left unticked.
 *
 * This said something cleverer for a few hours today: that a whole-screen
 * share cannot carry audio on macOS, so the box could not have existed. Robert's
 * screen share HAS that box. The claim was wrong and it is not coming back
 * without evidence from his machine.
 */
export function displayAudioMissingMessage(): string {
  return 'System audio was not shared — tick “Also share system audio” in the screen picker'
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

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /**
   * ALL INPUT MUST CONNECT (Robert 2026-08-25, verbatim, after the third stuck-mic
   * report: "all input must connect everytime without fails"). One timeout
   * used to be a verdict: a mic that missed its 8 s budget was dropped from
   * the take FOREVER, even though the very next getUserMedia often succeeds —
   * which is exactly what the user's own workaround (refresh, press record
   * again) had been doing by hand. So a granted device is now ASKED AGAIN:
   * CONNECT_ATTEMPTS_BEFORE_START attempts gate the synchronized start (a
   * device that answers the second ask still starts with everyone else), and
   * after that the take starts and the hunt continues in the background — the
   * channel late-joins the moment the browser hands it over, on the same
   * lateJoin path every mid-take resume already uses.
   *
   * The hunt is fenced three ways, because a retry loop that grabs devices is
   * a horror if it outlives its take: it runs only for GRANTED devices (a
   * permission prompt is never repeated at a user); it re-asks only while
   * stillWanted() says the session is alive, the channel is still missing and
   * the user has not turned it off; and a stream that lands after the answer
   * changed is stopped on arrival. A DENIAL ends everything instantly — that
   * is an answer, not a failure.
   */
  const connectPersistently = async (c: {
    kind: 'camera' | 'mic'
    grant: DeviceGrant
    dispatch: () => Promise<MediaStream>
    first: Promise<MediaStream>
    granted: boolean
    afterPicker?: Promise<unknown>
    adopt: (stream: MediaStream) => void
  }): Promise<void> => {
    const label = `getUserMedia(${c.kind})`
    const wanted = (): boolean => handlers.stillWanted?.(c.kind) ?? false
    const adopt = (stream: MediaStream): boolean => {
      try {
        rememberGrant(c.grant, true)
        c.adopt(stream)
        return true
      } catch (err) {
        for (const t of stream.getTracks()) t.stop()
        fail(toFailure(c.kind, err))
        mark(c.kind, 'failed', err instanceof Error ? err.message : String(err))
        return false
      }
    }
    let attemptPromise = c.first
    for (let attempt = 1; ; attempt++) {
      try {
        const stream = await withTimeout(
          attemptPromise,
          c.granted ? ACQUIRE_TIMEOUT_MS : PROMPT_TIMEOUT_MS,
          label,
          attempt === 1 ? c.afterPicker : undefined,
        )
        adopt(stream)
        return
      } catch (err) {
        const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
        const f = toFailure(c.kind, err, timedOut)
        if (f.denied) {
          rememberGrant(c.grant, false)
          fail(f)
          mark(c.kind, 'failed', f.message)
          return
        }
        // Prompt case: one ask on the full human budget, never repeated — a
        // second prompt is the same question the user just answered.
        if (!c.granted) {
          fail(f)
          mark(c.kind, timedOut ? 'timeout' : 'failed', f.message)
          return
        }
        if (attempt >= CONNECT_ATTEMPTS_BEFORE_START) {
          fail({
            kind: c.kind,
            message: `The ${c.kind === 'mic' ? 'microphone' : 'camera'} has not connected yet — still asking; it joins the take the moment it answers`,
            denied: false,
            timedOut,
          })
          mark(c.kind, timedOut ? 'timeout' : 'failed', 'still asking in the background')
          break
        }
        await sleep(CONNECT_RETRY_PAUSE_MS)
        mark(c.kind, 'start', `attempt ${attempt + 1}`)
        attemptPromise = c.dispatch()
      }
    }
    // The background hunt. Reached only for a granted device whose foreground
    // attempts all timed out; the take is starting without it.
    void (async () => {
      for (;;) {
        await sleep(CONNECT_RETRY_PAUSE_MS)
        if (!wanted()) return
        try {
          const stream = await withTimeout(c.dispatch(), ACQUIRE_TIMEOUT_MS, label)
          if (!wanted()) {
            for (const t of stream.getTracks()) t.stop()
            return
          }
          adopt(stream)
          return
        } catch (err) {
          // Revoked mid-hunt: the browser answered. Everything else — another
          // timeout, device busy, unplugged — is worth asking about again.
          if (err instanceof DOMException && err.name === 'NotAllowedError') {
            rememberGrant(c.grant, false)
            return
          }
        }
      }
    })()
  }

  /**
   * `granted` is a PROMISE on purpose. getUserMedia is dispatched on the first
   * line — before any await — so that when this is called beside an open
   * screen picker the device starts opening immediately; awaiting a
   * permissions.query first is what silently turned the concurrent start back
   * into a serial one (see grants.ts). The answer is still awaited, just
   * afterwards, and only to choose the budget: a prompt gets the human budget,
   * a granted device the hardware one. isGranted is itself bounded
   * (GRANT_PROBE_BUDGET_MS), so this await can never hold the hunt hostage.
   */
  const startCamera = async (
    granted: Promise<boolean>,
    afterPicker?: Promise<unknown>,
  ): Promise<void> => {
    mark('camera', 'start')
    const video = cameraVideoConstraints(config)
    if (config.cameraDeviceId) video.deviceId = config.cameraDeviceId
    const dispatch = (): Promise<MediaStream> => {
      const p = navigator.mediaDevices.getUserMedia({ video })
      p.catch(() => undefined) // adopted or stopped later; never unhandled
      return p
    }
    const first = dispatch()
    await connectPersistently({
      kind: 'camera',
      grant: 'camera',
      dispatch,
      first,
      granted: await granted,
      afterPicker,
      adopt: (stream) => {
        guardStream(stream)
        hintTrackContent(stream.getVideoTracks()[0], 'camera')
        deliver({ kind: 'camera', media: 'video', stream, track: stream.getVideoTracks()[0] })
        mark('camera', 'done', stream.getVideoTracks()[0]?.label)
      },
    })
  }

  /** Same shape as startCamera — see the note there on why `granted` is a promise. */
  const startMic = async (
    granted: Promise<boolean>,
    afterPicker?: Promise<unknown>,
  ): Promise<void> => {
    mark('mic', 'start')
    const audio: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      // Ask for full-band capture; a device stuck in telephone mode ignores
      // this, which is exactly what the narrowband rescue below detects.
      sampleRate: { ideal: 48000 },
    }
    if (config.micDeviceId) audio.deviceId = config.micDeviceId
    const dispatch = (): Promise<MediaStream> => {
      const p = navigator.mediaDevices.getUserMedia({ audio })
      p.catch(() => undefined) // adopted or stopped later; never unhandled
      return p
    }
    const first = dispatch()
    await connectPersistently({
      kind: 'mic',
      grant: 'microphone',
      dispatch,
      first,
      granted: await granted,
      afterPicker,
      adopt: (stream) => {
        guardStream(stream)
        // NARROWBAND WARNING only (Robert rule 2026-07-21: never override the user's
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
      },
    })
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
  /** The live request's handle — the timeout path marks it stuck so the NEXT
   *  press knows this frame can no longer ask (displayInflight.ts). */
  let displayReq: { stuck: () => void; claim: () => void } | null = null
  /** The live request's forensic watch — read again at the timeout, where its
   *  report is the only witness statement a wedge ever gives. */
  let displayForensics: ReturnType<typeof beginDisplayForensics> | null = null
  /** The screen request was HELD BACK ('busy' / 'stale'): this take is already
   *  dead — session.ts throws on a timed-out primary — so nothing else is
   *  asked for it (see the stragglers below). */
  let primaryRefused = false
  const canDisplay = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  // Which rung of the wedge ladder this request rides on — 0 unless this
  // machine has had a share taken and never delivered (displayWedge.ts). No
  // rung of it touches the user's asks, so audio is asked for iff they said so.
  const displayLevel: DisplayRequestLevel = config.screen ? displayRequestLevel() : 0
  if (config.screen) {
    /**
     * ONE SCREEN REQUEST AT A TIME — the refusal all the "do not ask now"
     * paths share. It is not a diagnosis and not a wedge: nothing is counted,
     * no rung moves, and the UI does not refresh on it (refreshing is what
     * orphans a request that could still settle). The user's next press is
     * free the moment Chrome is.
     */
    const refuseBusy = (why: string): void => {
      primaryRefused = true
      const msg = displayStallMessage('busy', detectPlatform().browser, 'failed')
      console.warn(`[capture] not asking Chrome for the screen — ${why}`)
      appendWedgeJournal({
        kind: 'wedge',
        stall: 'busy',
        level: displayLevel,
        count: displayWedgeCount(),
        pending: unsettledDisplayRequests(),
        channels: askedChannels(config),
      })
      fail({ kind: 'screen', message: msg, denied: false, timedOut: true, stall: 'busy' })
      mark('display', 'failed', why)
      if (config.systemAudio) {
        fail({ kind: 'system-audio', message: msg, denied: false, timedOut: true, stall: 'busy' })
        mark('system-audio', 'failed', why)
      }
    }
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
    } else if (displayRequestOutstanding()) {
      // A SCREEN REQUEST FROM THIS DOCUMENT IS STILL STUCK (displayInflight.ts).
      // Chrome has it booked against this RenderFrame and no page code can
      // cancel it; a second request dispatched into that frame is the one that
      // "wedges again" on every press after the first. Do not make the call
      // that cannot work — say so instantly and let the app reload, which is
      // the only reset a page has. Nothing that could have connected is given
      // up here; 30 s of "Waiting for screen…" is.
      const msg = displayStallMessage('stale', detectPlatform().browser, 'failed')
      console.warn('[capture] a screen request from this page is still outstanding — not dispatching another')
      analytics.track('display_wedge', {
        conservative: displayLevel > 0,
        level: displayLevel,
        wedgeCount: displayWedgeCount(),
        stall: 'stale',
      })
      // AND ON THE MACHINE, where somebody can actually read it later
      // (wedgeJournal.ts) — the sink above is a noop in production.
      appendWedgeJournal({
        kind: 'wedge',
        stall: 'stale',
        level: displayLevel,
        count: displayWedgeCount(),
        channels: askedChannels(config),
      })
      primaryRefused = true
      fail({ kind: 'screen', message: msg, denied: false, timedOut: true, stall: 'stale' })
      mark('display', 'failed', 'a previous screen request is still outstanding')
      if (config.systemAudio) {
        fail({ kind: 'system-audio', message: msg, denied: false, timedOut: true, stall: 'stale' })
        mark('system-audio', 'failed', 'a previous screen request is still outstanding')
      }
    } else if (displayRequestPending()) {
      // CHROME TAKES ONE SCREEN REQUEST AT A TIME, and this document already
      // has one out (displayInflight.ts). Robert proved what a second one does
      // (2026-08-30, two tabs at once: "wedge happen"), and the same collision
      // is reachable with no second tab at all — press record, let the picker
      // open, cancel the arm, press record again: the first request is still
      // pending because a page cannot cancel getDisplayMedia, and the second
      // one is the one that hangs forever.
      //
      // So this press does not send it. Nothing that could have connected is
      // given up — the call this removes is the one that was going to hang —
      // and unlike 'stale' NOTHING is refreshed: the pending request can still
      // settle by itself, and replacing this document is what orphans it where
      // nobody can ever settle it again.
      refuseBusy('a screen request from this page is still pending')
    } else {
      let stillHeldAtDeadline = false
      // NEVER RACE THE PREVIOUS SHARE'S TEARDOWN (displayRelease.ts — Robert's
      // rapid record/stop stress test wedges Chrome). The check is a sync
      // no-op whenever clear, so the same-tick dispatch survives in the
      // common case. Apple WebKit is exempt outright: transient activation
      // dies at the first await there, and it does not wedge this way.
      // Chromium/Gecko keep activation for ~5 s, far above the 3 s budget.
      if (!isAppleWebKit() && !displayCaptureClear()) {
        mark('display', 'start', 'waiting for the previous share to release')
        const cleared = await awaitDisplayCaptureClear()
        console.info(
          cleared
            ? '[capture] previous share released — requesting the screen'
            : '[capture] previous share still held at the deadline — not asking on top of it',
        )
        stillHeldAtDeadline = !cleared
      }
      // AND CLEAR THE PREVIOUS SHARE BEFORE ASKING, OR DO NOT ASK. Robert,
      // 2026-08-30: "when we about to ask permission, do we clear previous one
      // in this moment?" We do not — a page cannot cancel a getDisplayMedia,
      // and the only thing it can clear is a delivered track. What this used
      // to do at the deadline was worse than not clearing: it logged "still
      // held — requesting anyway" and made the call ON TOP of a live share,
      // which is the exact collision that hangs Chrome. It does not ask now.
      // The tracks are NOT stopped here: our own stop path keeps the display
      // track alive while it drains the recorder (P0-tail-raw), and killing it
      // would cut the tail off the take that is still being written.
      if (stillHeldAtDeadline) {
        refuseBusy('the previous share has not been released yet')
      } else {
        // A machine that wedged gets a smaller request — see displayWedge.ts.
        // Only OUR options are dropped, so nothing the user chose goes missing.
        const opts = displayMediaOptions(config, displayLevel)
        // PRINT THE ACTUAL REQUEST, EVERY TAKE. Three rounds of "the sound
        // checkbox is missing" were spent arguing about what we send; from here
        // the console answers that in one line, before the picker even opens.
        console.info(
          `[capture] asking Chrome for ${config.systemAudio ? 'screen + tab audio' : 'screen'}` +
            (displayLevel > 0
              ? ` — reduced request ${displayLevel}/${MAX_DISPLAY_LEVEL} after a stuck share, your channels unchanged`
              : ''),
          opts,
        )
        // TWO ceilings, because there are two different things that can be slow.
        // The outer one is the human at the picker and stays generous. The inner
        // one only starts once the picker has closed, and catches the failure
        // Robert actually hit: a getDisplayMedia that never settles at all while
        // Chrome shows the screen as shared. Without it the app waits out the
        // full human budget on a promise that is already dead.
        const rawDisplay = navigator.mediaDevices.getDisplayMedia(opts)
        rawDisplay.catch(() => undefined) // handled below; never unhandled
        // From here this document owns an open request until Chrome settles it —
        // which, in the wedge, is never. The next press must not add a second.
        displayReq = markDisplayRequest(rawDisplay)
        // …and from here the forensics watch what leaks out of Chrome around it
        // (focus and time — all a page can see), so a stall names its suspect
        // instead of adding one to a count (stallForensics.ts).
        const forensics = beginDisplayForensics()
        displayForensics = forensics
        displayPromise = withTimeout(
          withTimeout(rawDisplay, PICKER_SETTLE_MS, 'getDisplayMedia (picker closed)', pickerClosed()),
          DISPLAY_TOTAL_BUDGET_MS,
          'getDisplayMedia',
        )
        // SAY IT WHILE IT IS STILL HAPPENING (W1 item 3). Everything this app
        // knew about a stuck share used to arrive in the post-take banner, up to
        // 30 s after the press — and when the cause is an ungranted macOS
        // permission, Chrome has been displaying the answer that whole time
        // while our screen said "Waiting for screen…". This is a NOTICE, not a
        // failure: the request runs on, and most requests that reach this line
        // still land. It fires once, well past any plausible picker
        // interaction, and is cancelled the moment the promise settles either
        // way.
        const stallTimer = setTimeout(() => {
          const stall = classifyDisplayStall(detectPlatform().os)
          console.warn(
            `[capture] screen request still outstanding at ${DISPLAY_STALL_NOTICE_MS} ms — reading it as ${stall}`,
          )
          console.warn(`[capture:forensics] ${describeForensics(forensics.report())}`)
          handlers.onStall?.(displayStallMessage(stall, detectPlatform().browser, 'waiting'), stall)
        }, DISPLAY_STALL_NOTICE_MS)
        const clearStall = (): void => {
          clearTimeout(stallTimer)
          forensics.settle()
        }
        rawDisplay.then(clearStall, clearStall)
      }
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
      // THIS TAKE OWNS WHAT ARRIVED. Said here, first thing, because anything
      // that comes back unclaimed is stopped as an abandoned share
      // (displayInflight.ts) — the leak that kept a capture session alive for
      // this origin after a take had already given up on it.
      displayReq?.claim()
      // Before capDisplayTrack's await, before anything: from this line on the
      // screen is live and Chrome's indicator is lit, so from this line on it
      // must be releasable no matter what happens next.
      guardStream(display)
      // …and the NEXT share request must wait for these to end (displayRelease).
      for (const t of display.getTracks()) trackDisplayCapture(t)
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
      // wedge mark. A lower rung keeps it; it costs nothing visible.
      rememberDisplaySuccess(displayLevel)
      // …and the delivery count is what the forensics compare a stall against
      // ("first take after a Chrome launch" is the pattern under test).
      noteScreenDelivered()
      if (config.systemAudio) {
        const audio = display.getAudioTracks()[0]
        if (audio) {
          // PRINT WHAT THE TRACK ACTUALLY IS, every take — the request above
          // asks for raw stereo, but Chrome is the authority on what arrived,
          // and "tab music sounds wrong" is undiagnosable without this line.
          // ec/ns/agc true here = voice processing mangled the music.
          const s = audio.getSettings()
          console.info(
            `[capture] tab audio delivered: ec=${s.echoCancellation ?? '?'} ns=${s.noiseSuppression ?? '?'} ` +
              `agc=${s.autoGainControl ?? '?'} ch=${s.channelCount ?? '?'} sr=${s.sampleRate ?? '?'}`,
          )
          await repairDisplayAudio(audio)
          deliver({
            kind: 'system-audio',
            media: 'audio',
            stream: new MediaStream([audio]),
            track: audio,
          })
          mark('system-audio', 'done')
        } else {
          const message = displayAudioMissingMessage()
          fail({ kind: 'system-audio', message, denied: false })
          mark('system-audio', 'failed', message)
        }
      }
      // Anything the picker handed back that we do NOT deliver must be stopped
      // right here. Only the first video track and (when asked for) the first
      // audio track become channels; the rest used to stay live with no owner,
      // which on macOS keeps the screen-recording indicator lit after the take
      // is gone (Robert 2026-08-23: "indicators of mic and screen still there").
      const delivered = new Set<MediaStreamTrack>()
      if (video) delivered.add(video)
      if (config.systemAudio && display.getAudioTracks()[0]) {
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
      let stall: DisplayStall | undefined
      if (timedOut) {
        stall = classifyDisplayStall(detectPlatform().os)
        // OUR BUDGET IS DEAD, CHROME'S REQUEST IS NOT. It is still booked
        // against this frame with no way to cancel it, so nothing dispatched
        // from this document can get through any more — say so once, here,
        // where the deadline actually fired.
        displayReq?.stuck()
        // Counted before the message is built, so the text can say how many in
        // a row, and stop repeating advice this user has already carried out.
        rememberDisplayStall()
        // A PERMISSION STALL MUST NOT TOUCH THE LADDER (W1 item 3). The ladder
        // exists to find which of OUR options Chrome chokes on; an ungranted
        // macOS screen-recording toggle is not one of them, and escalating
        // against it parked Robert's machine on the floor for 24 h over a
        // checkbox — the exact ratchet this task removes. The share was taken
        // and never delivered only in the OTHER case, and only that one marks
        // the machine so the NEXT click sends the smaller request.
        if (stall === 'wedge') rememberDisplayWedge()
        // THE WITNESS STATEMENT, printed at the failure too: the stall notice
        // at 12 s is easy to scroll past, and the analytics event is where the
        // clustering question ("always the first take after a Chrome launch?")
        // gets its answer across machines.
        const witness = displayForensics?.report()
        if (witness) console.warn(`[capture:forensics] ${describeForensics(witness)}`)
        analytics.track('display_wedge', {
          conservative: displayLevel > 0,
          level: displayLevel,
          wedgeCount: displayWedgeCount(),
          stall,
          ...(witness
            ? {
                focus: witness.focus,
                deliveriesThisSession: witness.deliveriesThisSession,
                pageAgeMs: witness.pageAgeMs,
                waitedMs: witness.waitedMs,
              }
            : {}),
        })
        // THE SAME STATEMENT, WRITTEN DOWN. The console line above is for a
        // console nobody will open and the sink is a noop in production, so
        // the journal is the only copy that survives to be read off the
        // machine afterwards (wedgeJournal.ts).
        appendWedgeJournal({
          kind: 'wedge',
          stall,
          level: displayLevel,
          count: displayWedgeCount(),
          // Chrome takes one at a time: anything above 1 here (this request
          // included) means the take collided with one of ours.
          pending: unsettledDisplayRequests(),
          channels: askedChannels(config),
          ...(witness
            ? {
                focus: witness.focus,
                deliveries: witness.deliveriesThisSession,
                pageAgeMs: witness.pageAgeMs,
                waitedMs: witness.waitedMs,
              }
            : {}),
        })
      }
      fail(toFailure('screen', err, timedOut, stall))
      if (config.systemAudio) fail(toFailure('system-audio', err, timedOut, stall))
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
  // 120 s (Robert 2026-08-24). The probe was previously skipped entirely without a
  // screen picker; the reason given — extra await hops break Safari's
  // transient activation — only applies in front of getDisplayMedia, which by
  // here has either been dispatched already or was never requested.
  const parallel: Promise<void>[] = [...early]
  if (primaryRefused) {
    // A TAKE WHOSE SCREEN WAS HELD BACK IS ALREADY DEAD, AND IT USED TO ARM
    // ANYWAY. The 'busy' / 'stale' refusals above are instant by design (a
    // wedge costs one press) — but the camera and the mic were still started
    // here, and the take then sat through their budgets and the persistent-
    // connect re-asks before session.ts could throw the failure it already
    // knew about. Read off Robert's machine, 2026-09-02: 'stale' journalled at
    // 08:53:03, the reload it promised at 08:53:21 — eighteen seconds of
    // "Waiting for camera and microphone…" for nothing. Not fail-fast: nothing
    // that could have recorded is given up, because a timed-out primary fails
    // the take and releases every device regardless (session.ts).
    const why = 'the screen request was held back — nothing will record'
    if (config.camera && !camEarly) mark('camera', 'skipped', why)
    if (config.mic && !micEarly) mark('mic', 'skipped', why)
  } else {
    if (config.camera && !camEarly) parallel.push(startCamera(isGranted('camera')))
    if (config.mic && !micEarly) parallel.push(startMic(isGranted('microphone')))
  }

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
