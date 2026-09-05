/**
 * ONE FUNCTION, WITHOUT THE EDGE THAT COMES WITH IT — J12, 2026-09-05.
 *
 * `purge.ts` has to stop a take's running exports before it deletes the files
 * they are writing, and `exportJobs.removeExportJob` is exactly that button.
 * It may not IMPORT it. purge is reachable from `@core/store`, which
 * `export.worker.ts` imports, and exportJobs reaches the AI runner, so the edge
 * closes a worker cycle and vite refuses to build at all:
 *
 *   Circular worker imports detected. Vite does not support it.
 *   src/core/compose/export.worker.ts -> src/core/ai/ai.worker.ts
 *     -> src/core/compose/export.worker.ts
 *
 * A DYNAMIC IMPORT DOES NOT HELP — that was the second attempt, and vite
 * follows dynamic imports when it builds a worker's graph. The direction of the
 * dependency has to change, not its syntax. So this is a leaf that imports
 * nothing: exportJobs registers its canceller when it loads, and purge asks
 * this file.
 *
 * AND THE NULL CASE IS CORRECT, NOT A GAP. If exportJobs was never loaded in
 * this page session then no job is running in it, so there is nothing to
 * cancel — and the persisted rows are still cleared by purge's own step over
 * `jobsRepo`. Nothing is missed by asking an empty registry.
 */

type Canceller = (jobId: string) => void

let canceller: Canceller | null = null

/** Called by exportJobs.ts at module load. */
export function setExportJobCanceller(fn: Canceller | null): void {
  canceller = fn
}

/**
 * Cancel a running export job if this page session has one. Returns whether
 * anybody was listening — NOT whether that job was live, which only the caller
 * can tell by looking at what disappeared.
 */
export function cancelExportJob(jobId: string): boolean {
  if (!canceller) return false
  canceller(jobId)
  return true
}
