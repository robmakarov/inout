import type { ChannelKind, ChannelRecording } from '@core/types'
import { CHANNEL_KINDS } from '@app/lib/channels'

/**
 * ONE LANE PER INPUT, NOT ONE PER FILE.
 *
 * Robert, 2026-09-05, on a 90-minute take: "several times i turned off camera
 * and mic and turn back again - they shown in separate lanes in timeline, which
 * is not correct behaviour, same input must be in same lane, with blank spaces
 * if turned off in between".
 *
 * A chip toggled off and on mid-take is a real stop and a new segment, so the
 * take carries a SECOND `ChannelRecording` of the same kind — and H1's
 * containment opens more of them (up to 4 per channel) without anybody
 * pressing anything. The timeline drew one row per FILE, so four chosen inputs
 * with three toggles between them opened seven rows. Measured on prod
 * 2026-09-05 before this existed: Camera, Screen, Mic, Tab Audio, Camera, Mic,
 * Camera — in that order, because the rows followed the order the files were
 * opened in rather than the order of the inputs.
 *
 * The lane is the KIND. Its files each keep their own bar at their own instant
 * on the same row, and the stretch where the input was off is simply not drawn:
 * the blank IS the fact that it was off, which is what he asked for.
 *
 * ORDER IS THE CHIPS' ORDER (screen, camera, mic, tab audio) and not the order
 * the engine happened to arm them in — the second half of the same report was
 * "screen lane not shown at all", and a row's position must not depend on which
 * device answered first. A kind this table does not know (there is none today)
 * sorts last rather than disappearing.
 */
export interface TimelineLane {
  kind: ChannelKind
  /** Every file of this kind, earliest first. One per uninterrupted stretch. */
  channels: ChannelRecording[]
}

export function timelineLanes(channels: readonly ChannelRecording[]): TimelineLane[] {
  const rank = (k: ChannelKind): number => {
    const i = CHANNEL_KINDS.indexOf(k)
    return i < 0 ? CHANNEL_KINDS.length : i
  }
  const byKind = new Map<ChannelKind, ChannelRecording[]>()
  for (const c of channels) {
    const list = byKind.get(c.kind)
    if (list) list.push(c)
    else byKind.set(c.kind, [c])
  }
  return [...byKind.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([kind, list]) => ({
      kind,
      channels: [...list].sort((a, b) => a.startOffsetMs - b.startOffsetMs),
    }))
}
