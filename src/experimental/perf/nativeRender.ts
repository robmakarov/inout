/**
 * EXPERIMENTAL — R2: THE INSTRUMENT THAT WAS MISSING FOR THE GPU-PROCESS CRASH.
 *
 * The open bug: a ~4-minute 3024x1964@60 take exported at 1080p or 1440p lags
 * the machine, kills Chrome's GPU process ("even chrome header dissapears"),
 * takes every decoder in the tab with it, and loses the render. Five seconds of
 * the identical settings is fine, so it is exhaustion with the LENGTH of the
 * job — and nothing here could reproduce it, which is why three plausible
 * causes were ruled out by reading and none of them was the cause.
 *
 * WHY NO RIG COULD REPRODUCE IT, AND WHY THIS ONE CAN. Every previous attempt
 * tried to CAPTURE a 3024x1964@60 source, and could not: the synthetic screen
 * is a rAF-painted canvas costing ~209 Mpx/s where the source needs 356, so the
 * run starved the source and indicted the rig. But the crash is in the EXPORT,
 * and an export does not need a live source — it needs a FILE. A file can be
 * manufactured SLOWER THAN REAL TIME, which lifts the whole constraint: this
 * builds a genuine 3024x1964@60 raw channel at whatever pace the machine
 * manages, caches it in OPFS, and then runs the PRODUCTION exportRecording over
 * it as many times as a session needs.
 *
 * WHAT IT MEASURES. The page can only see its own heap (and the export runs in
 * a worker, where Chrome exposes no memory instrument at all — G3 established
 * that). So the page reports the shape of the render over time — progress,
 * wall clock, per-phase rate, its own heap — and the number that matters, GPU
 * process RSS, is sampled from the OS by `scripts/exp.mjs --gpu`, which also
 * notices the GPU process's PID CHANGING, i.e. the crash itself, as a fact
 * rather than as a symptom reported by a dying decoder.
 *
 *   node scripts/exp.mjs nativerender '{"takeSec":240}' --headed --gpu --timeout=3600
 *   node scripts/exp.mjs nativerender '{"takeSec":30,"outputs":["1080p"]}' --headed --gpu
 *
 * HEADED IS NOT OPTIONAL for a verdict: headless Chrome may fall back to a
 * software GL stack, and a software stack does not have the resource this bug
 * exhausts. A headless run still exercises the code path and is useful while
 * iterating; it cannot say the bug is gone.
 *
 * The fixture is CACHED under a key naming its own geometry, rate and length,
 * so the second run of a session pays nothing for it. `{"rebuild":true}` forces
 * a fresh one.
 */
import {
  ALL_FORMATS,
  BlobSource,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
  type StreamTargetChunk,
} from 'mediabunny'
import { exportRecording } from '@core/compose'
import { getLastRenderStats } from '@core/compose/render'
import { getLastScratchStats } from '@core/compose/scratch'
import { constantQualityQp, setConstantQuality } from '@core/compose/constantQuality'
import { settingsForTier, tierById, type QualityTierId } from '@core/compose/quality'
import { newId } from '@core/id'
import { blobStore, createPositionedWriter } from '@core/store'
import { defaultEditState } from '@core/timeline'
import { DEFAULT_BACKGROUND } from '@core/compose/background'
import type { ChannelRecording, EditState, Recording } from '@core/types'

const MB = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10

interface PerfMemory {
  usedJSHeapSize: number
}
function heapMB(): number | null {
  const mem = (performance as unknown as { memory?: PerfMemory }).memory
  return mem ? MB(mem.usedJSHeapSize) : null
}

