import { blobStore, recordingsRepo } from './index'
import { pendingBlobKeys } from '@core/capture/recovery'

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
 *  · `__` dev dump files, the same exclusion salvage.ts already makes.
 *
 * Failure is per-file and never fatal: a blob still locked by a worker that has
 * not finished dying refuses removal, and the next boot gets it. Losing the
 * sweep must never cost the boot.
 */
export interface ReclaimResult {
  removed: number
  bytes: number
  failed: number
}

export async function reclaimOrphanBlobs(): Promise<ReclaimResult> {
  const out: ReclaimResult = { removed: 0, bytes: 0, failed: 0 }
  const [files, recordings] = await Promise.all([blobStore.list(), recordingsRepo.list()])
  const keep = new Set<string>(pendingBlobKeys())
  for (const r of recordings) {
    for (const c of r.channels) keep.add(c.blobKey)
    if (r.composite) keep.add(r.composite.blobKey)
  }
  for (const f of files) {
    if (keep.has(f.key) || f.key.startsWith('__')) continue
    try {
      await blobStore.remove(f.key)
      out.removed += 1
      out.bytes += f.size
    } catch {
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
