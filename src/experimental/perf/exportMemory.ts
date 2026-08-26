/**
 * EXPERIMENTAL — O1 evidence: export memory, parity and orphan checks.
 *
 * Drives the PRODUCTION exportRecording (not a fork) over a synthetic
 * audio-only recording, so the render is the waveform path: no source decode,
 * but a real 1920×1080@30 avc encode at the production bitrate. That makes a
 * 30-minute OUTPUT affordable to render while producing exactly the byte
 * volume (8 Mbps ⇒ ~1.8 GB) that the BufferTarget high-water mark used to
 * materialize as one contiguous ArrayBuffer.
 *
 * Three reports:
 *  (a) memory   — peak JS heap per output duration, scratch vs BufferTarget
 *  (b) parity   — same take exported both ways: duration/tracks/dimensions equal, both decode
 *  (c) orphans  — abort mid-export leaves no xport-* file in OPFS
 */

import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  getFirstEncodableAudioCodec,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny'
import { exportRecording } from '@core/compose'
import { setInlinePositionedWriterEnabled } from '@core/store'
import type { WriterEquivalenceResult } from './writerEquivalence.worker'
import { getLastScratchStats, setExportScratchEnabled } from '@core/compose/scratch'
import { AUDIO_BITRATE, AUDIO_CHANNEL_COUNT, AUDIO_SAMPLE_RATE } from '@core/compose/codecs'
import { newId } from '@core/id'
import { blobStore, createPositionedWriter } from '@core/store'
import { defaultEditState } from '@core/timeline'
import type { Recording } from '@core/types'

interface PerfMemory {
  usedJSHeapSize: number
}

function heapNow(): number | null {
  const mem = (performance as unknown as { memory?: PerfMemory }).memory
  return mem ? mem.usedJSHeapSize : null
}

const MB = (bytes: number | null): number | null =>
  bytes === null ? null : Math.round((bytes / 1024 / 1024) * 10) / 10

/**
 * Settled heap reading: forced GC (Chrome --js-flags=--expose-gc) so the number
 * is RETAINED memory, not GC-schedule noise. Sampled peaks alone were useless —
 * they moved 8→65 MB run to run on identical work.
 */
async function retainedHeap(): Promise<number | null> {
  const gc = (globalThis as unknown as { gc?: () => void }).gc
  if (!gc) return heapNow()
  for (let i = 0; i < 3; i++) {
    gc()
    await new Promise((r) => setTimeout(r, 50))
  }
  return heapNow()
}

interface UaMemoryResult {
  bytes: number
}

/**
 * Total JS-attributed memory INCLUDING ArrayBuffer backing stores.
 * performance.memory.usedJSHeapSize deliberately excludes them, so it reported
 * 0.1 MB retained while the BufferTarget path held a 25 MB output buffer —
 * useless for this gate. Requires cross-origin isolation (scripts/exp.mjs sets
 * the dev-server headers); null when unavailable.
 */
