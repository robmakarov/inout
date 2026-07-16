import { newId } from '@core/id'
import { blobStore, createDurablePositionedWriter, recordingsRepo } from '@core/store'
import type {
  CaptureConfig,
  CaptureEvent,
  CaptureSession,
  CaptureState,
  ChannelKind,
  ChannelRecording,
  MediaKind,
  Recording,
} from '@core/types'
import { CaptureError, MAX_RECORDING_MS } from '@core/types'
import type { AcquiredChannel, AcquireFailure, ArmingProgressHandler } from './acquire'
import { acquireRealChannels } from './acquire'
import {
  canMeasureAudioCapture,
  prewarmMeasuredAudio,
  startMeasuredAudioCapture,
  type MeasuredAudioHandle,
} from './measuredAudio'
import { canLiveComposite, startLiveComposite, type LiveCompositeHandle } from './liveComposite'
import { clearPendingManifest, writePendingManifest } from './recovery'
import { createSyntheticChannels, isSyntheticMode } from './synthetic'

export type { ArmingProgressHandler, ArmingTimelineEntry, ArmingStep } from './acquire'

const VIDEO_MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
const AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/webm']
const TICK_MS = 250
const TIMESLICE_MS = 1000

function pickMimeType(media: MediaKind): string {
  const candidates = media === 'video' ? VIDEO_MIMES : AUDIO_MIMES
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return candidates[candidates.length - 1]
}

