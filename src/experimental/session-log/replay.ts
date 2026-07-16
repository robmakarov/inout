/**
 * EXPERIMENTAL — Log replay (Experiment 1).
 *
 * Reads a persisted shadow log back from OPFS and re-folds it. Together with
 * fold purity this demonstrates the replayability property: the folded view
 * of a session is recoverable from disk alone, including from a PREFIX of a
 * log whose writer died mid-session (every NDJSON line boundary is a valid
 * recovery point).
 */

import { expList, expReadFile } from '../shared/opfs'
import type { SessionFact } from './facts'
import { foldSession, type FoldedSession } from './fold'

export function parseNdjson(text: string): { facts: SessionFact[]; truncatedTail: boolean } {
  const facts: SessionFact[] = []
  let truncatedTail = false
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      facts.push(JSON.parse(line) as SessionFact)
    } catch {
      // A torn final line is expected after a crash — everything before it is valid.
      truncatedTail = true
      break
    }
  }
  return { facts, truncatedTail }
}

export async function listPersistedLogs(): Promise<string[]> {
  return (await expList()).filter((n) => n.endsWith('.slog.ndjson'))
}

export interface ReplayResult {
  file: string
  factCount: number
  truncatedTail: boolean
  folded: FoldedSession
}

export async function replayLog(file: string): Promise<ReplayResult> {
  const text = await (await expReadFile(file)).text()
  const { facts, truncatedTail } = parseNdjson(text)
  return { file, factCount: facts.length, truncatedTail, folded: foldSession(facts) }
}