async function retainedTotal(): Promise<number | null> {
  const api = (performance as unknown as {
    measureUserAgentSpecificMemory?: () => Promise<UaMemoryResult>
  }).measureUserAgentSpecificMemory
  if (!api || !(globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
    return null
  }
  try {
    return (await api.call(performance)).bytes
  } catch {
    return null
  }
}

/**
 * Runs `fn` while sampling BOTH memory instruments.
 *
 * The ArrayBuffer-aware one (measureUserAgentSpecificMemory) performs its own
 * GC, so its samples are LIVE memory — which is what an OOM is about, and why
 * this is the gate metric. It is slow, so it samples on a loop rather than a
 * fixed timer; the JS-heap sampler runs at 100 ms alongside it.
 */
async function withMemoryWatch<T>(fn: () => Promise<T>): Promise<{
  value: T
  heapPeak: number | null
  totalPeak: number | null
  totalSamples: number
}> {
  let heapPeak = heapNow() ?? 0
  const heapTimer = setInterval(() => {
    const h = heapNow()
    if (h !== null && h > heapPeak) heapPeak = h
  }, 100)

  let running = true
  let totalPeak: number | null = null
  let totalSamples = 0
  const totalLoop = (async () => {
    while (running) {
      const t = await retainedTotal()
      if (t !== null) {
        totalSamples++
        if (totalPeak === null || t > totalPeak) totalPeak = t
      } else {
        return
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  })()

  try {
    const value = await fn()
    const h = heapNow()
    if (h !== null && h > heapPeak) heapPeak = h
    return { value, heapPeak, totalPeak, totalSamples }
  } finally {
    running = false
    clearInterval(heapTimer)
    await totalLoop.catch(() => undefined)
  }
}

/**
 * Synthetic audio-only take: one tone channel written straight to the blob
 * store through the positioned writer, so building the fixture costs no heap
 * either (a 30-min fixture would otherwise be its own OOM).
 */
async function makeToneRecording(durationSec: number): Promise<Recording> {
  const key = `perf-o1-${newId('a')}`
  const writer = await createPositionedWriter(key)
  let closed = false
  const closeOnce = async (): Promise<void> => {
    if (closed) return
    closed = true
    await writer.close()
  }
  const writable = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      await writer.write(chunk.data, chunk.position)
    },
    close: closeOnce,
    abort: closeOnce,
  })
  const codec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
    numberOfChannels: AUDIO_CHANNEL_COUNT,
    sampleRate: AUDIO_SAMPLE_RATE,
    bitrate: AUDIO_BITRATE,
  })
  if (!codec) throw new Error('no audio encoder for the fixture')
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 1 << 20 }),
  })
  const source = new AudioBufferSource({ codec, bitrate: AUDIO_BITRATE })
  output.addAudioTrack(source)
  await output.start()

  const chunkFrames = AUDIO_SAMPLE_RATE
  const total = Math.round(durationSec * AUDIO_SAMPLE_RATE)
  const left = new Float32Array(chunkFrames)
  const right = new Float32Array(chunkFrames)
  for (let start = 0; start < total; start += chunkFrames) {
    const frames = Math.min(chunkFrames, total - start)
    for (let k = 0; k < frames; k++) {
      const t = (start + k) / AUDIO_SAMPLE_RATE
      // Speech-ish level so the loudness rescue behaves like a real take, with
      // a fast-varying envelope: the waveform render then differs every frame,
      // so the encoder spends its bitrate instead of coasting on a static
      // image (the point is to reach realistic output BYTES, not just seconds).
      const jitter = 0.5 + 0.5 * Math.sin(2 * Math.PI * 11.37 * t + Math.sin(2 * Math.PI * 3.1 * t) * 4)
      const env = 0.35 * (0.25 + 0.75 * jitter)
      left[k] = env * Math.sin(2 * Math.PI * 220 * t)
      right[k] = env * Math.sin(2 * Math.PI * 277 * t)
    }
    const buffer = new AudioBuffer({
      length: frames,
      numberOfChannels: AUDIO_CHANNEL_COUNT,
      sampleRate: AUDIO_SAMPLE_RATE,
    })
    buffer.copyToChannel(left.subarray(0, frames), 0)
    buffer.copyToChannel(right.subarray(0, frames), 1)
    await source.add(buffer)
  }
  source.close()
  await output.finalize()
  await closeOnce()

  const durationMs = Math.round(durationSec * 1000)
  return {
    id: newId('rec'),
    createdAt: Date.now(),
    durationMs,
    channels: [
      {
        id: newId('ch'),
        kind: 'mic',
        media: 'audio',
        mimeType: 'audio/mp4',
        blobKey: key,
        startOffsetMs: 0,
        durationMs,
      },
    ],
  }
}

