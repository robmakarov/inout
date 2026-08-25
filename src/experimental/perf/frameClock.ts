/**
 * EXPERIMENTAL — O4-polish: WHICH CLOCK DOES A CAPTURED FRAME CARRY?
 *
 * P0-instant-sync left one residual named and unchased: on the v2 engine the
 * instant path sits ~25-33 ms ABOVE the same take's render (65.8 / 77.2 / 75.6
 * against 41.8 / 51.6 / 42.6). The suspicion written down with it is that the
 * two ends of the composite's timeline are read off DIFFERENT clocks — video
 * frames are stamped `performance.now()` at the moment the reader hands them
 * over (an ARRIVAL time, late by however long the capture pipeline took), while
 * the file's origin is the first audio batch's CAPTURE time
 * (`wallForContextTime` of its first sample).
 *
 * A VideoFrame off MediaStreamTrackProcessor carries its own `timestamp`, and
 * that is the capture side of the same event. Its EPOCH is unspecified — it is
 * not documented to share performance.now()'s time origin — so the only honest
 * quantity is the DIFFERENCE
 *
 *     d_k = arrival_k − timestamp_k
 *
 * whose *spread* is the delivery jitter and whose *slope against time* is the
 * rate difference between the media clock and the wall clock. Both matter, and
 * they pull in opposite directions:
 *
 *   · a large spread says arrival stamping adds jitter that the media timestamp
 *     would remove (min-filter d, stamp frames at timestamp + min d);
 *   · a non-zero slope says the media clock DRIFTS against the wall clock, so
 *     adopting it wholesale would trade a fixed error for a growing one — and
 *     PO records 938-1800 s takes, where even 50 ppm is 45 ms.
 *
 * So this measures both before anything in production changes (note 10: the rig
 * is wrong before the product is). It reports per source kind, on a canvas
 * capture track (what every rig in this repo has) and, when the browser can
 * give one, on a getUserMedia camera — those are two different capture
 * pipelines and there is no reason to assume they answer alike.
 */
import { makeRig } from './compositorEngine'

interface LaneReport {
  lane: string
  frames: number
  /** arrival − frame.timestamp, ms. The epoch is arbitrary; the SHAPE is not. */
  meanMs: number
  minMs: number
  maxMs: number
  sdMs: number
  p50Ms: number
  p95Ms: number
  /** Excess over the best frame — this is what a min-filter would remove. */
  meanExcessMs: number
  p95ExcessMs: number
  /** Slope of d against wall time: the media clock's rate error, in ppm. */
  driftPpm: number
  /** Same slope expressed where it bites: ms of drift across a 900 s take. */
  driftMsPer900s: number
  /** Is the frame timestamp monotonic as delivered? */
  nonMonotonic: number
  /** First frame's raw timestamp, ms — says whether the epoch is take-relative. */
  firstTimestampMs: number
}

interface Sample {
  arrivalMs: number
  tsMs: number
}

const TP = (
  globalThis as unknown as {
    MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => {
      readable: ReadableStream<VideoFrame>
    }
  }
).MediaStreamTrackProcessor

async function readLane(track: MediaStreamTrack, forMs: number): Promise<Sample[]> {
  if (!TP) return []
  const reader = new TP({ track }).readable.getReader()
  const out: Sample[] = []
  const stopAt = performance.now() + forMs
  for (;;) {
    let res: ReadableStreamReadResult<VideoFrame>
    try {
      res = await reader.read()
    } catch {
      break
    }
    const arrivalMs = performance.now()
    const { value, done } = res
    if (done) break
    if (value) {
      out.push({ arrivalMs, tsMs: value.timestamp / 1000 })
      value.close()
    }
    if (arrivalMs >= stopAt) break
  }
  await reader.cancel().catch(() => undefined)
  return out
}

