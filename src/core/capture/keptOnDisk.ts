/**
 * H5 — WHAT A FINISHED TAKE KEEPS, AND WHO GETS TO SAY.
 *
 * A channel's stop reply carries its byte count and its length, and waiting for
 * that reply is bounded (STOP_BUDGET_MS, 5 s). So a channel that missed the
 * budget reached the end of stop() looking exactly like one that had never
 * written anything — and the take deleted its file and reported it as never
 * delivered, under a warning that said "keeping what reached disk".
 *
 * SEEN, not theorised (H1's rig, 2026-09-02): one cell in four came back with
 * screen AND camera missing from a take whose own console had both armed at
 * +120 ms and delivering 1920x1080 frames throughout — the fourth back-to-back
 * Chrome, both raw channels logging ~184 dropped frames. Megabytes on the
 * platter, removed, and the report card told the user the device never
 * connected.
 *
 * The rule below is the fix in one sentence: the reply is the fast answer, the
 * DISK is the true one, and a channel is dropped only when the disk agrees it
 * is empty. That last case still drops — an empty file left behind is the
 * orphan reclaim.ts exists to prevent, and a zero-byte channel in a take is a
 * lie in the other direction.
 */

export interface DiskTruth {
  /** Bytes the stop REPLY claimed. Zero when the reply never came. */
  replyBytes: number
  /** Bytes actually on the platter under this channel's key. Zero means the
   *  file is not there at all — see `unreadable` for "there but unanswerable". */
  diskBytes: number
  /** Length demuxed from those bytes. Zero when the file holds no media. */
  probedMs: number
  /**
   * THE DISK REFUSED TO ANSWER — the size read threw, or the demux threw, or
   * the demux ran past its deadline. Different from a zero, and the difference
   * decides the channel: a file that reads as empty IS empty (a 28-byte `ftyp`
   * and nothing else is what a channel that never delivered a frame writes),
   * while one that cannot be read at all may be megabytes of real take behind a
   * lock or a truncated last fragment. The first is removed; the second is
   * never deleted on the strength of a question nothing answered.
   */
  unreadable?: boolean
  /** Length the channel already knew — a reply, or a pre-stop wall-clock stamp. */
  knownMs?: number
  /** How long the channel ran, by this page's clock. The last resort. */
  wallClockMs: number
}

export interface KeepVerdict {
  keep: boolean
  bytes: number
  durationMs: number
  /** Which witness answered — this is what the console line names. */
  source: 'reply' | 'demuxed' | 'wall clock' | 'empty'
}

export function keepChannel(t: DiskTruth): KeepVerdict {
  if (t.replyBytes > 0) {
    return {
      keep: true,
      bytes: t.replyBytes,
      durationMs: Math.max(0, t.knownMs ?? 0),
      source: 'reply',
    }
  }
  if (t.unreadable && t.probedMs <= 0) {
    // Bytes we cannot read are still bytes. Keep the channel at the best length
    // anyone knows, and above all do not remove the file.
    const fallback = t.knownMs && t.knownMs > 0 ? t.knownMs : t.wallClockMs
    return {
      keep: true,
      bytes: t.diskBytes,
      durationMs: Math.max(0, fallback),
      source: 'wall clock',
    }
  }
  if (t.diskBytes > 0) {
    // THE PROBE OUTRANKS THE CLOCK, and the difference is not cosmetic: a stop
    // that timed out may have left its last seconds unflushed, so the wall
    // clock would claim material the file does not have and slide every other
    // channel against this one. Demux first; fall back only when it REFUSED.
    if (t.probedMs > 0) {
      return { keep: true, bytes: t.diskBytes, durationMs: t.probedMs, source: 'demuxed' }
    }
  }
  // Nothing on disk, or a file the reader got through and found empty. Both are
  // "this channel recorded nothing", and the file goes with the verdict.
  return { keep: false, bytes: 0, durationMs: 0, source: 'empty' }
}