async function probe(blob: Blob): Promise<{
  durationSec: number
  videoTracks: number
  audioTracks: number
  width: number | null
  height: number | null
  decodedFrames: number
}> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const tracks = await input.getTracks()
    const video = await input.getPrimaryVideoTrack()
    let decodedFrames = 0
    if (video) {
      const sink = new (await import('mediabunny')).VideoSampleSink(video)
      // "Plays" evidence: real decodes at three points across the file.
      const duration = await input.computeDuration()
      for (const t of [0, duration / 2, Math.max(0, duration - 0.2)]) {
        const sample = await sink.getSample(t)
        if (sample) {
          decodedFrames++
          sample.close()
        }
      }
    }
    return {
      durationSec: Math.round((await input.computeDuration()) * 1000) / 1000,
      videoTracks: tracks.filter((t) => t.isVideoTrack()).length,
      audioTracks: tracks.filter((t) => t.isAudioTrack()).length,
      width: video?.displayWidth ?? null,
      height: video?.displayHeight ?? null,
      decodedFrames,
    }
  } finally {
    input.dispose()
  }
}

async function scratchFilesInStore(): Promise<string[]> {
  return (await blobStore.listKeys()).filter((k) => k.startsWith('xport-'))
}

export interface ExportMemRun {
  path: 'scratch' | 'buffer'
  outputSec: number
  outputMB: number | null
  wallMs: number
  /** Retained heap (post-GC) before the export. */
  heapBaseMB: number | null
  /** measureUserAgentSpecificMemory before the export. */
  totalBaseMB: number | null
  /**
   * GATE METRIC — peak LIVE memory during the export above baseline, counting
   * ArrayBuffer backing stores. The old path must carry the whole file here.
   */
  totalPeakDeltaMB: number | null
  totalSamples: number
  /** Retained after the export while still holding the result (leak check). */
  totalRetainedDeltaMB: number | null
  /** JS-heap-only peak; excludes ArrayBuffers, kept as secondary evidence. */
  heapPeakDeltaMB: number | null
  /**
   * Scratch path only: output bytes the target held in memory at once, at its
   * high-water. This is the O1 claim measured at the source — no GC noise, no
   * instrument blind spots. The buffer path's equivalent is outputMB by
   * definition (BufferTarget IS one ArrayBuffer of the whole file).
   */
  targetHeldMB: number | null
  error?: string
}

export interface O1Report {
  memory: ExportMemRun[]
  /** Heap growth per output MB, least-squares over the runs of each path. */
  heapPerOutputMB: { scratch: number | null; buffer: number | null }
  extrapolated30MinPeakMB: { scratch: number | null; buffer: number | null }
  parity: {
    scratch: Awaited<ReturnType<typeof probe>> & { bytes: number }
    buffer: Awaited<ReturnType<typeof probe>> & { bytes: number }
    equal: boolean
  } | null
  orphans: {
    beforeExport: string[]
    afterAbort: string[]
    aborted: boolean
    leaked: string[]
  } | null
  /**
   * X2 — the scratch writer owning its OPFS handle inline (in the export
   * worker) against handing every chunk to a second writer worker. The file
   * must come out BYTE-IDENTICAL: same muxer, same bytes, same positions, one
   * copy and one thread hop fewer.
   */
  inlineWriter: {
    inlineBytes: number
    workerBytes: number
    /** SHA-256 of each file — byte identity, not just a length match. */
    inlineHash: string
    workerHash: string
    identical: boolean
    inlineMs: number
    workerMs: number
    /** Both orders, warmed: the first export of a process pays codec init. */
    inlineMsSecondOrder: number
    workerMsSecondOrder: number
    inlineHeldMB: number | null
    workerHeldMB: number | null
    /**
     * THE gate. Two exports of one take are not byte-identical anyway (the
     * video encoder is not bit-reproducible run to run — the `identical` field
     * above shows it), so equivalence is proven on what X2 actually changed:
     * one scripted sequence of positioned writes, back-patch included, driven
     * through both writers from inside a dedicated worker.
     */
    equivalence: WriterEquivalenceResult | null
  } | null
  notes: string[]
}

