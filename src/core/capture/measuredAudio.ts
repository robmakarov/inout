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

export const MEASURED_AUDIO_MIME = 'audio/webm;codecs=opus'

const WORKLET_SOURCE = `
class InoutPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = []
    this.frames = 0
    this.channels = 1
    this.sawLive = false
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
    for (const q of this.buf) {
      if (q.data) {
        for (let c = 0; c < ch && c < q.data.length; c++) planar.set(q.data[c], c * total + off)
      }
      off += q.n
    }
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
}): Promise<MeasuredAudioHandle> {
  const track = opts.stream.getAudioTracks()[0]
  if (!track) throw new Error('measured audio: no audio track')

  const audioCtx =
    opts.audioCtx && opts.audioCtx.state !== 'closed'
      ? opts.audioCtx
      : await prewarmMeasuredAudio(track)

  const sampleRate = audioCtx.sampleRate
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
  const sinkStream = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      await opts.writer.write(chunk.data, chunk.position)
      bytesWritten = Math.max(bytesWritten, chunk.position + chunk.data.byteLength)
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
    },
  })
  encoder.configure(config)

  const sourceNode = audioCtx.createMediaStreamSource(opts.stream)
  const worklet = new AudioWorkletNode(audioCtx, WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: numberOfChannels,
  })

  worklet.port.onmessage = (ev: MessageEvent) => {
    if ((ev.data as { flushed?: boolean } | null)?.flushed) {
      flushResolve?.()
      return
    }
    if (stopped) return
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
    if (framesWritten < ANCHOR_WINDOW_S * sampleRate) {
      const arrival = performance.now()
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
  await audioCtx.resume()

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
      await finishEncode()
      if (encodeError) throw encodeError
      // Refined min-filter anchor beats the provisional first-arrival value.
      const offset =
        anchorWallMs !== Infinity ? Math.max(0, anchorWallMs - opts.epoch) : (startOffsetMs ?? 0)
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
