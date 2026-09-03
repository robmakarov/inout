/**
 * A MEDIA FILE THAT SAYS WHAT IT IS (task H7, idea 2).
 *
 * THE HOLE IT CLOSES. A take's channels are only findable through the pending
 * manifest — one localStorage key plus H2b's IndexedDB copy. Both are written
 * at record start, and if BOTH are lost the files are still on disk, complete,
 * and unrecoverable: nothing on them says which take they belong to or which
 * of them is the screen. H2 measured the manifest genuinely going missing (a
 * `kill -9` at 2.8 s left it in a buffer inside the killed process), which is
 * why the durable copy exists at all. This is the third copy, and it is the one
 * that cannot be lost separately from the data, because it IS the data's name.
 *
 * WHY THE NAME AND NOT A TAG INSIDE THE FILE. The task says "its own metadata"
 * and the honest reading of that, for a file whose whole problem is that it was
 * interrupted, is the name. A crash-truncated MP4 may have no readable moov at
 * all — the tag would be exactly as gone as the manifest. The name survives
 * every truncation, costs nothing to write, and is free to read: OPFS gives it
 * up in a directory listing with no decode.
 *
 * THE SHAPE, chosen so a parse cannot guess wrong:
 *
 *     <recordingId>_<kind>_ch_<12 chars>.<ext>
 *
 * Read RIGHT to left — `ch_` and its fixed alphabet end it, one of the four
 * kinds precedes it, and everything before that is the take id however many
 * underscores or dashes it contains. A key that does not match this exactly is
 * NOT ADOPTED: files from before H7 (`<recordingId>_ch_xxx.mp4`), composites,
 * scratch, chunks and anything a future feature writes all fail the match and
 * are left alone, which is the gate that matters most — a salvage that adopts
 * a stranger's file is worse than one that finds nothing.
 */
import type { ChannelKind } from '../types'

const KINDS: ChannelKind[] = ['screen', 'camera', 'mic', 'system-audio']

/** The channel id `newId('ch')` makes: `ch_` plus 12 of [a-z0-9]. */
const CHANNEL_ID = String.raw`ch_[a-z0-9]{12}`

const SELF_MANIFEST = new RegExp(
  `^(?<take>.+)_(?<kind>${KINDS.join('|')})_(?<channel>${CHANNEL_ID})\\.(?<ext>[a-z0-9]+)$`,
)

export interface SelfManifest {
  recordingId: string
  kind: ChannelKind
  channelId: string
  ext: string
}

/** The blob key for a channel — the only place this name is built. */
export function selfManifestKey(
  recordingId: string,
  kind: ChannelKind,
  channelId: string,
  ext: string,
): string {
  return `${recordingId}_${kind}_${channelId}.${ext}`
}

/** What a key says about itself, or null when it does not say it in this form. */
export function readSelfManifest(key: string): SelfManifest | null {
  const m = SELF_MANIFEST.exec(key)
  if (!m?.groups) return null
  return {
    recordingId: m.groups.take!,
    kind: m.groups.kind as ChannelKind,
    channelId: m.groups.channel!,
    ext: m.groups.ext!,
  }
}

/**
 * Group every self-describing key by take, newest-looking first is NOT decided
 * here — the caller ranks them, because only it knows which takes the repo has
 * already saved.
 */
export function groupByRecording(keys: string[]): Map<string, SelfManifest[]> {
  const takes = new Map<string, SelfManifest[]>()
  for (const key of keys) {
    const self = readSelfManifest(key)
    if (!self) continue
    const list = takes.get(self.recordingId)
    if (list) list.push(self)
    else takes.set(self.recordingId, [self])
  }
  return takes
}
