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
import { getLastRenderStats, renderExport, type RenderStats } from './render'
import { getLastScratchStats, type ScratchStats } from './scratch'

export type ExportWorkerIn =
  | { type: 'start'; recording: Recording; edit: EditState; settings?: ExportSettings }
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
