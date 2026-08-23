/**
 * EXPERIMENTAL — Pipeline Oracle: fiducial codec + estimation math (pure).
 *
 * The oracle turns synthetic capture into a measuring instrument:
 *  - VIDEO fiducial: every painted frame carries a machine-readable barcode
 *    strip encoding the rig-clock time (ms) at paint. Big high-contrast
 *    blocks survive 8 Mbps encoding; two reference blocks provide adaptive
 *    thresholding; a parity bit rejects corrupt reads.
 *  - AUDIO fiducial: short tone bursts at exact rig-clock intervals; onsets
 *    are detected from the decoded export and compared against the
 *    video-derived clock mapping to measure A/V sync.
 *
 * Everything in this file is pure math on numbers/arrays — unit-tested in
 * node. Browser I/O (painting, recording, demuxing) lives in rig.ts/analyze.ts.
 */

// -- barcode geometry --------------------------------------------------------

export const FID_BITS = 24 // ms values up to ~4.6h
export const FID_BLOCK = 32 // px per block, at rig canvas scale
export const FID_MARGIN = 16 // px from top-left
/** Strip: [white ref][black ref][b23..b0][parity] */
export const FID_BLOCK_COUNT = 2 + FID_BITS + 1

export interface BlockReader {
  /** Mean luma 0..255 of block i's center region. */
  luma(blockIndex: number): number
}

export function parity(value: number): number {
  let v = value >>> 0
  let p = 0
  while (v) {
    p ^= v & 1
    v >>>= 1
  }
  return p
}

/** Bit values for a given timestamp, MSB first, followed by parity. */
export function encodeBits(ms: number): number[] {
  const v = Math.max(0, Math.min(2 ** FID_BITS - 1, Math.round(ms)))
  const bits: number[] = []
  for (let i = FID_BITS - 1; i >= 0; i--) bits.push((v >> i) & 1)
  bits.push(parity(v))
  return bits
}

/**
 * Decode a timestamp from block lumas. Returns null when the read is
 * unreliable (poor reference contrast or parity failure).
 */
export function decodeBits(reader: BlockReader): number | null {
  const white = reader.luma(0)
  const black = reader.luma(1)
  if (white - black < 64) return null // strip not found / too degraded
  const threshold = (white + black) / 2
  let v = 0
  for (let i = 0; i < FID_BITS; i++) {
    const bit = reader.luma(2 + i) > threshold ? 1 : 0
    v = (v << 1) | bit
  }
  const parityBit = reader.luma(2 + FID_BITS) > threshold ? 1 : 0
  if (parityBit !== parity(v)) return null
  return v
}

// -- clock mapping estimation --------------------------------------------------

export interface FrameReading {
  /** Output presentation time, seconds. */
  outSec: number
  /** Decoded rig time, ms (null = unreadable frame). */
  rigMs: number | null
}

export interface ClockFit {
  /** rigMs = alphaMs + beta * outMs */
  alphaMs: number
  beta: number
  /** RMS residual of used (inlier) frames, ms. */
  rmsMs: number
  maxAbsMs: number
  usedPoints: number
  /** Readable frames excluded as outliers (misdecodes, stalls), TD item 3. */
  rejectedPoints: number
}

interface XY {
  x: number
  y: number
}

function leastSquares(pts: XY[]): { alphaMs: number; beta: number } | null {
  const n = pts.length
  if (n < 2) return null
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (const p of pts) {
    sx += p.x
    sy += p.y
    sxx += p.x * p.x
    sxy += p.x * p.y
  }
  const denom = n * sxx - sx * sx
  if (Math.abs(denom) < 1e-9) return null
  const beta = (n * sxy - sx * sy) / denom
  return { alphaMs: (sy - beta * sx) / n, beta }
}

/** Floor below which residual spread is treated as frame quantization, ms. */
const OUTLIER_FLOOR_MS = 12

