/**
 * EXPERIMENTAL — analyze an arbitrary exported MP4/audio file (no fiducial tones).
 *
 * Reports click/splice events with timestamps, spectral spur peaks, coarse THD
 * on the dominant partial, and L/R separation. Used by `oracle:fidelity --file=`.
 */

import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny'
import { boundaryJumpsOf } from './audioIntegrity'
import { goertzelPower } from './audioFidelity'

export const CLICK_DELTA_THRESHOLD = 0.12
export const SPLICE_JUMP_THRESHOLD = 0.1
export const MAX_SPUR_DB = -40

export interface AudioDefectEvent {
  kind: 'click' | 'splice'
  /** Seconds on the decoded audio timeline. */
  tSec: number
  /** Peak |Δ| sample (clicks) or boundary jump (splices). */
  magnitude: number
}

export interface SpurPeak {
  freqHz: number
  levelDb: number
}

export interface FileFidelityReport {
  sampleRate: number
  durationSec: number
  frames: number
  channels: number
  /** Large sample-to-sample steps (clicks, pops). */
  clickEvents: AudioDefectEvent[]
  /** Discontinuities at ~1s decode/mix chunk seams. */
  spliceEvents: AudioDefectEvent[]
  clickCount: number
  spliceCount: number
  /** Worst spur vs the dominant partial (dB). */
  spurPeakDb: number | null
  spurPeaks: SpurPeak[]
  /** THD estimate on the loudest coarse bin (dB, more negative = cleaner). */
  thdDb: number | null
  dominantFreqHz: number | null
  /** L/R isolation: min band-wise 10·log10(E_own/E_other) when stereo. */
  separationDb: number | null
  /** Stereo correlation coefficient (1 = mono). */
  correlation: number | null
  pass: boolean
  note: string
}

async function decodeStereo(blob: Blob): Promise<{
  left: Float32Array
  right: Float32Array
  sampleRate: number
  channels: number
} | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return null
    const sink = new AudioBufferSink(track)
    const leftChunks: Float32Array[] = []
    const rightChunks: Float32Array[] = []
    let sampleRate = 48_000
    let channels = 1
    for await (const { buffer } of sink.buffers()) {
      sampleRate = buffer.sampleRate
      channels = buffer.numberOfChannels
      leftChunks.push(buffer.getChannelData(0).slice())
      rightChunks.push(
        buffer.numberOfChannels > 1
          ? buffer.getChannelData(1).slice()
          : buffer.getChannelData(0).slice(),
      )
    }
    let frames = 0
    for (const c of leftChunks) frames += c.length
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    let o = 0
    for (let i = 0; i < leftChunks.length; i++) {
      left.set(leftChunks[i]!, o)
      right.set(rightChunks[i]!, o)
      o += leftChunks[i]!.length
    }
    return { left, right, sampleRate, channels }
  } finally {
    input.dispose()
  }
}

function detectClicks(mono: Float32Array, sampleRate: number): AudioDefectEvent[] {
  const out: AudioDefectEvent[] = []
  let last = -1
  for (let i = 1; i < mono.length; i++) {
    const d = Math.abs(mono[i]! - mono[i - 1]!)
    if (d >= CLICK_DELTA_THRESHOLD) {
      const tSec = i / sampleRate
      if (last < 0 || tSec - last > 0.05) {
        out.push({ kind: 'click', tSec, magnitude: d })
        last = tSec
      }
    }
  }
  return out
}

function detectSplices(samples: Float32Array, sampleRate: number): AudioDefectEvent[] {
  const chunk = sampleRate
  const jumps = boundaryJumpsOf(samples, chunk)
  const out: AudioDefectEvent[] = []
  for (let b = 0; b < jumps.length; b++) {
    const mag = jumps[b]!
    if (mag >= SPLICE_JUMP_THRESHOLD) {
      out.push({ kind: 'splice', tSec: ((b + 1) * chunk) / sampleRate, magnitude: mag })
    }
  }
  return out
}

function dominantFreq(samples: Float32Array, sampleRate: number): number | null {
  let bestF = 0
  let bestP = 0
  for (let f = 80; f <= Math.min(4000, sampleRate / 2 - 40); f += 40) {
    const p = goertzelPower(samples, sampleRate, f)
    if (p > bestP) {
      bestP = p
      bestF = f
    }
  }
  return bestP > 0 ? bestF : null
}

function spurScan(
  samples: Float32Array,
  sampleRate: number,
  refHz: number | null,
): { spurPeakDb: number | null; spurPeaks: SpurPeak[] } {
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) sumSq += samples[i]! * samples[i]!
  const rms = Math.sqrt(sumSq / Math.max(1, samples.length))
  const refP = Math.max(1e-30, rms * rms)
  const spurPeaks: SpurPeak[] = []
  let worst = -Infinity
  for (let f = 60; f < sampleRate / 2 - 40; f += 25) {
    if (refHz !== null && Math.abs(f - refHz) < 60) continue
    const p = goertzelPower(samples, sampleRate, f)
    const db = 10 * Math.log10(Math.max(1e-30, p) / refP)
    if (db > -20) spurPeaks.push({ freqHz: f, levelDb: db })
    if (db > worst) worst = db
  }
  spurPeaks.sort((a, b) => b.levelDb - a.levelDb)
  return { spurPeakDb: worst === -Infinity ? null : worst, spurPeaks: spurPeaks.slice(0, 8) }
}

