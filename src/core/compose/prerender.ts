/**
 * THE EXPORT IS MADE BEFORE IT IS ASKED FOR — task F16, core.
 *
 * Robert, 2026-08-30: "max 60 fps must export fast on any old computer". It
 * cannot be made fast by rendering faster. A 3024x1964@60 take re-rendered to
 * 1440p is ~577 Mpx/s of decode and encode against the ~416 his machine
 * measures for one encoder, and an older machine is further away, so no amount
 * of optimisation reaches "fast" — the only export that is fast on ANY computer
 * is one that is already finished. His own counter, the day before: "cant it be
 * same high instant quality rendered already ... squeeze rendering in parallel
 * of edits so user wont notice?" Editing is when the machine is idle: capture
 * is over, and the render already lives in a worker.
 *
 * WHAT F16 PRESCRIBED AND WHAT MEASUREMENT SAID. The task specified a
 * background TRANSCODE lane, on the premise that transcoding is several times
 * cheaper than rendering. Spike T1 measured it at 1.3x, identically at 60 s and
 * 120 s — and transcoding from the smaller High file, which decodes a third of
 * the pixels, was not faster than transcoding from the raw channel at all. The
 * premise was formed against a render whose encoder had no backpressure and
 * spent its time draining a queue; that defect was fixed the same morning
 * (0f8fefe). So there is no transcode lane here and there does not need to be:
 * this runs THE PRODUCTION RENDER, earlier. It reuses every path, costs no
 * second generation of 4:2:0, and scales the same way on a slow machine.
 *
 * ONE JOB AT A TIME, and it belongs to exactly one (recording, edit, settings).
 * Anything that changes the output changes the key and cancels what was
 * running: a render for an edit the user has moved past is worse than no render
 * at all, because it is spending the machine on a file nobody will ask for.
 *
 * WHAT IT WILL NOT DO:
 *  · never for an export that is already a packet COPY. Instant is instant;
 *    pre-rendering it would spend a machine to save nothing.
 *  · never a second render of the same thing. An export pressed while the job
 *    is still running JOINS it — `take()` hands back the in-flight promise —
 *    so pressing the button early costs the user the remaining time and never
 *    restarts the work.
 */
import type { EditState, ExportProgress, ExportResult, ExportSettings, Recording } from '@core/types'
import { newId } from '@core/id'
import { blobStore, persistBlobCopy } from '@core/store'
import { exportRecording } from './pipeline'

/**
 * A pre-rendered file has to survive the NEXT export, and by default it does
 * not: an ExportResult's blob is a view of the export scratch, and scratch.ts
 * keeps only the newest finished one — by design, and documented. A second
 * pre-render (the user changed rung) would therefore delete the first one's
 * bytes and leave a blob that reads back "network error".
 *
 * It cannot be fixed by retaining the scratch, because the scratch's
 * bookkeeping lives in the EXPORT WORKER's own module instance and the main
 * thread has no reference to hand it. So the finished file is copied once, to a
 * key this module owns, and the copy is what is served. One extra file on disk,
 * never two: the previous copy is removed as soon as a new job supersedes it.
 *
 * The copy itself is store/persistBlobCopy.ts — export jobs make the same move.
 */
export const PRERENDER_PREFIX = 'prerender-'
const OWN_PREFIX = PRERENDER_PREFIX

export interface PrerenderKeyInput {
  recording: Recording
  edit: EditState
  settings?: ExportSettings
}

/**
 * Everything that changes the bytes, and nothing that does not. The edit and
 * the settings go in whole: a key that summarised them would eventually serve
 * one take's file for another take's edit, which is the single worst thing this
 * module could do.
 */
export function prerenderKey({ recording, edit, settings }: PrerenderKeyInput): string {
  return JSON.stringify([recording.id, edit, settings ?? null])
}

export type PrerenderState = 'running' | 'done' | 'failed'

interface Job {
  key: string
  state: PrerenderState
  progress: ExportProgress
  startedAt: number
  abort: AbortController
  blobKey: string
  promise: Promise<ExportResult>
  /** Set by the claimer (takePrerender) — progress keeps flowing after the
   *  job is retired, because from then on it is a USER-VISIBLE export. */
  forward: ((p: ExportProgress) => void) | null
  /** Claimed by an export. The settle handlers must then KEEP the blob — the
   *  claimer's file reads from it; the boot sweep collects it next session. */
  takenOut: boolean
}

let job: Job | null = null

/** What the panel may say about the job — never a promise it cannot keep. */
export function prerenderStatus(key: string): { state: PrerenderState; ratio: number } | null {
  if (!job || job.key !== key) return null
  return { state: job.state, ratio: job.progress.ratio }
}

async function dropOwnBlob(key: string): Promise<void> {
  await blobStore.remove(key).catch(() => undefined)
}

