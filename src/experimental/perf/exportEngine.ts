/**
 * EXPERIMENTAL — O5 evidence: the export engine, worker vs main thread.
 *
 * Answers the three numbers O5's gates are written in, on ONE fixture so an
 * A/B of engines is not also an A/B of content:
 *
 *   realtimeFactor   output seconds produced per second of wall clock
 *   longTasks        main-thread blocks >50 ms DURING the export (the gate is
 *                    zero, and it is the reason the worker exists at all)
 *   plays            the file decodes at three instants, with its real dims
 *
 * THE FIXTURE IS THE PRODUCTION SHAPE, deliberately: a canvas recorded through
 * MediaRecorder into a vp9 webm, exactly as a raw screen channel is captured on
 * Chromium. Encoding the fixture with WebCodecs instead would have been ~10×
 * faster to build and would have quietly measured avc decode, which is not the
 * decode the export actually pays.
 *
 * The main-thread lane is not a straw man: it is the SAME render.ts the worker
 * runs, with yieldEveryFrames 8 — i.e. the engine exactly as it shipped before
 * O5, which is what "×N faster" has to be measured against to mean anything.
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { exportRecording } from '@core/compose'
import { getLastRenderStats, setExportWorkerEnabled } from '@core/compose/pipeline'
import type { RenderStats } from '@core/compose/render'
import { newId } from '@core/id'
import { blobStore } from '@core/store'
import {
  channelSourceTimeAt,
  clampEditState,
  defaultEditState,
  outputDurationMs,
} from '@core/timeline'
import { openVideoChannel } from '@core/compose/video'
import type { ChannelRecording, EditState, Recording } from '@core/types'
import { screenLikeSource, motionSource, type Source } from './bitsAudit'
import { LongTaskWatch, SchedulingDelayWatch } from './mainThreadWatch'
import { measureDecodeSite, type DecodeSiteRow } from './decodeSite'

const RAW_MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

/** Record a canvas the way production records a raw video channel. */
async function recordChannel(
  source: Source,
  kind: 'screen' | 'camera',
  takeMs: number,
  bitrate: number,
): Promise<ChannelRecording> {
  const mime = RAW_MIMES.find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) throw new Error('no supported raw recorder mime')
  const stream = source.canvas.captureStream(30)
  const blobKey = `exp-o5-${newId('src')}.webm`
  const writer = (await blobStore.createWriteStream(blobKey)).getWriter()
  let chain = Promise.resolve()
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate })
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return
    chain = chain.then(() => writer.write(e.data).catch(() => undefined))
  }
  recorder.start(1000)
  await new Promise((r) => setTimeout(r, takeMs))
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    recorder.requestData()
    recorder.stop()
  })
  await chain
  await writer.close().catch(() => undefined)
  for (const t of stream.getTracks()) t.stop()
  return {
    id: newId('ch'),
    kind,
    media: 'video',
    mimeType: mime,
    blobKey,
    startOffsetMs: 0,
    durationMs: takeMs,
    width: source.canvas.width,
    height: source.canvas.height,
  }
}

/** A mic channel recorded off an oscillator — the export must mix real audio. */
async function recordAudioChannel(takeMs: number): Promise<ChannelRecording | null> {
  const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) return null
  const ctx = new AudioContext({ sampleRate: 48_000 })
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const dest = ctx.createMediaStreamDestination()
  osc.frequency.value = 220
  gain.gain.value = 0.12
  osc.connect(gain).connect(dest)
  osc.start()
  const blobKey = `exp-o5-${newId('aud')}.webm`
  const writer = (await blobStore.createWriteStream(blobKey)).getWriter()
  let chain = Promise.resolve()
  const recorder = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 128_000 })
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return
    chain = chain.then(() => writer.write(e.data).catch(() => undefined))
  }
  recorder.start(1000)
  await new Promise((r) => setTimeout(r, takeMs))
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    recorder.requestData()
    recorder.stop()
  })
  await chain
  await writer.close().catch(() => undefined)
  osc.stop()
  await ctx.close()
  return {
    id: newId('ch'),
    kind: 'mic',
    media: 'audio',
    mimeType: mime,
    blobKey,
    startOffsetMs: 0,
    durationMs: takeMs,
  }
}

