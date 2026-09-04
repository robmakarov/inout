/**
 * Which export path a take takes — one decision, shared (task O5-flip).
 *
 * There are three ways to make the file and they are tried in order of how
 * little work they do:
 *
 *   instant   unedited + composite + default geometry → copy every packet
 *   smartcut  a TIME-ONLY edit + composite + default geometry → copy the
 *             packets inside each kept span, re-encode only [cut → keyframe]
 *   render    everything else, and the fallback for both of the above
 *
 * THIS FILE EXISTS BECAUSE THE LADDER USED TO LIVE IN EditorScreen, WHERE NO
 * GATE COULD REACH IT. The oracle exported by calling exportRecording directly,
 * so the sync band measured the render and only the render — a file the product
 * hands to a user only when the fast paths refuse. Smart cut could not be
 * turned on for exactly that reason: nothing in CI would have noticed if it
 * shipped a broken one. Now the oracle drives the same function the editor
 * drives, so "which path ran" is a measured fact in the report rather than an
 * assumption, and a fast path that silently stops engaging fails the run.
 *
 * Every fall-back is quiet by design (an export must never fail because a
 * shortcut was unavailable) but never SILENT: the chosen path is returned, and
 * the callers that gate on it say so.
 */
import type {
  EditState,
  ExportOptions,
  ExportProgress,
  ExportResult,
  ExportSettings,
  Recording,
} from '@core/types'
import { isDefaultEdit } from '@core/timeline'
import { chooseCopySource, type CopyOrigin } from './copySource'
import { exportInstant } from './instant'
import { exportRecording } from './pipeline'
import { prerenderKey, takePrerender } from './prerender'
import { exportSmartCut, isPixelDefaultEdit } from './smartCut'
import { smartCutEnabled } from './smartCutFlag'
import { fullColourActive } from './fullColour'
import { separateAudioTracks } from './audioTracks'

export type ExportPath = 'instant' | 'smartcut' | 'render'

export interface ChosenExport {
  result: ExportResult
  path: ExportPath
  /** Why a faster path was not taken, in order of attempt. Evidence, not UI. */
  declined: { path: ExportPath; reason: string }[]
  /**
   * WHICH FILE THE COPY CAME FROM when a copying path ran (task O3b) — the
   * composite, or a single raw channel that already held the default
   * composition. Null on the render. Reported because two files of the same
   * take differ visibly on coloured text depending on it, so no rig or oracle
   * should have to infer it.
   */
  copiedFrom: CopyOrigin | null
  /** Why single generation was not available, when it was not. Evidence. */
  copyDeclined: { origin: CopyOrigin; reason: string }[]
}

