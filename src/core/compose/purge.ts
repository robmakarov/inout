/**
 * DELETING A VIDEO DELETES ITS VIDEO — task J11, 2026-09-05.
 *
 * Robert: "i dont need fucking junk, and i need deleting video in app delet all
 * this video junk too, users disk must not get trashed by our app".
 *
 * `recordingsRepo.remove` dropped a take's channels, its composite, its
 * IndexedDB row and its edit. Everything the take had CAUSED to exist stayed:
 *
 *   · render chunks   the export, made early — measured on Robert's own Chrome
 *                     2026-09-05 at 1,855 files / 2.686 GB, sitting exactly on
 *                     the cache ceiling, for takes already dealt with. Held for
 *                     24 h by TTL and bounded by a cap, so never unbounded —
 *                     but "bounded by 2.7 GB for a day" is not what a person
 *                     means when they press Delete.
 *   · the pre-render  a whole export file, and the biggest single thing this
 *                     app writes: ~6.8 GB for a 90-minute max60 take.
 *   · export jobs     each finished job holds its own copy of the output
 *                     (`xjob-<id>`) plus a row in the jobs database.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES AT THE DELETE BUTTON. There is more
 * than one way to delete a take (the list's Delete, its Delete all, and the
 * repo's own `remove`, which the experiments call), and a cleanup that lives at
 * one caller is a cleanup the other callers forget. `recordingsRepo.remove`
 * awaits this, so every path pays it. The import there is dynamic on purpose:
 * compose already imports the store, and a static edge back would close a
 * cycle.
 *
 * IT NEVER THROWS. A delete that half-fails must still delete the take — the
 * user pressed a button and the take must go. Every failure is counted and
 * reported instead, and whatever is left behind is still reachable by the boot
 * sweep and by Reclaim, which is what those exist for.
 */
import { blobStore, jobsRepo, EXPORTJOB_PREFIX } from '@core/store'
import { removeChunksFor } from './chunkStore'
import { cancelPrerenderFor, prerenderBlobFor } from './prerender'

export interface PurgeResult {
  /** Files actually removed, of every kind. */
  removed: number
  /** Bytes those files held. */
  bytes: number
  /** Job rows dropped from the jobs database. */
  jobs: number
  /** A pre-render was running or finished for this take and has been dropped. */
  prerender: boolean
  /** Files that refused to go — still open. The boot sweep gets them. */
  failed: number
}

/**
 * Everything this take caused to exist, gone. Safe to call for a take that
 * never rendered anything: it is then three empty listings and no writes.
 */
export async function purgeDerivedFor(recordingId: string): Promise<PurgeResult> {
  const out: PurgeResult = { removed: 0, bytes: 0, jobs: 0, prerender: false, failed: 0 }

  // 1. The pre-render, in flight or finished. Cancelled FIRST: a running job
  //    writes more bytes while the rest of this runs.
  try {
    const blobKey = prerenderBlobFor(recordingId)
    out.prerender = cancelPrerenderFor(recordingId)
    if (blobKey) {
      const size = await blobStore.size(blobKey).catch(() => 0)
      await blobStore.remove(blobKey).then(
        () => {
          if (size > 0) {
            out.removed += 1
            out.bytes += size
          }
        },
        () => {
          out.failed += 1
        },
      )
    }
  } catch {
    out.failed += 1
  }

  // 2. The render chunks — the big one, and the reason the key names its take.
  try {
    const chunks = await removeChunksFor(recordingId)
    out.removed += chunks.removed
    out.bytes += chunks.bytes
  } catch {
    out.failed += 1
  }

  // 3. Export jobs: each finished one holds its own copy of the output.
  try {
    for (const job of await jobsRepo.list()) {
      if (job.recordingId !== recordingId) continue
      const key = job.result?.blobKey ?? `${EXPORTJOB_PREFIX}${job.id}`
      const size = await blobStore.size(key).catch(() => 0)
      if (size > 0) {
        await blobStore.remove(key).then(
          () => {
            out.removed += 1
            out.bytes += size
          },
          () => {
            out.failed += 1
          },
        )
      }
      await jobsRepo.remove(job.id)
      out.jobs += 1
    }
  } catch {
    out.failed += 1
  }

  if (out.removed > 0 || out.jobs > 0) {
    console.info(
      `[store] ${recordingId}: removed ${out.removed} derived file(s), ` +
        `${(out.bytes / 1048576).toFixed(1)} MB` +
        (out.jobs ? `, ${out.jobs} export job(s)` : '') +
        (out.prerender ? ', and a pre-render' : '') +
        (out.failed ? ` — ${out.failed} still in use` : '') +
        ' (J11)',
    )
  }
  return out
}