async function probe(blob: Blob): Promise<{
  durationSec: number
  width: number | null
  height: number | null
  decodedFrames: number
}> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    const duration = await input.computeDuration()
    let decodedFrames = 0
    if (video) {
      const sink = new VideoSampleSink(video)
      for (const t of [0, duration / 2, Math.max(0, duration - 0.2)]) {
        const s = await sink.getSample(t)
        if (s) {
          decodedFrames++
          s.close()
        }
      }
    }
    return {
      durationSec: Math.round(duration * 1000) / 1000,
      width: video?.displayWidth ?? null,
      height: video?.displayHeight ?? null,
      decodedFrames,
    }
  } finally {
    input.dispose()
  }
}

export interface EngineLane {
  engine: 'worker' | 'main'
  label: string
  outputSec: number
  wallMs: number
  realtimeFactor: number
  bytes: number
  longTasks: { supported: boolean; count: number; totalMs: number; maxMs: number }
  mainThread: { ticks: number; totalLateMs: number; maxLateMs: number; p95LateMs: number }
  /** Where the render's own wall clock went — the stage split from render.ts. */
  stages: RenderStats | null
  plays: { durationSec: number; width: number | null; height: number | null; decodedFrames: number }
}

async function runLane(
  engine: 'worker' | 'main',
  label: string,
  recording: Recording,
  edit: EditState,
): Promise<EngineLane> {
  setExportWorkerEnabled(engine === 'worker')
  const longWatch = new LongTaskWatch()
  const delayWatch = new SchedulingDelayWatch()
  // A settle tick first, so a stall from the PREVIOUS lane cannot be
  // attributed to this one — note 10, the rig is wrong before the product is.
  await new Promise((r) => setTimeout(r, 250))
  longWatch.start()
  delayWatch.start()
  const t0 = performance.now()
  const result = await exportRecording({ recording, edit })
  const wallMs = performance.now() - t0
  const mainThread = delayWatch.stop()
  const longTasks = longWatch.stop()
  const outputSec = outputDurationMs(edit) / 1000
  return {
    engine,
    label,
    outputSec: Math.round(outputSec * 1000) / 1000,
    wallMs: Math.round(wallMs),
    realtimeFactor: Math.round((outputSec / (wallMs / 1000)) * 100) / 100,
    bytes: result.blob.size,
    longTasks,
    mainThread,
    stages: getLastRenderStats(),
    plays: await probe(result.blob),
  }
}

/**
 * The floor under everything: what it costs merely to DECODE the frames the
 * export samples, with no draw, no encode and no muxer.
 *
 * This is the number that decides whether O5's pipelining premise can pay at
 * all. If the export's total wall clock is close to this, then the render is
 * already overlapping everything it can and the only way to go faster is to
 * decode fewer frames — which is smart-cut, not scheduling.
 */
async function decodeFloor(
  recording: Recording,
  edit: EditState,
  fps: number,
): Promise<{ frames: number; wallMs: number; framesPerSec: number }> {
  const channel = recording.channels.find((c) => c.media === 'video')
  if (!channel) return { frames: 0, wallMs: 0, framesPerSec: 0 }
  const blob = await blobStore.read(channel.blobKey)
  const reader = await openVideoChannel(blob, channel.id, channel.kind, channel.durationMs / 1000)
  if (!reader) return { frames: 0, wallMs: 0, framesPerSec: 0 }
  const totalFrames = Math.max(1, Math.ceil((outputDurationMs(edit) / 1000) * fps - 1e-9))
  const t0 = performance.now()
  let frames = 0
  try {
    for (let f = 0; f < totalFrames; f++) {
      const localMs = channelSourceTimeAt(recording, edit, channel.id, (f / fps) * 1000)
      if (localMs === null) continue
      if (await reader.sampleAt(localMs / 1000)) frames++
    }
  } finally {
    reader.dispose()
  }
  const wallMs = performance.now() - t0
  return {
    frames,
    wallMs: Math.round(wallMs),
    framesPerSec: Math.round((frames / (wallMs / 1000)) * 10) / 10,
  }
}