export interface ChooseExportOptions {
  recording: Recording
  edit: EditState
  settings?: ExportSettings
  /**
   * True only when the requested output geometry IS the composite's — i.e. the
   * default quality tier. The caller owns this because it owns the tier
   * ladder (compose/quality.ts), and the render is unaffected either way.
   *
   * O3c: this fences the COMPOSITE only. A single RAW channel that already
   * holds the requested geometry exactly (a native-res 1440p screen at the
   * 1440p step) is packet-copyable at ANY tier — chooseCopySource answers
   * that against `settings`, so a non-default tier no longer forces a full
   * re-render of pixels a file on disk already holds.
   */
  allowPacketCopy: boolean
  onProgress?: (p: ExportProgress) => void
  signal?: AbortSignal
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

/** Rethrow immediately for a user abort — that is not a path being unavailable. */
function throwIfAbort(err: unknown): void {
  if (err instanceof Error && err.name === 'AbortError') throw err
}


/**
 * WOULD THIS EXPORT HAVE TO RENDER? — the question F16's pre-render asks before
 * it spends the machine on anything.
 *
 * Read-only, and deliberately CONSERVATIVE: it says yes only when neither
 * copying path can possibly apply, so a take whose export is already instant
 * (or a smart cut) is never pre-rendered. Spending a machine to save nothing is
 * the one way this feature could make the product worse, and under-triggering
 * costs only the pre-render — the export itself behaves exactly as it always
 * did either way.
 */
export function exportWouldRender(opts: {
  recording: Recording
  edit: EditState
  settings?: ExportSettings
  allowPacketCopy: boolean
}): boolean {
  const { recording, edit, settings, allowPacketCopy } = opts
  const copy = chooseCopySource(recording, settings, { allowComposite: allowPacketCopy })
  if (!copy.source) return true
  // A copy source exists, so an unedited take is instant and a time-only edit
  // is a smart cut. Anything that changes PIXELS cannot be copied through.
  if (isDefaultEdit(recording, edit)) return false
  return !isPixelDefaultEdit(recording, edit)
}

export async function exportByBestPath(opts: ChooseExportOptions): Promise<ChosenExport> {
  const { recording, edit, settings, allowPacketCopy, onProgress, signal } = opts
  const declined: { path: ExportPath; reason: string }[] = []

  // O3b: RESOLVED ONCE, HERE. Both copying paths take the source they are
  // given, so the origin this function reports and the file they actually
  // copied cannot drift apart — and the reasons single generation was refused
  // travel with the answer instead of being re-derived from a console line.
  // O3c: consulted on EVERY tier — the composite is fenced by allowPacketCopy,
  // a matching raw channel is not.
  const copy = chooseCopySource(recording, settings, { allowComposite: allowPacketCopy })
  /**
   * O9(b). A COPY CANNOT CHANGE THE COLOUR OF WHAT IT COPIES. The instant path
   * hands back the recorded packets and smart cut re-encodes only the cut
   * boundaries, so a take exported through either is 4:2:0 whatever the switch
   * says — and a switch that silently does nothing is the defect this project
   * has already paid for twice (`?cq=`, `?sourceframe=`). When full colour is
   * asked for, the copying paths DECLINE BY NAME and the render runs.
   *
   * Nothing moves for anyone who did not ask: the flag is off by default, so
   * `source` is exactly what it was and both fast paths are untouched.
   */
  const fullColour = fullColourActive()
  /**
   * O10b — THE COPYING PATHS CANNOT SPLIT A MIX EITHER, and for the same kind
   * of reason as the colour above: an instant copy hands over the audio track
   * the take already has, so a take with two audio channels would come back as
   * one mixed track while the switch said separate. It only bites when there is
   * something to separate — a take with one audio channel is already "each
   * channel on its own track", so nothing declines and the fast path stays.
   */
  const wantSeparate =
    separateAudioTracks() &&
    recording.channels.filter((c) => c.media === 'audio').length > 1
  const source = fullColour || wantSeparate ? null : copy.source
  if (fullColour && copy.source) {
    const why = 'every colour asked for: a packet copy cannot change 4:2:0 into 4:4:4'
    declined.push({ path: 'instant', reason: why })
    declined.push({ path: 'smartcut', reason: why })
  }
  if (wantSeparate && copy.source && !fullColour) {
    const why = 'the sounds kept apart: a packet copy hands over the mix the take already has'
    declined.push({ path: 'instant', reason: why })
    declined.push({ path: 'smartcut', reason: why })
  }

  if (source) {
    if (isDefaultEdit(recording, edit)) {
      try {
        const result = await exportInstant({ recording, edit, source, onProgress, signal })
        return {
          result,
          path: 'instant',
          declined,
          copiedFrom: source.origin,
          copyDeclined: copy.declined,
        }
      } catch (err) {
        throwIfAbort(err)
        // Fast path unusable (codec/track/incomplete tail) — never fail an
        // export over it.
        declined.push({ path: 'instant', reason: reasonOf(err) })
        console.warn('[compose] instant export unavailable, trying the next path', err)
      }
    } else {
      declined.push({ path: 'instant', reason: 'edit is not the default edit' })
    }

    if (smartCutEnabled()) {
      try {
        const result = await exportSmartCut({ recording, edit, source, onProgress, signal })
        return {
          result,
          path: 'smartcut',
          declined,
          copiedFrom: source.origin,
          copyDeclined: copy.declined,
        }
      } catch (err) {
        throwIfAbort(err)
        declined.push({ path: 'smartcut', reason: reasonOf(err) })
        console.info('[compose] smart cut unavailable, rendering', err)
      }
    } else {
      declined.push({ path: 'smartcut', reason: 'disabled by flag' })
    }
  } else if (!fullColour) {
    // Full colour has already said why, by name, above — saying "nothing to
    // copy" on top of it would report a second, wrong reason for one decision.
    const why = allowPacketCopy
      ? copy.declined.map((d) => `${d.origin}: ${d.reason}`).join('; ') || 'nothing to copy'
      : 'not the default output geometry'
    declined.push({ path: 'instant', reason: why })
    declined.push({ path: 'smartcut', reason: why })
  }

  // F16: THE RENDER MAY ALREADY BE DONE. A job started at stop, for this exact
  // (recording, edit, settings), is either finished or in flight — and taking
  // an IN-FLIGHT one is as important as taking a finished one, because it means
  // pressing export early costs the remainder rather than starting the same
  // work twice. Never slower than before: a miss falls straight through.
  /**
   * O9(b) USED TO SKIP THE PRE-RENDER ENTIRELY when full colour was asked for,
   * because `prerenderKey` carried no render flag and would have served a 4:2:0
   * file for a 4:4:4 export. The key carries the flags now (prerender.ts), so a
   * pre-render made under the same flags is servable and one made under
   * different flags is not adopted — which is what the skip was standing in
   * for, for one flag out of four.
   */
  const ready = takePrerender(prerenderKey({ recording, edit, settings }))
  if (ready) {
    // A JOINED JOB IS THIS EXPORT NOW, so it reports ITS OWN place and obeys
    // THIS export's cancel. The first version of the join reported a flat
    // `finalizing 0.99` and listened to nothing: Robert pressed export on a
    // take whose pre-render had minutes left, watched "99%" for five of them,
    // and his cancel reached no one — the render finished anyway and the file
    // downloaded the moment it did (2026-08-30).
    const onAbort = (): void => ready.abort.abort()
    try {
      onProgress?.(ready.progress)
      if (onProgress) ready.onProgress(onProgress)
      if (signal) {
        if (signal.aborted) onAbort()
        signal.addEventListener('abort', onAbort)
      }
      const result = await ready.promise
      console.info('[compose] export served a render that was already made (F16)')
      return { result, path: 'render', declined, copiedFrom: null, copyDeclined: copy.declined }
    } catch (err) {
      throwIfAbort(err)
      // The pre-render failed or was cancelled under us. Render on demand,
      // which is exactly what this function did before F16 existed.
      declined.push({ path: 'render', reason: `pre-render unusable: ${reasonOf(err)}` })
      console.info('[compose] the pre-made render was unusable, rendering now', err)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  const result = await exportRecording({
    recording,
    edit,
    settings,
    onProgress,
    signal,
  } satisfies ExportOptions)
  return { result, path: 'render', declined, copiedFrom: null, copyDeclined: copy.declined }
}

/** Re-exported for callers that only need the type. */
export type { EditState }