export interface NativeRenderOptions {
  /** Source geometry. Default is Robert's screen. */
  sourceW?: number
  sourceH?: number
  /** Source rate written into the file and read back by takeRate(). */
  sourceFps?: number
  /** Length of the manufactured take. The whole point of the rig is length. */
  takeSec?: number
  /** Bitrate of the manufactured raw channel — decode cost follows it. */
  sourceMbps?: number
  /** Which export steps to run, in order. */
  outputs?: QualityTierId[]
  /** Add a camera channel, so the render runs TWO decoders like his take did. */
  camera?: boolean
  /**
   * RENDER IT THE WAY HE RENDERED IT (Robert 2026-09-02: "render was with frame
   * and zoom effect once - it must not make it slower"). With this on, the edit
   * carries the default background frame and one zoom span, which is what a
   * take with a frame and a zoom actually asks the render to draw. Off, the
   * edit is the plain default — so one run of this rig prices the decoration
   * against itself on the same source.
   */
  frame?: boolean
  /**
   * HOW MANY AUDIO CHANNELS THE TAKE CARRIES. Robert's take had two (mic and
   * tab audio) and every previous run of this rig had NONE, so the audio stage
   * of the render — decode two opus streams, Hermite-resample, soft-limit every
   * sample, encode AAC, once per output second — has never been in a number
   * this rig produced. `audioMs` reading 0 in every report is not evidence that
   * it is free; it is evidence that it was never measured.
   */
  audioChannels?: number
  /**
   * Constant quality for this run: a QP, or 'off' for the bitrate target. The
   * flag is normally a URL parameter and this rig is served from a harness page
   * whose URL it does not own, so the A/B has to be settable from the cell —
   * and the encoder is where a native-resolution render spends its wall clock,
   * so this is the first thing a slow-export report has to be able to swing.
   */
  cq?: number | 'off'
  /** Ignore a cached fixture of the same shape. */
  rebuild?: boolean
  /** Stop the fixture build early if it is taking longer than this. */
  buildBudgetSec?: number
}

interface Sample {
  atMs: number
  ratio: number
  heapMB: number | null
}

interface OutputReport {
  step: QualityTierId
  width: number
  height: number
  fps: number
  videoBitrate: number | undefined
  /** null when the export threw — `error` then says what came back. */
  outputMB: number | null
  wallMs: number
  error: string | null
  /** Frames per second of OUTPUT the render sustained, first half vs last half.
   *  A render that is slowing down is a render whose cost is growing. */
  fpsFirstHalf: number | null
  fpsLastHalf: number | null
  heapStartMB: number | null
  heapEndMB: number | null
  /** Where the wall clock went — the render's own stage split. */
  stages: Record<string, number> | null
  /**
   * WHAT THE MUXER HELD IN MEMORY. The export streams to an OPFS scratch and
   * claims O(1) memory for it; this is the claim, measured. If output bytes are
   * piling up faster than the disk takes them, this is where a render's
   * footprint comes from — and it would also explain a finalize that takes
   * "too long on 95%", since the backlog has to land before the file closes.
   */
  scratchHeldMB: number | null
  scratchWrittenMB: number | null
  samples: Sample[]
}

export interface NativeRenderReport {
  source: {
    width: number
    height: number
    fps: number
    takeSec: number
    bytes: number
    sizeMB: number
    mbps: number
    cached: boolean
    buildMs: number
    /** Frames actually written — a truncated build is a smaller take, not a lie. */
    frames: number
  }
  camera: { width: number; height: number; sizeMB: number } | null
  outputs: OutputReport[]
  notes: string[]
}

/** A fixture is identified by everything that changes its bytes. */
export function fixtureKey(w: number, h: number, fps: number, sec: number, mbps: number): string {
  // `v3` is the PAINTER's version: a cached file built by an earlier painter is
  // a different picture at a different bitrate, and reusing one silently would
  // compare two takes rather than two renders.
  return `r2fix-v3-${w}x${h}-${fps}fps-${sec}s-${mbps}mbps`
}

export async function existingFixture(key: string): Promise<Blob | null> {
  try {
    const blob = await blobStore.read(key)
    return blob.size > 0 ? blob : null
  } catch {
    return null
  }
}

/**
 * THE PICTURE THE FIXTURE PAINTS, and why it is painted this way.
 *
 * It has to cost the DECODER what a screen recording costs it — that is the
 * whole load under test — while costing the PAINTER little enough that four
 * minutes of 6 Mpx frames can be built at all. So the frame is composed once
 * into a backdrop canvas and blitted (a GPU copy, not a fill), and only the
 * moving furniture is drawn per frame: enough new residual in every macroblock
 * row that the encoder spends its bitrate instead of coasting on a still.
 */
