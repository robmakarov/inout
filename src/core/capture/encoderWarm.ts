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

import { pickAvcConfig } from './avcCodecs'
import { rememberEncoderThroughput } from './encoderBudget'
import { encoderWarmYielded } from './encoderWarmYield'

/** Enough to time, few enough to be invisible: ~0.2 s at 1080p on the machine
 *  this was written on, 0.6 s at 3024x1964, and the warm above has already paid
 *  the initialization. */
const MEASURE_FRAMES = 40

/**
 * THE METER IS CONFIGURED AT THE SIZE THE DECISION IS ABOUT — task B14, and
 * this line is the whole of the defect.
 *
 * `rateForSurface` asks "can this machine encode WxH at 60?" and answers it by
 * comparing the demand against `measuredEncoderThroughput()`. That number was
 * measured at a hard-coded 1920x1080, with a hard-coded `avc1.4D402A` — LEVEL
 * 4.2, which cannot be configured above 1080p at all, so the size was not a
 * choice so much as the only size that codec string allows.
 *
 * Mpx/s is NOT the machine invariant this file used to claim it was. Measured
 * on prod 2026-09-03, one machine, one meter, the take's own codec ladder:
 *
 *   1920x1080  330 Mpx/s     2560x1662  389     3024x1964  398/406/412     3840x2160  417
 *
 * It RISES with frame size — the same shape rate.ts recorded on 2026-08-30
 * (362/410/416/435). So a 1080p reading is a LOWER BOUND on a bigger frame's
 * throughput, and it was being used as an upper one: 3024x1964@60 wants 356
 * Mpx/s, the machine delivers ~405 at that size and 330 at 1080p, and every max
 * take on a 3024 screen was held at 30 fps by the gap between those two numbers.
 * A comment in this file called measuring small "the safe direction". It is the
 * refusing direction, which is the opposite of safe for a decision that can only
 * ever take something away.
 *
 * THE DISPLAY'S OWN PIXEL SIZE is the right frame, and it is available at mount
 * with no device touched (the frozen no-idle-device-access rule): a capture
 * surface cannot be bigger than the screen it is on, so this measures the worst
 * case the decision will ever be asked about, and a smaller surface needs less
 * than a number taken at a larger one.
 */
function meterFrameSize(): { width: number; height: number } {
  const fallback = { width: 1920, height: 1080 }
  try {
    if (typeof screen === 'undefined') return fallback
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1
    const w = even(Math.round(screen.width * dpr))
    const h = even(Math.round(screen.height * dpr))
    // A headless or otherwise unreported screen must not shrink the meter below
    // what it has always measured — the number would then be lower than the one
    // this replaces, which is the failure this task exists to remove.
    if (w < fallback.width || h < fallback.height) return fallback
    return { width: w, height: h }
  } catch {
    return fallback
  }
}

/** AVC cannot encode an odd side (oddSide.ts), and a screen can report one. */
function even(n: number): number {
  return n % 2 === 0 ? n : n - 1
}

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
      // Mpx/s IS NOT A MACHINE-LEVEL INVARIANT, and B14 is what believing that
      // cost. It rises with frame size on every machine measured, so the meter
      // runs at the size the decision is about — see meterFrameSize() above.
      await runMeter()
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
    await runMeter()
  } catch {
    /* the budget simply goes unmeasured this launch, as it did before O15 */
  }
}

/**
 * ONE MEASUREMENT, ONE PLACE. It used to be two call sites each carrying their
 * own copy of the config, which is how the deferred half and the warm half
 * could ever have disagreed about what was measured — and B14 is a task about a
 * number that was measured under one geometry and spent under another.
 */
async function runMeter(): Promise<void> {
  if (typeof VideoEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined') return
  const { width, height } = meterFrameSize()
  const config = await pickAvcConfig({
    width,
    height,
    bitrate: 8_000_000,
    framerate: 30,
    latencyMode: 'realtime',
    hardwareAcceleration: 'prefer-hardware',
  })
  // NO AVC AT THIS SIZE MEANS NO NUMBER, and that is the honest answer rather
  // than a smaller frame's number wearing this frame's label. `encoderCeiling`
  // and `rateForSurface` both already have an unmeasured branch; this is what
  // it is for.
  if (!config) return
  const canvas = new OffscreenCanvas(config.width, config.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return
  ctx.fillStyle = '#202028'
  ctx.fillRect(0, 0, config.width, config.height)

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
    rememberEncoderThroughput(mpxPerSec, config.width, config.height)
    console.info(
      `[capture] this machine's video encoder: ${Math.round(out / seconds)} fps at ` +
        `${config.width}x${config.height} (${config.codec}) = ${mpxPerSec.toFixed(0)} Mpx/s ` +
        `(measured while nothing was recording, AT THE SIZE A TAKE WILL ASK FOR — what a take may ` +
        `attempt is decided from this rather than from a constant, and Mpx/s is not the same number ` +
        `at every frame size (B14))`,
    )
  }
}