/** Stop whatever is running and forget it. Its file goes with it. */
export function cancelPrerender(): void {
  if (!job) return
  const dying = job
  job = null
  dying.abort.abort()
  // The promise is already owned by whoever called start(); swallow its
  // rejection here so an abort never surfaces as an unhandled rejection.
  dying.promise.catch(() => undefined)
  void dropOwnBlob(dying.blobKey)
}

/**
 * Begin a render for this exact output, or keep the one already running for it.
 * Returns nothing: nobody waits on a pre-render, that is the whole point.
 */
export function startPrerender(input: PrerenderKeyInput): void {
  const key = prerenderKey(input)
  if (job && job.key === key) return
  cancelPrerender()

  const abort = new AbortController()
  const blobKey = `${OWN_PREFIX}${newId('p')}`
  const started: Job = {
    key,
    state: 'running',
    progress: { phase: 'preparing', ratio: 0 },
    startedAt: Date.now(),
    abort,
    blobKey,
    promise: Promise.resolve() as unknown as Promise<ExportResult>,
    forward: null,
    takenOut: false,
  }
  job = started

  started.promise = (async () => {
    const result = await exportRecording({
      recording: input.recording,
      edit: input.edit,
      settings: input.settings,
      signal: abort.signal,
      onProgress: (p) => {
        // NOT guarded by `job === started`: once claimed the job is retired
        // from this module but its progress is what the user is watching —
        // the flat "finalizing 99%" Robert sat five minutes behind was this
        // guard swallowing every real number the render produced.
        started.progress = p
        started.forward?.(p)
      },
    })
    // Copied BEFORE anyone can supersede it — see persistBlobCopy's note.
    const held = await persistBlobCopy(result.blob, blobKey)
    if (result.scratchKey) {
      // The copy is the file now; the scratch would otherwise sit until an
      // age sweep. Nobody has downloaded from this blob yet — it was never
      // handed out — so the remove is safe.
      void blobStore.remove(result.scratchKey).catch(() => undefined)
    }
    return { ...result, blob: held, scratchKey: undefined }
  })()

  started.promise.then(
    (result) => {
      if (job !== started) {
        // Superseded while it ran: its file is nobody's now. A CLAIMED job is
        // different — its file is exactly what the claimer is serving.
        if (!started.takenOut) void dropOwnBlob(blobKey)
        return
      }
      started.state = 'done'
      started.progress = { phase: 'finalizing', ratio: 1 }
      console.info(
        `[compose] pre-render ready after ${((Date.now() - started.startedAt) / 1000).toFixed(1)}s — ` +
          `${(result.blob.size / 1048576).toFixed(1)} MB waiting before it was asked for (F16)`,
      )
    },
    (err: unknown) => {
      void dropOwnBlob(blobKey)
      if (job !== started) return
      started.state = 'failed'
      if (!(err instanceof Error && err.name === 'AbortError')) {
        // Never fatal: the export path falls back to rendering on demand,
        // exactly as it did before this module existed.
        console.info('[compose] pre-render did not finish; the export will render on demand', err)
      }
    },
  )
}

/** What a claimer gets: the render, and the levers a user-visible export needs. */
export interface TakenPrerender {
  promise: Promise<ExportResult>
  /** Aborting this aborts the underlying render — cancel must reach a joined
   *  job (Robert's cancel pressed at the fake 99% reached nothing). */
  abort: AbortController
  /** Where the job is right now, for the first paint of the claimer's UI. */
  progress: ExportProgress
  /** Live updates from here on. One claimer; a second call replaces the first. */
  onProgress(cb: (p: ExportProgress) => void): void
}

/**
 * The finished (or in-flight) render for this exact output, or null.
 *
 * JOINING A RUNNING JOB IS THE POINT, not a bonus: an export pressed halfway
 * through waits out the remainder instead of starting the same work again,
 * which is what "export is never slower than it was" rests on.
 *
 * Handing it out RETIRES the job — the blob is the caller's now, and this
 * module must not delete a file somebody is downloading.
 */
export function takePrerender(key: string): TakenPrerender | null {
  if (!job || job.key !== key || job.state === 'failed') return null
  const taken = job
  job = null
  taken.takenOut = true
  return {
    promise: taken.promise,
    abort: taken.abort,
    progress: taken.progress,
    onProgress: (cb) => {
      taken.forward = cb
    },
  }
}

/** Test seam — module state outlives test cases. */
export function resetPrerenderForTests(): void {
  job = null
}

/** Boot sweep: pre-render files from a previous page session belong to nobody. */
export async function sweepPrerenderBlobs(): Promise<number> {
  let removed = 0
  for (const f of await blobStore.list()) {
    if (!f.key.startsWith(OWN_PREFIX)) continue
    if (job && f.key === job.blobKey) continue
    await blobStore.remove(f.key).then(
      () => {
        removed += 1
      },
      () => undefined,
    )
  }
  return removed
}
