/**
 * O10b — MIC AND SYSTEM AUDIO AS SEPARATE TRACKS IN THE FILE.
 *
 * Today every export flattens the measured audio channels into one stereo
 * track: mic and tab audio are summed, and whoever opens the file cannot pull
 * them apart again. Separate tracks keep them apart in the container, so a
 * player or an editor that understands multiple audio tracks can mute one,
 * level one, or take only one — and one that does not still plays the file.
 *
 * IT IS OPT-IN AND THE FLAT MIX STAYS THE DEFAULT, which is the whole safety
 * of it: the default export is byte-identical to what shipped before this
 * existed, pinned by a test, so nobody's file changes because this landed.
 *
 * AND THE SWITCH IS NOT A CONTAINER WORD. SIZE-CODEC's rule — "codec is never
 * a user word, the destination decides" — applies to tracks too: the row says
 * what he GETS (the sounds kept apart, a file some players show as one), never
 * `AudioSampleSource` or `trak`.
 *
 *   ?audiotracks=separate   this load only
 *   ?audiotracks=flat       today's mix, and the revert
 *   localStorage['inout.compose.audiotracks']   (sticky, the /?test row)
 *
 * A URL parameter wins, then the override, then storage, then the default.
 * Read on the MAIN thread and forwarded (pipeline.ts → export.worker.ts): the
 * render worker has no `localStorage` and a `location` of its own script URL,
 * which is the hole `?cq=` fell into once and constantQuality.ts's header
 * describes.
 */

import type { MixSource } from './audio'

export type AudioTrackMode = 'flat' | 'separate'

const STORAGE_KEY = 'inout.compose.audiotracks'

function parse(v: string | null): AudioTrackMode | null {
  if (v === 'separate' || v === 'multi' || v === '1' || v === 'true') return 'separate'
  if (v === 'flat' || v === 'mixed' || v === '0' || v === 'false' || v === 'off') return 'flat'
  return null
}

function fromSearch(): AudioTrackMode | null {
  if (typeof location === 'undefined') return null
  return parse(new URLSearchParams(location.search).get('audiotracks'))
}

function fromStorage(): AudioTrackMode | null {
  try {
    return parse(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

export function audioTrackMode(): AudioTrackMode {
  return fromSearch() ?? fromStorage() ?? 'flat'
}

/** The panel's writer. `null` clears the choice back to the shipped default. */
export function setAudioTrackMode(mode: AudioTrackMode | null): void {
  try {
    if (mode === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}

/** The worker has neither location nor storage: it is TOLD. */
let override: AudioTrackMode | null = null
export function setAudioTrackModeOverride(mode: AudioTrackMode | null): void {
  override = mode
}

export function audioTrackModeActive(): AudioTrackMode {
  return fromSearch() ?? override ?? fromStorage() ?? 'flat'
}

/** True when this export should write one audio track per channel. */
export function separateAudioTracks(): boolean {
  return audioTrackModeActive() === 'separate'
}

/**
 * THE MIXERS, GROUPED INTO THE TRACKS THEY BELONG TO.
 *
 * A mixer is one (channel x kept segment) — `openAudioMixers` makes several per
 * channel when the edit has cuts — so the grouping is by CHANNEL and the
 * segments of one channel all feed one track. Order is first appearance, which
 * is the order the recording lists its channels in, so the track order in the
 * file is stable across exports of the same take.
 *
 * The label is what a player shows in its track menu, so it is a word a person
 * uses. A channel whose kind we do not have a word for keeps its kind, which is
 * still better than an id.
 */
export interface AudioTrackGroup {
  channelId: string
  label: string
  mixers: MixSource[]
}

const LABELS: Record<string, string> = {
  mic: 'Microphone',
  'system-audio': 'System audio',
}

export function audioTrackGroups(
  mixers: MixSource[],
  recording: { channels: { id: string; kind: string }[] },
): AudioTrackGroup[] {
  const byId = new Map<string, AudioTrackGroup>()
  for (const m of mixers) {
    // '' means the source is not a single channel (a stretched span holding
    // several). Those cannot be split apart and stay on the first track, which
    // is stated rather than silent: see the caller's decline.
    const id = m.channelId
    if (!id) return []
    const found = byId.get(id)
    if (found) {
      found.mixers.push(m)
      continue
    }
    const kind = recording.channels.find((c) => c.id === id)?.kind ?? ''
    byId.set(id, { channelId: id, label: LABELS[kind] ?? kind ?? 'Audio', mixers: [m] })
  }
  return [...byId.values()]
}
