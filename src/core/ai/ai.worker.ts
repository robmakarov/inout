/**
 * The AI export, off the main thread (task X9).
 *
 * The For-AI build decodes the whole take, composes every sample through the
 * production layout and JPEG-encodes the pages it keeps — 0.74× a full render,
 * which is seconds of work — and it did all of that on the UI thread. Nothing
 * in core/ai touches the DOM (it was written against OffscreenCanvas by
 * construction), so the move is the same one the render made at O5a: one
 * 'start' in, progress out, one terminal message.
 *
 * The finished blob crosses back as a Blob because it is OPFS-backed (the PDF
 * is written through blobStore, not accumulated in the heap), so cloning it
 * copies a handle rather than the file.
 *
 * Abort crosses as a message: AbortSignal is not cloneable.
 */
import type { EditState, ExportProgress, ExportResult, Recording } from '@core/types'
import { buildForAi, getLastAiExportStats, type AiExportStats } from './build'

export type AiWorkerIn =
  | { type: 'start'; recording: Recording; edit: EditState }
  | { type: 'abort' }

export type AiWorkerOut =
  | { type: 'progress'; progress: ExportProgress }
  | { type: 'done'; result: ExportResult; stats: AiExportStats | null }
  | { type: 'error'; message: string; name: string }

const abort = new AbortController()
let started = false

self.onmessage = (ev: MessageEvent<AiWorkerIn>): void => {
  const msg = ev.data
  if (msg.type === 'abort') {
    abort.abort()
    return
  }
  if (msg.type !== 'start' || started) return
  started = true
  void run(msg)
}

async function run(msg: Extract<AiWorkerIn, { type: 'start' }>): Promise<void> {
  const post = (m: AiWorkerOut): void => self.postMessage(m)
  try {
    const result = await buildForAi({
      recording: msg.recording,
      edit: msg.edit,
      signal: abort.signal,
      onProgress: (progress) => post({ type: 'progress', progress }),
    })
    post({ type: 'done', result, stats: getLastAiExportStats() })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    post({ type: 'error', message: e.message, name: e.name })
  }
}
