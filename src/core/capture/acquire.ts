import type { CaptureConfig, ChannelKind, MediaKind } from '@core/types'

export interface AcquiredChannel {
  kind: ChannelKind
  media: MediaKind
  stream: MediaStream
  /** Primary track: the video track for video kinds, the audio track for audio kinds. */
  track: MediaStreamTrack
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

/** Per-device acquisition budget — degrade to succeeded channels rather than
 * hang. 5s (was 15s): a hung device must not hold a take hostage; the take
 * starts without it and the loss is surfaced loudly. */
export const ACQUIRE_TIMEOUT_MS = 5_000

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
    ? `Timed out after ${ACQUIRE_TIMEOUT_MS}ms`
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DOMException(`${label} timed out after ${ms}ms`, 'TimeoutError'))
    }, ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
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

  const startCamera = async (): Promise<void> => {
    mark('camera', 'start')
    try {
      const video: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } }
      if (config.cameraDeviceId) video.deviceId = config.cameraDeviceId
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ video }),
        ACQUIRE_TIMEOUT_MS,
        'getUserMedia(camera)',
      )
      deliver({ kind: 'camera', media: 'video', stream, track: stream.getVideoTracks()[0] })
      mark('camera', 'done', stream.getVideoTracks()[0]?.label)
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      fail(toFailure('camera', err, timedOut))
      mark('camera', timedOut ? 'timeout' : 'failed', err instanceof Error ? err.message : String(err))
    }
  }

  const startMic = async (): Promise<void> => {
    mark('mic', 'start')
    try {
      const audio: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
      if (config.micDeviceId) audio.deviceId = config.micDeviceId
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio }),
        ACQUIRE_TIMEOUT_MS,
        'getUserMedia(mic)',
      )
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
  const early: Promise<void>[] = []
  let camEarly = false
  let micEarly = false
  if (config.camera && (await isGranted('camera'))) {
    camEarly = true
    early.push(startCamera())
  }
  if (config.mic && (await isGranted('microphone'))) {
    micEarly = true
    early.push(startMic())
  }

  if (config.screen) {
    mark('display', 'start')
    try {
      const opts: DisplayMediaOptions = {
        video: { frameRate: { ideal: 30 } },
        // Chromium defaults AEC/NS/AGC ON for display audio — voice processing
        // mangles music into warble and downmixes to mono. Capture it raw.
        audio: config.systemAudio
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          : false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: config.systemAudio ? 'include' : 'exclude',
      }
      const display = await withTimeout(
        navigator.mediaDevices.getDisplayMedia(opts),
        ACQUIRE_TIMEOUT_MS,
        'getDisplayMedia',
      )
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
      // Screen delivered LAST from the display result: it is the primary, and
      // delivering it resolves primaryReady — system audio must already be in.
      if (video) {
        deliver({ kind: 'screen', media: 'video', stream: new MediaStream([video]), track: video })
      }
      mark('display', 'done', video ? `track=${video.label || video.id}` : 'no video track')
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      fail(toFailure('screen', err, timedOut))
      if (config.systemAudio) fail(toFailure('system-audio', err, timedOut))
      mark('display', timedOut ? 'timeout' : 'failed', err instanceof Error ? err.message : String(err))
      if (config.systemAudio) {
        mark('system-audio', timedOut ? 'timeout' : 'failed')
      }
    }
  } else if (config.systemAudio) {
    fail({ kind: 'system-audio', message: 'System audio requires screen sharing', denied: false })
    mark('system-audio', 'skipped', 'requires screen sharing')
  }

  const parallel: Promise<void>[] = [...early]
  if (config.camera && !camEarly) parallel.push(startCamera())
  if (config.mic && !micEarly) parallel.push(startMic())

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
