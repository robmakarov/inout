/**
 * exportRecording — the public entry to the certified render (task O5a).
 *
 * The render itself moved to render.ts so a worker can import it. What is left
 * here is the choice of WHERE it runs, and the frozen rule decides the shape:
 * the worker is the fast path, the in-thread render is the fallback, and the
 * fallback is the SAME CODE rather than a second implementation that could
 * drift. A browser without module workers, a worker that fails to construct,
 * or a worker that dies mid-export all land on the in-thread render with the
 * behaviour it has had since O1 — including its 8-frame yields, which exist
 * only for that case.
 *
 * ONE-SHOT FALLBACK, AND ONLY BEFORE ANY OUTPUT: a worker failure is retried
 * in-thread only if the worker never reported progress past 'preparing'. Past
 * that it has already written to the export scratch, and re-running would
 * leave two files racing for the same result — the scratch's own discard()
 * handles the dead one, and the error is surfaced instead.
 */
import type { ExportOptions, ExportProgress, ExportResult } from '@core/types'
import { clampEditState, defaultEditState, outputDurationMs, isDefaultEdit } from '@core/timeline'
import {
  busGainFor,
  loudnessFromCaptureStats,
  makeupGainForLoudness,
  measureMixLoudness,
  mixGainForChannels,
  openAudioMixers,
} from './audio'
import { AUDIO_SAMPLE_RATE } from './codecs'
import { getLastRenderStats, renderExport, setLastRenderStats } from './render'
import { isInlinePositionedWriterEnabled } from '@core/store'
import { isExportScratchEnabled, setLastScratchStats } from './scratch'
import type { ExportWorkerIn, ExportWorkerOut } from './export.worker'

/** Yields the main-thread render keeps: it shares a thread with the UI. */
const MAIN_THREAD_YIELD_EVERY_FRAMES = 8

/**
 * Loudness makeup the export will apply to this recording (default edit) —
 * used by the editor preview for parity: what you hear while editing is the
 * loudness the exported file will have. Safe fallback: unity on any failure.
 */
export async function measureRecordingMakeup(
  recording: ExportOptions['recording'],
): Promise<number> {
  try {
    const edit = clampEditState(recording, defaultEditState(recording))
    // O2: capture-time stats describe exactly this (default-edit) mix, so the
    // editor no longer decodes the whole take on open to set preview loudness.
    const audioIds = recording.channels.filter((c) => c.media === 'audio').map((c) => c.id)
    const storedGain = audioIds.length > 1 ? mixGainForChannels(audioIds.length) : 1
    const stored = loudnessFromCaptureStats(recording.loudness, audioIds, storedGain)
    if (stored) {
      const makeup = makeupGainForLoudness(stored)
      console.info(
        `preview: loudness from capture stats p90rms ${stored.loudRms.toFixed(4)} peak ${stored.peak.toFixed(3)} → makeup ${makeup.toFixed(2)}×`,
      )
      return makeup
    }
    const probe = await openAudioMixers(recording, edit, () => {})
    if (probe.length === 0) return 1
    const baseGain = busGainFor(probe)
    try {
      const totalAudioFrames = Math.round((outputDurationMs(edit) / 1000) * AUDIO_SAMPLE_RATE)
      const loud = await measureMixLoudness(probe, baseGain, totalAudioFrames, () => {})
      const makeup = makeupGainForLoudness(loud)
      console.info(
        `preview: loudness p90rms ${loud.loudRms.toFixed(4)} peak ${loud.peak.toFixed(3)} → makeup ${makeup.toFixed(2)}×`,
      )
      return makeup
    } finally {
      for (const m of probe) m.dispose()
    }
  } catch (err) {
    console.warn('preview loudness measurement failed, using unity', err)
    return 1
  }
}

/** Escape hatch and A/B lever: forces the in-thread render (evidence runs). */
let workerEnabled = true
export function setExportWorkerEnabled(value: boolean): void {
  workerEnabled = value
}

function canUseExportWorker(): boolean {
  return workerEnabled && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

export async function exportRecording(opts: ExportOptions): Promise<ExportResult> {
  if (canUseExportWorker()) {
    try {
      return await exportInWorker(opts)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      if (err instanceof WorkerStartFailure) {
        console.warn('[compose] export worker unusable, rendering in-thread', err.cause)
      } else {
        throw err
      }
    }
  }
  return renderExport({ ...opts, yieldEveryFrames: MAIN_THREAD_YIELD_EVERY_FRAMES })
}

/** Thrown only while the worker has produced nothing — safe to retry in-thread. */
class WorkerStartFailure extends Error {
  constructor(override readonly cause: unknown) {
    super('export worker failed before producing output')
    this.name = 'WorkerStartFailure'
  }
}

function exportInWorker(opts: ExportOptions): Promise<ExportResult> {
  const { recording, edit, settings, onProgress, signal } = opts
  let worker: Worker
  try {
    worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })
  } catch (err) {
    return Promise.reject(new WorkerStartFailure(err))
  }

  return new Promise<ExportResult>((resolve, reject) => {
    let settled = false
    // Until the worker reports real progress it has touched nothing on disk,
    // so a failure up to that point may safely be retried in-thread.
    let producedOutput = false
    const onAbort = (): void => post({ type: 'abort' })

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      fn()
    }
    const post = (m: ExportWorkerIn): void => worker.postMessage(m)

    worker.onmessage = (ev: MessageEvent<ExportWorkerOut>) => {
      const msg = ev.data
      if (msg.type === 'progress') {
        if (msg.progress.phase !== 'preparing' || msg.progress.ratio > 0) producedOutput = true
        onProgress?.(msg.progress as ExportProgress)
        return
      }
      if (msg.type === 'done') {
        // The stage split was measured in the worker; publish it on this side
        // so getLastRenderStats() answers the same question wherever it ran.
        setLastRenderStats(msg.stats)
        setLastScratchStats(msg.scratch)
        finish(() => resolve(msg.result))
        return
      }
      const err =
        msg.name === 'AbortError'
          ? new DOMException(msg.message, 'AbortError')
          : new Error(msg.message)
      finish(() => reject(producedOutput ? err : new WorkerStartFailure(err)))
    }
    // A worker that fails to LOAD (no module worker support, bundling problem)
    // reports here and has by definition produced nothing.
    worker.onerror = (ev) => {
      finish(() => reject(new WorkerStartFailure(new Error(ev.message || 'export worker error'))))
    }
    worker.onmessageerror = () => {
      finish(() => reject(new WorkerStartFailure(new Error('export worker message could not be cloned'))))
    }

    if (signal?.aborted) {
      finish(() => reject(new DOMException('Export aborted', 'AbortError')))
      return
    }
    signal?.addEventListener('abort', onAbort)
    // The worker has its own module instances: carry the main thread's
    // evidence levers across, or a rig flips them on a thread that does not
    // render (which is what O1's buffer lane was doing).
    post({
      type: 'start',
      recording,
      edit,
      settings,
      inlineScratchWriter: isInlinePositionedWriterEnabled(),
      scratchEnabled: isExportScratchEnabled(),
    })
  })
}

/** Re-exported so nothing outside compose has to know the render moved. */
export { renderExport, getLastRenderStats, isDefaultEdit }