function makePainter(
  ctx: OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
): (frame: number) => void {
  const backdrop = new OffscreenCanvas(w, h)
  const bctx = backdrop.getContext('2d', { alpha: false })
  if (!bctx) throw new Error('fixture: no 2d context for the backdrop')
  const grad = bctx.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, '#12161c')
  grad.addColorStop(0.5, '#1d2530')
  grad.addColorStop(1, '#0e1116')
  bctx.fillStyle = grad
  bctx.fillRect(0, 0, w, h)
  // Text-like rows: this is a screen recording, and screen recordings are text.
  bctx.fillStyle = '#c8d3e0'
  for (let y = 40; y < h - 20; y += 34) {
    const cols = 6 + ((y / 34) % 5)
    let x = 60
    for (let c = 0; c < cols; c++) {
      const wide = 60 + ((y * 7 + c * 53) % 220)
      bctx.fillRect(x, y, wide, 12)
      x += wide + 24
      if (x > w - 120) break
    }
  }
  // WHAT THIS IS NOT ANY MORE: a field of random noise. The first version
  // blitted a noise tile to stop the encoder coasting, and it worked far too
  // well — noise is INCOMPRESSIBLE, so a 60 s take exported at 1080p wrote
  // 2,857 MB (381 Mbps against a 16 Mbps target) and spent 112-131 s in
  // finalize. Both numbers were the FIXTURE's, not the product's, and what
  // gave it away was `?cq=off` reproducing them byte for byte: a lever that
  // changes nothing is measuring something the lever does not touch.
  //
  // Screen content is TEXT AND EDGES THAT MOVE — highly structured, highly
  // compressible, expensive in a completely different way. So the frame
  // SCROLLS: the backdrop is drawn at a moving offset, which gives every
  // macroblock real motion residual without handing the encoder entropy it
  // cannot compress.
  return (frame: number) => {
    // The page scrolls, wrapping — a reader moving through a document, which
    // is what a screen recording mostly is.
    const oy = -((frame * 2) % h)
    ctx.drawImage(backdrop, 0, oy)
    ctx.drawImage(backdrop, 0, oy + h)
    // A window dragged across it: one large moving edge, the other thing
    // screen recordings are made of.
    const wx = ((frame * 4) % (w + 600)) - 600
    ctx.fillStyle = '#0b0e13'
    ctx.fillRect(wx, h * 0.25, 560, h * 0.45)
    ctx.fillStyle = '#5b8def'
    ctx.fillRect(wx, h * 0.25, 560, 28)
    ctx.fillStyle = '#9fb2c9'
    for (let i = 0; i < 9; i++) {
      ctx.fillRect(wx + 24, h * 0.25 + 60 + i * 30, 180 + ((i * 61 + frame) % 300), 11)
    }
    // A caret, so something changes even in an otherwise still stretch.
    if (frame % 30 < 15) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(wx + 24, h * 0.25 + 330, 10, 14)
    }
  }
}

/** Manufacture one video channel file, slower than real time if it must be. */
export async function buildChannelFile(opts: {
  key: string
  width: number
  height: number
  fps: number
  seconds: number
  mbps: number
  budgetSec: number
  label: string
  /**
   * Write a FRAGMENTED MP4, the way rawVideo.worker.ts writes a real channel
   * (`fastStart: 'fragmented'`). Default false, which is what every earlier run
   * of R2 built — a plain file with one sample table, which is a different
   * thing for a reader to open. editorOpen.ts needs both to tell them apart.
   */
  fragmented?: boolean
}): Promise<{ frames: number; bytes: number; ms: number }> {
  const { key, width, height, fps, seconds, mbps, budgetSec, label } = opts
  const codec = await getFirstEncodableVideoCodec(['avc'], { width, height })
  if (!codec) throw new Error(`fixture: no AVC encoder for ${width}x${height}`)

  const writer = await createPositionedWriter(key)
  let closed = false
  const closeOnce = async (): Promise<void> => {
    if (closed) return
    closed = true
    await writer.close()
  }
  let bytes = 0
  const writable = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      await writer.write(chunk.data, chunk.position)
      bytes += chunk.data.byteLength
    },
    close: closeOnce,
    abort: closeOnce,
  })
  const output = new Output({
    format: new Mp4OutputFormat(opts.fragmented ? { fastStart: 'fragmented' } : undefined),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 4 << 20 }),
  })
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('fixture: no 2d context')
  const paint = makePainter(ctx, width, height)
  const source = new CanvasSource(canvas, {
    codec,
    bitrate: Math.round(mbps * 1_000_000),
    keyFrameInterval: 2,
    // The raw channel encodes this way in production since R2's own
    // measurement — quality mode is ~13 % faster for the same bytes.
    latencyMode: 'quality',
  })
  output.addVideoTrack(source, { frameRate: fps })
  await output.start()

  const total = Math.round(seconds * fps)
  const t0 = performance.now()
  let frames = 0
  for (let f = 0; f < total; f++) {
    paint(f)
    await source.add(f / fps, 1 / fps)
    frames++
    if (f % (fps * 10) === 0) {
      const elapsed = (performance.now() - t0) / 1000
      console.info(
        `[r2] ${label} fixture ${f}/${total} frames, ${elapsed.toFixed(0)}s elapsed, ${MB(bytes)} MB`,
      )
      if (elapsed > budgetSec) {
        console.warn(`[r2] ${label} fixture hit its ${budgetSec}s budget at ${f} frames — stopping short`)
        break
      }
    }
  }
  source.close()
  await output.finalize()
  await closeOnce()
  return { frames, bytes, ms: Math.round(performance.now() - t0) }
}

