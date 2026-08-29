/**
 * Measured VIDEO capture (task X6) — a raw screen/camera channel recorded with
 * WebCodecs instead of MediaRecorder, shaped exactly like measuredAudio.ts so
 * session.ts's existing `useMeasured` seam carries it with no new stop path.
 *
 * WHY IT NEEDS ITS OWN TRACK. A MediaStreamTrackProcessor CONSUMES a track's
 * frames, and the v2 live composite already has one on the screen and camera
 * tracks. Two processors on one track is not a thing. So this clones the track:
 * a clone is an independent sink on the same source, which is precisely what
 * MediaRecorder was as a second consumer. The clone is ours to stop, which also
 * means the tail-drain constraints P0-tail-raw applies land on the clone rather
 * than on the track the composite and the preview are using.
 *
 * WHAT IT BUYS, in the order the task states it:
 *   · the encode moves from SOFTWARE VP8/VP9 to hardware AVC (O3a measured the
 *     two software encodes as the largest capture CPU cost);
 *   · the file STREAMS — fragmented MP4 written and flushed per chunk to the
 *     worker's own SyncAccessHandle — which is the exact property O3a refused
 *     MediaRecorder's MP4 for lacking (753 bytes on a mid-take kill);
 *   · the stop path gets a real flush() instead of P0-tail-raw's starve-and-
 *     probe ritual, because the encoder is ours;
 *   · keyframe control on raw channels, which is what smart-cut-over-raw needs.
 *
 * IT IS OFF BY DEFAULT. The frozen rule is that a new engine ships capability-
 * gated with the current path as the runtime fallback and DEFAULTS UNCHANGED
 * unless the task says otherwise, and X6 does not say otherwise — a capture
 * default is Robert's to flip, on evidence, as O4's was. `?rawcodec=webcodecs`.
 */
import { rawVideoCodec } from './rawCodec'
import type { RawVideoMsg, RawVideoReply, RawVideoStats } from './rawVideo.worker'

export const MEASURED_VIDEO_MIME = 'video/mp4'

/** MediaStreamTrackProcessor (Chromium) — still absent from the TS DOM lib. */
interface TrackProcessorLike {
  readable: ReadableStream<VideoFrame>
}
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => TrackProcessorLike

function trackProcessorCtor(): TrackProcessorCtor | null {
  const g = globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }
  return typeof g.MediaStreamTrackProcessor === 'function' ? g.MediaStreamTrackProcessor : null
}

/**
 * Can this browser record a raw video channel this way, and has it been asked
 * to? Capability AND preference, in that order — the same shape
 * canMeasureAudioCapture() has.
 */
export function canMeasureVideoCapture(): boolean {
  return (
    rawVideoCodec() === 'webcodecs' &&
    trackProcessorCtor() !== null &&
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    !!navigator.storage?.getDirectory
  )
}

export interface MeasuredVideoHandle {
  readonly mimeType: string
  /** Resolves with startOffsetMs once the first frame has been encoded. */
  readonly firstOffset: Promise<number>
  stop: () => Promise<{
    bytes: number
    durationMs: number
    startOffsetMs: number
    stats: RawVideoStats
    /** B7: what this channel's offset was built from. Instrumentation only. */
    anchor: { rawAnchorMs: number; firstFrameDelayMs: number }
  }>
  cancel: () => Promise<void>
}

const START_TIMEOUT_MS = 8_000
const STOP_TIMEOUT_MS = 10_000

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