function summarize(lane: string, samples: Sample[]): LaneReport {
  const n = samples.length
  if (n === 0) {
    return {
      lane,
      frames: 0,
      meanMs: 0,
      minMs: 0,
      maxMs: 0,
      sdMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      meanExcessMs: 0,
      p95ExcessMs: 0,
      driftPpm: 0,
      driftMsPer900s: 0,
      nonMonotonic: 0,
      firstTimestampMs: 0,
    }
  }
  const d = samples.map((s) => s.arrivalMs - s.tsMs)
  const sorted = [...d].sort((a, b) => a - b)
  const mean = d.reduce((a, b) => a + b, 0) / n
  const min = sorted[0]!
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / n)
  const q = (p: number): number => sorted[Math.min(n - 1, Math.floor(p * n))]!
  // Least squares of d against arrival time: a rate difference between the two
  // clocks shows up here and nowhere else.
  const t0 = samples[0]!.arrivalMs
  const xs = samples.map((s) => (s.arrivalMs - t0) / 1000)
  const xbar = xs.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - xbar) * (d[i]! - mean)
    sxx += (xs[i]! - xbar) ** 2
  }
  const slopeMsPerSec = sxx > 0 ? sxy / sxx : 0
  let nonMonotonic = 0
  for (let i = 1; i < n; i++) if (samples[i]!.tsMs < samples[i - 1]!.tsMs) nonMonotonic++
  const excess = d.map((x) => x - min)
  const excessSorted = [...excess].sort((a, b) => a - b)
  const r2 = (x: number): number => Math.round(x * 100) / 100
  return {
    lane,
    frames: n,
    meanMs: r2(mean),
    minMs: r2(min),
    maxMs: r2(sorted[n - 1]!),
    sdMs: r2(sd),
    p50Ms: r2(q(0.5)),
    p95Ms: r2(q(0.95)),
    meanExcessMs: r2(excess.reduce((a, b) => a + b, 0) / n),
    p95ExcessMs: r2(excessSorted[Math.min(n - 1, Math.floor(0.95 * n))]!),
    driftPpm: Math.round(slopeMsPerSec * 1000),
    driftMsPer900s: r2(slopeMsPerSec * 900),
    nonMonotonic,
    firstTimestampMs: r2(samples[0]!.tsMs),
  }
}

export async function runFrameClock(
  opts: { takeMs?: number } = {},
): Promise<{
  supported: boolean
  takeMs: number
  lanes: LaneReport[]
  notes: string[]
}> {
  const takeMs = opts.takeMs ?? 20000
  const notes: string[] = []
  if (!TP) {
    return {
      supported: false,
      takeMs,
      lanes: [],
      notes: ['MediaStreamTrackProcessor unavailable — this browser runs the v1 engine anyway.'],
    }
  }

  const rig = makeRig(1920, 1080, null)
  const lanes: LaneReport[] = []
  try {
    const screenTrack = rig.screen.getVideoTracks()[0]
    const cameraTrack = rig.camera.getVideoTracks()[0]
    const [screen, camera] = await Promise.all([
      screenTrack ? readLane(screenTrack, takeMs) : Promise.resolve([]),
      cameraTrack ? readLane(cameraTrack, takeMs) : Promise.resolve([]),
    ])
    lanes.push(summarize('canvas-screen', screen))
    lanes.push(summarize('canvas-camera', camera))
  } finally {
    rig.stop()
  }

  // A real device pipeline, when one is reachable. Headless Chromium without
  // --use-fake-device-for-media-stream has none, and saying so beats reporting
  // the canvas number as if it covered both.
  try {
    const gum = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
    const t = gum.getVideoTracks()[0]
    if (t) lanes.push(summarize('getUserMedia-camera', await readLane(t, Math.min(takeMs, 8000))))
    for (const track of gum.getTracks()) track.stop()
  } catch (err) {
    notes.push(`no getUserMedia lane: ${(err as Error).name ?? String(err)}`)
  }

  notes.push(
    'd = arrival − frame.timestamp. Its EPOCH is meaningless (the timebases differ); its SPREAD is the ' +
      'delivery jitter a media-clock stamp would remove, and its SLOPE is the rate error adopting that ' +
      'clock would introduce.',
  )
  return { supported: true, takeMs, lanes, notes }
}
