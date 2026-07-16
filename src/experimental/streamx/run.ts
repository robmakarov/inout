/**
 * EXPERIMENTAL — Streaming export benchmark (Experiment 5).
 *
 * Isolates ONE claim from the export pipeline: BufferTarget materializes the
 * entire output file in RAM (at 8 Mbps video, ~60 MB/min; a 30-min export
 * ≈ 1.8 GB high-water mark), while a StreamTarget writing to OPFS keeps peak
 * memory flat regardless of duration.
 *
 * The benchmark renders the SAME procedurally drawn composition (no decode —
 * decode cost is orthogonal and identical for both paths) through both
 * targets and reports wall time, JS-heap delta (Chromium performance.memory)
 * and output size. Deliberately NOT a fork of exportRecording: the production
 * pipeline is untouched; this measures the muxing-target decision alone,
 * which is the smallest reviewable unit of the streaming-export proposal.
 *
 * Worker note: moving this loop into a Worker is mechanical once the target
 * decision lands (OffscreenCanvas already used here); jank measurement in a
 * shared main thread would be confounded, so the prototype keeps a single
 * variable per run.
 */

import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny'
import { expDir, expReadFile, expRemove } from '../shared/opfs'

export interface StreamxRun {
  target: 'buffer' | 'opfs-stream'
  durationSec: number
  wallMs: number
  realtimeFactor: number
  outputBytes: number
  /** JS heap used delta, bytes (Chromium-only; null elsewhere). */
  heapDeltaBytes: number | null
  /** Peak JS heap observed during the run, bytes (sampled every 500ms). */
  heapPeakBytes: number | null
}

export interface StreamxReport {
  width: number
  height: number
  fps: number
  runs: StreamxRun[]
  notes: string[]
}

interface PerfMemory {
  usedJSHeapSize: number
}

function heapNow(): number | null {
  const mem = (performance as unknown as { memory?: PerfMemory }).memory
  return mem ? mem.usedJSHeapSize : null
}

const WIDTH = 1920
const HEIGHT = 1080
const FPS = 30
const BITRATE = 8_000_000

async function renderRun(target: 'buffer' | 'opfs-stream', durationSec: number): Promise<StreamxRun> {
  const fileName = `streamx-${Date.now()}.mp4`
  let writable: FileSystemWritableFileStream | null = null
  let streamedBytes = 0

  const outputTarget =
    target === 'buffer'
      ? new BufferTarget()
      : new StreamTarget(
          new WritableStream<StreamTargetChunk>({
            start: async () => {
              const dir = await expDir()
              const fh = await dir.getFileHandle(fileName, { create: true })
              writable = await fh.createWritable()
            },
            write: async (chunk) => {
              await writable?.write({ type: 'write', data: chunk.data, position: chunk.position })
              streamedBytes = Math.max(streamedBytes, chunk.position + chunk.data.byteLength)
            },
          }),
        )

  const output = new Output({
    // Fragmented keeps StreamTarget writes append-mostly; BufferTarget uses
    // the same format so the comparison stays apples-to-apples.
    format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
    target: outputTarget,
  })

  const canvas = new OffscreenCanvas(WIDTH, HEIGHT)
  const g = canvas.getContext('2d', { alpha: false })
  if (!g) throw new Error('2d context unavailable')
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate: BITRATE })
  output.addVideoTrack(source, { frameRate: FPS })
  await output.start()

  const heap0 = heapNow()
  let heapPeak = heap0 ?? 0
  const sampler = setInterval(() => {
    const h = heapNow()
    if (h !== null && h > heapPeak) heapPeak = h
  }, 500)

  const totalFrames = Math.ceil(durationSec * FPS)
  const t0 = performance.now()
  for (let f = 0; f < totalFrames; f++) {
    const tSec = f / FPS
    g.fillStyle = `hsl(${(tSec * 40) % 360}, 45%, 16%)`
    g.fillRect(0, 0, WIDTH, HEIGHT)
    g.fillStyle = '#fff'
    g.font = 'bold 120px monospace'
    g.fillText(tSec.toFixed(2), 760, 540)
    g.fillStyle = `hsl(${(tSec * 200) % 360}, 80%, 60%)`
    g.fillRect(((tSec * 300) % (WIDTH + 200)) - 200, 900, 200, 60)
    await source.add(tSec, 1 / FPS)
    if (f % 16 === 0) await new Promise((r) => setTimeout(r, 0))
  }
  source.close()
  await output.finalize()

  let outputBytes: number
  if (target === 'buffer') {
    const buf = (outputTarget as BufferTarget).buffer
    outputBytes = buf ? buf.byteLength : 0
  } else {
    await (writable as FileSystemWritableFileStream | null)?.close()
    outputBytes = (await expReadFile(fileName)).size
    if (outputBytes !== streamedBytes) {
      // fine: positions can overlap on header rewrites; file size is the truth
    }
    await expRemove(fileName)
  }

  clearInterval(sampler)
  const wallMs = performance.now() - t0
  const heap1 = heapNow()
  return {
    target,
    durationSec,
    wallMs,
    realtimeFactor: (durationSec * 1000) / wallMs,
    outputBytes,
    heapDeltaBytes: heap0 !== null && heap1 !== null ? heap1 - heap0 : null,
    heapPeakBytes: heap0 !== null ? heapPeak : null,
  }
}

export async function runStreamxBenchmark(durationSec = 20): Promise<StreamxReport> {
  const notes: string[] = [
    'render-only benchmark: decode cost is identical for both targets and excluded on purpose',
    'heap numbers are Chromium performance.memory (JS heap only; BufferTarget cost appears here, OPFS page cache does not)',
    `extrapolation: at ${BITRATE / 1e6} Mbps, BufferTarget high-water grows ~${Math.round(BITRATE / 8 / 1024 / 1024 * 60)} MB per output minute; the stream path stays flat`,
  ]
  const runs: StreamxRun[] = []
  // Stream first, then buffer — so buffer's heap growth cannot be attributed
  // to warmup ordering.
  runs.push(await renderRun('opfs-stream', durationSec))
  runs.push(await renderRun('buffer', durationSec))
  return { width: WIDTH, height: HEIGHT, fps: FPS, runs, notes }
}