export interface O5Report {
  notes: string[]
  takeSec: number
  content: string
  /** Decode-only cost of the same frames — the floor the render cannot beat. */
  decodeFloor: { frames: number; wallMs: number; framesPerSec: number }
  /** X4's verdict: is the decode thread-bound, or is it competing? */
  decodeSite: DecodeSiteRow[]
  lanes: EngineLane[]
  gates: {
    /** ≥5× realtime on the 60 s edited take (stretch 8×). */
    throughput: { worker: number; main: number; speedup: number; pass: boolean }
    /**
     * The main thread stays free. Stated as scheduling lateness, not long
     * tasks: see SchedulingDelayWatch for why the long-task form of this gate
     * cannot fail and therefore cannot pass either.
     */
    mainThreadClear: {
      workerLateMs: number
      mainLateMs: number
      workerLongTaskMs: number
      mainLongTaskMs: number
      pass: boolean
    }
  }
}

/**
 * The O5 A/B. `takeSec` is the fixture length (the gate names 60 s);
 * `content` picks the source ('screen' | 'motion'), because the two extremes
 * price decode very differently and a single number would hide it.
 */
export async function runExportEngine(
  opts: { takeSec?: number; content?: 'screen' | 'motion'; cuts?: boolean; camera?: boolean } = {},
): Promise<O5Report> {
  const takeSec = opts.takeSec ?? 60
  const content = opts.content ?? 'screen'
  const withCuts = opts.cuts ?? true
  const notes: string[] = []
  const takeMs = takeSec * 1000

  const source = content === 'motion' ? motionSource(1920, 1080) : screenLikeSource(1920, 1080)
  // X4's question is about sharding decode ACROSS channels, so its fixture has
  // to have more than one — and screen+camera is also the shape PO records.
  const cameraSource = opts.camera ? motionSource(1280, 720) : null
  let recording: Recording
  try {
    const [video, cam, audio] = await Promise.all([
      recordChannel(source, 'screen', takeMs, 8_000_000),
      cameraSource ? recordChannel(cameraSource, 'camera', takeMs, 2_500_000) : Promise.resolve(null),
      recordAudioChannel(takeMs),
    ])
    const channels = [video, ...(cam ? [cam] : []), ...(audio ? [audio] : [])]
    if (!audio) notes.push('no opus recorder: video-only fixture, audio lane not exercised')
    if (cam) notes.push('two VIDEO channels (screen 1080p + camera 720p) — the shape X4 tried to shard')
    recording = {
      id: newId('rec'),
      createdAt: Date.now(),
      durationMs: takeMs,
      channels,
    }
  } finally {
    source.stop()
    cameraSource?.stop()
  }

  // The gate says EDITED: an unedited take would take the instant path in the
  // product and never reach this engine at all. Two cuts, off the keyframe
  // grid on purpose.
  const base = clampEditState(recording, defaultEditState(recording))
  const edit: EditState = withCuts
    ? clampEditState(recording, {
        ...base,
        segments: [
          { startMs: 0, endMs: Math.round(takeMs * 0.3) },
          { startMs: Math.round(takeMs * 0.45), endMs: takeMs },
        ],
      })
    : base

  const lanes: EngineLane[] = []
  try {
    // WARM FIRST, AND THEN RUN BOTH ORDERS. The first version of this rig ran
    // worker-then-main once and reported the worker 35 % slower — which is
    // note 10's fourth instance waiting to happen, because the first lane of
    // any run pays the codec cold start for the whole matrix. A discarded
    // export absorbs it, and measuring A,B,B,A means an order effect that
    // survives the warm-up still cannot be mistaken for an engine difference.
    const warmEdit = clampEditState(recording, {
      ...base,
      globalTrimStartMs: 0,
      globalTrimEndMs: Math.min(takeMs, 2000),
    })
    setExportWorkerEnabled(false)
    await exportRecording({ recording, edit: warmEdit })
    setExportWorkerEnabled(true)
    await exportRecording({ recording, edit: warmEdit })
    notes.push('both engines warmed with a discarded 2 s export before measuring')

    const label = `${content} ${takeSec}s edited`
    lanes.push(await runLane('worker', `${label} #1`, recording, edit))
    lanes.push(await runLane('main', `${label} #1`, recording, edit))
    lanes.push(await runLane('main', `${label} #2`, recording, edit))
    lanes.push(await runLane('worker', `${label} #2`, recording, edit))
  } finally {
    setExportWorkerEnabled(true)
  }

  const best = (engine: 'worker' | 'main'): EngineLane =>
    lanes
      .filter((l) => l.engine === engine)
      .reduce((a, b) => (b.realtimeFactor > a.realtimeFactor ? b : a))
  const worker = best('worker')
  const main = best('main')
  notes.push('gates read the BEST run of each engine, so a stray OS hiccup cannot decide the verdict')
  notes.push(
    'fixture is MediaRecorder vp9 webm, the production raw-channel shape; the main lane is the same render.ts with yieldEveryFrames 8 (pre-O5 behaviour)',
  )
  if (!worker.longTasks.supported) {
    notes.push('Long Tasks API unavailable in this browser — longTasks numbers are not measurements')
  }

  const floor = await decodeFloor(recording, edit, 30)
  notes.push(
    `decode floor: ${floor.frames} frames in ${floor.wallMs}ms (${floor.framesPerSec} fps) — the render's own decode wait should be close to this, and what is left over is everything else the export does`,
  )

  // X4: the decode SITE. Kept after the decode farm was measured and deleted,
  // so nobody re-proposes "shard the decode across threads" without first
  // reading what a thread actually buys here.
  const decodeSite = await measureDecodeSite(recording, edit, 30)
  for (const row of decodeSite) {
    notes.push(
      `X4 decode site (${row.channelKind}): ${row.inThreadMs}ms in-thread · ${row.workerAloneMs}ms in a worker ALONE ` +
        `(${row.siteRatio}× — the site is free) · ${row.workerDuringMs}ms in a worker WHILE the render runs ` +
        `(${row.contentionRatio}× — the decode is competing, not thread-bound). This is why the X4 decode farm ` +
        `was built, measured at 0.99-1.08× against a ≥2× gate, and deleted`,
    )
  }

  return {
    notes,
    takeSec,
    content,
    decodeFloor: floor,
    decodeSite,
    lanes,
    gates: {
      throughput: {
        worker: worker.realtimeFactor,
        main: main.realtimeFactor,
        speedup: Math.round((worker.realtimeFactor / main.realtimeFactor) * 100) / 100,
        pass: worker.realtimeFactor >= 5,
      },
      mainThreadClear: {
        workerLateMs: worker.mainThread.totalLateMs,
        mainLateMs: main.mainThread.totalLateMs,
        workerLongTaskMs: worker.longTasks.totalMs,
        mainLongTaskMs: main.longTasks.totalMs,
        // The worker lane must leave the thread measurably freer than the
        // in-thread lane does; a ratio, because the machine's own load moves
        // the absolute number run to run.
        pass: worker.mainThread.totalLateMs * 2 < main.mainThread.totalLateMs,
      },
    },
  }
}