function estimateThd(samples: Float32Array, sampleRate: number, fundHz: number): number | null {
  const p1 = goertzelPower(samples, sampleRate, fundHz)
  if (p1 <= 0) return null
  let harm = 0
  for (const h of [2, 3, 4, 5, 6]) {
    const f = fundHz * h
    if (f < sampleRate / 2 - 40) harm += goertzelPower(samples, sampleRate, f)
  }
  return 10 * Math.log10(Math.max(1e-30, harm) / p1)
}

function stereoSeparationDb(left: Float32Array, right: Float32Array, sampleRate: number): {
  separationDb: number
  correlation: number
} {
  const probes = [220, 440, 880, 1760, 3520].filter((f) => f < sampleRate / 2 - 40)
  let minSep = Infinity
  for (const f of probes) {
    const pL = Math.max(1e-30, goertzelPower(left, sampleRate, f))
    const pR = Math.max(1e-30, goertzelPower(right, sampleRate, f))
    const sep = 10 * Math.log10(Math.max(pL, pR) / Math.min(pL, pR))
    minSep = Math.min(minSep, sep)
  }
  let ll = 0
  let rr = 0
  let lr = 0
  const n = Math.min(left.length, right.length)
  const step = Math.max(1, Math.floor(n / 48_000))
  for (let i = 0; i < n; i += step) {
    ll += left[i]! * left[i]!
    rr += right[i]! * right[i]!
    lr += left[i]! * right[i]!
  }
  const corr = lr / Math.max(1e-30, Math.sqrt(ll * rr))
  return {
    separationDb: Number.isFinite(minSep) ? minSep : 0,
    correlation: corr,
  }
}

/** Inject defects for unit red-gate proof (synthetic buffers). */
export function injectFileDefects(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  opts: { spliceAtSec?: number; spurHz?: number; spurAmp?: number },
): void {
  if (opts.spliceAtSec != null) {
    const i = Math.min(left.length - 1, Math.floor(opts.spliceAtSec * sampleRate))
    left[i] = (left[i] ?? 0) + 0.85
    right[i] = (right[i] ?? 0) + 0.85
  }
  if (opts.spurHz != null && opts.spurAmp != null) {
    for (let i = 0; i < left.length; i++) {
      const s = opts.spurAmp * Math.sin((2 * Math.PI * opts.spurHz * i) / sampleRate)
      left[i] = (left[i] ?? 0) + s
      right[i] = (right[i] ?? 0) + s
    }
  }
}

export function analyzeDecodedAudio(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  channels: number,
): FileFidelityReport {
  const frames = Math.min(left.length, right.length)
  const L = left.subarray(0, frames)
  const R = right.subarray(0, frames)
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) mono[i] = 0.5 * (L[i]! + R[i]!)

  const clickEvents = detectClicks(mono, sampleRate)
  const spliceEvents = detectSplices(mono, sampleRate)

  const dom = dominantFreq(mono, sampleRate)
  const spur = dom ? spurScan(mono, sampleRate, dom) : { spurPeakDb: null, spurPeaks: [] }
  const thdDb = dom ? estimateThd(mono, sampleRate, dom) : null

  let separationDb: number | null = null
  let correlation: number | null = null
  if (channels > 1) {
    const sep = stereoSeparationDb(L, R, sampleRate)
    separationDb = sep.separationDb
    correlation = sep.correlation
  }

  const spurFail = spur.spurPeakDb !== null && spur.spurPeakDb > MAX_SPUR_DB
  const defectFail = clickEvents.length > 0 || spliceEvents.length > 0
  const pass = !spurFail && !defectFail

  return {
    sampleRate,
    durationSec: frames / sampleRate,
    frames,
    channels,
    clickEvents,
    spliceEvents,
    clickCount: clickEvents.length,
    spliceCount: spliceEvents.length,
    spurPeakDb: spur.spurPeakDb,
    spurPeaks: spur.spurPeaks,
    thdDb,
    dominantFreqHz: dom,
    separationDb,
    correlation,
    pass,
    note: pass
      ? 'no injected-class defects above thresholds'
      : `defects: clicks=${clickEvents.length} splices=${spliceEvents.length} spur=${spur.spurPeakDb?.toFixed(1) ?? 'n/a'}dB`,
  }
}

export async function analyzeAudioFile(blob: Blob): Promise<FileFidelityReport> {
  const decoded = await decodeStereo(blob)
  if (!decoded) {
    return {
      sampleRate: 0,
      durationSec: 0,
      frames: 0,
      channels: 0,
      clickEvents: [],
      spliceEvents: [],
      clickCount: 0,
      spliceCount: 0,
      spurPeakDb: null,
      spurPeaks: [],
      thdDb: null,
      dominantFreqHz: null,
      separationDb: null,
      correlation: null,
      pass: false,
      note: 'decode failed',
    }
  }
  return analyzeDecodedAudio(
    decoded.left,
    decoded.right,
    decoded.sampleRate,
    decoded.channels,
  )
}
