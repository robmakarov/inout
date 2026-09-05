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
/**
 * The FLOOR on the distance between thumbnail centres, CSS px.
 *
 * UI1 halved it — Robert, 2026-08-30: "videos frames in timeline stripe
 * smaller, smaller step so more frames". A 76 px pitch on a 900 px lane is
 * twelve frames for a whole take, which is a decoration rather than a way of
 * finding a moment.
 *
 * IT IS A FLOOR AND NOT THE PITCH, because a pitch smaller than a thumbnail is
 * not a denser strip — it is a squashed one. The strip is drawn as ONE image
 * `count * thumbWidthPx` wide and then stretched to the lane with
 * `background-size: 100% 100%`, so asking for more thumbnails than fit
 * side-by-side compresses every frame horizontally by exactly the overrun.
 * `thumbPitchPx` below is what actually spaces them.
 */
export const THUMB_PITCH_PX = 38

/**
 * The real distance between thumbnail centres: the frames tile edge to edge,
 * never overlapping and never squashed. With the lane at 24 px this is 43 px,
 * against the 76 px it was — so a 900 px lane carries 21 frames where it
 * carried 12, which is the density Robert asked for, bought by making the
 * frames smaller rather than by cheating the arithmetic.
 */
export function thumbPitchPx(thumbHeightPx: number): number {
  return Math.max(THUMB_PITCH_PX, Math.max(1, Math.round(thumbHeightPx * THUMB_ASPECT)))
}
/**
 * The DECODE budget, and it had to move with the pitch or the pitch would do
 * nothing on any lane wider than 24 thumbnails. Each thumbnail is a seek to a
 * keyframe and a decode (65 ms mean on this codebase's own random-access
 * reader, F8's rig), so 48 is ~3 s of background work for a picture nobody is
 * waiting on — it lands after the editor is already usable, and a failure at
 * any point simply leaves the lane as it was.
 */
export const MAX_THUMBS = 48
/**
 * How tall a lane carrying a filmstrip is. A video lane grows from 24 px to
 * this; audio lanes do not move. Kept next to the pitch because the two
 * together are the strip's shape, and .lane--film in app.css must agree.
 *
 * SMALLER SINCE UI1, with the pitch: the frames are the thing being made
 * denser, and a 30 px tall thumbnail at a 38 px pitch is nearly square, which
 * is not what a strip of 16:9 frames should look like.
 */
export const FILM_LANE_HEIGHT_PX = 24

export interface FilmstripPlan {
  /** How many thumbnails the strip holds. */
  count: number
  /** Each thumbnail's width in CSS px — the strip is count × this wide. */
  thumbWidthPx: number
  /** Channel-local seconds to decode, ascending. */
  atSec: number[]
}

/**
 * @param trackWidthPx  the strip's width on screen — the pixels it has to fill,
 *                      which is what decides how many frames go in it.
 * @param spanSec       the stretch of the channel being drawn. The whole
 *                      channel unless `fromSec` says otherwise.
 * @param fromSec       where that stretch starts inside the channel.
 *
 * THE PITCH IS THE RULE AND THE SPAN IS FREE, which is what lets the timeline
 * zoom: the same 38 px between frames buys twelve frames of an hour or twelve
 * frames of two seconds, and the second one is a strip you can cut against.
 * The count is still bounded by MAX_THUMBS, and a shorter span makes the
 * budget go further rather than costing more — the seeks land near each other.
 */
export function planFilmstrip(
  trackWidthPx: number,
  spanSec: number,
  thumbHeightPx: number,
  fromSec = 0,
): FilmstripPlan | null {
  const thumbWidthPx = Math.max(1, Math.round(thumbHeightPx * THUMB_ASPECT))
  if (!(trackWidthPx > 0) || !(spanSec > 0) || !Number.isFinite(spanSec)) return null
  if (trackWidthPx < thumbWidthPx) return null
  const wanted = Math.round(trackWidthPx / thumbPitchPx(thumbHeightPx))
  const count = Math.max(1, Math.min(MAX_THUMBS, wanted))
  const atSec: number[] = []
  const last = fromSec + spanSec - 1e-3
  for (let i = 0; i < count; i++) {
    // The CENTRE of each cell, so the first thumbnail is not the capture's
    // first frame (often a blank surface) and the last is not the stop itself.
    const t = fromSec + ((i + 0.5) / count) * spanSec
    atSec.push(Math.min(last, Math.max(0, t)))
  }
  return { count, thumbWidthPx, atSec }
}
