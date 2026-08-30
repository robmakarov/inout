/**
 * EXPERIMENTAL — F16 spike T1: is a TRANSCODE actually several times faster
 * than a full render, and which file should it read?
 *
 * F16's whole design rests on one claim: "Min and Medium are BACKGROUND
 * TRANSCODES of the High file, started at stop", pre-made in idle time so that
 * by the time the user reaches the export panel the file already exists. The
 * task's own gate says that claim is currently made from reasoning, and this
 * project does not ship reasoning — so this measures it.
 *
 * THE THREE LANES, and the third is the one the spec leaves open:
 *
 *   RENDER      what happens today. exportRecording decodes the native raw
 *               channel, composites onto a canvas, encodes the small file.
 *   FROM-RAW    mediabunny Conversion straight off the native raw channel:
 *               heavier decode (5.9 Mpx frames), but ONE generation of 4:2:0.
 *   FROM-HIGH   Conversion off the already-made High file: much lighter decode
 *               (2 Mpx frames), but a SECOND generation of 4:2:0 on top of it.
 *
 * F16 says "pick by measurement: one extra 4:2:0 generation against a heavier
 * decode". That is this run's job. Speed is measured here; the picture cost of
 * the extra generation is X15/R1's chroma instruments and is a separate lane —
 * what matters first is whether either transcode is fast enough to be "done
 * before the panel opens", because if neither is, F16's premise is wrong and
 * the design has to change before any of it is built.
 *
 *   node scripts/exp.mjs f16t1 '{"takeSec":120}' --headed --gpu --timeout=900
 *
 * Shares nativeRender's fixture (same cache key, same painter), so a session
 * that has already built one pays nothing here.
 */
import { ALL_FORMATS, BlobSource, Conversion, Input, Mp4OutputFormat, Output, StreamTarget, type StreamTargetChunk } from 'mediabunny'
import { exportRecording } from '@core/compose'
import { settingsForTier, tierById, type QualityTierId } from '@core/compose/quality'
import { newId } from '@core/id'
import { blobStore, createPositionedWriter } from '@core/store'
import { defaultEditState } from '@core/timeline'
import type { Recording } from '@core/types'
import { buildChannelFile, channel, existingFixture, fixtureKey } from './nativeRender'
import { SchedulingDelayWatch } from './mainThreadWatch'
import { cancelPrerender, prerenderKey, startPrerender, takePrerender } from '@core/compose/prerender'

const MB = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10

export interface F16TranscodeOptions {
  sourceW?: number
  sourceH?: number
  sourceFps?: number
  takeSec?: number
  sourceMbps?: number
  /** Which rungs to make. Defaults to Min (540p) and Medium (720p). */
  rungs?: QualityTierId[]
  rebuild?: boolean
}

interface LaneResult {
  lane: 'render' | 'from-raw' | 'from-high'
  rung: QualityTierId
  width: number
  height: number
  wallMs: number
  outputMB: number | null
  error: string | null
  /** Multiple of REAL TIME. Above 1 means faster than the take is long. */
  timesRealtime: number | null
}

export interface T2Report {
  /** UI-thread lateness with nothing running — the floor this machine has. */
  idle: { ticks: number; totalLateMs: number; maxLateMs: number; p95LateMs: number }
  /** The same, measured while the background pre-render runs. */
  duringPrerender: { ticks: number; totalLateMs: number; maxLateMs: number; p95LateMs: number }
  prerenderFinished: boolean
  prerenderMs: number
  verdict: string
}

export interface F16TranscodeReport {
  source: { width: number; height: number; fps: number; takeSec: number; sizeMB: number }
  high: { width: number; height: number; sizeMB: number; wallMs: number } | null
  lanes: LaneResult[]
  verdict: string[]
  /** F16 spike T2 — see runF16BackgroundCost. Null unless asked for. */
  t2?: T2Report
}


/**
 * A COPY THAT OUTLIVES THE NEXT EXPORT. An ExportResult's blob is a view of the
 * export SCRATCH, and scratch.ts keeps only the newest finished file — so the
 * moment the next lane exports, High's bytes are gone and reading it fails with
 * "network error". That is scratch.ts behaving exactly as documented; it is the
 * rig that has to hold its own reference.
 *
 * Streamed, not `arrayBuffer()`: a High file is tens to hundreds of megabytes
 * and this rig exists to measure memory-sensitive work.
 */
async function persistCopy(blob: Blob, key: string): Promise<Blob> {
  const writer = await createPositionedWriter(key)
  const reader = blob.stream().getReader()
  let position = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await writer.write(value, position)
      position += value.byteLength
    }
  } finally {
    await writer.close()
  }
  return blobStore.read(key)
}

