/**
 * EXPERIMENTAL — F7c attempt 4, step one: WHY is a 30-frame encode three times
 * cheaper per delta than a 360-frame one?
 *
 * Attempt 3 measured two 15-frame windows and predicted files 59-69 % too small
 * on motion content. The task left one named suspect: "rate control has not
 * settled in the short encode". That is a guess, and this measures it instead.
 *
 * The hypothesis this run tests is narrower and more mechanical: a delta right
 * after a keyframe is CHEAP, because it references a fresh, high-quality frame.
 * Later deltas reference deltas, drift accumulates, and they cost more. A
 * 15-frame window only ever sees the cheap end. If that is what is happening,
 * mean(delta[1..14]) will be a fraction of mean(delta[1..150]) — a 150-frame
 * GOP being what the shipped 5 s cadence actually produces (O11b) — and the
 * fraction will be measurable, content by content, which is all a correction
 * needs.
 *
 * Nothing here is a candidate estimator yet. It is the measurement that decides
 * whether attempt 4 has a mechanism to correct for or a dead hypothesis to bury.
 */

import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny'
import { motionSource, screenLikeSource, type Source } from './bitsAudit'

/** The shipped output cadence: 5 s at 30 fps (O11b). */
const GOP_FRAMES = 150
/** Long enough to cover a whole GOP and then some. */
const FRAMES = 180
const FPS = 30
/**
 * Frames of source animation to run and DISCARD before the encode starts.
 * Without it the first bucket measures the rig waking up — the screen source's
 * first scroll and caret blink land inside it — and that would be read as the
 * encoder settling. (TASKS note 10: the rig is wrong before the product is.)
 */
const WARMUP_FRAMES = 45

interface Bucket {
  from: number
  to: number
  meanBytes: number
  frames: number
}

export interface DeltaGrowthRow {
  content: 'screen' | 'motion'
  width: number
  height: number
  bitrate: number
  keyframeBytes: number
  /** Every delta in order — the raw evidence, trimmed for the report. */
  firstDeltas: number[]
  buckets: Bucket[]
  /** What attempt 3 measured: the mean over a 15-frame window. */
  shortWindowMeanBytes: number
  /** What a real GOP costs on average. */
  gopMeanBytes: number
  /**
   * gopMean ÷ shortWindowMean. If the mechanism is real this is ~3 and it is
   * the correction attempt 4 needs. If it is ~1, the hypothesis is dead and the
   * factor of three is somewhere else entirely.
   */
  ratio: number
  encodeMs: number
}

async function measure(
  content: 'screen' | 'motion',
  width: number,
  height: number,
  bitrate: number,
): Promise<DeltaGrowthRow> {
  const source: Source = content === 'screen' ? screenLikeSource(width, height) : motionSource(width, height)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false })!
  const keyBytes: number[] = []
  const deltas: number[] = []
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const encoder = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate,
    // One keyframe, at the start — the encoder must not insert its own or the
    // distance-from-keyframe axis this whole run is about stops meaning anything.
    keyFrameInterval: 1e6,
    onEncodedPacket: (p) => {
      if (p.type === 'key') keyBytes.push(p.byteLength)
      else deltas.push(p.byteLength)
    },
  })
  output.addVideoTrack(encoder, { frameRate: FPS })
  // Let the source reach its steady state before anything is measured.
  for (let i = 0; i < WARMUP_FRAMES; i++) await new Promise((r) => setTimeout(r, 1000 / FPS))
  const t0 = performance.now()
  try {
    await output.start()
    for (let i = 0; i < FRAMES; i++) {
      // Let the source ANIMATE between captures: encoding 180 frames as fast as
      // the CPU allows would sample one still picture 180 times and measure
      // nothing. A 30 fps capture sees the canvas every 33 ms, so this does too.
      await new Promise((r) => setTimeout(r, 1000 / FPS))
      ctx.drawImage(source.canvas, 0, 0, width, height)
      await encoder.add(i / FPS, 1 / FPS, { keyFrame: i === 0 })
    }
    encoder.close()
    await output.finalize()
  } finally {
    source.stop()
  }
  const encodeMs = Math.round(performance.now() - t0)
  const mean = (xs: number[]): number =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0
  const bucketRanges: [number, number][] = [
    [0, 14],
    [14, 29],
    [29, 59],
    [59, 119],
    [119, 179],
  ]
  const buckets = bucketRanges.map(([from, to]) => {
    const slice = deltas.slice(from, to)
    return { from: from + 1, to, meanBytes: mean(slice), frames: slice.length }
  })
  const shortWindowMeanBytes = mean(deltas.slice(0, 14))
  const gopMeanBytes = mean(deltas.slice(0, GOP_FRAMES - 1))
  return {
    content,
    width,
    height,
    bitrate,
    keyframeBytes: mean(keyBytes),
    firstDeltas: deltas.slice(0, 20),
    buckets,
    shortWindowMeanBytes,
    gopMeanBytes,
    ratio:
      shortWindowMeanBytes > 0 ? Math.round((gopMeanBytes / shortWindowMeanBytes) * 100) / 100 : 0,
    encodeMs,
  }
}

