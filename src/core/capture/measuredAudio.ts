/**
 * Measured audio capture — replaces MediaRecorder for mic / system-audio.
 *
 * Pipeline: AudioWorklet PCM (sample-counted) → first-sample wall clock
 * anchored to session epoch → WebCodecs AudioEncoder (opus) →
 * mediabunny EncodedAudioPacketSource → WebM → OPFS write stream.
 *
 * startOffsetMs = performance.now() at first PCM − session epoch.
 * No onstart heuristic, no machine-specific lag constants.
 */

import {
  EncodedAudioPacketSource,
  EncodedPacket,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny'

const WORKLET_NAME = 'inout-pcm-capture'
const OPUS_BITRATE = 128_000
/** Anchor min-filter window; at 50ppm clock skew the bias stays < 0.2ms. */
const ANCHOR_WINDOW_S = 3
/** Below this, do nothing: normal batching jitter is ~21ms and must not pad. */
const PAD_MIN_MS = 80
/** One batch may not conjure more than this much silence, whatever the stamp says. */
const PAD_MAX_MS = 1000
/** The wall origin stops moving here — a min-filter that runs for the whole
 *  take keeps ratcheting onto the luckiest batch, and each ratchet pads silence
 *  for time nothing lost, walking the audio late. Same window as the anchor. */
const PAD_ORIGIN_WINDOW_S = 3
/** ~1.3ms, the same ramp the worklet uses on its own silence splices. */
const PAD_FADE = 64

export const MEASURED_AUDIO_MIME = 'audio/webm;codecs=opus'

const WORKLET_SOURCE = `
class InoutPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = []
    this.frames = 0
    this.channels = 1
    this.sawLive = false
    // Whether the last sample emitted by the previous flush was inserted
    // silence — lets fades span batch boundaries.
    this.prevSilent = false
    // ~21ms per post instead of 2.7ms: 8x less main-thread churn.
    this.batchFrames = 1024
    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === 'flush') {
        this.flush()
        this.port.postMessage({ flushed: true })
      }
    }
  }
  process(inputs) {
    const chans = inputs[0]
    const live = chans && chans.length && chans[0] && chans[0].length
    // Mid-stream starved quanta (bluetooth hiccups, device switches) MUST
    // become silence, not be skipped: timestamps are sample-counted, so a
    // skipped quantum splices the timeline and produces audible crackle.
    // But quanta BEFORE the first live one are the context's startup
    // catch-up burst — counting them prepends fast-forwarded silence and
    // shifts all real audio late. Sample 0 = first live sample.
    if (!live && !this.sawLive) return true
    const n = live ? chans[0].length : 128
    if (live) {
      this.sawLive = true
      this.channels = chans.length
      const copy = []
      for (let c = 0; c < chans.length; c++) copy.push(chans[c].slice(0))
      this.buf.push({ n, data: copy })
    } else {
      this.buf.push({ n, data: null })
    }
    this.frames += n
    if (this.frames >= this.batchFrames) this.flush()
    return true
  }
  flush() {
    if (!this.frames) return
    const total = this.frames
    const ch = this.channels
    const planar = new Float32Array(ch * total)
    let off = 0
    // Silence splices (starved quanta become zeros) are step discontinuities —
    // each live→silence→live edge is an audible click. Ramp ~1.3ms on both
    // sides of every splice so the timeline stays sample-counted but seamless.
    const FADE = 64
    let prevSilent = this.prevSilent
    for (const q of this.buf) {
      if (q.data) {
        for (let c = 0; c < ch && c < q.data.length; c++) planar.set(q.data[c], c * total + off)
        if (prevSilent) {
          const n = Math.min(FADE, q.n)
          for (let c = 0; c < ch; c++) {
            const base = c * total + off
            for (let i = 0; i < n; i++) planar[base + i] *= i / n
          }
        }
        prevSilent = false
      } else {
        if (!prevSilent && off > 0) {
          const n = Math.min(FADE, off)
          for (let c = 0; c < ch; c++) {
            const base = c * total + off
            for (let i = 1; i <= n; i++) planar[base - i] *= (i - 1) / n
          }
        }
        prevSilent = true
      }
      off += q.n
    }
    this.prevSilent = prevSilent
    this.port.postMessage({ frames: total, channels: ch, currentTime, planar }, [planar.buffer])
    this.buf = []
    this.frames = 0
  }
}
registerProcessor('${WORKLET_NAME}', InoutPcmCapture)
`

let workletUrl: string | null = null

function workletModuleUrl(): string {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
  }
  return workletUrl
}

