/**
 * O4 — force the renderer's first-VideoEncoder initialization while nobody is
 * recording.
 *
 * Measured 2026-08-24: the first VideoEncoder of a Chrome PROCESS pays a
 * multi-second initialization — per LAUNCH, not per profile (a reused profile
 * in a new process still measured 13-16 fps / 177-260 ms latency on its first
 * take against ~28 fps / 13 ms warm). Without this, the v2 engine's first take
 * after every browser launch drops its opening seconds while the encoder wakes
 * up. Five 1080p frames through a throwaway encoder at mount move that cost to
 * app load, off every critical path. No device is touched (the frozen
 * no-idle-device-access rule); the input is a blank OffscreenCanvas.
 *
 * The warm runs on the MAIN thread while the engine encodes in a WORKER — that
 * this still works is measured, not assumed (the init lives in the GPU
 * process, shared across threads): `npm run exp -- o4worker
 * {"cells":["mainwarm"],"warmup":false}` runs exactly this function cold and
 * then the production worker.
 */

import { rememberEncoderThroughput } from './encoderBudget'
import { encoderWarmYielded } from './encoderWarmYield'

/** Enough to time, few enough to be invisible: ~0.2 s on the machine this was
 *  written on, and the warm above has already paid the initialization. */
const MEASURE_FRAMES = 40

let started: Promise<void> | null = null
/**
 * The measurement below is INSTRUMENTATION and the init above it is not, so
 * they are owed separately. A take that starts mid-warm gets the machine and
 * this is deferred to the moment the take ends — the number is cached across
 * launches, so deferring it costs at most the first take of a fresh profile the
 * encoder budget it would have had.
 */
let meterOwed = true

export function warmVideoEncoder(): Promise<void> {
  started ??= (async () => {
    try {
      if (typeof VideoEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined') return
      const config: VideoEncoderConfig = {
        codec: 'avc1.4D402A',
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        framerate: 30,
        latencyMode: 'realtime',
        hardwareAcceleration: 'prefer-hardware',
      }
      const support = await VideoEncoder.isConfigSupported(config).catch(() => null)
      if (!support?.supported) return
      const canvas = new OffscreenCanvas(config.width, config.height)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return
      const encoder = new VideoEncoder({ output: () => undefined, error: () => undefined })
      encoder.configure(config)
      for (let i = 0; i < 5; i++) {
        // Content is irrelevant; the flush below is what forces the
        // initialization to actually complete rather than merely queue.
        ctx.fillStyle = i % 2 ? '#202028' : '#303038'
        ctx.fillRect(0, 0, config.width, config.height)
        const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / 30) })
        try {
          encoder.encode(frame, { keyFrame: i === 0 })
        } finally {
          frame.close()
        }
      }
      await encoder.flush()
      // CLOSED THE INSTANT THE INIT IS PAID, and it used to stay open through
      // the whole measurement below. Two 1080p encoders alive here plus the
      // three a take opens is five hardware sessions competing, which is the
      // fight this file's companion module documents. The init is a property of
      // the PROCESS, not of this object: closing it keeps every millisecond of
      // what the warm bought.
      encoder.close()

      // A TAKE IS STARTING — STOP. Everything above was the point; everything
      // below is a number, and a number is not worth a second of somebody's
      // recording. runOwedEncoderMeasurement() picks it up when the take ends.
      if (encoderWarmYielded()) return

      // …AND NOW THAT IT IS WARM, MEASURE WHAT IT CAN DO (2026-08-30).
      //
      // Robert's freeze needed a number nobody had: how much encoding THIS
      // machine can actually carry. Every guard until now used a constant —
      // rate.ts capped 60 fps above a 2560 long edge, which is a size and not a
      // capability, and rate.ts's own header already says why that is wrong
      // ("a constant from one machine cannot decide what every machine may
      // attempt"). But its answer — let the ladder decide while the take runs —
      // cannot cover a collapse that is instant, which is exactly O15's premise.
      //
      // So the machine is asked, once per launch, HERE: where the encoder is
      // already warm, no device is touched, nothing is recording, and the cost
      // is already being paid. One frame is built and re-stamped rather than
      // repainted, so this measures the ENCODER and not a canvas — and the
      // count is small enough to be invisible (measured on this Mac: ~0.2 s).
      //
      // Mpx/s is the machine-level invariant worth storing: measured across
      // 1080p / 2560x1662 / 3024x1964 / 4K it reads 362 / 410 / 416 / 435, so
      // it is near-constant and RISES slightly with frame size. Measuring at
      // 1080p therefore under-states a bigger frame, which is the safe
      // direction for a number that decides what to attempt.
      await runMeter(config, canvas)
    } catch {
      /* a failed warm costs nothing — the take pays the init instead */
    }
  })()
  return started
}

/**
 * The deferred half. Called when a take ends: if the warm stood down for it,
 * this is the measurement it owes, run where it was always meant to run —
 * with nothing recording.
 */
export async function runOwedEncoderMeasurement(): Promise<void> {
  if (!meterOwed || encoderWarmYielded()) return
  try {
    if (typeof VideoEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined') return
    const config: VideoEncoderConfig = {
      codec: 'avc1.4D402A',
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
      framerate: 30,
      latencyMode: 'realtime',
      hardwareAcceleration: 'prefer-hardware',
    }
    const support = await VideoEncoder.isConfigSupported(config).catch(() => null)
    if (!support?.supported) return
    const canvas = new OffscreenCanvas(config.width, config.height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.fillStyle = '#202028'
    ctx.fillRect(0, 0, config.width, config.height)
    await runMeter(config, canvas)
  } catch {
    /* the budget simply goes unmeasured this launch, as it did before O15 */
  }
}

async function runMeter(config: VideoEncoderConfig, canvas: OffscreenCanvas): Promise<void> {
  const t0 = performance.now()
  let out = 0
  const meter = new VideoEncoder({ output: () => (out += 1), error: () => undefined })
  meter.configure(config)
  const still = new VideoFrame(canvas, { timestamp: 0 })
  for (let i = 0; i < MEASURE_FRAMES; i++) {
    const frame = new VideoFrame(still, { timestamp: Math.round((i * 1e6) / 30) })
    try {
      meter.encode(frame, { keyFrame: i === 0 })
    } finally {
      frame.close()
    }
  }
  await meter.flush()
  still.close()
  meter.close()
  const seconds = (performance.now() - t0) / 1000
  meterOwed = false
  if (out > 0 && seconds > 0) {
    const mpxPerSec = (config.width * config.height * (out / seconds)) / 1e6
    rememberEncoderThroughput(mpxPerSec)
    console.info(
      `[capture] this machine's video encoder: ${Math.round(out / seconds)} fps at ` +
        `${config.width}x${config.height} = ${mpxPerSec.toFixed(0)} Mpx/s (measured while nothing ` +
        `was recording — what a take may attempt is decided from this rather than from a constant)`,
    )
  }
}
