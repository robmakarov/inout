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
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  getFirstEncodableVideoCodec,
  type StreamTargetChunk,
} from 'mediabunny'
import { exportRecording } from '@core/compose'
import { settingsForTier, tierById, type QualityTierId } from '@core/compose/quality'
import { newId } from '@core/id'
import { blobStore, createPositionedWriter } from '@core/store'
import { defaultEditState } from '@core/timeline'
import type { ChannelRecording, Recording } from '@core/types'

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
function fixtureKey(w: number, h: number, fps: number, sec: number, mbps: number): string {
  // `v2` is the PAINTER's version: a cached file built by an earlier painter is
  // a different picture at a different bitrate, and reusing one silently would
  // compare two takes rather than two renders.
  return `r2fix-v2-${w}x${h}-${fps}fps-${sec}s-${mbps}mbps`
}

async function existingFixture(key: string): Promise<Blob | null> {
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
  // High-frequency detail, pre-rendered once and blitted with a moving offset.
  // Without it the encoder coasts: the first version of this fixture asked for
  // 24 Mbps and wrote 6.4, because flat bands over a still backdrop are almost
  // free — and a file that cheap decodes far more cheaply than the take under
  // investigation, which would have made every verdict here optimistic.
  const tile = new OffscreenCanvas(512, 512)
  const tctx = tile.getContext('2d', { alpha: false })
  if (!tctx) throw new Error('fixture: no 2d context for the detail tile')
  const noise = tctx.createImageData(512, 512)
  let seed = 0x2f6e2b1
  for (let i = 0; i < noise.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const v = 40 + (seed % 180)
    noise.data[i] = v
    noise.data[i + 1] = v
    noise.data[i + 2] = v
    noise.data[i + 3] = 255
  }
  tctx.putImageData(noise, 0, 0)

  const bars = 14
  return (frame: number) => {
    ctx.drawImage(backdrop, 0, 0)
    // The detail field moves a pixel or two per frame, which is what makes a
    // screen recording expensive: every macroblock has new residual.
    const ox = -(frame * 3) % 512
    const oy = -(frame * 2) % 512
    for (let y = oy; y < h; y += 512) {
      for (let x = ox; x < w; x += 512) ctx.drawImage(tile, x, y)
    }
    // Moving furniture: one band per stripe of the frame, so every row of
    // macroblocks carries new residual every frame.
    for (let i = 0; i < bars; i++) {
      const bandH = h / bars
      const y = i * bandH
      const phase = (frame * (3 + i)) % (w + 400)
      ctx.fillStyle = i % 2 === 0 ? '#3d7ef0' : '#e8b64c'
      ctx.fillRect(phase - 400, y + 4, 320, bandH - 8)
    }
    ctx.fillStyle = '#ffffff'
    ctx.fillRect((frame * 11) % (w - 200), h / 2 - 60, 200, 120)
  }
}

/** Manufacture one video channel file, slower than real time if it must be. */
async function buildChannelFile(opts: {
  key: string
  width: number
  height: number
  fps: number
  seconds: number
  mbps: number
  budgetSec: number
  label: string
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
    format: new Mp4OutputFormat(),
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

function channel(
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

export async function runNativeRender(
  opts: NativeRenderOptions = {},
): Promise<NativeRenderReport> {
  const sourceW = opts.sourceW ?? 3024
  const sourceH = opts.sourceH ?? 1964
  const sourceFps = opts.sourceFps ?? 60
  const takeSec = opts.takeSec ?? 240
  const mbps = opts.sourceMbps ?? 24
  const outputs = opts.outputs ?? (['1080p', '1440p'] as QualityTierId[])
  const notes: string[] = []

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

  const recording: Recording = {
    id: newId('rec'),
    createdAt: Date.now(),
    durationMs,
    channels: [
      channel('screen', key, sourceW, sourceH, sourceFps, durationMs, sourceBlob.size),
      ...(cameraChannel ? [cameraChannel] : []),
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
        edit: defaultEditState(recording),
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
      samples,
    })
  }

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
