/**
 * THE AI SINK'S KEY, AND NOTHING ELSE — J12, 2026-09-05.
 *
 * A leaf on purpose: it imports nothing, so anybody may ask which take an
 * `aixport-` file belongs to without pulling `ai/build.ts` — and with it the AI
 * WORKER — into their module graph.
 *
 * IT EXISTS BECAUSE THE DEPLOY GATE REFUSED THE PUSH. `compose/purge.ts` first
 * read this parser straight out of `ai/build.ts`, which typechecks and tests
 * clean and then fails the production build outright:
 *
 *   Circular worker imports detected. Vite does not support it.
 *   src/core/compose/export.worker.ts -> src/core/ai/ai.worker.ts
 *     -> src/core/compose/export.worker.ts
 *
 * `recordingsRepo.ts` already carries `EXPORTJOB_PREFIX` for exactly this
 * reason, in its own words: so reclaim.ts "can honour it without dragging the
 * whole compose graph into the boot sweep". Same shape, same answer — a key is
 * a fact about a name, and a fact about a name needs no engine behind it.
 */

/** OPFS namespace of the AI export's PDF sink: `aixport-<recording id>-<id>.pdf`. */
export const AI_SINK_PREFIX = 'aixport-'

/**
 * Which take this PDF is of, or null for a key written before J12.
 *
 * The sink already deletes every file but the newest finished one whenever a
 * new AI export starts, so this was never unbounded — but that newest one is a
 * whole recording flattened to pages, and it sat there until the NEXT AI
 * export, long after its take had been deleted. A pre-J12 key has `ai_…` in
 * this position, matches no recording, and stays owned by that newest-only rule
 * exactly as it always was.
 */
export function recordingOfAiSink(key: string): string | null {
  if (!key.startsWith(AI_SINK_PREFIX)) return null
  const rest = key.slice(AI_SINK_PREFIX.length)
  const cut = rest.indexOf('-')
  return cut > 0 ? rest.slice(0, cut) : null
}
