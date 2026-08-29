/**
 * G2 — DOES THE RIG'S OWN SOURCE MOVE?
 *
 * Every synthetic rig in this repo is a canvas handed to `captureStream()`, and
 * a captureStream track emits a frame only when its canvas is PAINTED. So the
 * first question of any load or tail measurement is one nobody had asked with a
 * number: in the environment the runner actually launches, does the painter run?
 *
 * The claim on the roadmap was that it does not — "a headless page runs rAF at
 * 0, so the source starves and the tail band reads starvation as tail loss".
 * That is a claim about Chrome, and this experiment is how it stops being one.
 *
 * Four lanes, same window, same seconds:
 *   raf       — a canvas painted from requestAnimationFrame (what most rigs do)
 *   interval  — the same canvas painted from setInterval (the known mitigation)
 *   guarded   — rAF with an interval watchdog behind it (the shipped fix)
 *   clocks    — the raw callback rates, so a starved TRACK can be told apart
 *               from a starved PAINTER
 *
 * Delivered fps is read off the TRACK with MediaStreamTrackProcessor, not off
 * the canvas: what a recorder receives is the only number that decides a band.
 *
 * Run it both ways and put the pair in the handoff:
 *   npm run exp -- rigsource
 *   npm run exp -- rigsource '{}' --headed
 */
import { paintLoop } from '../rigPaint'

export interface RigSourceLane {
  lane: 'raf' | 'interval' | 'guarded'
  /** Times the painter ran, per second of the measured window. */
  paintFps: number
  /** Frames that actually left the track, per second. */
  deliveredFps: number
  /** guarded only: how many of its paints came from the watchdog, not rAF. */
  watchdogPaints: number | null
}

export interface RigSourceReport {
  windowMs: number
  requestedFps: number
  hidden: boolean
  visibility: string
  /** Bare requestAnimationFrame callbacks per second, painting nothing. */
  rafHz: number
  /** Bare setInterval(16) callbacks per second, painting nothing. */
  intervalHz: number
  lanes: RigSourceLane[]
  /** True when rAF is too slow to source the requested rate. */
  rafStarved: boolean
  verdict: string
  notes: string[]
}

type FrameProcessor = new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }

function processorCtor(): FrameProcessor | undefined {
  return (globalThis as { MediaStreamTrackProcessor?: FrameProcessor }).MediaStreamTrackProcessor
}

/** Count frames off a live track for `ms`, then release it. */
async function countDelivered(track: MediaStreamTrack, ms: number): Promise<number> {
  const TP = processorCtor()
  if (!TP) return 0
  const reader = new TP({ track }).readable.getReader()
  let frames = 0
  const deadline = performance.now() + ms
  while (performance.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    frames++
    value.close()
  }
  await reader.cancel().catch(() => undefined)
  return frames
}

function makeCanvas(): { canvas: HTMLCanvasElement; draw: () => void; painted: () => number } {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  const g = canvas.getContext('2d')!
  let painted = 0
  const draw = (): void => {
    painted++
    g.fillStyle = `hsl(${(painted * 7) % 360}, 60%, 30%)`
    g.fillRect(0, 0, 640, 360)
    g.fillStyle = '#fff'
    g.fillRect((painted * 9) % 640, 160, 40, 40)
  }
  return { canvas, draw, painted: () => painted }
}

async function measureLane(
  lane: RigSourceLane['lane'],
  fps: number,
  windowMs: number,
): Promise<RigSourceLane> {
  const { canvas, draw, painted } = makeCanvas()
  let stop = (): void => undefined
  let watchdog: (() => number) | null = null
  if (lane === 'raf') {
    let raf = 0
    const tick = (): void => {
      draw()
      raf = requestAnimationFrame(tick)
    }
    tick()
    stop = () => cancelAnimationFrame(raf)
  } else if (lane === 'interval') {
    const timer = setInterval(draw, Math.round(1000 / fps))
    draw()
    stop = () => clearInterval(timer)
  } else {
    const loop = paintLoop(draw, fps)
    stop = loop.stop
    watchdog = () => loop.watchdogPaints()
  }
  const stream = canvas.captureStream(fps)
  const track = stream.getVideoTracks()[0]!
  const before = painted()
  const t0 = performance.now()
  const frames = await countDelivered(track, windowMs)
  const elapsed = (performance.now() - t0) / 1000
  const paints = painted() - before
  stop()
  track.stop()
  return {
    lane,
    paintFps: Math.round((paints / elapsed) * 10) / 10,
    deliveredFps: Math.round((frames / elapsed) * 10) / 10,
    watchdogPaints: watchdog ? watchdog() : null,
  }
}

/** Bare callback rates, painting nothing — separates a dead clock from a dead track. */
async function measureClocks(windowMs: number): Promise<{ rafHz: number; intervalHz: number }> {
  let rafs = 0
  let intervals = 0
  let running = true
  let raf = 0
  const tick = (): void => {
    rafs++
    if (running) raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  const timer = setInterval(() => {
    intervals++
  }, 16)
  const t0 = performance.now()
  await new Promise((r) => setTimeout(r, windowMs))
  const elapsed = (performance.now() - t0) / 1000
  running = false
  cancelAnimationFrame(raf)
  clearInterval(timer)
  return {
    rafHz: Math.round((rafs / elapsed) * 10) / 10,
    intervalHz: Math.round((intervals / elapsed) * 10) / 10,
  }
}

export async function runRigSource(opts?: {
  windowMs?: number
  fps?: number
}): Promise<RigSourceReport> {
  const windowMs = opts?.windowMs ?? 4000
  const fps = opts?.fps ?? 30
  const notes: string[] = []
  if (!processorCtor()) notes.push('MediaStreamTrackProcessor unavailable — deliveredFps reads 0 for every lane and this run proves nothing.')

  const { rafHz, intervalHz } = await measureClocks(windowMs)
  const lanes: RigSourceLane[] = []
  for (const lane of ['raf', 'interval', 'guarded'] as const) {
    lanes.push(await measureLane(lane, fps, windowMs))
  }

  // A source that cannot paint at the rate it declares cannot SOURCE that rate,
  // and every band downstream is then measuring the harness.
  const rafLane = lanes.find((l) => l.lane === 'raf')!
  const rafStarved = rafLane.deliveredFps < fps * 0.5
  const guarded = lanes.find((l) => l.lane === 'guarded')!
  const verdict = rafStarved
    ? `rAF SOURCE STARVED — ${rafLane.deliveredFps} of ${fps} fps delivered; the guarded lane delivers ${guarded.deliveredFps}`
    : `rAF source alive — ${rafLane.deliveredFps} of ${fps} fps delivered`
  return {
    windowMs,
    requestedFps: fps,
    hidden: typeof document !== 'undefined' ? document.hidden : false,
    visibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    rafHz,
    intervalHz,
    lanes,
    rafStarved,
    verdict,
    notes,
  }
}