export async function startMeasuredVideoCapture(opts: {
  /** The channel's live track. CLONED here; the original is left alone. */
  track: MediaStreamTrack
  /** OPFS key the channel's file is written to. */
  key: string
  /** Session epoch (performance.now() at start()). */
  epoch: number
  width: number
  height: number
  fps: number
  videoBitrate: number
  /**
   * Fired ONCE if capture dies mid-take. Without it the take keeps "recording"
   * while every later frame is lost — the file just stops partway with no
   * signal, which is the failure mode channel-error exists for.
   */
  onFatal?: (err: Error) => void
}): Promise<MeasuredVideoHandle> {
  const TP = trackProcessorCtor()
  if (!TP) throw new Error('measured video: MediaStreamTrackProcessor unavailable')

  const worker = new Worker(new URL('./rawVideo.worker.ts', import.meta.url), { type: 'module' })
  // An independent sink on the same source: the composite keeps the original.
  const clone = opts.track.clone()

  let resolveFirst: (offsetMs: number) => void = () => {}
  const firstOffset = new Promise<number>((resolve) => {
    resolveFirst = resolve
  })

  let settleStart: ((r: RawVideoReply) => void) | null = null
  let settleStop: ((r: RawVideoReply) => void) | null = null
  let settleCancel: (() => void) | null = null
  let fatalReported = false

  worker.onmessage = (ev: MessageEvent<RawVideoReply>) => {
    const reply = ev.data
    if ('event' in reply) {
      if (!fatalReported) {
        fatalReported = true
        opts.onFatal?.(new Error(reply.error))
      }
      return
    }
    if (reply.cmd === 'start') settleStart?.(reply)
    else if (reply.cmd === 'stop') settleStop?.(reply)
    else if (reply.cmd === 'cancel') settleCancel?.()
  }
  worker.onerror = (ev) => {
    if (!fatalReported) {
      fatalReported = true
      opts.onFatal?.(new Error(ev.message || 'raw video worker error'))
    }
  }

  const send = (msg: RawVideoMsg, transfer?: Transferable[]): void =>
    worker.postMessage(msg, transfer ?? [])

  const started = new Promise<RawVideoReply>((resolve) => {
    settleStart = resolve
  })
  send({
    cmd: 'start',
    key: opts.key,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    videoBitrate: opts.videoBitrate,
  })
  const startReply = await withDeadline(started, START_TIMEOUT_MS, 'raw video start').catch(
    (err: Error) => {
      clone.stop()
      worker.terminate()
      throw err
    },
  )
  if (!('ok' in startReply) || !startReply.ok) {
    clone.stop()
    worker.terminate()
    throw new Error(
      'ok' in startReply && !startReply.ok ? startReply.error : 'raw video start failed',
    )
  }
  console.info(
    `[capture] raw ${opts.track.kind} channel on WebCodecs: ${startReply.cmd === 'start' ? `${startReply.codec} (${startReply.hardware})` : ''}`,
  )

  // ---- the frame pump ------------------------------------------------------
  // Read on THIS thread and transfer each frame, exactly as liveCompositeV2
  // does, so the arrival stamp startOffsetMs is built from is a main-thread
  // stamp on the same clock as the session epoch. See the worker's header.
  let pumping = true
  let firstFrameSeen = false
  // B7: when this channel STARTED ASKING for frames. `startOffsetMs` measures
  // from the session epoch and so folds in everything the session did before
  // this channel existed; the gap between these two is the DEVICE's own
  // spin-up, which is the half a synthetic rig can never show (a canvas
  // answers in ~0 ms, a real getDisplayMedia surface took 233 ms in one run).
  const pumpStartMs = performance.now()
  let firstFrameDelayMs = 0
  const reader = new TP({ track: clone }).readable.getReader()
  void (async () => {
    try {
      while (pumping) {
        const { value, done } = await reader.read()
        if (done) break
        if (!pumping) {
          value.close()
          break
        }
        const atMs = performance.now()
        if (!firstFrameSeen) {
          firstFrameSeen = true
          firstFrameDelayMs = atMs - pumpStartMs
          resolveFirst(atMs - opts.epoch)
          // WHAT COLOUR DOES THE SOURCE EVEN HAND US? This decides whether the
          // ~20 % of glyph colour a take loses is OURS or Chrome's, and nothing
          // in the lab can answer it: a synthetic screen is a canvas, while a
          // real getDisplayMedia frame comes from the OS capturer.
          //   I420 / NV12  → already 4:2:0 before we touch it. No encoder we
          //                  choose can get that colour back, and the ceiling
          //                  is what skipping the composite (O3b) already hits.
          //   RGBA / I444  → the source is full colour and the loss is OUR
          //                  encode, so a 4:4:4 capture mode would recover it.
          // Logged once per channel, console only, nothing behaves differently.
          console.info(
            `[capture] raw ${opts.track.kind} source frame: format ${value.format ?? 'unknown'} · coded ${value.codedWidth}x${value.codedHeight} · display ${value.displayWidth}x${value.displayHeight}`,
          )
        }
        send({ cmd: 'frame', atMs, frame: value }, [value as unknown as Transferable])
      }
    } catch {
      /* the reader is cancelled at stop; a throw here is that, not a failure */
    }
  })()

  const endPump = async (): Promise<void> => {
    pumping = false
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
    clone.stop()
  }

  return {
    mimeType: MEASURED_VIDEO_MIME,
    firstOffset,
    async stop() {
      // Order matters: stop feeding BEFORE asking the encoder to flush, or the
      // flush races frames still arriving and the file's last fragment is a
      // partial one. The composite's stop makes the same move.
      // The channel ends HERE, on this thread's clock — the same clock the
      // session epoch and startOffsetMs live on. Read before endPump() so the
      // teardown's own duration is not counted as recorded material.
      const stopAtMs = performance.now()
      await endPump()
      const done = new Promise<RawVideoReply>((resolve) => {
        settleStop = resolve
      })
      send({ cmd: 'stop', atMs: stopAtMs })
      const reply = await withDeadline(done, STOP_TIMEOUT_MS, 'raw video stop').finally(() => {
        // Terminated only after the worker has answered: it owns the
        // SyncAccessHandle, and killing it mid-finalize would leave the file
        // without its last fragment.
        setTimeout(() => worker.terminate(), 0)
      })
      if (!('ok' in reply) || !reply.ok || reply.cmd !== 'stop') {
        throw new Error('raw video stop failed')
      }
      const startOffsetMs =
        reply.firstFrameAtMs !== null ? reply.firstFrameAtMs - opts.epoch : 0
      const st = reply.stats
      // Named on the console because a channel that silently drops frames looks
      // exactly like one that was recorded at a lower rate, and only the
      // counter can tell them apart.
      const level = st.framesDropped > 0 ? console.warn : console.info
      level(
        `[capture] raw ${opts.track.kind} channel: ${st.framesEncoded} frames encoded of ${st.framesIn} in` +
          `${st.keepAliveFrames > 0 ? `, ${st.keepAliveFrames} keep-alive (source was static)` : ''}` +
          `${st.framesDropped > 0 ? `, ${st.framesDropped} DROPPED (encoder behind)` : ''}` +
          ` · ${st.keyframeCount} keyframes · ${(st.bytes / 1024).toFixed(0)} KB · ${st.codec} ${st.hardware}`,
      )
      return {
        bytes: reply.bytes,
        durationMs: reply.durationMs,
        startOffsetMs,
        stats: reply.stats,
        anchor: {
          rawAnchorMs: Math.round(startOffsetMs * 10) / 10,
          firstFrameDelayMs: Math.round(firstFrameDelayMs * 10) / 10,
        },
      }
    },
    async cancel() {
      await endPump()
      const done = new Promise<void>((resolve) => {
        settleCancel = resolve
      })
      send({ cmd: 'cancel' })
      await withDeadline(done, STOP_TIMEOUT_MS, 'raw video cancel').catch(() => undefined)
      worker.terminate()
    },
  }
}