/** One Conversion from an existing file to a smaller one, timed. */
async function transcode(
  input: Blob,
  width: number,
  height: number,
): Promise<{ ms: number; bytes: number }> {
  const key = `f16t1-${newId('t')}`
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
  const t0 = performance.now()
  const conversion = await Conversion.init({
    input: new Input({ source: new BlobSource(input), formats: ALL_FORMATS }),
    output: new Output({
      format: new Mp4OutputFormat(),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 4 << 20 }),
    }),
    video: { width, height, fit: 'contain' },
  })
  await conversion.execute()
  await closeOnce()
  const ms = Math.round(performance.now() - t0)
  await blobStore.remove(key).catch(() => undefined)
  return { ms, bytes }
}


/**
 * F16 SPIKE T2 — WHAT DOES A BACKGROUND RENDER COST THE PERSON EDITING?
 *
 * The whole design says "editing is when the machine is idle", and the render
 * lives in a worker, so the expectation is that the UI thread barely notices.
 * That is a reasoning claim and F16's gate refuses reasoning, so it is measured
 * against this machine's OWN floor: the same 16 ms ticker, once with nothing
 * running and once while the pre-render works, so the answer is a DELTA rather
 * than a number that means nothing without a machine attached to it.
 *
 * A background job that makes editing stutter is worse than no background job,
 * because the user is looking at the thing it is stuttering.
 */
export async function runF16BackgroundCost(opts: {
  sourceW?: number
  sourceH?: number
  sourceFps?: number
  takeSec?: number
  sourceMbps?: number
  rung?: QualityTierId
  sampleSec?: number
} = {}): Promise<T2Report> {
  const sourceW = opts.sourceW ?? 3024
  const sourceH = opts.sourceH ?? 1964
  const sourceFps = opts.sourceFps ?? 60
  const takeSec = opts.takeSec ?? 60
  const mbps = opts.sourceMbps ?? 24
  const sampleSec = opts.sampleSec ?? 8

  const key = fixtureKey(sourceW, sourceH, sourceFps, takeSec, mbps)
  let frames = Math.round(takeSec * sourceFps)
  if ((await existingFixture(key)) === null) {
    const built = await buildChannelFile({
      key, width: sourceW, height: sourceH, fps: sourceFps,
      seconds: takeSec, mbps, budgetSec: 1800, label: 'screen',
    })
    frames = built.frames
  }
  const rawBlob = await blobStore.read(key)
  const durationMs = Math.round((frames / sourceFps) * 1000)
  const recording: Recording = {
    id: newId('rec'),
    createdAt: Date.now(),
    durationMs,
    channels: [channel('screen', key, sourceW, sourceH, sourceFps, durationMs, rawBlob.size)],
  }
  const settings = settingsForTier(tierById(opts.rung ?? '1080p'), recording)

  // The floor, first and alone.
  const idleWatch = new SchedulingDelayWatch()
  idleWatch.start()
  await new Promise((r) => setTimeout(r, sampleSec * 1000))
  const idle = idleWatch.stop()

  // The same ticker, while the background render works.
  const t0 = performance.now()
  startPrerender({ recording, edit: defaultEditState(recording), settings })
  const busyWatch = new SchedulingDelayWatch()
  busyWatch.start()
  await new Promise((r) => setTimeout(r, sampleSec * 1000))
  const duringPrerender = busyWatch.stop()

  const taken = takePrerender(prerenderKey({ recording, edit: defaultEditState(recording), settings }))
  let prerenderFinished = false
  if (taken) {
    try {
      await taken
      prerenderFinished = true
    } catch {
      prerenderFinished = false
    }
  }
  cancelPrerender()

  const deltaP95 = Math.round((duringPrerender.p95LateMs - idle.p95LateMs) * 10) / 10
  return {
    idle,
    duringPrerender,
    prerenderFinished,
    prerenderMs: Math.round(performance.now() - t0),
    verdict:
      `p95 UI lateness ${idle.p95LateMs} ms idle -> ${duringPrerender.p95LateMs} ms during the ` +
      `background render (delta ${deltaP95} ms); worst tick ${idle.maxLateMs} -> ${duringPrerender.maxLateMs} ms`,
  }
}

