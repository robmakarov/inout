/**
 * EXPERIMENTAL — how late is the measured-audio anchor, and why.
 *
 * The anchor dates sample 0 as (batch arrival wall time − audio already
 * received). Everything between the source and the worklet — device capture
 * buffer, stream transport, context input buffer — happened BEFORE arrival and
 * is invisible to it, so the anchor is late by exactly that transport latency
 * L, and the export places audio L ms late. The min-filter removes jitter, not
 * a constant.
 *
 * This measures L directly with a loopback: schedule impulses at known
 * positions on a source context's clock, run the stream through the PRODUCTION
 * capture path, and compare where the anchor thinks each impulse happened
 * against where it was actually rendered.
 */

import {
  contextTimeToPerformanceMs,
  prewarmMeasuredAudio,
  startMeasuredAudioCapture,
} from '@core/capture/measuredAudio'
import { createPositionedWriter, blobStore } from '@core/store'
import { newId } from '@core/id'

const RATE = 48_000
const IMPULSE_MS = 4
const IMPULSE_INTERVAL_SEC = 0.5

/** Robust context→wall mapping: arrival delay is one-sided, so MIN converges. */
function calibrate(ctx: AudioContext, samples = 200): { contextTime: number; performanceTime: number } {
  let best = Infinity
  let pair = { contextTime: ctx.currentTime, performanceTime: performance.now() }
  for (let i = 0; i < samples; i++) {
    const c = ctx.currentTime
    const p = performance.now()
    const delta = p - c * 1000
    if (delta < best) {
      best = delta
      pair = { contextTime: c, performanceTime: p }
    }
  }
  return pair
}

export interface AudioLatencyReport {
  platform: {
    contextSampleRate: number
    baseLatencySec: number | null
    outputLatencySec: number | null
    trackLatencySec: number | null
    trackSettings: Record<string, unknown>
  }
  impulses: { index: number; scheduledWallMs: number; anchorWallMs: number; errorMs: number }[]
  /** Mean anchor error, ms. Positive = anchor dates audio LATE ⇒ audio exports late. */
  anchorErrorMeanMs: number | null
  anchorErrorSdMs: number | null
  startOffsetMs: number | null
  /** Sample 0 dated from the AUDIO clock instead of message arrival. */
  clockAnchorMs: number | null
  /** How much earlier the audio-clock anchor places sample 0, ms. */
  clockAnchorGainMs: number | null
  notes: string[]
}