export function channel(
  kind: 'screen' | 'camera',
  blobKey: string,
  width: number,
  height: number,
  fps: number,
  durationMs: number,
  bytes: number,
): ChannelRecording {
  return {
    id: newId('ch'),
    kind,
    media: 'video',
    mimeType: 'video/mp4',
    blobKey,
    startOffsetMs: 0,
    durationMs,
    width,
    height,
    fps,
    bytes,
  }
}

/**
 * ONE OPUS AUDIO CHANNEL, the shape capture writes (measuredAudio.ts): stereo
 * 48 kHz opus at 128 kbps in WebM. Content is a moving tone plus noise so no
 * part of the render can coast on silence, and so the loudness statistics the
 * export reads are those of a real signal rather than of a flat line.
 */
export async function buildAudioFile(key: string, seconds: number): Promise<number> {
  const SR = 48_000
  const CH = 2
  const writer = await createPositionedWriter(key)
  const sink = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      await writer.write(chunk.data, chunk.position)
    },
  })
  const output = new Output({ format: new WebMOutputFormat(), target: new StreamTarget(sink) })
  const source = new AudioBufferSourceLikeSource()
  output.addAudioTrack(source.packetSource)
  await output.start()
  await source.start({ sampleRate: SR, numberOfChannels: CH, seconds })
  await output.finalize()
  await writer.close()
  const blob = await blobStore.read(key)
  return blob.size
}

/** The encoder half of buildAudioFile, kept apart so the muxing reads plainly. */
class AudioBufferSourceLikeSource {
  readonly packetSource = new EncodedAudioPacketSource('opus')

  async start(opts: { sampleRate: number; numberOfChannels: number; seconds: number }): Promise<void> {
    const { sampleRate, numberOfChannels, seconds } = opts
    const FRAMES = 960 // 20 ms, opus's own frame
    const total = Math.round(seconds * sampleRate)
    let queued: Promise<void> = Promise.resolve()
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        queued = queued.then(() =>
          this.packetSource.add(EncodedPacket.fromEncodedChunk(chunk), meta as never),
        )
      },
      error: (err) => console.error('[r2] audio fixture encoder', err),
    })
    encoder.configure({ codec: 'opus', sampleRate, numberOfChannels, bitrate: 128_000 })
    const data = new Float32Array(FRAMES * numberOfChannels)
    for (let at = 0; at < total; at += FRAMES) {
      const n = Math.min(FRAMES, total - at)
      for (let i = 0; i < n; i++) {
        const t = (at + i) / sampleRate
        const v = 0.3 * Math.sin(2 * Math.PI * (220 + 40 * Math.sin(t)) * t) + 0.02 * (Math.random() - 0.5)
        for (let c = 0; c < numberOfChannels; c++) data[c * n + i] = v
      }
      const chunk = new AudioData({
        data: data.slice(0, n * numberOfChannels),
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: n,
        numberOfChannels,
        timestamp: Math.round((at / sampleRate) * 1e6),
      })
      encoder.encode(chunk)
      chunk.close()
      if (encoder.encodeQueueSize > 8) {
        await new Promise<void>((r) => encoder.addEventListener('dequeue', () => r(), { once: true }))
      }
    }
    await encoder.flush()
    encoder.close()
    await queued
  }
}

/** An audio ChannelRecording over a file buildAudioFile wrote. */
function audioChannel(
  kind: 'mic' | 'system-audio',
  blobKey: string,
  durationMs: number,
  bytes: number,
): ChannelRecording {
  return {
    id: newId('ch'),
    kind,
    media: 'audio',
    mimeType: 'audio/webm;codecs=opus',
    blobKey,
    startOffsetMs: 0,
    durationMs,
    bytes,
  }
}

/**
 * The edit under test. Plain = exactly what this rig always ran. Framed = the
 * default background (a gradient backdrop, a 6 % inset, rounded corners and a
 * drop shadow) plus a zoom that holds 2x across the middle third of the take,
 * which is the shape of the edit Robert exported.
 */