export function canMeasureAudioCapture(): boolean {
  return (
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof AudioData !== 'undefined' &&
    typeof AudioEncoder.isConfigSupported === 'function'
  )
}

export interface MeasuredAudioHandle {
  readonly mimeType: string
  /** Resolves with startOffsetMs once the first PCM quantum arrives. */
  readonly firstOffset: Promise<number>
  stop: () => Promise<{ bytes: number; durationMs: number; startOffsetMs: number }>
  cancel: () => Promise<void>
}

/**
 * Map an AudioContext time to performance.now() using a calibration pair
 * taken at resume (not getOutputTimestamp — that clock includes output-
 * device latency and is wrong for capture-only MediaStreamSource graphs).
 */
export function contextTimeToPerformanceMs(
  contextTime: number,
  calib: { contextTime: number; performanceTime: number },
): number {
  return calib.performanceTime + (contextTime - calib.contextTime) * 1000
}

/** Compile the worklet module once (no live audio) — first-use latency killer. */
export async function prewarmWorkletModule(): Promise<void> {
  const ctx = new AudioContext()
  try {
    await ctx.audioWorklet.addModule(workletModuleUrl())
  } finally {
    await ctx.close().catch(() => undefined)
  }
}

export async function prewarmMeasuredAudio(track: MediaStreamTrack): Promise<AudioContext> {
  const trackRate = track.getSettings().sampleRate
  const audioCtx = new AudioContext(trackRate ? { sampleRate: trackRate } : undefined)
  await audioCtx.audioWorklet.addModule(workletModuleUrl())
  await audioCtx.resume()
  return audioCtx
}