async function writerEquivalence(): Promise<WriterEquivalenceResult | null> {
  const keyA = `xeq-inline-${Date.now().toString(36)}`
  const keyB = `xeq-worker-${Date.now().toString(36)}`
  let worker: Worker
  try {
    worker = new Worker(new URL('./writerEquivalence.worker.ts', import.meta.url), {
      type: 'module',
    })
  } catch {
    return null
  }
  try {
    return await new Promise<WriterEquivalenceResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('writer equivalence timed out')), 60_000)
      worker.onmessage = (ev: MessageEvent<WriterEquivalenceResult>) => {
        clearTimeout(timer)
        resolve(ev.data)
      }
      worker.onerror = (ev) => {
        clearTimeout(timer)
        reject(new Error(ev.message || 'writer equivalence worker error'))
      }
      worker.postMessage({ keyA, keyB, chunkBytes: 4 * 1024 * 1024, chunks: 4 })
    })
  } catch {
    return null
  } finally {
    worker.terminate()
    await blobStore.remove(keyA).catch(() => undefined)
    await blobStore.remove(keyB).catch(() => undefined)
  }
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function slope(points: { x: number; y: number }[]): number | null {
  if (points.length < 2) return null
  const n = points.length
  const sx = points.reduce((a, p) => a + p.x, 0)
  const sy = points.reduce((a, p) => a + p.y, 0)
  const sxx = points.reduce((a, p) => a + p.x * p.x, 0)
  const sxy = points.reduce((a, p) => a + p.x * p.y, 0)
  const denom = n * sxx - sx * sx
  if (Math.abs(denom) < 1e-9) return null
  return Math.round(((n * sxy - sx * sy) / denom) * 1000) / 1000
}

async function runOne(path: 'scratch' | 'buffer', durationSec: number): Promise<ExportMemRun> {
  const recording = await makeToneRecording(durationSec)
  setExportScratchEnabled(path === 'scratch')
  try {
    const settledBase = await retainedHeap()
    const totalBase = await retainedTotal()
    const t0 = performance.now()
    const { value, heapPeak, totalPeak, totalSamples } = await withMemoryWatch(() =>
      exportRecording({ recording, edit: defaultEditState(recording) }),
    )
    const wallMs = performance.now() - t0
    const bytes = value.blob.size
    // `value` is still referenced here, so anything the result retains counts.
    const totalAfter = await retainedTotal()
    void value.blob.size
    return {
      path,
      outputSec: durationSec,
      outputMB: MB(bytes),
      wallMs: Math.round(wallMs),
      heapBaseMB: MB(settledBase),
      totalBaseMB: MB(totalBase),
      totalPeakDeltaMB:
        totalBase !== null && totalPeak !== null ? MB(totalPeak - totalBase) : null,
      totalSamples,
      totalRetainedDeltaMB:
        totalBase !== null && totalAfter !== null ? MB(totalAfter - totalBase) : null,
      heapPeakDeltaMB: settledBase !== null && heapPeak !== null ? MB(heapPeak - settledBase) : null,
      targetHeldMB: path === 'scratch' ? MB(getLastScratchStats()?.maxOutstandingBytes ?? null) : MB(bytes),
    }
  } catch (err) {
    return {
      path,
      outputSec: durationSec,
      outputMB: null,
      wallMs: 0,
      heapBaseMB: null,
      totalBaseMB: null,
      totalPeakDeltaMB: null,
      totalSamples: 0,
      totalRetainedDeltaMB: null,
      heapPeakDeltaMB: null,
      targetHeldMB: null,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    }
  } finally {
    setExportScratchEnabled(true)
    for (const c of recording.channels) await blobStore.remove(c.blobKey).catch(() => undefined)
  }
}