export async function runF16Transcode(
  opts: F16TranscodeOptions = {},
): Promise<F16TranscodeReport> {
  const sourceW = opts.sourceW ?? 3024
  const sourceH = opts.sourceH ?? 1964
  const sourceFps = opts.sourceFps ?? 60
  const takeSec = opts.takeSec ?? 120
  const mbps = opts.sourceMbps ?? 24
  const rungs = opts.rungs ?? (['540p', '720p'] as QualityTierId[])
  const verdict: string[] = []

  // ---- the take ----------------------------------------------------------
  const key = fixtureKey(sourceW, sourceH, sourceFps, takeSec, mbps)
  let frames = Math.round(takeSec * sourceFps)
  if (opts.rebuild || (await existingFixture(key)) === null) {
    await blobStore.remove(key).catch(() => undefined)
    const built = await buildChannelFile({
      key,
      width: sourceW,
      height: sourceH,
      fps: sourceFps,
      seconds: takeSec,
      mbps,
      budgetSec: 1800,
      label: 'screen',
    })
    frames = built.frames
  }
  const rawBlob = await blobStore.read(key)
  const actualSec = frames / sourceFps
  const durationMs = Math.round(actualSec * 1000)
  const recording: Recording = {
    id: newId('rec'),
    createdAt: Date.now(),
    durationMs,
    channels: [channel('screen', key, sourceW, sourceH, sourceFps, durationMs, rawBlob.size)],
  }

  // ---- HIGH, made once, and NOT counted against the transcode lanes ------
  // In production High is the composite, already on disk when the take stops —
  // it costs the transcode lane nothing. Here it has to be made, so its cost is
  // reported separately rather than folded in, which would be a lie about the
  // lane being measured.
  const highSettings = settingsForTier(tierById('1080p'), recording)
  let high: F16TranscodeReport['high'] = null
  let highBlob: Blob | null = null
  {
    const t0 = performance.now()
    try {
      const r = await exportRecording({ recording, edit: defaultEditState(recording), settings: highSettings })
      const wallMs = Math.round(performance.now() - t0)
      // Copied out BEFORE any other export runs — see persistCopy.
      highBlob = await persistCopy(r.blob, `f16t1-high-${newId('h')}`)
      high = {
        width: highSettings.width,
        height: highSettings.height,
        sizeMB: MB(highBlob.size),
        wallMs,
      }
      console.info(`[f16t1] High made: ${high.sizeMB} MB in ${high.wallMs} ms`)
    } catch (err) {
      verdict.push(`High could not be made: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---- the three lanes, per rung ----------------------------------------
  const lanes: LaneResult[] = []
  for (const rung of rungs) {
    const s = settingsForTier(tierById(rung), recording)
    const record = (
      lane: LaneResult['lane'],
      wallMs: number,
      bytes: number | null,
      error: string | null,
    ): void => {
      lanes.push({
        lane,
        rung,
        width: s.width,
        height: s.height,
        wallMs,
        outputMB: bytes === null ? null : MB(bytes),
        error,
        timesRealtime: wallMs > 0 ? Math.round((actualSec / (wallMs / 1000)) * 100) / 100 : null,
      })
    }

    // RENDER — today's path.
    {
      const t0 = performance.now()
      try {
        const r = await exportRecording({ recording, edit: defaultEditState(recording), settings: s })
        record('render', Math.round(performance.now() - t0), r.blob.size, null)
      } catch (err) {
        record('render', Math.round(performance.now() - t0), null, err instanceof Error ? err.message : String(err))
      }
    }
    // FROM-RAW — one generation, heavy decode.
    {
      const t0 = performance.now()
      try {
        const r = await transcode(rawBlob, s.width, s.height)
        record('from-raw', r.ms, r.bytes, null)
      } catch (err) {
        record('from-raw', Math.round(performance.now() - t0), null, err instanceof Error ? err.message : String(err))
      }
    }
    // FROM-HIGH — two generations, light decode.
    if (highBlob) {
      const t0 = performance.now()
      try {
        const r = await transcode(highBlob, s.width, s.height)
        record('from-high', r.ms, r.bytes, null)
      } catch (err) {
        record('from-high', Math.round(performance.now() - t0), null, err instanceof Error ? err.message : String(err))
      }
    }
  }

  // ---- what the numbers say, said here rather than left to a reader ------
  for (const rung of rungs) {
    const of = (lane: LaneResult['lane']): LaneResult | undefined =>
      lanes.find((l) => l.rung === rung && l.lane === lane)
    const r = of('render')
    const raw = of('from-raw')
    const hi = of('from-high')
    if (r?.wallMs && raw?.wallMs && !raw.error && !r.error) {
      verdict.push(
        `${rung}: from-raw is ${(r.wallMs / raw.wallMs).toFixed(1)}x the render ` +
          `(${raw.wallMs} ms vs ${r.wallMs} ms, ${raw.timesRealtime}x realtime)`,
      )
    }
    if (r?.wallMs && hi?.wallMs && !hi.error && !r.error) {
      verdict.push(
        `${rung}: from-high is ${(r.wallMs / hi.wallMs).toFixed(1)}x the render ` +
          `(${hi.wallMs} ms vs ${r.wallMs} ms, ${hi.timesRealtime}x realtime)`,
      )
    }
    if (raw?.outputMB && hi?.outputMB) {
      verdict.push(`${rung}: from-raw ${raw.outputMB} MB vs from-high ${hi.outputMB} MB`)
    }
  }

  return {
    source: {
      width: sourceW,
      height: sourceH,
      fps: sourceFps,
      takeSec: Math.round(actualSec * 10) / 10,
      sizeMB: MB(rawBlob.size),
    },
    high,
    lanes,
    verdict,
  }
}
