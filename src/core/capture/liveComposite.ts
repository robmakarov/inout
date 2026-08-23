/**
 * Instant rendering v1: while channels record, a second lightweight recorder
 * captures the DEFAULT composition (screen contain + camera PiP + mixed audio)
 * to its own blob. If the user exports without edits — the common case — the
 * file already exists and export is instant. Any edit falls back to the full
 * compositor. Geometry mirrors src/core/compose/layout.ts (decision #11).
 * v2 (WebCodecs + smart-cut) replaces this without changing the contract.
 */
import { blobStore } from '@core/store'
import type { CompositeRecording } from '../types'
import { SourceLiveness, type LivenessEvent } from './sourceLiveness'

/**
 * Draw ticks come from an AudioWorklet, NOT requestAnimationFrame: rAF is
 * throttled to a standstill in background tabs, and recording normally means
 * switching AWAY from this tab. Audio render quanta keep firing regardless.
 */
const TICKER_SOURCE = `
class InoutCompositeTick extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0 }
  process() {
    this.n++
    if (this.n >= 6) { this.port.postMessage(0); this.n = 0 }
    return true
  }
}
registerProcessor('inout-composite-tick', InoutCompositeTick)
`
let tickerUrl: string | null = null
function tickerModuleUrl(): string {
  if (!tickerUrl) {
    tickerUrl = URL.createObjectURL(new Blob([TICKER_SOURCE], { type: 'application/javascript' }))
  }
  return tickerUrl
}

const FPS = 30
const W = 1920
const H = 1080
const VIDEO_BITS = 8_000_000
/** How often each source's delivered frame rate is logged (evidence only). */
const FPS_LOG_MS = 10_000
/** rAF cadence watchdog: give up silently rather than tax a weak machine. */
const WATCHDOG_AFTER_MS = 5000
const WATCHDOG_MAX_GAP_P50_MS = 50

export interface LiveCompositeInputs {
  screen?: MediaStream
  camera?: MediaStream
  audio: MediaStream[]
}

export interface LiveCompositeOptions {
  /**
   * A video source stopped (or resumed) delivering frames mid-take. The
   * composite keeps running — the session decides what to do — but a stalled
   * source means the composite is painting the same frame over and over, so an
   * unedited export must NOT copy it. Driven by the worklet tick, so it keeps
   * firing while the tab is in the background (which is the normal case).
   */
  onSourceLiveness?: (kind: 'screen' | 'camera', event: LivenessEvent) => void
}

export interface LiveCompositeHandle {
  /** Resolves at stop: null when the composite was aborted by the watchdog. */
  stop(): Promise<CompositeRecording | null>
  cancel(): Promise<void>
}

/**
 * MP4 first — the instant file must match the rendered export's format
 * (product: no surprise .webm). Without MediaRecorder MP4 support the
 * composite is skipped and export falls back to the full render (mp4).
 */
const MP4_MIMES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
]

function pickCompositeMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const m of MP4_MIMES) if (MediaRecorder.isTypeSupported(m)) return m
  return null
}

export function canLiveComposite(inputs: LiveCompositeInputs): boolean {
  return !!(inputs.screen || inputs.camera) && pickCompositeMime() !== null
}

function drawContain(ctx: CanvasRenderingContext2D, v: HTMLVideoElement): void {
  const vw = v.videoWidth || W
  const vh = v.videoHeight || H
  const s = Math.min(W / vw, H / vh)
  const dw = vw * s
  const dh = vh * s
  ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh)
}

function drawCover(ctx: CanvasRenderingContext2D, v: HTMLVideoElement): void {
  const vw = v.videoWidth || W
  const vh = v.videoHeight || H
  const s = Math.max(W / vw, H / vh)
  const dw = vw * s
  const dh = vh * s
  ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh)
}

function drawPip(ctx: CanvasRenderingContext2D, v: HTMLVideoElement): void {
  const scale = W / 1920
  const pipW = 0.24 * W
  const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 4 / 3
  const pipH = pipW / aspect
  const margin = 24 * scale
  const r = 16 * scale
  const x = W - pipW - margin
  const y = H - pipH - margin
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x, y, pipW, pipH, r)
  ctx.clip()
  ctx.drawImage(v, x, y, pipW, pipH)
  ctx.restore()
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x, y, pipW, pipH, r)
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'
  ctx.lineWidth = 1.5 * scale
  ctx.stroke()
  ctx.restore()
}