export interface O1Options {
  /** Output durations to render, seconds. */
  durationsSec?: number[]
  /** Which target(s) to exercise. One per process when RSS is the instrument. */
  paths?: ('scratch' | 'buffer')[]
  /** Also run the same durations through the old BufferTarget path. */
  includeBuffer?: boolean
  /** Longest duration the BufferTarget A/B is allowed to attempt (it OOMs). */
  bufferMaxSec?: number
  /** Take length for the parity + abort checks. */
  shortSec?: number
  skipMemory?: boolean
  skipChecks?: boolean
}

export async function runO1Evidence(opts: O1Options = {}): Promise<O1Report> {
  const durations = opts.durationsSec ?? [10, 20, 40]
  const includeBuffer = opts.includeBuffer ?? true
  const bufferMaxSec = opts.bufferMaxSec ?? 120
  const shortSec = opts.shortSec ?? 6
  const notes: string[] = [
    'audio-only synthetic take: the export renders the production waveform video at 1920x1080@30, avc 8 Mbps — same muxer target decision, no source decode',
    'heap = Chromium performance.memory usedJSHeapSize sampled every 100ms; OPFS page cache is not JS heap and correctly does not appear',
    'the scratch/buffer and inline/worker levers are now FORWARDED INTO THE EXPORT WORKER — before this they were flipped on the main thread, which has not rendered since O5a, so the buffer lane was measuring the scratch path',
  ]

  // ---- (b) parity: the same take through both targets ----
  let parity: O1Report['parity'] = null
  if (!opts.skipChecks) {
    const recording = await makeToneRecording(shortSec)
    try {
      setExportScratchEnabled(true)
      const a = await exportRecording({ recording, edit: defaultEditState(recording) })
      // Probe BEFORE the next export runs: a finished scratch is deleted when
      // the one after it finishes, so a blob held across an export is dead.
      const pa = { ...(await probe(a.blob)), bytes: a.blob.size }
      setExportScratchEnabled(false)
      const b = await exportRecording({ recording, edit: defaultEditState(recording) })
      const pb = { ...(await probe(b.blob)), bytes: b.blob.size }
      parity = {
        scratch: pa,
        buffer: pb,
        equal:
          Math.abs(pa.durationSec - pb.durationSec) < 0.05 &&
          pa.videoTracks === pb.videoTracks &&
          pa.audioTracks === pb.audioTracks &&
          pa.width === pb.width &&
          pa.height === pb.height &&
          pa.decodedFrames === 3 &&
          pb.decodedFrames === 3,
      }
    } finally {
      setExportScratchEnabled(true)
      for (const c of recording.channels) await blobStore.remove(c.blobKey).catch(() => undefined)
    }
  }

  // ---- (b2) X2: inline scratch writer vs the second writer worker ----
  let inlineWriter: O1Report['inlineWriter'] = null
  if (!opts.skipChecks) {
    const recording = await makeToneRecording(shortSec)
    const edit = defaultEditState(recording)
    try {
      // Hash INSIDE the run: scratch.ts deletes the previous finished export
      // when a new one finishes, so a blob held across the next export is dead
      // (note 13b). Read it before the next one starts, never after.
      const once = async (
        inline: boolean,
      ): Promise<{ bytes: number; hash: string; ms: number; heldMB: number | null }> => {
        setInlinePositionedWriterEnabled(inline)
        const t = performance.now()
        const r = await exportRecording({ recording, edit })
        const ms = Math.round(performance.now() - t)
        return {
          bytes: r.blob.size,
          hash: (await sha256(r.blob)).slice(0, 16),
          ms,
          heldMB: MB(getLastScratchStats()?.maxOutstandingBytes ?? null),
        }
      }
      // Warm first: a process's FIRST export pays codec init, and whichever
      // lane runs first would otherwise be reported as the slower one (note 10).
      await once(true)
      const inlineRun = await once(true)
      const workerRun = await once(false)
      // …and both orders, because one ordering is one measurement.
      const workerAgain = await once(false)
      const inlineAgain = await once(true)
      inlineWriter = {
        inlineBytes: inlineRun.bytes,
        workerBytes: workerRun.bytes,
        inlineHash: inlineRun.hash,
        workerHash: workerRun.hash,
        identical: inlineRun.hash === workerRun.hash && inlineAgain.hash === workerAgain.hash,
        inlineMs: inlineRun.ms,
        workerMs: workerRun.ms,
        inlineMsSecondOrder: inlineAgain.ms,
        workerMsSecondOrder: workerAgain.ms,
        inlineHeldMB: inlineRun.heldMB,
        workerHeldMB: workerRun.heldMB,
        equivalence: await writerEquivalence(),
      }
    } finally {
      setInlinePositionedWriterEnabled(true)
      for (const c of recording.channels) await blobStore.remove(c.blobKey).catch(() => undefined)
    }
  }

  // ---- (c) abort mid-export leaves no scratch file ----
  let orphans: O1Report['orphans'] = null
  if (!opts.skipChecks) {
    const recording = await makeToneRecording(20)
    const beforeExport = await scratchFilesInStore()
    const ac = new AbortController()
    let aborted = false
    try {
      const p = exportRecording({
        recording,
        edit: defaultEditState(recording),
        signal: ac.signal,
        onProgress: (progress) => {
          // Abort once the muxer is definitely writing frames.
          if (progress.phase === 'rendering' && progress.ratio > 0.3) ac.abort()
        },
      })
      await p
    } catch (err) {
      aborted = err instanceof Error && err.name === 'AbortError'
    }
    // The writer close is awaited inside discard(), but OPFS removal is async
    // at the directory level; re-read after a tick.
    await new Promise((r) => setTimeout(r, 250))
    const afterAbort = await scratchFilesInStore()
    orphans = {
      beforeExport,
      afterAbort,
      aborted,
      leaked: afterAbort.filter((k) => !beforeExport.includes(k)),
    }
    for (const c of recording.channels) await blobStore.remove(c.blobKey).catch(() => undefined)
  }

  // ---- (a) memory series ----
  const memory: ExportMemRun[] = []
  if (!opts.skipMemory) {
    const paths = opts.paths ?? (includeBuffer ? ['scratch', 'buffer'] : ['scratch'])
    for (const d of durations) {
      for (const path of paths) {
        if (path === 'buffer' && d > bufferMaxSec) continue
        memory.push(await runOne(path, d))
      }
    }
  }

  // Slope over the instrument that sees ArrayBuffers, falling back to the
  // JS-heap-only one when cross-origin isolation isn't available.
  const metric = (r: ExportMemRun): number | null => r.totalPeakDeltaMB ?? r.heapPeakDeltaMB
  const pts = (path: 'scratch' | 'buffer') =>
    memory
      .filter((r) => r.path === path && r.outputMB !== null && metric(r) !== null)
      .map((r) => ({ x: r.outputMB as number, y: metric(r) as number }))
  const sScratch = slope(pts('scratch'))
  const sBuffer = slope(pts('buffer'))
  // A 30-min take at the production 8 Mbps video + 128 kbps audio bitrate.
  const thirtyMinMB = Math.round((((8_000_000 + 128_000) / 8) * 1800) / 1024 / 1024)
  notes.push(`30-min output at production bitrate = ${thirtyMinMB} MB of muxed file`)
  const base = (path: 'scratch' | 'buffer'): number | null => {
    const rs = memory.filter((r) => r.path === path && metric(r) !== null)
    return rs.length ? Math.round(Math.min(...rs.map((r) => metric(r) as number)) * 10) / 10 : null
  }
  const extrapolate = (s: number | null, b: number | null): number | null =>
    s === null || b === null ? null : Math.round(b + s * thirtyMinMB)

  return {
    memory,
    heapPerOutputMB: { scratch: sScratch, buffer: sBuffer },
    extrapolated30MinPeakMB: {
      scratch: extrapolate(sScratch, base('scratch')),
      buffer: extrapolate(sBuffer, base('buffer')),
    },
    parity,
    orphans,
    inlineWriter,
    notes,
  }
}
