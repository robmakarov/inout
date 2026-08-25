/**
 * THE PICTURE UNDER THE TIMELINE (task F8).
 *
 * F8 was written on "scrub decodes the EXACT frame instead of <video> seek
 * granularity", and that premise was REFUTED on 2026-08-25: at five off-grid
 * instants a <video> seek and this codebase's own random-access reader land on
 * the same frame, 0 ms apart, and the element is the faster path
 * (`npm run exp -- f8`). What survived the refutation is the rest of the task,
 * and this is the first half of it: a lane that shows what is IN the take
 * instead of a coloured rectangle standing for it.
 *
 * IT DOES NOT TOUCH ANY EXPORT PATH. Nothing under compose/ imports this and it
 * imports no export code beyond the demuxer; instant, smart cut and the full
 * render are byte-for-byte unaffected (conflict rule: "anything touching
 * compose/* has to say which of the three it changed" — this one changes none).
 *
 * TWO DECISIONS ARE THE WHOLE DESIGN:
 *
 * 1. RANDOM ACCESS, NOT A FORWARD WALK. compose/video.ts's reader decodes every
 *    frame between the instants it is asked for, which is right for a render
 *    (it wants them all) and catastrophic here: 24 thumbnails from a 30-minute
 *    take would decode 54,000 frames. mediabunny's `samplesAtTimestamps` seeks
 *    to the keyframe before each instant instead, so the cost is 24 seeks and
 *    24 short decodes — F8's rig measured that path at 65 ms per frame.
 *
 * 2. ONE STITCHED IMAGE, NOT N ELEMENTS. The strip is drawn into a single
 *    canvas and handed over as one blob, so the timeline paints one background
 *    however long the take is. F8's remaining gate is 60 fps with a 30-minute
 *    take loaded, and a thousand <img> nodes is the way to fail it.
 *
 * The whole thing is best-effort by construction: a thumbnail that will not
 * decode leaves its cell empty and the strip still lands, because a filmstrip
 * is decoration over an editor that already works without it.
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from 'mediabunny'

export interface Filmstrip {
  /** N thumbnails side by side, each thumbWidth × thumbHeight device px. */
  blob: Blob
  count: number
  thumbWidth: number
  thumbHeight: number
  /** How many cells actually got a frame — the rest are empty. */
  decoded: number
  /** What it cost. This is a budget, and budgets get measured (F8's gate). */
  wallMs: number
}

export async function buildFilmstrip(
  blob: Blob,
  atSec: number[],
  thumbWidth: number,
  thumbHeight: number,
  opts: { signal?: AbortSignal } = {},
): Promise<Filmstrip | null> {
  if (atSec.length === 0 || thumbWidth <= 0 || thumbHeight <= 0) return null
  const t0 = performance.now()
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) return null
    if (opts.signal?.aborted) return null
    const sink = new VideoSampleSink(track)

    const canvas = new OffscreenCanvas(thumbWidth * atSec.length, thumbHeight)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return null
    ctx.fillStyle = '#101014'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    let decoded = 0
    let cell = 0
    // Ascending timestamps: mediabunny can then keep one decoder walking
    // forward across neighbouring instants instead of re-seeking each time.
    for await (const sample of sink.samplesAtTimestamps(atSec)) {
      if (opts.signal?.aborted) return null
      if (sample) {
        try {
          // 'cover' inside the cell: a letterboxed thumbnail wastes the few
          // pixels a 32 px lane has, and the strip reads as a rhythm of
          // pictures rather than a row of framed stamps.
          ctx.save()
          ctx.beginPath()
          ctx.rect(cell * thumbWidth, 0, thumbWidth, thumbHeight)
          ctx.clip()
          drawCover(ctx, sample, cell * thumbWidth, thumbWidth, thumbHeight)
          ctx.restore()
          decoded++
        } finally {
          sample.close()
        }
      }
      cell++
      if (cell >= atSec.length) break
    }
    if (decoded === 0) return null
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 })
    return {
      blob: out,
      count: atSec.length,
      thumbWidth,
      thumbHeight,
      decoded,
      wallMs: Math.round(performance.now() - t0),
    }
  } catch (err) {
    console.warn('[timeline] filmstrip unavailable', err)
    return null
  } finally {
    input.dispose()
  }
}

/** `drawWithFit` centres on the WHOLE canvas, and a cell is not the canvas. */
function drawCover(
  ctx: OffscreenCanvasRenderingContext2D,
  sample: VideoSample,
  dx: number,
  w: number,
  h: number,
): void {
  const sw = sample.displayWidth
  const sh = sample.displayHeight
  if (!(sw > 0) || !(sh > 0)) return
  const scale = Math.max(w / sw, h / sh)
  const dw = sw * scale
  const dh = sh * scale
  sample.draw(ctx, dx + (w - dw) / 2, (h - dh) / 2, dw, dh)
}
