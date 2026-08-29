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
import { exportSmartCut } from './smartCut'
import { smartCutEnabled } from './smartCutFlag'

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
   * default quality tier. Any other tier is a different picture, so neither
   * packet-copying path may run. The caller owns this because it owns the tier
   * ladder (compose/quality.ts), and the render is unaffected either way.
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

export async function exportByBestPath(opts: ChooseExportOptions): Promise<ChosenExport> {
  const { recording, edit, settings, allowPacketCopy, onProgress, signal } = opts
  const declined: { path: ExportPath; reason: string }[] = []

  // O3b: RESOLVED ONCE, HERE. Both copying paths take the source they are
  // given, so the origin this function reports and the file they actually
  // copied cannot drift apart — and the reasons single generation was refused
  // travel with the answer instead of being re-derived from a console line.
  const copy = allowPacketCopy
    ? chooseCopySource(recording, settings)
    : { source: null, declined: [] as { origin: CopyOrigin; reason: string }[] }
  const source = copy.source

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
  } else {
    const why = allowPacketCopy
      ? copy.declined.map((d) => `${d.origin}: ${d.reason}`).join('; ') || 'nothing to copy'
      : 'not the default output geometry'
    declined.push({ path: 'instant', reason: why })
    declined.push({ path: 'smartcut', reason: why })
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