/** Frames the source has actually handed this element, or null where the
 * browser doesn't expose the counter. Exact — unlike inferring cadence from
 * the media clock, which only tells us "advanced since last tick". */
function deliveredFrames(el: HTMLVideoElement): number | null {
  if (typeof el.getVideoPlaybackQuality !== 'function') return null
  return el.getVideoPlaybackQuality().totalVideoFrames
}

function videoFor(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement('video')
  v.srcObject = stream
  v.muted = true
  v.playsInline = true
  void v.play().catch(() => undefined)
  return v
}

export async function startLiveComposite(
  inputs: LiveCompositeInputs,
  blobKey: string,
  options: LiveCompositeOptions = {},
): Promise<LiveCompositeHandle> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('live composite: 2d context unavailable')

  const screenEl = inputs.screen ? videoFor(inputs.screen) : null
  const cameraEl = inputs.camera ? videoFor(inputs.camera) : null
  let torndown = false

  // Mixed audio with gain staging + limiter: naive unity summing clips as
  // soon as mic and system audio overlap — that IS audible noise/distortion.
  const audioCtx = new AudioContext({ sampleRate: 48000 })
  await audioCtx.audioWorklet.addModule(tickerModuleUrl())
  let audioTrack: MediaStreamTrack | null = null
  if (inputs.audio.length > 0) {
    const dest = audioCtx.createMediaStreamDestination()
    if (inputs.audio.length === 1) {
      // Single source can't exceed ±1 — any dynamics stage here only damages
      // it (the −6dB/20:1 limiter audibly pumped tab music: music program
      // sits near full scale, so it lived permanently above threshold).
      audioCtx.createMediaStreamSource(inputs.audio[0]!).connect(dest)
    } else {
      const limiter = audioCtx.createDynamicsCompressor()
      // Safety net for overlapping sources, not a mastering stage: after 0.7
      // gain staging, typical program peaks land under −3dB and pass clean;
      // only genuine mic+music pileups get caught.
      limiter.threshold.value = -3
      limiter.knee.value = 3
      limiter.ratio.value = 12
      limiter.attack.value = 0.003
      limiter.release.value = 0.25
      limiter.connect(dest)
      const perSource = audioCtx.createGain()
      perSource.gain.value = 0.7
      perSource.connect(limiter)
      for (const s of inputs.audio) audioCtx.createMediaStreamSource(s).connect(perSource)
    }
    audioTrack = dest.stream.getAudioTracks()[0] ?? null
  }
  await audioCtx.resume()

  const canvasStream = canvas.captureStream(FPS)
  if (audioTrack) canvasStream.addTrack(audioTrack)

  const writable = await blobStore.createWriteStream(blobKey)
  const writer = writable.getWriter()
  let writeChain = Promise.resolve()
  let bytes = 0
  let writeFailed = false

  const mime = pickCompositeMime()
  if (!mime) throw new Error('live composite: no supported mp4 mime')
  const recorder = new MediaRecorder(canvasStream, {
    mimeType: mime,
    videoBitsPerSecond: VIDEO_BITS,
    audioBitsPerSecond: 128_000,
  })
  recorder.ondataavailable = (e) => {
    if (!e.data.size || writeFailed) return
    writeChain = writeChain.then(() =>
      writer.write(e.data).then(
        () => {
          bytes += e.data.size
        },
        () => {
          writeFailed = true
        },
      ),
    )
  }

  const startedAt = performance.now()
  let lastFrame = startedAt
  let lastDraw = 0
  const gaps: number[] = []
  let aborted = false

  // Frozen-source watch: a dead track keeps readyState >= 2 forever, so
  // drawImage happily repaints its last frame for the rest of the take and the
  // file ends up a still image. The media clock is the only honest signal.
  const liveness: {
    kind: 'screen' | 'camera'
    el: HTMLVideoElement
    det: SourceLiveness
    /** Frame counter at the last cadence log — see the FPS_LOG_MS block. */
    framesAtLog: number | null
  }[] = []
  if (screenEl)
    liveness.push({ kind: 'screen', el: screenEl, det: new SourceLiveness(), framesAtLog: null })
  if (cameraEl)
    liveness.push({ kind: 'camera', el: cameraEl, det: new SourceLiveness(), framesAtLog: null })
  let lastFpsLog = startedAt

  const draw = (): void => {
    const now = performance.now()
    if (now - lastDraw < 1000 / FPS - 3) return
    lastDraw = now
    gaps.push(now - lastFrame)
    lastFrame = now
    for (const s of liveness) {
      if (s.el.readyState < 2) continue
      const ev = s.det.sample(now, s.el.currentTime)
      if (ev) {
        console.warn(`[capture] ${s.kind} source ${ev}`)
        options.onSourceLiveness?.(s.kind, ev)
      }
    }
    // Cadence evidence, console only — deliberately NOT a warning: a static
    // screen legitimately delivers ~1 keep-alive fps, so low cadence alone
    // can't be judged here. Full freezes are the detector's job above; this
    // is what turns the next "it stutters" report into a number.
    if (now - lastFpsLog >= FPS_LOG_MS) {
      const windowSec = (now - lastFpsLog) / 1000
      lastFpsLog = now
      for (const s of liveness) {
        const frames = deliveredFrames(s.el)
        if (frames === null) continue
        const prev = s.framesAtLog
        s.framesAtLog = frames
        if (prev === null) continue
        console.info(
          `[capture] ${s.kind} ${s.el.videoWidth}×${s.el.videoHeight} ` +
            `delivering ${((frames - prev) / windowSec).toFixed(1)} fps`,
        )
      }
    }
    // Watchdog: median frame gap over the warmup window decides viability.
    if (!aborted && now - startedAt > WATCHDOG_AFTER_MS && gaps.length > 30) {
      const sorted = [...gaps].sort((a, b) => a - b)
      if (sorted[Math.floor(sorted.length / 2)] > WATCHDOG_MAX_GAP_P50_MS) {
        aborted = true
        console.warn('[capture] live composite aborted: compositor cannot keep pace')
        void teardown(true)
        return
      }
      gaps.length = 0
    }
    ctx.fillStyle = '#0a0a0c'
    ctx.fillRect(0, 0, W, H)
    if (screenEl && screenEl.readyState >= 2) {
      drawContain(ctx, screenEl)
      if (cameraEl && cameraEl.readyState >= 2) drawPip(ctx, cameraEl)
    } else if (cameraEl && cameraEl.readyState >= 2) {
      drawCover(ctx, cameraEl)
    }
  }
  const ticker = new AudioWorkletNode(audioCtx, 'inout-composite-tick', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  })
  ticker.connect(audioCtx.destination)
  ticker.port.onmessage = () => {
    if (!torndown && !aborted) draw()
  }
  recorder.start(1000)

  const teardown = async (discard: boolean): Promise<void> => {
    if (torndown) return
    torndown = true
    try {
      ticker.port.onmessage = null
      ticker.disconnect()
    } catch {
      /* already gone */
    }
    if (recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
        try {
          recorder.requestData()
          recorder.stop()
        } catch {
          resolve()
        }
      })
    }
    await writeChain
    try {
      await writer.close()
    } catch {
      /* already failed */
    }
    for (const el of [screenEl, cameraEl]) if (el) el.srcObject = null
    if (audioCtx.state !== 'closed') await audioCtx.close().catch(() => undefined)
    if (discard) await blobStore.remove(blobKey).catch(() => undefined)
  }

  return {
    async stop() {
      const durationMs = performance.now() - startedAt
      if (aborted) return null
      await teardown(false)
      if (writeFailed || bytes === 0) {
        await blobStore.remove(blobKey).catch(() => undefined)
        return null
      }
      return {
        blobKey,
        mimeType: recorder.mimeType || mime,
        durationMs: Math.round(durationMs),
        width: W,
        height: H,
        bytes,
      }
    },
    async cancel() {
      aborted = true
      await teardown(true)
    },
  }
}