/**
 * Robust fit of rig time as a linear function of output time.
 * Two passes: ordinary least squares, then refit excluding points whose
 * residual exceeds max(3sigma-equivalent MAD, 12 ms floor). Rejects
 * barcode misdecodes / render stalls without letting them drag alpha
 * (TD verdict item 3: outlier rejection in fitClock).
 */
export function fitClock(readings: FrameReading[]): ClockFit | null {
  const pts: XY[] = readings
    .filter((r): r is FrameReading & { rigMs: number } => r.rigMs !== null)
    .map((r) => ({ x: r.outSec * 1000, y: r.rigMs }))
  const first = leastSquares(pts)
  if (!first) return null

  const residuals = pts.map((p) => p.y - (first.alphaMs + first.beta * p.x))
  const absSorted = residuals.map(Math.abs).sort((a, b) => a - b)
  const medAbs = absSorted[Math.floor(absSorted.length / 2)]
  // 1.4826*MAD estimates sigma for normal noise; 3x that is the cut.
  const cutoff = Math.max(3 * 1.4826 * medAbs, OUTLIER_FLOOR_MS)
  const inliers = pts.filter((_, i) => Math.abs(residuals[i]) <= cutoff)

  const final = inliers.length >= 2 && inliers.length < pts.length ? leastSquares(inliers) : first
  const used = inliers.length >= 2 && final !== first ? inliers : pts
  if (!final) return null

  let ss = 0
  let maxAbs = 0
  for (const p of used) {
    const resid = p.y - (final.alphaMs + final.beta * p.x)
    ss += resid * resid
    maxAbs = Math.max(maxAbs, Math.abs(resid))
  }
  return {
    alphaMs: final.alphaMs,
    beta: final.beta,
    rmsMs: Math.sqrt(ss / used.length),
    maxAbsMs: maxAbs,
    usedPoints: used.length,
    rejectedPoints: pts.length - used.length,
  }
}

export interface FrameFlowStats {
  frames: number
  readable: number
  /** Consecutive readable frames showing the same rig time (encoder dup / source stall). */
  duplicates: number
  /** Rig-time jumps > 1.5x the median delta (dropped source frames). */
  gaps: number
  medianDeltaMs: number
}

export function frameFlowStats(readings: FrameReading[]): FrameFlowStats {
  const rig = readings.map((r) => r.rigMs)
  const deltas: number[] = []
  let duplicates = 0
  let prev: number | null = null
  for (const v of rig) {
    if (v === null) continue
    if (prev !== null) {
      const d = v - prev
      if (d === 0) duplicates++
      else deltas.push(d)
    }
    prev = v
  }
  const sorted = [...deltas].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  const gaps = median > 0 ? deltas.filter((d) => d > 1.5 * median).length : 0
  return {
    frames: readings.length,
    readable: readings.filter((r) => r.rigMs !== null).length,
    duplicates,
    gaps,
    medianDeltaMs: median,
  }
}

// -- audio onset detection -----------------------------------------------------

export interface OnsetDetectorState {
  /** Envelope from the previous chunk's tail. */
  prevEnv: number
  /** Time until which new onsets are suppressed, sec. */
  refractoryUntilSec: number
  onsetsSec: number[]
  /**
   * Same onsets dated at the CENTRE of the envelope window instead of its
   * start. The true onset lies uniformly inside the window, so the start is
   * biased early by half a window (~1.33 ms at 48 kHz) — small next to the
   * video-side quantisation, but it is a bias, and O4's ≤10 ms gate has no
   * room for free ones. Reported alongside, never in place of, onsetsSec.
   */
  onsetsCenteredSec: number[]
}

export function newOnsetDetector(): OnsetDetectorState {
  return { prevEnv: 0, refractoryUntilSec: -Infinity, onsetsSec: [], onsetsCenteredSec: [] }
}

const ONSET_THRESHOLD = 0.1
const REFRACTORY_SEC = 0.2
const ENV_WINDOW = 128 // samples per envelope point

