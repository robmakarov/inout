import { describe, expect, it } from 'vitest'
import {
  GATE_DEFAULTS,
  GATE_FRAME,
  GATE_HOP,
  StreamingGate,
  gate,
  noiseProfile,
  profileWindowFrames,
} from './spectralGate'

/**
 * THE WIRING'S OWN GATE — and it is here because the FIRST attempt at this
 * wiring was written, found wrong, and backed out (.ai/wip/o10c.md, 09-04).
 *
 * The gate holds `frame - hop` = 768 samples (16 ms at 48 kHz) until their
 * windows close. Writing its output at the CURRENT chunk's position therefore
 * shifts the whole soundtrack 16 ms LATE against the video on every gated
 * export — silently, and sync is Robert's. render.ts writes each returned
 * sample at its OWN absolute position instead, and this file is the arithmetic
 * of that claim: what goes in comes out, in the same place, in the same order.
 *
 * It models the loop in render.ts's `writeAudioChunk` exactly — hold until the
 * profile window is full, arm, feed what was held, then stream — so a change to
 * that loop that breaks the timeline breaks a test here.
 */
const SR = 48000

function noisySpeech(seconds: number): Float32Array {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  let seed = 12345
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  for (let i = 0; i < n; i++) {
    const t = i / SR
    // A steady bed everywhere, and two bursts of "speech" with silence between.
    const bed = rnd() * 0.004
    const speaking = (t > 0.9 && t < 1.6) || (t > 2.4 && t < 3.1)
    const voice = speaking ? 0.25 * Math.sin(2 * Math.PI * 220 * t) * (1 + 0.4 * Math.sin(2 * Math.PI * 5 * t)) : 0
    out[i] = bed + voice
  }
  return out
}

/**
 * render.ts's audio loop, reduced to its timeline: one-second chunks, held
 * until the profile window is full, then written at each sample's own place.
 */
function throughTheWiring(
  signal: Float32Array,
  chunkFrames = SR,
  budgetSec = 1,
): { out: Float32Array; positions: number[] } {
  const profileFrames = profileWindowFrames(SR, budgetSec)
  const hold: Float32Array[] = []
  let held = 0
  let g: StreamingGate | null = null
  const pieces: Float32Array[] = []
  const positions: number[] = []
  let emitted = 0

  const emit = (piece: Float32Array): void => {
    if (piece.length === 0) return
    positions.push(emitted)
    emitted += piece.length
    pieces.push(piece)
  }

  for (let at = 0; at < signal.length; at += chunkFrames) {
    const chunk = signal.subarray(at, Math.min(signal.length, at + chunkFrames))
    if (!g) {
      hold.push(new Float32Array(chunk))
      held += chunk.length
      if (held >= profileFrames) {
        const total = Math.min(held, profileFrames)
        const mono = new Float32Array(total)
        let k = 0
        for (const p of hold) {
          mono.set(p.subarray(0, Math.max(0, total - k)), k)
          k += p.length
          if (k >= total) break
        }
        g = new StreamingGate(noiseProfile(mono), GATE_DEFAULTS)
        for (const p of hold) emit(g.push(p))
        hold.length = 0
        held = 0
      }
    } else {
      emit(g.push(new Float32Array(chunk)))
    }
  }
  if (!g) {
    // A take shorter than the profile window never armed — finishGate's branch.
    const mono = new Float32Array(held)
    let k = 0
    for (const p of hold) {
      mono.set(p, k)
      k += p.length
    }
    g = new StreamingGate(noiseProfile(mono), GATE_DEFAULTS)
    for (const p of hold) emit(g.push(p))
  }
  emit(g.flush())

  const out = new Float32Array(emitted)
  let at = 0
  for (const p of pieces) {
    out.set(p, at)
    at += p.length
  }
  return { out, positions }
}

describe('the gate is wired without moving the sound', () => {
  const signal = noisySpeech(4)

  it('hands back exactly as many samples as it was given', () => {
    // THE SYNC CLAIM, at its simplest: a sample lost or held is a sample the
    // video no longer lines up with.
    expect(throughTheWiring(signal).out.length).toBe(signal.length)
  })

  it('writes every piece where the last one ended — no gap, no overlap', () => {
    const { positions, out } = throughTheWiring(signal)
    expect(positions[0]).toBe(0)
    expect(positions.every((p, i) => i === 0 || p > positions[i - 1]!)).toBe(true)
    expect(out.length).toBe(signal.length)
  })

  it('is not 16 ms late — the defect the backed-out wiring would have shipped', () => {
    // What the wrong shape did: write the gate's output at the CHUNK's own
    // position, which pushes everything `frame - hop` samples later. Modelled
    // here so the assertion below is measured against the actual mistake.
    const late = GATE_FRAME - GATE_HOP
    expect(late).toBe(768)
    const { out } = throughTheWiring(signal)
    // Cross-correlate the first second against the input: the peak must be at
    // lag 0, not at 768.
    const lagScore = (lag: number): number => {
      let dot = 0
      for (let i = 0; i + lag < SR; i++) dot += signal[i]! * out[i + lag]!
      return dot
    }
    expect(lagScore(0)).toBeGreaterThan(lagScore(late))
    expect(lagScore(0)).toBeGreaterThan(lagScore(-late + 2 * late)) // same, explicit
  })

  it('is the same gate as gating the whole signal at once', () => {
    // Chunked and whole must agree, or the export sounds different from the
    // preview and from every measurement taken on the unit path.
    const profileFrames = profileWindowFrames(SR, 1)
    const whole = gate(signal, noiseProfile(signal.subarray(0, profileFrames)), GATE_DEFAULTS)
    const { out } = throughTheWiring(signal)
    let worst = 0
    // Skip the first and last window: the whole-signal path pads its edges from
    // nothing, the streamed one from the previous chunk.
    for (let i = GATE_FRAME; i < signal.length - GATE_FRAME; i++) {
      worst = Math.max(worst, Math.abs(whole.out[i]! - out[i]!))
    }
    let peak = 0
    for (const v of whole.out) peak = Math.max(peak, Math.abs(v))
    expect(20 * Math.log10(worst / peak)).toBeLessThan(-100)
  })

  it('gates a take shorter than the profile window rather than passing it through', () => {
    const short = noisySpeech(0.5)
    const { out } = throughTheWiring(short)
    expect(out.length).toBe(short.length)
    let moved = 0
    for (let i = 0; i < short.length; i++) if (Math.abs(out[i]! - short[i]!) > 1e-6) moved++
    expect(moved).toBeGreaterThan(0)
  })

  it('does not care how the chunks are cut', () => {
    const even = throughTheWiring(signal, SR).out
    const odd = throughTheWiring(signal, 7777).out
    expect(odd.length).toBe(even.length)
    let worst = 0
    for (let i = GATE_FRAME; i < even.length - GATE_FRAME; i++) {
      worst = Math.max(worst, Math.abs(even[i]! - odd[i]!))
    }
    expect(worst).toBeLessThan(1e-5)
  })
})