function editFor(recording: Recording, frame: boolean): EditState {
  const edit = defaultEditState(recording)
  if (!frame) return edit
  const endMs = recording.durationMs
  const whole = { xFrac: 0.5, yFrac: 0.5, widthFrac: 1 }
  const inAt = Math.round(endMs / 3)
  const outAt = Math.round((2 * endMs) / 3)
  return {
    ...edit,
    background: { ...DEFAULT_BACKGROUND },
    viewport: {
      keyframes: [
        { ...whole, atMs: 0 },
        { xFrac: 0.5, yFrac: 0.5, widthFrac: 0.5, atMs: inAt },
        { xFrac: 0.5, yFrac: 0.5, widthFrac: 0.5, atMs: outAt },
        { ...whole, atMs: endMs },
      ],
    },
  }
}

export async function runNativeRender(
  opts: NativeRenderOptions = {},
): Promise<NativeRenderReport> {
  const sourceW = opts.sourceW ?? 3024
  const sourceH = opts.sourceH ?? 1964
  const sourceFps = opts.sourceFps ?? 60
  const takeSec = opts.takeSec ?? 240
  const mbps = opts.sourceMbps ?? 24
  const outputs = opts.outputs ?? (['1080p', '1440p'] as QualityTierId[])
  const frame = opts.frame === true
  const notes: string[] = []
  const cqBefore = constantQualityQp()
  if (opts.cq !== undefined) {
    setConstantQuality(opts.cq === 'off' ? null : opts.cq)
    notes.push(`constant quality forced to ${opts.cq} for this run (was ${cqBefore ?? 'off'})`)
  }
  if (frame) notes.push('edit carries the default background frame and one zoom span')

  // ---- the fixture -------------------------------------------------------
  const key = fixtureKey(sourceW, sourceH, sourceFps, takeSec, mbps)
  let cached = !opts.rebuild && (await existingFixture(key)) !== null
  let buildMs = 0
  let frames = Math.round(takeSec * sourceFps)
  if (cached) {
    notes.push(`reusing cached fixture ${key}`)
  } else {
    await blobStore.remove(key).catch(() => undefined)
    const built = await buildChannelFile({
      key,
      width: sourceW,
      height: sourceH,
      fps: sourceFps,
      seconds: takeSec,
      mbps,
      budgetSec: opts.buildBudgetSec ?? 1800,
      label: 'screen',
    })
    buildMs = built.ms
    frames = built.frames
    cached = false
  }
  const sourceBlob = await blobStore.read(key)
  const actualSec = frames / sourceFps
  const durationMs = Math.round(actualSec * 1000)

  // ---- an optional second decoder, which his take had --------------------
  let cameraChannel: ChannelRecording | null = null
  let cameraInfo: NativeRenderReport['camera'] = null
  if (opts.camera) {
    const camKey = fixtureKey(1920, 1080, sourceFps, Math.round(actualSec), 8)
    if (opts.rebuild || (await existingFixture(camKey)) === null) {
      await blobStore.remove(camKey).catch(() => undefined)
      await buildChannelFile({
        key: camKey,
        width: 1920,
        height: 1080,
        fps: sourceFps,
        seconds: actualSec,
        mbps: 8,
        budgetSec: opts.buildBudgetSec ?? 1800,
        label: 'camera',
      })
    }
    const camBlob = await blobStore.read(camKey)
    cameraChannel = channel('camera', camKey, 1920, 1080, sourceFps, durationMs, camBlob.size)
    cameraInfo = { width: 1920, height: 1080, sizeMB: MB(camBlob.size) }
  }

  // ---- the audio his take had, which this rig never had -----------------
  const audioChannels: ChannelRecording[] = []
  const wantAudio = Math.max(0, Math.min(4, Math.round(opts.audioChannels ?? 0)))
  for (let i = 0; i < wantAudio; i++) {
    const aKey = `r2aud-v1-${Math.round(actualSec)}s-${i}`
    let size = 0
    if (opts.rebuild || (await existingFixture(aKey)) === null) {
      await blobStore.remove(aKey).catch(() => undefined)
      const t0 = performance.now()
      size = await buildAudioFile(aKey, actualSec)
      notes.push(`built audio fixture ${aKey} (${MB(size)} MB) in ${Math.round(performance.now() - t0)} ms`)
    } else {
      size = (await blobStore.read(aKey)).size
    }
    audioChannels.push(
      audioChannel(i === 0 ? 'mic' : 'system-audio', aKey, durationMs, size),
    )
  }

  const recording: Recording = {
    id: newId('rec'),
    createdAt: Date.now(),
    durationMs,
    channels: [
      channel('screen', key, sourceW, sourceH, sourceFps, durationMs, sourceBlob.size),
      ...(cameraChannel ? [cameraChannel] : []),
      ...audioChannels,
    ],
  }

  // Sanity: the file has to actually be what the recording claims, or every
  // number below describes a different take than the one named.
  {
    const input = new Input({ source: new BlobSource(sourceBlob), formats: ALL_FORMATS })
    try {
      const track = await input.getPrimaryVideoTrack()
      const decodable = track ? await track.canDecode() : false
      notes.push(
        `fixture track ${track?.codedWidth ?? 0}x${track?.codedHeight ?? 0} decodable=${decodable}`,
      )
    } finally {
      input.dispose()
    }
  }

  // ---- the renders --------------------------------------------------------
  const reports: OutputReport[] = []
  for (const step of outputs) {
    const settings = settingsForTier(tierById(step), recording)
    const totalFrames = Math.max(1, Math.round((durationMs / 1000) * settings.fps))
    const samples: Sample[] = []
    const t0 = performance.now()
    const heapStartMB = heapMB()
    let lastRatio = 0
    const timer = setInterval(() => {
      samples.push({ atMs: Math.round(performance.now() - t0), ratio: lastRatio, heapMB: heapMB() })
    }, 1000)
    let outputMB: number | null = null
    let error: string | null = null
    try {
      console.info(
        `[r2] rendering ${step} ${settings.width}x${settings.height}@${settings.fps} ` +
          `from ${sourceW}x${sourceH}@${sourceFps}, ${actualSec.toFixed(1)}s take`,
      )
      const result = await exportRecording({
        recording,
        edit: editFor(recording, frame),
        settings,
        onProgress: (p) => {
          lastRatio = p.ratio
        },
      })
      outputMB = MB(result.blob.size)
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      console.error(`[r2] ${step} export FAILED: ${error}`)
    } finally {
      clearInterval(timer)
    }
    const wallMs = Math.round(performance.now() - t0)
    const rs = getLastRenderStats()
    const ss = getLastScratchStats()
    // Rate over the first and last half of the RENDER phase, which is where a
    // growing cost would show as a slowdown rather than as a crash.
    const rendering = samples.filter((s) => s.ratio > 0.05 && s.ratio < 0.95)
    const rate = (from: Sample | undefined, to: Sample | undefined): number | null => {
      if (!from || !to || to.atMs <= from.atMs) return null
      const dFrames = (to.ratio - from.ratio) * totalFrames
      return Math.round((dFrames / ((to.atMs - from.atMs) / 1000)) * 10) / 10
    }
    const mid = Math.floor(rendering.length / 2)
    reports.push({
      step,
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      videoBitrate: settings.videoBitrate,
      outputMB,
      wallMs,
      error,
      fpsFirstHalf: rate(rendering[0], rendering[mid]),
      fpsLastHalf: rate(rendering[mid], rendering[rendering.length - 1]),
      heapStartMB,
      heapEndMB: heapMB(),
      stages: rs
        ? {
            frames: rs.frames,
            prepareMs: Math.round(rs.prepareMs),
            decodeMs: Math.round(rs.decodeMs),
            drawMs: Math.round(rs.drawMs),
            encodeMs: Math.round(rs.encodeMs),
            audioMs: Math.round(rs.audioMs),
            finalizeMs: Math.round(rs.finalizeMs),
            totalMs: Math.round(rs.totalMs),
          }
        : null,
      scratchHeldMB: ss ? MB(ss.maxOutstandingBytes) : null,
      scratchWrittenMB: ss ? MB(ss.bytesWritten) : null,
      samples,
    })
  }

  // Put the flag back: a rig must not leave a machine configured differently
  // than it found it, and this one writes localStorage.
  if (opts.cq !== undefined) setConstantQuality(cqBefore)

  return {
    source: {
      width: sourceW,
      height: sourceH,
      fps: sourceFps,
      takeSec: Math.round(actualSec * 10) / 10,
      bytes: sourceBlob.size,
      sizeMB: MB(sourceBlob.size),
      mbps: Math.round(((sourceBlob.size * 8) / actualSec / 1_000_000) * 10) / 10,
      cached,
      buildMs,
      frames,
    },
    camera: cameraInfo,
    outputs: reports,
    notes,
  }
}