export async function startMeasuredAudioCapture(opts: {
  stream: MediaStream
  /** Session epoch (performance.now() at start()). */
  epoch: number
  /** Durable positioned writer (SyncAccessHandle worker) — crash-safe audio. */
  writer: import('@core/store').PositionedDurableWriter
  /** Optional pre-warmed context from prewarmMeasuredAudio (arm phase). */
  audioCtx?: AudioContext
  /** Fired ONCE if capture dies mid-take (storage write / encoder failure).
   * Without it the take keeps "recording" while every later sample is lost —
   * the file just stops partway with no signal to the user. */
  onFatal?: (err: Error) => void
  /**
   * Live PCM tap (task O2). Called once per worklet batch with the same samples
   * that go to the encoder, before any encode. `startFrame` is channel-local
   * (sample 0 = first live sample); `startOffsetMs` places that sample on the
   * session timeline. `right` aliases `left` for mono sources. Must be cheap
   * and must not throw — it runs on the capture path.
   */
  onPcm?: (
    left: Float32Array,
    right: Float32Array,
    startFrame: number,
    startOffsetMs: number,
    sampleRate: number,
    /** AudioContext currentTime the worklet reported for this batch. */
    contextTime: number,
  ) => void
}): Promise<MeasuredAudioHandle> {
  const track = opts.stream.getAudioTracks()[0]
  if (!track) throw new Error('measured audio: no audio track')

  // BOUNDED init: AudioContext setup on wedged hardware can pend forever, and
  // session.stop() awaits this whole function — an unbounded hang here wedges
  // both start AND stop. Fail the channel loudly instead.
  const audioCtx =
    opts.audioCtx && opts.audioCtx.state !== 'closed'
      ? opts.audioCtx
      : await new Promise<AudioContext>((resolve, reject) => {
          let late = false
          const timer = setTimeout(() => {
            late = true
            reject(new Error('measured audio: context init timed out after 5000ms'))
          }, 5000)
          prewarmMeasuredAudio(track).then(
            (ctx) => {
              if (late) {
                void ctx.close().catch(() => undefined)
                return
              }
              clearTimeout(timer)
              resolve(ctx)
            },
            (err) => {
              clearTimeout(timer)
              if (!late) reject(err)
            },
          )
        })

  const sampleRate = audioCtx.sampleRate
  /**
   * The anchor dates sample 0 from when its batch ARRIVES. Everything upstream
   * — device capture buffer, stream transport — happened before that and is
   * invisible to it, so the anchor is late by exactly the input latency and the
   * export places audio that much late. Measured on a loopback rig: impulses
   * landed +128.7 ms late with sd 0.70, and dating sample 0 from the audio
   * clock instead of message arrival changed it by 1.1 ms — the delay is in the
   * signal path, not the messaging, so no amount of anchor cleverness sees it.
   *
   * The platform does report the part it knows: the track's own latency. Use
   * that, bounded, and log it — never a fitted constant (a 90 ms fallback was
   * rejected on exactly those grounds in the 2026-07 sync work).
   */
  // `latency` is in MediaTrackSupportedConstraints but not in this TS lib's
  // MediaTrackSettings; Chrome reports it for audio input tracks.
  const reportedLatencySec = (track.getSettings() as MediaTrackSettings & { latency?: number })
    .latency
  const inputLatencyMs =
    typeof reportedLatencySec === 'number' && reportedLatencySec > 0
      ? Math.min(200, reportedLatencySec * 1000)
      : 0
  // Unreported channelCount (Chromium often omits it for display/system audio)
  // must default to STEREO: assuming mono downmixes tab music irreversibly,
  // while assuming stereo on a true mono source just duplicates the channel.
  const numberOfChannels = Math.min(2, Math.max(1, track.getSettings().channelCount ?? 2))

  const config: AudioEncoderConfig = {
    codec: 'opus',
    sampleRate,
    numberOfChannels,
    bitrate: OPUS_BITRATE,
  }
  const support = await AudioEncoder.isConfigSupported(config)
  if (!support.supported) {
    if (!opts.audioCtx) await audioCtx.close().catch(() => undefined)
    throw new Error('measured audio: opus AudioEncoder config unsupported')
  }

  let bytesWritten = 0
  let fatalError: Error | null = null
  const fatal = (err: unknown): void => {
    if (fatalError) return
    fatalError = err instanceof Error ? err : new Error(String(err))
    console.error('[capture] measured audio fatal', fatalError)
    try {
      opts.onFatal?.(fatalError)
    } catch {
      /* listener threw */
    }
  }
  const sinkStream = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      try {
        await opts.writer.write(chunk.data, chunk.position)
        bytesWritten = Math.max(bytesWritten, chunk.position + chunk.data.byteLength)
      } catch (err) {
        fatal(err)
        throw err
      }
    },
  })

  const output = new Output({
    format: new WebMOutputFormat(),
    target: new StreamTarget(sinkStream),
  })
  const packetSource = new EncodedAudioPacketSource('opus')
  output.addAudioTrack(packetSource)
  await output.start()

  let encodeChain: Promise<void> = Promise.resolve()
  let framesWritten = 0
  let anchorWallMs = Infinity
  let lastArrivalMs = -Infinity
  /**
   * THE CHANNEL'S TIMELINE IS HELD AGAINST THE WALL CLOCK — same defect and
   * same remedy as the composite's (compositor.worker.ts, PO 2026-08-25's
   * 4K-game take). The worklet already turns starved quanta it SEES into
   * silence, because a skipped quantum splices a sample-counted timeline. What
   * neither it nor the sample count can see is a quantum the AudioContext never
   * rendered at all: measured on a loaded machine, a context returned 56.1 s of
   * quanta in 59.2 s of wall time, which shortens the channel by ~5 % and moves
   * everything after the loss that much earlier against the picture. This is
   * the path an EDITED export renders from, so it needs the guard too.
   *
   * The origin is a MIN-FILTER because batch delivery can only ever be LATE —
   * the same estimator, for the same reason, as the anchor above.
   */
  let wallOriginMs = Infinity
  let paddedFrames = 0
  /** Last sample per channel of the previous batch — the fade-out needs a value. */
  const lastSample = new Float32Array(2)
  let flushResolve: (() => void) | null = null
  let startOffsetMs: number | null = null
  let resolveFirst!: (ms: number) => void
  const firstOffset = new Promise<number>((r) => {
    resolveFirst = r
  })
  let stopped = false
  let encodeError: Error | null = null

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      encodeChain = encodeChain.then(() =>
        packetSource.add(EncodedPacket.fromEncodedChunk(chunk), meta),
      )
    },
    error: (err) => {
      encodeError = err instanceof Error ? err : new Error(String(err))
      console.error('[capture] AudioEncoder error', err)
      fatal(err)
    },
  })
  encoder.configure(config)

  const sourceNode = audioCtx.createMediaStreamSource(opts.stream)
  const worklet = new AudioWorkletNode(audioCtx, WORKLET_NAME, {
    numberOfInputs: 1,
    // Safari stops rendering any capture subgraph that never reaches the
    // destination: with numberOfOutputs:0 the worklet ran ~1s then went idle,
    // truncating audio to a second while MediaRecorder video stayed full
    // length. Give it a (silent) output so it can be routed to the destination
    // through a zero-gain node below — keeps every browser pulling the graph.
    numberOfOutputs: 1,
    outputChannelCount: [numberOfChannels],
    channelCount: numberOfChannels,
  })

  worklet.port.onmessage = (ev: MessageEvent) => {
    if ((ev.data as { flushed?: boolean } | null)?.flushed) {
      flushResolve?.()
      return
    }
    if (stopped || fatalError) return
    const { frames, channels, currentTime, planar } = ev.data as {
      frames: number
      channels: number
      currentTime: number
      planar: Float32Array
    }
    // Anchor estimation: arrival wall time minus the audio-time of the frames
    // already received dates sample 0. Main-thread scheduling can only delay
    // arrival (one-sided error), so the MIN over many quanta converges on the
    // true wall time of sample 0 — the single-first-arrival anchor was exactly
    // the source of the +45–50ms audio-late runs. Window capped so audio-clock
    // vs performance.now drift (~50ppm) cannot bias the estimate.
    // Taken for EVERY batch now, not just inside the anchor window: it is the
    // only stamp here that keeps time when the audio graph does not.
    const arrivalMs = performance.now()
    if (framesWritten < ANCHOR_WINDOW_S * sampleRate) {
      const arrival = arrivalMs
      // Catch-up bursts after resume() deliver quanta back-to-back; their
      // arrival times date sample 0 falsely early. Only steady-state quanta
      // (spaced >= half a quantum) may contribute anchor candidates.
      const quantumMs = (frames / sampleRate) * 1000
      if (arrival - lastArrivalMs >= quantumMs / 2) {
        // Batches arrive when their LAST sample was rendered — date sample 0
        // from the end of the message, or batching biases the anchor late.
        const cand = arrival - ((framesWritten + frames) / sampleRate) * 1000
        if (cand < anchorWallMs) anchorWallMs = cand
      }
      lastArrivalMs = arrival
    }
    if (startOffsetMs === null) {
      startOffsetMs = performance.now() - opts.epoch
      resolveFirst(startOffsetMs)
      console.info(
        `[capture] measured audio first-sample offset=${startOffsetMs.toFixed(1)}ms provisional ` +
          `(ctx=${currentTime.toFixed(4)}s rate=${sampleRate})`,
      )
    }

    const encCh = numberOfChannels
    const interleaved = new Float32Array(frames * encCh)
    if (channels === 1 && encCh === 1) {
      interleaved.set(planar.subarray(0, frames))
    } else if (channels >= 2 && encCh === 2) {
      const L = planar.subarray(0, frames)
      const R = planar.subarray(frames, frames * 2)
      for (let i = 0; i < frames; i++) {
        interleaved[i * 2] = L[i]!
        interleaved[i * 2 + 1] = R[i]!
      }
    } else if (channels >= 2 && encCh === 1) {
      const L = planar.subarray(0, frames)
      const R = planar.subarray(frames, frames * 2)
      for (let i = 0; i < frames; i++) interleaved[i] = 0.5 * (L[i]! + R[i]!)
    } else {
      for (let i = 0; i < frames; i++) {
        interleaved[i * 2] = planar[i]!
        interleaved[i * 2 + 1] = planar[i]!
      }
    }

    // Loudness tap: the certified mix is measured here, live, from the very
    // samples about to be encoded — so no export has to decode them again.
    if (opts.onPcm) {
      try {
        const L = planar.subarray(0, frames)
        const R = channels >= 2 ? planar.subarray(frames, frames * 2) : L
        opts.onPcm(L, R, framesWritten, startOffsetMs ?? 0, sampleRate, currentTime)
      } catch (err) {
        console.warn('[capture] loudness tap threw (ignored)', err)
      }
    }

    // Hold the timeline against the wall before placing this batch. Silence is
    // only ever ADDED, and only where real time went missing, so a healthy take
    // pads nothing and is bit-identical to before.
    {
      const timelineMs = (framesWritten / sampleRate) * 1000
      const batchMs = (frames / sampleRate) * 1000
      // Steady-state batches only, and only while the origin window is open —
      // a startup catch-up burst dates the origin falsely early (padding time
      // that was never lost) and a never-closing min-filter ratchets down on
      // the luckiest batch of the take. Both guards mirror the anchor above.
      const steady = arrivalMs - lastArrivalMs >= batchMs / 2
      if (steady && framesWritten < PAD_ORIGIN_WINDOW_S * sampleRate) {
        const originCand = arrivalMs - timelineMs
        if (originCand < wallOriginMs) wallOriginMs = originCand
      }
      const behindMs = arrivalMs - wallOriginMs - timelineMs
      if (wallOriginMs !== Infinity && behindMs > PAD_MIN_MS) {
        const padFrames = Math.round((Math.min(behindMs, PAD_MAX_MS) / 1000) * sampleRate)
        // Ramp out of the signal and back into it: a step to zero is a click,
        // which is the exact defect the worklet's own splice fades exist for.
        const padData = new Float32Array(padFrames * encCh)
        const head = Math.min(PAD_FADE, padFrames)
        for (let i = 0; i < head; i++) {
          const k = 1 - i / head
          for (let c = 0; c < encCh; c++) padData[i * encCh + c] = (lastSample[c] ?? 0) * k
        }
        const pad = new AudioData({
          format: 'f32',
          sampleRate,
          numberOfFrames: padFrames,
          numberOfChannels: encCh,
          timestamp: Math.round((framesWritten * 1_000_000) / sampleRate),
          data: padData,
        })
        framesWritten += padFrames
        paddedFrames += padFrames
        try {
          encoder.encode(pad)
        } finally {
          pad.close()
        }
        const tail = Math.min(PAD_FADE, frames)
        for (let i = 0; i < tail; i++) {
          const k = i / tail
          for (let c = 0; c < encCh; c++) interleaved[i * encCh + c] *= k
        }
        // Deliberately NOT fed to the loudness tap: the envelope describes the
        // take's CONTENT, and this silence is the machine choking, not content.
      }
    }
    for (let c = 0; c < encCh; c++) {
      lastSample[c] = interleaved[(frames - 1) * encCh + c] ?? 0
    }

    const timestamp = Math.round((framesWritten * 1_000_000) / sampleRate)
    const data = new AudioData({
      format: 'f32',
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels: encCh,
      timestamp,
      data: interleaved,
    })
    framesWritten += frames
    try {
      encoder.encode(data)
    } finally {
      data.close()
    }
  }

  sourceNode.connect(worklet)
  // Silent keep-alive: routes the (empty) worklet output to the destination at
  // zero gain. Nothing is audible, but the graph now reaches destination, so
  // Safari keeps pulling the worklet for the whole take (see note above).
  const keepAlive = audioCtx.createGain()
  keepAlive.gain.value = 0
  worklet.connect(keepAlive)
  keepAlive.connect(audioCtx.destination)
  // resume() on an already-running (prewarmed) context is a no-op; on wedged
  // hardware it can pend — never let it block the take, proceed regardless.
  await Promise.race([
    audioCtx.resume().catch(() => undefined),
    new Promise<void>((r) => setTimeout(r, 2000)),
  ])

  const teardownGraph = async (): Promise<void> => {
    if (!stopped) {
      // Drain the worklet's partial batch (<=21ms of tail audio) before teardown.
      await new Promise<void>((resolve) => {
        flushResolve = resolve
        setTimeout(resolve, 150)
        try {
          worklet.port.postMessage({ cmd: 'flush' })
        } catch {
          resolve()
        }
      })
    }
    stopped = true
    try {
      sourceNode.disconnect()
      worklet.disconnect()
      keepAlive.disconnect()
    } catch {
      /* already disconnected */
    }
    worklet.port.onmessage = null
    worklet.port.close()
    if (audioCtx.state !== 'closed') await audioCtx.close().catch(() => undefined)
  }

  const finishEncode = async (): Promise<void> => {
    await encoder.flush()
    encoder.close()
    await encodeChain
    packetSource.close()
    await output.finalize()
    try {
      await opts.writer.close()
    } catch {
      /* already closed */
    }
  }

  return {
    mimeType: MEASURED_AUDIO_MIME,
    firstOffset,
    async stop() {
      await teardownGraph()
      // A take that died mid-flight keeps everything durably written up to the
      // failure — never throw the whole channel away for a partial loss.
      try {
        await finishEncode()
      } catch (err) {
        fatal(err)
      }
      if (encodeError) fatal(encodeError)
      // Refined min-filter anchor beats the provisional first-arrival value,
      // then step back by the input latency the anchor structurally cannot see.
      const rawOffset =
        anchorWallMs !== Infinity ? Math.max(0, anchorWallMs - opts.epoch) : (startOffsetMs ?? 0)
      const offset = Math.max(0, rawOffset - inputLatencyMs)
      if (inputLatencyMs > 0) {
        console.info(
          `[capture] audio anchor ${rawOffset.toFixed(1)}ms − ${inputLatencyMs.toFixed(1)}ms reported input latency → ${offset.toFixed(1)}ms ` +
            `(baseLatency ${((audioCtx as AudioContext & { baseLatency?: number }).baseLatency ?? 0) * 1000}ms)`,
        )
      }
      if (paddedFrames > 0) {
        // Never silent: this take's audio graph lost real time, and the file
        // says where instead of sliding everything after it earlier.
        console.warn(
          `[capture] measured audio padded ${((paddedFrames / sampleRate) * 1000).toFixed(0)}ms of silence ` +
            `to hold the timeline against the wall clock (the machine was starving this take)`,
        )
      }
      if (startOffsetMs === null) resolveFirst(offset)
      return {
        bytes: bytesWritten,
        durationMs: (framesWritten / sampleRate) * 1000,
        startOffsetMs: offset,
      }
    },
    async cancel() {
      await teardownGraph()
      try {
        encoder.close()
      } catch {
        /* already closed */
      }
      try {
        packetSource.close()
      } catch {
        /* */
      }
      try {
        await output.cancel()
      } catch {
        /* */
      }
      try {
        await opts.writer.abort()
      } catch {
        /* discarding */
      }
      if (startOffsetMs === null) resolveFirst(0)
    },
  }
}
