/**
 * WHERE THE FILMSTRIP'S THUMBNAILS GO (task F8).
 *
 * The strip is one stitched image painted as the lane's background, not N DOM
 * nodes: a 30-minute take must not put a thousand elements in a timeline that
 * has to hold 60 fps while the playhead moves. So the layout is decided here,
 * once, and the picture is drawn to match it — which makes the arithmetic worth
 * testing on its own.
 *
 * The rule is a PITCH in CSS pixels, not a count: thumbnails are the same size
 * whatever the take's length, so a 10-second take gets a handful and a
 * 30-minute take gets the same handful, each standing for more time. A count
 * that scaled with length would decode for a minute and paint 1-pixel slivers.
 *
 * Two things bound it from below and above:
 *   · a strip narrower than one thumbnail is not a strip — under that, none;
 *   · MAX_THUMBS is a DECODE budget. Each thumbnail is a seek to a keyframe and
 *     a decode (65 ms mean on this codebase's own random-access reader, F8's
 *     rig), so 24 of them is ~1.5 s of work for a picture nobody is waiting on.
 */
export const THUMB_ASPECT = 16 / 9
/** Target distance between thumbnail centres, CSS px. */
export const THUMB_PITCH_PX = 76
export const MAX_THUMBS = 24
/**
 * How tall a lane carrying a filmstrip is. A video lane grows from 24 px to
 * this; audio lanes do not move. Kept next to the pitch because the two
 * together are the strip's shape, and .lane--film in app.css must agree.
 */
export const FILM_LANE_HEIGHT_PX = 30

export interface FilmstripPlan {
  /** How many thumbnails the strip holds. */
  count: number
  /** Each thumbnail's width in CSS px — the strip is count × this wide. */
  thumbWidthPx: number
  /** Channel-local seconds to decode, ascending. */
  atSec: number[]
}

/**
 * @param trackWidthPx  the lane bar's width on screen — the strip covers the
 *                      channel's own window, not the whole timeline.
 * @param durationSec   the channel's own length.
 */
export function planFilmstrip(
  trackWidthPx: number,
  durationSec: number,
  thumbHeightPx: number,
): FilmstripPlan | null {
  const thumbWidthPx = Math.max(1, Math.round(thumbHeightPx * THUMB_ASPECT))
  if (!(trackWidthPx > 0) || !(durationSec > 0) || !Number.isFinite(durationSec)) return null
  if (trackWidthPx < thumbWidthPx) return null
  const wanted = Math.round(trackWidthPx / THUMB_PITCH_PX)
  const count = Math.max(1, Math.min(MAX_THUMBS, wanted))
  const atSec: number[] = []
  for (let i = 0; i < count; i++) {
    // The CENTRE of each cell, so the first thumbnail is not the capture's
    // first frame (often a blank surface) and the last is not the stop itself.
    const t = ((i + 0.5) / count) * durationSec
    atSec.push(Math.min(durationSec - 1e-3, Math.max(0, t)))
  }
  return { count, thumbWidthPx, atSec }
}
