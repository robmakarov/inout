/**
 * EXPERIMENTAL — Oracle audio-integrity metric (Task 3b gate).
 *
 * For an exported pure beep: no spectral content outside the beep frequency
 * above -40 dB, and zero sample discontinuities > 0.1 between adjacent samples
 * at 1 s mix-chunk boundaries.
 */

import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny'
import { AUDIO_SAMPLE_RATE } from '@core/compose/codecs'
import { BEEP_INTERVAL_MS } from './rig'

export const MAX_BOUNDARY_JUMP = 0.1
export const MAX_SPURIOUS_DB = -40
/** Chunk size used by production compose (pipeline writeAudioChunk). */
export const MIX_CHUNK_FRAMES = AUDIO_SAMPLE_RATE

export interface AudioIntegrityReport {
  sampleRate: number
  frames: number
  /** |Δ| at each mix-chunk boundary (frame N·sr − 1 → N·sr). */
  boundaryJumps: number[]
  maxBoundaryJump: number
  boundaryPass: boolean
  /** Peak magnitude outside ±toneBandwidthHz of toneHz, dBFS relative to peak. */
  spurPeakDb: number | null
  spectrumPass: boolean | null
  pass: boolean
}

function goertzelPower(samples: Float32Array, sampleRate: number, freqHz: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate
  const coeff = 2 * Math.cos(w)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/**
 * Coarse spectrum check: compare tone bin power vs a set of probe frequencies
 * away from the tone and its low harmonics. Good enough to catch broadband
 * clicks/buzz without a full FFT dependency.
 */
function spurPeakDbRelative(
  samples: Float32Array,
  sampleRate: number,
  toneHz: number,
): number {
  const toneP = Math.max(1e-20, goertzelPower(samples, sampleRate, toneHz))
  const probes = [
    toneHz * 0.5,
    toneHz * 1.5,
    toneHz * 2.5,
    120,
    1000,
    2000,
    4000,
    8000,
  ].filter((f) => f > 40 && f < sampleRate / 2 - 40 && Math.abs(f - toneHz) > 80)
  let worst = -Infinity
  for (const f of probes) {
    const p = goertzelPower(samples, sampleRate, f)
    const db = 10 * Math.log10(p / toneP)
    if (db > worst) worst = db
  }
  return worst
}

export function boundaryJumpsOf(
  samples: Float32Array,
  chunkFrames: number = MIX_CHUNK_FRAMES,
): number[] {
  const jumps: number[] = []
  for (let b = chunkFrames; b < samples.length; b += chunkFrames) {
    jumps.push(Math.abs(samples[b]! - samples[b - 1]!))
  }
  return jumps
}

export async function analyzeAudioIntegrity(
  blob: Blob,
  opts?: { toneHz?: number },
): Promise<AudioIntegrityReport> {
  const toneHz = opts?.toneHz ?? 880
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) {
      return {
        sampleRate: 0,
        frames: 0,
        boundaryJumps: [],
        maxBoundaryJump: 0,
        boundaryPass: false,
        spurPeakDb: null,
        spectrumPass: null,
        pass: false,
      }
    }
    const sink = new AudioBufferSink(track)
    const chunks: Float32Array[] = []
    let sampleRate = AUDIO_SAMPLE_RATE
    for await (const { buffer } of sink.buffers()) {
      sampleRate = buffer.sampleRate
      chunks.push(buffer.getChannelData(0).slice())
    }
    let frames = 0
    for (const c of chunks) frames += c.length
    const samples = new Float32Array(frames)
    let o = 0
    for (const c of chunks) {
      samples.set(c, o)
      o += c.length
    }

    const jumps = boundaryJumpsOf(samples, Math.round(sampleRate))
    const maxBoundaryJump = jumps.length ? Math.max(...jumps) : 0
    const boundaryPass = maxBoundaryJump <= MAX_BOUNDARY_JUMP

    // Spectrum over a window that should contain a beep (skip leading silence).
    const windowSec = Math.min(2.5, samples.length / sampleRate)
    const start = Math.min(
      Math.floor(0.8 * sampleRate),
      Math.max(0, samples.length - Math.floor(windowSec * sampleRate)),
    )
    const end = Math.min(samples.length, start + Math.floor(windowSec * sampleRate))
    const window = samples.subarray(start, end)
    const spurPeakDb = window.length > sampleRate / 4 ? spurPeakDbRelative(window, sampleRate, toneHz) : null
    const spectrumPass = spurPeakDb === null ? null : spurPeakDb <= MAX_SPURIOUS_DB

    return {
      sampleRate,
      frames,
      boundaryJumps: jumps,
      maxBoundaryJump,
      boundaryPass,
      spurPeakDb,
      spectrumPass,
      pass: boundaryPass && spectrumPass !== false,
    }
  } finally {
    input.dispose()
  }
}

/** Interval used by the beep grid — documented so integrity stays aligned with the rig. */
export const INTEGRITY_BEEP_INTERVAL_MS = BEEP_INTERVAL_MS
