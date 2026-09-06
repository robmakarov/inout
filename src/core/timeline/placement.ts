/**
 * WHERE A CHANNEL IS ALLOWED TO SIT ON ITS OWN TAKE'S TIMELINE.
 *
 * A take's channels are armed at one epoch and started together; a mid-take
 * segment (H1) opens because a component died WHILE the take was running, so
 * something else was still recording when it did. It follows that no channel of
 * a real take can begin after every other channel has already finished. A
 * `startOffsetMs` past that line is not a late device. It is a clock.
 *
 * IT HAS HAPPENED, AND THIS IS THE TAKE (rec_cff9nmm7trmh, 2026-09-06):
 *
 *     screen/video        off=0          dur=2768642   (46.1 min)
 *     system-audio/audio  off=30445691   dur=2768680   (46.1 min)
 *     durationMs = 33214371 = 553.6 minutes
 *
 * Robert recorded 47 minutes of screen and tab audio and the editor opened
 * 9 hours 13 minutes: his picture, 8 h 27 min of nothing, then his sound. The
 * cause is fixed at its source in core/realmClock.ts and refused at its source
 * in capture/measuredAudio.ts. This is the third line, and it is here for two
 * reasons the first two cannot cover: the takes already written this way are
 * still in the store, and the next lane to grow a clock seam will not know it.
 *
 * WHAT THE REPAIR IS ALLOWED TO DO: move an impossible channel back to the
 * take's start, which is where its own provisional anchor — this thread's
 * `performance.now()` at the channel's first sample — would have put it. It
 * never touches a file, never trims and never reorders anything believable.
 * Placement that only LOOKS surprising (a channel that joined late, a segment
 * that opened at minute 40) is inside the rule and is left exactly alone.
 */
import type { Recording } from '@core/types'

export interface PlacementRepair {
  channelId: string
  kind: string
  wasMs: number
  nowMs: number
}

/**
 * Returns the repairs a recording needs, newest arithmetic included, or an
 * empty array when its channels are all believable. Pure: it reads the row and
 * decides, and `applyPlacementRepair` is what rewrites one.
 */
export function findPlacementRepairs(rec: Recording): PlacementRepair[] {
  const channels = rec.channels ?? []
  // With one channel there is no second witness, and a lone channel's offset is
  // rebased to 0 by the session anyway. Nothing to judge.
  if (channels.length < 2) return []
  const impossible = channels.filter((c) => {
    const start = c.startOffsetMs ?? 0
    if (!(start > 0)) return false
    let latestOtherEnd = 0
    for (const o of channels) {
      if (o === c) continue
      latestOtherEnd = Math.max(latestOtherEnd, (o.startOffsetMs ?? 0) + (o.durationMs ?? 0))
    }
    return start > latestOtherEnd
  })
  if (impossible.length === 0) return []
  // The take's start, as the channels that are still believed report it — NOT
  // zero. A row that has not been rebased would otherwise gain a lead nothing
  // recorded, and a rebased one (every row the session writes) reads 0 here
  // anyway. All-impossible cannot happen (a channel is only impossible against
  // another channel's end), so the fallback is arithmetic, not a case.
  const earliestMs = channels
    .filter((c) => !impossible.includes(c))
    .reduce((m, c) => Math.min(m, c.startOffsetMs ?? 0), Infinity)
  const nowMs = Number.isFinite(earliestMs) ? Math.max(0, earliestMs) : 0
  return impossible.map((c) => ({
    channelId: c.id,
    kind: c.kind,
    wasMs: Math.round(c.startOffsetMs ?? 0),
    nowMs,
  }))
}

/**
 * A repaired copy, or the SAME OBJECT when nothing was wrong — callers lean on
 * the identity to know whether they have anything to persist.
 */
export function repairPlacement(rec: Recording): Recording {
  const repairs = findPlacementRepairs(rec)
  if (repairs.length === 0) return rec
  const byId = new Map(repairs.map((r) => [r.channelId, r]))
  const channels = rec.channels.map((c) =>
    byId.has(c.id) ? { ...c, startOffsetMs: byId.get(c.id)!.nowMs } : c,
  )
  // Rebase, exactly as the session does at build: the earliest channel is t=0.
  const minOffset = channels.reduce((m, c) => Math.min(m, c.startOffsetMs), Infinity)
  const shifted =
    minOffset > 0 ? channels.map((c) => ({ ...c, startOffsetMs: c.startOffsetMs - minOffset })) : channels
  return {
    ...rec,
    channels: shifted,
    durationMs: shifted.reduce((m, c) => Math.max(m, c.startOffsetMs + c.durationMs), 0),
  }
}

/** The one line a repaired take says, wherever it is repaired. */
export function placementRepairLine(
  id: string,
  beforeMs: number,
  afterMs: number,
  repairs: PlacementRepair[],
): string {
  const min = (ms: number): string => `${(ms / 60000).toFixed(1)} min`
  const what = repairs
    .map((r) => `${r.kind} began ${min(r.wasMs)} after every other channel had ended`)
    .join('; ')
  return (
    `[timeline] ${id} carried an impossible channel placement — ${what}. ` +
    `Moved to the take's start: ${min(beforeMs)} becomes ${min(afterMs)}. A clock under that ` +
    `channel was wrong when it was recorded — see core/realmClock.ts.`
  )
}