/**
 * ATTEMPT 5's COUNTABLE QUESTION. Attempt 4's probe encodes EXACTLY the GOP the
 * render encodes, from the same pixels, at the same bitrate, and still comes out
 * a uniform 1.44x under on motion content. One number, not a curve, points at
 * something countable — and the first suspect on the list is that THE FIRST GOP
 * OF A FILE IS NOT A TYPICAL ONE: a fresh encoder's rate controller starts
 * conservative and ramps, which is exactly the shape attempt 4's buckets show
 * (motion deltas 4775 B near the keyframe, 16356 B at frame 120-179).
 *
 * So encode FOUR consecutive GOPs, each with its own forced keyframe at the
 * cadence the render ships (5 s / 150 frames), and compare GOP 1 with the mean
 * of GOPs 2-4. If the first one is ~0.7x of the rest, the probe is measuring the
 * ramp and must skip it. If they are all the same, this suspect is dead too and
 * the 1.44x is somewhere else.
 */
export interface GopSeriesRow {
  content: 'screen' | 'motion'
  gops: {
    index: number
    keyframeBytes: number
    meanDeltaBytes: number
    totalBytes: number
  }[]
  /** mean(GOP 2..N) / GOP 1, on TOTAL bytes. ~1 kills the hypothesis. */
  laterOverFirst: number
  /** Same on the delta mean alone, so a keyframe outlier cannot carry it. */
  laterOverFirstDeltas: number
  /** What the encoder actually achieved over the whole run, against the ask. */
  achievedMbps: number
  requestedMbps: number
  encodeMs: number
}

export interface DeltaGrowthReport {
  frames: number
  gopFrames: number
  rows: DeltaGrowthRow[]
  gopSeries: GopSeriesRow[]
  notes: string[]
}

/** How many consecutive GOPs the series encodes. 4 x 5 s = 20 s per content. */
const GOP_SERIES = 4