function recorderOptions(kind: ChannelKind, media: MediaKind, mimeType: string): MediaRecorderOptions {
  if (media === 'video') {
    return { mimeType, videoBitsPerSecond: kind === 'screen' ? 8_000_000 : 4_000_000 }
  }
  return { mimeType, audioBitsPerSecond: 128_000 }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err)
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

  private stateInternal: CaptureState = 'armed'
  private readonly listeners = new Set<(e: CaptureEvent) => void>()
  private readonly channels: ChannelRuntime[] = []
  private pendingErrors: { kind: ChannelKind; message: string }[] = []
  private readonly recordingId = newId('rec')
  private epoch = 0
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private manifestTimer: ReturnType<typeof setTimeout> | null = null
  private composite: LiveCompositeHandle | null = null
  private compositeStarting: Promise<void> | null = null
  private stopPromise: Promise<Recording> | null = null
  private cancelPromise: Promise<void> | null = null
  private cancelled = false
  private disposeSynthetic: (() => void) | null = null
  private readonly onArming: ArmingProgressHandler | undefined

  constructor(config: CaptureConfig, onArming?: ArmingProgressHandler) {
    this.config = { ...config }
    this.onArming = onArming
  }

  get state(): CaptureState {
    return this.stateInternal
  }

  async arm(): Promise<void> {
    const armT0 = performance.now()
    let acquired: AcquiredChannel[]
    const failures: AcquireFailure[] = []

    if (isSyntheticMode()) {
      const rig = createSyntheticChannels(this.config)
      this.disposeSynthetic = rig.dispose
      acquired = rig.channels
    } else {
      const res = await acquireRealChannels(this.config, this.onArming)
      acquired = res.channels
      failures.push(...res.failures)
    }

    const writerT0 = performance.now()
    console.info(
      `[capture:arming] writers start +${(writerT0 - armT0).toFixed(0)}ms (${acquired.length} channels)`,
    )
    const armed = await Promise.all(
      acquired.map(async (acq) => {
        try {
          await this.armChannel(acq)
          return null
        } catch (err) {
          for (const t of acq.stream.getTracks()) t.stop()
          return { kind: acq.kind, message: errMessage(err), denied: false } satisfies AcquireFailure
        }
      }),
    )
    for (const f of armed) if (f) failures.push(f)
    console.info(
      `[capture:arming] writers done +${(performance.now() - armT0).toFixed(0)}ms ` +
        `(writer phase ${(performance.now() - writerT0).toFixed(0)}ms)`,
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
  }

  private async armChannel(acq: AcquiredChannel): Promise<void> {
    const id = newId('ch')
    const blobKey = `${this.recordingId}_${id}.webm`
    const useMeasured = acq.media === 'audio' && canMeasureAudioCapture()

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
      recorderStarted: false,
      ended: false,
      stopped,
      resolveStopped,
    }

    if (useMeasured) {
      try {
        rt.audioCtx = await prewarmMeasuredAudio(acq.track)
      } catch (err) {
        console.warn('[capture] measured audio prewarm failed, will init at start', err)
      }
    } else {
      const writable = await blobStore.createWriteStream(blobKey)
      const writer = writable.getWriter()
      rt.writer = writer
      let recorder: MediaRecorder
      try {
        recorder = new MediaRecorder(acq.stream, recorderOptions(acq.kind, acq.media, rt.mimeType))
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
        rt.writeChain = rt.writeChain.then(async () => {
          if (rt.writeFailed || !rt.writer) return
          try {
            await rt.writer.write(data)
            rt.bytes += data.size
          } catch (err) {
            rt.writeFailed = true
            console.error('[capture] blob write failed for', rt.kind, err)
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
  }

  start(): void {
    if (this.stateInternal !== 'armed') return
    this.epoch = performance.now()
    const startT0 = performance.now()

    for (const ch of this.channels) {
      if (ch.ended) continue
      if (ch.useMeasured) {
        ch.measuredStarting = this.startMeasured(ch, startT0)
        continue
      }
      if (!ch.recorder) continue
      try {
        const tCall = performance.now()
        // Video file epoch ≈ startCall (MEASURED) — not onstart. Using onstart
        // made video startOffset ~76ms late vs audio and showed up as +150ms
        // flash+click (audio late).
        ch.startAbs = tCall
        ch.startOffsetMs = tCall - this.epoch
        ch.recorder.start(TIMESLICE_MS)
        ch.recorderStarted = true
        console.info(
          `[capture:arming] recorder.start ${ch.kind} call +${(tCall - startT0).toFixed(0)}ms`,
        )
      } catch (err) {
        ch.ended = true
        this.pendingErrors.push({ kind: ch.kind, message: errMessage(err) })
      }
    }
    console.info(
      `[capture:arming] all start calls kicked +${(performance.now() - startT0).toFixed(0)}ms`,
    )
    this.setState('recording')
    const queued = this.pendingErrors
    this.pendingErrors = []
    for (const e of queued) this.emit({ type: 'channel-error', kind: e.kind, message: e.message })
    this.tickTimer = setInterval(() => this.onTick(), TICK_MS)
    this.startComposite()
    this.writeManifest()
    // Offsets settle within the first seconds; refresh so a salvage keeps sync.
    this.manifestTimer = setTimeout(() => this.writeManifest(), 2500)
  }

  private startComposite(): void {
    const screen = this.previewStreams.screen
    const camera = this.previewStreams.camera
    const audio = [this.previewStreams.mic, this.previewStreams['system-audio']].filter(
      (x): x is MediaStream => !!x,
    )
    const inputs = { screen, camera, audio }
    if (!canLiveComposite(inputs)) return
    this.compositeStarting = startLiveComposite(inputs, `${this.recordingId}_composite.webm`)
      .then((h) => {
        if (this.stateInternal === 'recording') this.composite = h
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
    if (rt.useMeasured && rt.measured) {
      void rt.measured.stop().then((r) => {
        rt.bytes = r.bytes
        rt.durationMs = r.durationMs
        rt.startOffsetMs = r.startOffsetMs
        rt.resolveStopped()
      })
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

  private releaseMedia(): void {
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

  private async doStop(): Promise<Recording> {
    this.clearTick()
    this.setState('stopping')
    this.stopRecorders(true)
    await Promise.all(this.channels.map((c) => c.stopped))
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

    try {
      if (this.compositeStarting) await this.compositeStarting
      const composite = await this.composite?.stop()
      if (composite) recording.composite = composite
    } catch (err) {
      console.warn('[capture] live composite stop failed', err)
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
    this.clearTick()
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
}

export async function createCaptureSession(
  config: CaptureConfig,
  opts?: CreateCaptureSessionOptions,
): Promise<CaptureSession> {
  const session = new Session(config, opts?.onArming)
  await session.arm()
  return session
}
