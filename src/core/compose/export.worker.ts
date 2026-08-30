/**
 * The export, off the main thread (task O5a).
 *
 * The render is a decode/draw/encode loop that used to run where the UI runs.
 * It was polite about it — a setTimeout every 8 frames — but polite is not the
 * same as absent: the yields cost real wall-clock, and between them a slow
 * frame still blocked paint. Here there is nothing to block, so the yields are
 * gone (render.ts, yieldEveryFrames 0) and the loop runs flat out.
 *
 * The protocol is deliberately small: one 'start' in, progress out, one
 * terminal message. Everything the render needs is either structured-cloneable
 * (Recording, EditState, ExportSettings — all plain data by contract) or is
 * opened here from OPFS, which a worker reaches exactly as the main thread
 * does. The finished blob goes back as a Blob: it is disk-backed by the export
 * scratch (O1), so cloning it copies a handle, not 1.8 GB of file.
 *
 * Abort crosses the boundary as a message, not a signal — AbortSignal is not
 * cloneable — and is re-made into a local AbortController here.
 */
import type { EditState, ExportProgress, ExportResult, ExportSettings, Recording } from '@core/types'
import { setInlinePositionedWriterEnabled } from '@core/store'
import { setSourceFrame } from '@core/frame'
import { getLastRenderStats, renderExport, type RenderStats } from './render'
import { setConstantQualityOverride } from './constantQuality'
import { setLoudnessMode, type LoudnessMode } from './loudnessMode'
import { getLastScratchStats, setExportScratchEnabled, type ScratchStats } from './scratch'

export type ExportWorkerIn =
  | {
      type: 'start'
      recording: Recording
      edit: EditState
      settings?: ExportSettings
      /**
       * Evidence levers. The worker has its OWN module instances, so a rig
       * flipping a flag on the main thread flips it on a thread that does not
       * render; both are forwarded here instead. Absent = the shipped path.
       */
      inlineScratchWriter?: boolean
      scratchEnabled?: boolean
      /**
       * EVERY FLAG THE RENDER ITSELF READS, decided on the thread that can
       * actually read them. A worker has no `localStorage` and its `location`
       * is its own script URL, so a getter called in here answers its DEFAULT
       * no matter what the page was opened with. Three switches were silently
       * dead on the shipped path because of it — see the note in pipeline.ts.
       */
      flags?: {
        cq?: number | null
        loudness?: LoudnessMode
        sourceFrame?: boolean
      }
    }
  | { type: 'abort' }

export type ExportWorkerOut =
  | { type: 'progress'; progress: ExportProgress }
  | { type: 'done'; result: ExportResult; stats: RenderStats | null; scratch: ScratchStats | null }
  | { type: 'error'; message: string; name: string }

const abort = new AbortController()
let started = false

self.onmessage = (ev: MessageEvent<ExportWorkerIn>): void => {
  const msg = ev.data
  if (msg.type === 'abort') {
    abort.abort()
    return
  }
  if (msg.type !== 'start' || started) return
  started = true
  void run(msg)
}

async function run(msg: Extract<ExportWorkerIn, { type: 'start' }>): Promise<void> {
  const post = (m: ExportWorkerOut): void => self.postMessage(m)
  if (msg.inlineScratchWriter === false) setInlinePositionedWriterEnabled(false)
  if (msg.scratchEnabled === false) setExportScratchEnabled(false)
  if (msg.flags) {
    // Absent means "the page did not say", which must stay distinct from
    // "the page said off" — hence the `in` checks rather than truthiness.
    if ('cq' in msg.flags) setConstantQualityOverride(msg.flags.cq)
    if (msg.flags.loudness) setLoudnessMode(msg.flags.loudness)
    if (typeof msg.flags.sourceFrame === 'boolean') setSourceFrame(msg.flags.sourceFrame)
  }
  try {
    const result = await renderExport({
      recording: msg.recording,
      edit: msg.edit,
      settings: msg.settings,
      signal: abort.signal,
      // Nothing shares this thread: never sleep.
      yieldEveryFrames: 0,
      onProgress: (progress) => post({ type: 'progress', progress }),
    })
    post({ type: 'done', result, stats: getLastRenderStats(), scratch: getLastScratchStats() })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    post({ type: 'error', message: e.message, name: e.name })
  }
}
