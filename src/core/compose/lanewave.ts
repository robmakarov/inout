/**
 * THE SOUND UNDER THE TIMELINE (task F8, second half).
 *
 * The filmstrip gave every VIDEO lane the take's own frames and left the audio
 * lanes as coloured rectangles — which is the half of a timeline that tells you
 * where somebody spoke. This draws them.
 *
 * IT SAMPLES, IT DOES NOT SCAN. Decoding a 30-minute mic track end to end to
 * draw 800 pixels is the same mistake the filmstrip avoided one level over:
 * mediabunny's `samplesAtTimestamps` seeks to each instant instead, so the cost
 * is set by how wide the lane is, not by how long the take is. Each column is
 * therefore an HONEST SAMPLE rather than a summary — it is the loudest thing in
 * a short window at that instant, and windows between columns are not read at
 * all. That is the right trade for an overview a user scrubs against, and it is
 * stated here because a waveform LOOKS like it summarises everything.
 *
 * The output is ONE stitched image, for the same reason the filmstrip is: the
 * timeline has to hold 60 fps with a long take loaded, and per-column DOM nodes
 * are how that gets lost.
 *
 * Nothing in the export imports this. compose/waveform.ts is a different thing
 * with a similar name and stays that way: that one PAINTS VIDEO for audio-only
 * takes and is part of the render.
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny'

export interface LaneWave {
  blob: Blob
  columns: number
  width: number
  height: number
  /** Columns that actually got audio — the rest are silence by default. */
  decoded: number
  /** Peak of the loudest column, 0..1. Zero means the take is silent. */
  peak: number
  /** What it cost. A budget that is not measured is not a budget (F8's gate). */
  wallMs: number
}

/** Column peaks, 0..1, sampled at `atSec`. Exported for testing the shape. */
export function columnTimes(durationSec: number, columns: number): number[] {
  const out: number[] = []
  for (let i = 0; i < columns; i++) {
    out.push(Math.min(durationSec - 1e-3, Math.max(0, ((i + 0.5) / columns) * durationSec)))
  }
  return out
}

/** Fraction of columns allowed to clip at full height. */
const REFERENCE_PERCENTILE = 0.95
/** Below this the lane is drawn flat — there is nothing to show a shape of. */
const SILENCE = 0.005

/**
 * WHAT THE LANE IS DRAWN AGAINST — the one decision in this file that can be
 * wrong without looking wrong, so it is pure and tested.
 *
 * NOT the maximum. The first version used it and a real take showed why within
 * a minute: a system-audio channel whose steady tone sits near 0.05 opened with
 * a 2.2 transient, so every other column was drawn at 2 % of the lane and the
 * whole channel looked empty. One click must not set the scale for everything
 * after it. The reference is a high percentile instead, and the few columns
 * above it are simply drawn full height.
 */
export function waveScale(peaks: ArrayLike<number>): { peak: number; reference: number; scale: number } {
  const n = peaks.length
  if (n === 0) return { peak: 0, reference: 0, scale: 0 }
  const sorted = Array.from(peaks).sort((a, b) => a - b)
  const peak = sorted[n - 1]!
  const reference = sorted[Math.min(n - 1, Math.floor(n * REFERENCE_PERCENTILE))]!
  return { peak, reference, scale: reference > SILENCE ? 1 / reference : 0 }
}

export async function buildLaneWave(
  blob: Blob,
  durationSec: number,
  width: number,
  height: number,
  opts: { signal?: AbortSignal; columns?: number } = {},
): Promise<LaneWave | null> {
  if (!(durationSec > 0) || width <= 0 || height <= 0) return null
  const t0 = performance.now()
  // One column per device pixel is wasted work — a lane is ~30 px tall and the
  // eye reads envelope, not detail. Two pixels per column keeps the shape and
  // halves the seeks.
  const columns = opts.columns ?? Math.max(8, Math.min(512, Math.round(width / 2)))
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return null
    if (opts.signal?.aborted) return null
    const sink = new AudioSampleSink(track)

    const peaks = new Float32Array(columns)
    let decoded = 0
    let i = 0
    for await (const sample of sink.samplesAtTimestamps(columnTimes(durationSec, columns))) {
      if (opts.signal?.aborted) return null
      if (sample) {
        try {
          const frames = sample.numberOfFrames
          const data = new Float32Array(frames)
          sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' })
          let peak = 0
          // A decoded packet is ~20 ms of audio; every frame of it is cheap to
          // scan and skipping frames would alias a transient away.
          for (let k = 0; k < frames; k++) {
            const a = Math.abs(data[k]!)
            if (a > peak) peak = a
          }
          peaks[i] = peak
          decoded++
        } catch {
          /* one unreadable packet is a gap in the picture, not a failure */
        } finally {
          sample.close()
        }
      }
      i++
      if (i >= columns) break
    }
    if (decoded === 0) return null

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return null
    ctx.clearRect(0, 0, width, height)
    /**
     * NORMALISED TO THE TAKE'S OWN LEVEL, and that is a decision worth naming:
     * a quiet recording drawn against full scale is a flat line, which reads as
     * "nothing here" when the truth is "recorded quietly". The lane says WHERE
     * sound is, not how loud it was against 0 dBFS — the certification tag and
     * the loudness pipeline own that question. What it is normalised AGAINST is
     * waveScale's business.
     */
    const { peak, scale } = waveScale(peaks)
    const mid = height / 2
    const colW = width / columns
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    for (let c = 0; c < columns; c++) {
      const h = Math.max(1, Math.min(1, peaks[c]! * scale) * (height - 2))
      ctx.fillRect(c * colW, mid - h / 2, Math.max(1, colW - 0.5), h)
    }
    return {
      blob: await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 }),
      columns,
      width,
      height,
      decoded,
      peak,
      wallMs: Math.round(performance.now() - t0),
    }
  } catch (err) {
    console.warn('[timeline] lane waveform unavailable', err)
    return null
  } finally {
    input.dispose()
  }
}