export async function runAudioLatency(opts: { seconds?: number } = {}): Promise<AudioLatencyReport> {
  const seconds = opts.seconds ?? 6

  const ctxA = new AudioContext({ sampleRate: RATE })
  await ctxA.resume()
  const calib = calibrate(ctxA)
  const dest = ctxA.createMediaStreamDestination()

  // One impulse buffer, replayed at exact context times.
  const frames = Math.round((IMPULSE_MS / 1000) * RATE)
  const buf = new AudioBuffer({ length: frames, numberOfChannels: 1, sampleRate: RATE })
  const ch = buf.getChannelData(0)
  for (let i = 0; i < frames; i++) ch[i] = 0.9 * Math.sin((2 * Math.PI * 4000 * i) / RATE)

  const track = dest.stream.getAudioTracks()[0]!
  const settings = track.getSettings() as Record<string, unknown>

  // Capture FIRST, then schedule: arming (worklet compile, encoder config,
  // OPFS writer) takes long enough that impulses scheduled beforehand play
  // into a recorder that does not exist yet.
  // Own the capture context so its clock can be calibrated too — the
  // alternative anchor below reads the AUDIO clock instead of message arrival.
  const ctxB = await prewarmMeasuredAudio(track)
  const calibB = calibrate(ctxB)

  const key = `perf-o4b-${newId('a')}`
  const writer = await createPositionedWriter(key)
  const epoch = performance.now()
  const pcm: { left: Float32Array; startFrame: number; contextTime: number }[] = []
  const handle = await startMeasuredAudioCapture({
    stream: dest.stream,
    epoch,
    writer,
    audioCtx: ctxB,
    onPcm: (left, _right, startFrame, _off, _rate, contextTime) => {
      pcm.push({ left: left.slice(), startFrame, contextTime })
    },
  })
  await handle.firstOffset
  await new Promise((r) => setTimeout(r, 300))

  const t0 = ctxA.currentTime + 0.4
  const scheduled: number[] = []
  for (let k = 0; k * IMPULSE_INTERVAL_SEC < seconds; k++) {
    const at = t0 + k * IMPULSE_INTERVAL_SEC
    const src = new AudioBufferSourceNode(ctxA, { buffer: buf })
    src.connect(dest)
    src.start(at)
    scheduled.push(at)
  }
  await new Promise((r) => setTimeout(r, (seconds + 1) * 1000))
  const stopped = await handle.stop()
  await blobStore.remove(key).catch(() => undefined)

  // Envelope onsets with a refractory window — a 4 kHz burst crosses zero
  // dozens of times, so a per-sample threshold reports one impulse many times.
  const ENV = 128
  const REFRACTORY_FRAMES = 0.2 * RATE
  const onsets: number[] = []
  let prevEnv = 0
  let refractoryUntil = -Infinity
  for (const { left, startFrame } of pcm) {
    for (let i = 0; i < left.length; i += ENV) {
      const end = Math.min(left.length, i + ENV)
      let peak = 0
      for (let k = i; k < end; k++) {
        const a = Math.abs(left[k]!)
        if (a > peak) peak = a
      }
      const frame = startFrame + i
      if (peak > 0.3 && prevEnv <= 0.3 && frame >= refractoryUntil) {
        onsets.push(frame)
        refractoryUntil = frame + REFRACTORY_FRAMES
      }
      prevEnv = peak
    }
  }

  // Pair each detected onset with the NEAREST scheduled impulse rather than by
  // index: a missed onset at either end would otherwise shift every pairing.
  // Alternative anchor: the worklet reports the context time of each batch, so
  // sample 0 can be dated on the AUDIO clock instead of on main-thread message
  // arrival. Everything the audio thread does after rendering — postMessage,
  // task scheduling — drops out of the estimate.
  let clockAnchorMs: number | null = null
  if (pcm.length) {
    let best = Infinity
    for (const b of pcm) {
      const sample0Ctx = b.contextTime - (b.startFrame + b.left.length) / RATE
      const cand = contextTimeToPerformanceMs(sample0Ctx, calibB) - epoch
      if (cand < best) best = cand
    }
    clockAnchorMs = Math.round(best * 100) / 100
  }

  const impulses: AudioLatencyReport['impulses'] = []
  const wallOf = (ctxSec: number): number =>
    calib.performanceTime + (ctxSec - calib.contextTime) * 1000 - epoch
  for (const [k, frame] of onsets.entries()) {
    const anchorWallMs = stopped.startOffsetMs + (frame / RATE) * 1000
    let best: number | null = null
    for (const at of scheduled) {
      const d = anchorWallMs - wallOf(at)
      if (best === null || Math.abs(d) < Math.abs(best)) best = d
    }
    if (best === null || Math.abs(best) > 250) continue
    const nearest = scheduled.find((at) => Math.abs(anchorWallMs - wallOf(at) - best!) < 1e-6)!
    impulses.push({
      index: k,
      scheduledWallMs: Math.round(wallOf(nearest) * 100) / 100,
      anchorWallMs: Math.round(anchorWallMs * 100) / 100,
      errorMs: Math.round(best * 100) / 100,
    })
  }
  const errs = impulses.map((i) => i.errorMs)
  const mean = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null
  const sd =
    errs.length > 1 && mean !== null
      ? Math.sqrt(errs.reduce((a, b) => a + (b - mean) ** 2, 0) / (errs.length - 1))
      : null

  await ctxA.close().catch(() => undefined)

  return {
    platform: {
      contextSampleRate: ctxA.sampleRate,
      baseLatencySec: (ctxA as AudioContext & { baseLatency?: number }).baseLatency ?? null,
      outputLatencySec: (ctxA as AudioContext & { outputLatency?: number }).outputLatency ?? null,
      trackLatencySec: typeof settings.latency === 'number' ? settings.latency : null,
      trackSettings: settings,
    },
    impulses,
    anchorErrorMeanMs: mean === null ? null : Math.round(mean * 100) / 100,
    anchorErrorSdMs: sd === null ? null : Math.round(sd * 100) / 100,
    startOffsetMs: Math.round(stopped.startOffsetMs * 100) / 100,
    clockAnchorMs,
    clockAnchorGainMs:
      clockAnchorMs === null ? null : Math.round((stopped.startOffsetMs - clockAnchorMs) * 100) / 100,
    notes: [
      'positive error = the anchor dates audio LATER than it was rendered ⇒ audio exports late',
      'loopback path is MediaStreamDestination → MediaStream → capture context; a real mic substitutes device capture latency for the same term',
    ],
  }
}
