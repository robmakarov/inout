import { roundedRectPath, type FrameCanvas } from './layout'

const BAR_COUNT = 96
const WINDOW_SEC = 1.5
export const PEAK_BUCKETS_PER_SEC = 60

export function createPeakBuffer(durationSec: number): Float32Array {
  return new Float32Array(Math.ceil(durationSec * PEAK_BUCKETS_PER_SEC) + 1)
}

/** Folds mixed (already clamped to [-1,1]) chunk samples into per-bucket peaks. */
export function collectPeaks(
  peaks: Float32Array,
  left: Float32Array,
  right: Float32Array,
  startFrame: number,
  sampleRate: number,
): void {
  const framesPerBucket = sampleRate / PEAK_BUCKETS_PER_SEC
  for (let k = 0; k < left.length; k++) {
    const b = Math.floor((startFrame + k) / framesPerBucket)
    if (b >= peaks.length) break
    const v = Math.max(Math.abs(left[k]), Math.abs(right[k]))
    if (v > peaks[b]) peaks[b] = v
  }
}

/**
 * Audio-only mode: static dark diagonal gradient with a centered horizontal
 * waveform — 96 rounded bars over a sliding ~1.5s window around t; the
 * center bar (the playhead) gets a subtle blue glow.
 */
export function createWaveformRenderer(
  f: FrameCanvas,
  peaks: Float32Array,
): (tSec: number) => void {
  const { ctx, width, height, scale } = f
  const gradient = ctx.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, '#0a0a0c')
  gradient.addColorStop(1, '#1a1a24')
  const span = width * 0.7
  const slot = span / BAR_COUNT
  const barW = slot * 0.55
  const originX = (width - span) / 2 + (slot - barW) / 2
  const centerY = height / 2
  const minH = 3 * scale
  const maxH = height * 0.36
  const centerIndex = BAR_COUNT / 2

  return (tSec: number): void => {
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
    for (let i = 0; i < BAR_COUNT; i++) {
      const barTime = tSec + ((i + 0.5) / BAR_COUNT - 0.5) * WINDOW_SEC
      const bucket = Math.floor(barTime * PEAK_BUCKETS_PER_SEC)
      const amp = bucket >= 0 && bucket < peaks.length ? Math.min(1, peaks[bucket]) : 0
      const h = minH + Math.pow(amp, 0.75) * (maxH - minH)
      const glow = i === centerIndex && amp > 0.01
      if (glow) {
        ctx.shadowColor = '#0a84ff'
        ctx.shadowBlur = 14 * scale
      }
      ctx.fillStyle = '#f5f5f7'
      roundedRectPath(ctx, originX + i * slot, centerY - h / 2, barW, h, barW / 2)
      ctx.fill()
      if (glow) {
        ctx.shadowBlur = 0
        ctx.shadowColor = 'transparent'
      }
    }
  }
}
