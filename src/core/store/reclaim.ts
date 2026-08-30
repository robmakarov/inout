import { blobStore, recordingsRepo } from './index'
import { pendingBlobKeys } from '@core/capture/recovery'
import { SCRATCH_PREFIX } from '@core/compose/scratch'
import { PRERENDER_PREFIX } from '@core/compose/prerender'
import { EXPORTJOB_PREFIX } from './recordingsRepo'

/**
 * DELETE WHAT BELONGS TO NOTHING, AT EVERY BOOT — Robert, 2026-08-30: "we must
 * prevent junk from saving, it will fuck up users disks".
 *
 * A take that FREEZES never reaches stop(), so no Recording row is ever
 * written — but the durable writer has already streamed its file to disk. On
 * his machine that was ONE orphan of 1,138 MB, with the app showing no takes at
 * all and nothing anywhere able to see it. A recorder that leaks a gigabyte per
 * failed take, silently, is a recorder that eventually costs someone their disk.
 *
 * A BUTTON WAS THE WRONG ANSWER and this replaces it as the primary one: it
 * asks the user to notice a problem they cannot see, in a product they opened
 * to record something. Boot is the right moment and the safe one — nothing is
 * recording, so every file here is either referenced by a saved take, claimed
 * by the crash-recovery manifest, or garbage.
 *
 * WHAT IT WILL NOT TOUCH:
 *  · anything a saved Recording points at — channels and the composite;
 *  · anything the PENDING manifest claims. recovery.ts writes that at record
 *    start and clears it on a clean stop, so those files are unreferenced ON
 *    PURPOSE until the row exists. Deleting them turns a recoverable take into
 *    a lost one, which is the one outcome worse than the leak;
 *  · the EXPORT SCRATCH. `xport-*` is the file a finished export's own blob
 *    reads from — the download, the upload — and it is unreferenced by any
 *    Recording BY DESIGN, so a sweep that goes by references alone reads a live
 *    export as garbage and deletes the thing the user is about to save. It is
 *    also the file most likely to still be OPEN, which is how it broke the
 *    Reclaim button (below). scratch.ts owns these and sweeps its own stale
 *    ones at every export start; one fact, one home;
 *  · a live PRE-RENDER (F16). Same shape as the scratch: unreferenced by any
 *    Recording on purpose, because it is an export that has not been asked for
 *    yet. prerender.ts owns these and sweeps its own at boot, before any job
 *    starts — so a leftover from a previous page session is gone by the time
 *    this runs, and one belonging to a LIVE job must not be touched.
 *  · an EXPORT JOB's finished file (`xjob-*`). Referenced by a jobsRepo row,
 *    which this sweep does not read; exportJobs.ts owns these and sweeps its
 *    own unclaimed ones at resume. One fact, one home.
 *  · `__` dev dump files, the same exclusion salvage.ts already makes.
 *
 * Failure is per-file and never fatal: a blob still locked by a worker that has
 * not finished dying refuses removal, and the next boot gets it. Losing the
 * sweep must never cost the boot.
 */
export interface ReclaimResult {
  removed: number
  bytes: number
  /** Files that refused removal — still open. The next boot gets them. */
  failed: number
}

/**
 * Keys this sweep is allowed to consider AT ALL, before references are checked.
 * Shared by the count and the sweep on purpose: they used to be two copies of
 * the rule in two files, and a count that disagrees with the button beside it
 * is how "Reclaim does nothing" looks from the outside.
 */
function isSweepable(key: string): boolean {
  return (
    !key.startsWith('__') &&
    !key.startsWith(SCRATCH_PREFIX) &&
    !key.startsWith(PRERENDER_PREFIX) &&
    !key.startsWith(EXPORTJOB_PREFIX)
  )
}

async function keepSet(): Promise<Set<string>> {
  const keep = new Set<string>(pendingBlobKeys())
  for (const r of await recordingsRepo.list()) {
    for (const c of r.channels) keep.add(c.blobKey)
    if (r.composite) keep.add(r.composite.blobKey)
  }
  return keep
}

/** Bytes on disk belonging to nothing — what the Reclaim line offers to free. */
export async function orphanBlobBytes(): Promise<number> {
  const [files, keep] = await Promise.all([blobStore.list(), keepSet()])
  let total = 0
  for (const f of files) {
    if (!isSweepable(f.key) || keep.has(f.key)) continue
    total += f.size
  }
  return total
}

export async function reclaimOrphanBlobs(): Promise<ReclaimResult> {
  const out: ReclaimResult = { removed: 0, bytes: 0, failed: 0 }
  const [files, keep] = await Promise.all([blobStore.list(), keepSet()])
  for (const f of files) {
    if (!isSweepable(f.key) || keep.has(f.key)) continue
    try {
      await blobStore.remove(f.key)
      out.removed += 1
      out.bytes += f.size
    } catch {
      // PER FILE, AND THIS IS THE WHOLE BUG THE BUTTON HAD. The copy of this
      // loop that lived in TakesList had no catch: the first file that refused
      // removal threw, the loop died, the remaining orphans were never touched
      // and the count on screen never moved. Pressing Reclaim did nothing,
      // visibly and repeatedly (Robert, 2026-08-30: "reclaim button still
      // fucking doing nothing"). One locked file must cost one file.
      out.failed += 1
    }
  }
  if (out.removed > 0 || out.failed > 0) {
    console.info(
      `[store] reclaimed ${out.removed} orphaned file(s), ${(out.bytes / 1048576).toFixed(1)} MB — ` +
        `left behind by takes that never reached stop` +
        (out.failed > 0 ? `; ${out.failed} still locked, the next boot will get them` : ''),
    )
  }
  return out
}