/**
 * Feed one decoded mono chunk; detects rising envelope edges (tone burst
 * starts). Sample-accurate to ~ENV_WINDOW samples (~2.7ms @48k).
 */
export function feedOnsetDetector(
  st: OnsetDetectorState,
  samples: Float32Array,
  chunkStartSec: number,
  sampleRate: number,
): void {
  for (let i = 0; i < samples.length; i += ENV_WINDOW) {
    const end = Math.min(samples.length, i + ENV_WINDOW)
    let peak = 0
    for (let k = i; k < end; k++) {
      const a = Math.abs(samples[k])
      if (a > peak) peak = a
    }
    const tSec = chunkStartSec + i / sampleRate
    if (peak > ONSET_THRESHOLD && st.prevEnv <= ONSET_THRESHOLD && tSec >= st.refractoryUntilSec) {
      st.onsetsSec.push(tSec)
      st.onsetsCenteredSec.push(tSec + (end - i) / 2 / sampleRate)
      st.refractoryUntilSec = tSec + REFRACTORY_SEC
    }
    st.prevEnv = peak
  }
}

export interface SyncStats {
  onsets: number
  matched: number
  /**
   * SIGN CONVENTION (TD item 3, fixed and documented):
   *   offset = audio onset position on the output timeline
   *            minus the video-clock-predicted position of that beep.
   *   POSITIVE  => AUDIO LATE relative to video (equivalently: video content
   *                placed too early on the timeline).
   *   NEGATIVE  => AUDIO EARLY relative to video (video placed too late).
   * The TD's measured +171 ms therefore reads: audio lags video by ~171 ms.
   */
  meanOffsetMs: number
  maxAbsOffsetMs: number
  /** Human-readable restatement of meanOffsetMs per the convention above. */
  leads: 'audio-late/video-early' | 'audio-early/video-late' | 'in-sync'
}

/**
 * A/V sync: the clock fit maps output→rig; invert it to predict where each
 * detected onset SHOULD sit on the output timeline, then measure the
 * deviation to the nearest beep. See SyncStats for the sign convention.
 *
 * GRID CORRECTION (falsification finding, hypothesis d): beeps are scheduled
 * on the AudioContext clock, which stalls 100–300 ms at startup — they do NOT
 * sound at nominal k·intervalMs. When the rig supplies the MEASURED beep
 * times (`beepGridRigMs`, from continuously sampled clock pairs), matching
 * runs against that true grid; the nominal grid is only a fallback and
 * overstates the offset by the per-session stall.
 */
export function syncStats(
  onsetsSec: number[],
  fit: ClockFit,
  intervalMs: number,
  beepGridRigMs?: number[],
): SyncStats {
  const grid = beepGridRigMs && beepGridRigMs.length > 0 ? beepGridRigMs : null
  let sum = 0
  let maxAbs = 0
  let matched = 0
  for (const t of onsetsSec) {
    const rigMs = fit.alphaMs + fit.beta * t * 1000
    let beepRigMs: number
    if (grid) {
      let best = grid[0]
      for (const g of grid) if (Math.abs(g - rigMs) < Math.abs(best - rigMs)) best = g
      if (Math.abs(best - rigMs) > intervalMs / 2) continue
      beepRigMs = best
    } else {
      beepRigMs = Math.round(rigMs / intervalMs) * intervalMs
      if (beepRigMs < 0) continue
    }
    const predictedOutMs = (beepRigMs - fit.alphaMs) / fit.beta
    const offset = t * 1000 - predictedOutMs
    sum += offset
    maxAbs = Math.max(maxAbs, Math.abs(offset))
    matched++
  }
  const meanOffsetMs = matched ? sum / matched : NaN
  return {
    onsets: onsetsSec.length,
    matched,
    meanOffsetMs,
    maxAbsOffsetMs: maxAbs,
    leads:
      !matched || Math.abs(meanOffsetMs) <= 5
        ? 'in-sync'
        : meanOffsetMs > 0
          ? 'audio-late/video-early'
          : 'audio-early/video-late',
  }
}