async function measureGopSeries(
  content: 'screen' | 'motion',
  width: number,
  height: number,
  bitrate: number,
): Promise<GopSeriesRow> {
  const source: Source =
    content === 'screen' ? screenLikeSource(width, height) : motionSource(width, height)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false })!
  const packets: { key: boolean; bytes: number }[] = []
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const encoder = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate,
    // Forced by hand at the shipped cadence, so which packet belongs to which
    // GOP is known rather than inferred.
    keyFrameInterval: 1e6,
    onEncodedPacket: (p) => packets.push({ key: p.type === 'key', bytes: p.byteLength }),
  })
  output.addVideoTrack(encoder, { frameRate: FPS })
  for (let i = 0; i < WARMUP_FRAMES; i++) await new Promise((r) => setTimeout(r, 1000 / FPS))
  const total = GOP_SERIES * GOP_FRAMES
  const t0 = performance.now()
  try {
    await output.start()
    for (let i = 0; i < total; i++) {
      await new Promise((r) => setTimeout(r, 1000 / FPS))
      ctx.drawImage(source.canvas, 0, 0, width, height)
      await encoder.add(i / FPS, 1 / FPS, { keyFrame: i % GOP_FRAMES === 0 })
    }
    encoder.close()
    await output.finalize()
  } finally {
    source.stop()
  }
  const encodeMs = Math.round(performance.now() - t0)
  const mean = (xs: number[]): number =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0
  const gops = []
  for (let g = 0; g < GOP_SERIES; g++) {
    const slice = packets.slice(g * GOP_FRAMES, (g + 1) * GOP_FRAMES)
    if (slice.length === 0) continue
    const deltas = slice.filter((p) => !p.key).map((p) => p.bytes)
    const keys = slice.filter((p) => p.key).map((p) => p.bytes)
    gops.push({
      index: g + 1,
      keyframeBytes: mean(keys),
      meanDeltaBytes: mean(deltas),
      totalBytes: slice.reduce((a, p) => a + p.bytes, 0),
    })
  }
  const first = gops[0]
  const later = gops.slice(1)
  const laterTotal = later.length ? later.reduce((a, g) => a + g.totalBytes, 0) / later.length : 0
  const laterDelta = later.length ? later.reduce((a, g) => a + g.meanDeltaBytes, 0) / later.length : 0
  const bytes = packets.reduce((a, p) => a + p.bytes, 0)
  return {
    content,
    gops,
    laterOverFirst:
      first && first.totalBytes > 0 ? Math.round((laterTotal / first.totalBytes) * 100) / 100 : 0,
    laterOverFirstDeltas:
      first && first.meanDeltaBytes > 0
        ? Math.round((laterDelta / first.meanDeltaBytes) * 100) / 100
        : 0,
    achievedMbps: Math.round(((bytes * 8) / (total / FPS) / 1e6) * 100) / 100,
    requestedMbps: Math.round((bitrate / 1e6) * 100) / 100,
    encodeMs,
  }
}

export async function runDeltaGrowth(
  opts: { width?: number; height?: number; bitrate?: number; series?: boolean } = {},
): Promise<DeltaGrowthReport> {
  const width = opts.width ?? 1920
  const height = opts.height ?? 1080
  const bitrate = opts.bitrate ?? 8_000_000
  const rows: DeltaGrowthRow[] = []
  const gopSeries: GopSeriesRow[] = []
  for (const content of ['screen', 'motion'] as const) {
    if (opts.series !== false) {
      gopSeries.push(await measureGopSeries(content, width, height, bitrate))
      await new Promise((r) => setTimeout(r, 500))
    }
    rows.push(await measure(content, width, height, bitrate))
    await new Promise((r) => setTimeout(r, 500))
  }
  return {
    frames: FRAMES,
    gopFrames: GOP_FRAMES,
    rows,
    gopSeries,
    notes: [
      'one forced keyframe at frame 0 and none after: the axis this measures is DISTANCE FROM THE KEYFRAME, which an encoder-inserted key would destroy',
      'the source animates between captures at 33 ms, exactly what a 30 fps capture sees — encoding as fast as the CPU allows would sample one still picture 180 times',
      'shortWindowMeanBytes is what F7c attempt 3 measured; gopMeanBytes is what a shipped 5 s GOP actually averages; ratio is the correction attempt 4 would need',
      'a ratio near 1 kills the hypothesis: the factor of three would then be somewhere other than distance from the keyframe',
      `the source animates for ${WARMUP_FRAMES} frames before the encode starts: without that warm-up the first bucket measures the RIG waking up, not the encoder settling`,
      `gopSeries encodes ${GOP_SERIES} consecutive ${GOP_FRAMES}-frame GOPs at the shipped 5 s cadence and compares the FIRST with the mean of the rest — attempt 5's countable question, since the probe only ever measures a file's first GOP`,
    ],
  }
}
