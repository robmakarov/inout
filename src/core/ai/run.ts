/**
 * exportForAi — the public entry to the For-AI build (task X9).
 *
 * The build itself is build.ts so a worker can import it. What is left here is
 * the choice of WHERE it runs, and it is deliberately the same shape as
 * compose/pipeline.ts: the worker is the fast path, the in-thread build is the
 * fallback, and the fallback is THE SAME CODE rather than a second
 * implementation that could drift. A browser without module workers, a worker
 * that fails to construct, or a worker that dies before producing anything all
 * land on the build the main thread has run since AI1.
 *
 * ONE-SHOT FALLBACK, AND ONLY BEFORE ANY OUTPUT — the same rule and the same
 * reason as the export's: past the first real progress report the worker has
 * already written PDF bytes into its own OPFS sink, and re-running would leave
 * two files racing for one result. openPdfDestination() sweeps stale sinks on
 * the next build, so the dead one is collected rather than leaked, and the
 * error is surfaced instead of retried.
 */
import type { ExportProgress, ExportResult } from '@core/types'
import { buildForAi, setLastAiExportStats, type AiExportOptions } from './build'
import type { AiWorkerIn, AiWorkerOut } from './ai.worker'

/** Escape hatch and A/B lever: forces the in-thread build (evidence runs). */
let workerEnabled = true
export function setAiWorkerEnabled(value: boolean): void {
  workerEnabled = value
}
export function isAiWorkerEnabled(): boolean {
  return workerEnabled
}

function canUseAiWorker(): boolean {
  return workerEnabled && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

export async function exportForAi(opts: AiExportOptions): Promise<ExportResult> {
  if (canUseAiWorker()) {
    try {
      return await buildInWorker(opts)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      if (err instanceof WorkerStartFailure) {
        console.warn('[ai] worker unusable, building on this thread', err.cause)
      } else {
        throw err
      }
    }
  }
  return buildForAi(opts)
}

/** Thrown only while the worker has produced nothing — safe to retry in-thread. */
class WorkerStartFailure extends Error {
  constructor(override readonly cause: unknown) {
    super('ai worker failed before producing output')
    this.name = 'WorkerStartFailure'
  }
}

function buildInWorker(opts: AiExportOptions): Promise<ExportResult> {
  const { recording, edit, onProgress, signal } = opts
  let worker: Worker
  try {
    worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' })
  } catch (err) {
    return Promise.reject(new WorkerStartFailure(err))
  }

  return new Promise<ExportResult>((resolve, reject) => {
    let settled = false
    let producedOutput = false
    const onAbort = (): void => post({ type: 'abort' })

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      fn()
    }
    const post = (m: AiWorkerIn): void => worker.postMessage(m)

    worker.onmessage = (ev: MessageEvent<AiWorkerOut>) => {
      const msg = ev.data
      if (msg.type === 'progress') {
        if (msg.progress.phase !== 'preparing' || msg.progress.ratio > 0) producedOutput = true
        onProgress?.(msg.progress as ExportProgress)
        return
      }
      if (msg.type === 'done') {
        // Measured in the worker; published here so getLastAiExportStats()
        // answers the same question wherever the build ran (the AI1 gates and
        // the rig both read it from the calling thread).
        setLastAiExportStats(msg.stats)
        finish(() => resolve(msg.result))
        return
      }
      const err =
        msg.name === 'AbortError'
          ? new DOMException(msg.message, 'AbortError')
          : new Error(msg.message)
      finish(() => reject(producedOutput ? err : new WorkerStartFailure(err)))
    }
    worker.onerror = (ev) => {
      finish(() => reject(new WorkerStartFailure(new Error(ev.message || 'ai worker error'))))
    }
    worker.onmessageerror = () => {
      finish(() =>
        reject(new WorkerStartFailure(new Error('ai worker message could not be cloned'))),
      )
    }

    if (signal?.aborted) {
      finish(() => reject(new DOMException('Export aborted', 'AbortError')))
      return
    }
    signal?.addEventListener('abort', onAbort)
    post({ type: 'start', recording, edit })
  })
}
