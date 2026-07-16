/**
 * EXPERIMENTAL — Session journal (Experiment 3).
 *
 * A tiny durable manifest, written OUTSIDE production storage
 * (localStorage key `exp:inout:journal`), updated on every tick while a
 * shadow-observed session records. If the tab dies mid-recording, the journal
 * survives with enough information to find the orphaned channel blobs in OPFS
 * and drive a salvage pass.
 *
 * localStorage is deliberate for the prototype: writes are synchronous (they
 * survive even a hard tab kill on the same event-loop turn) and ~100 bytes at
 * 4Hz is negligible. A production implementation would use the Session Log
 * itself as the journal — this experiment isolates just the recovery flow.
 */

import type { CaptureSession, ChannelKind } from '@core/types'

const KEY = 'exp:inout:journal'

export interface JournalEntry {
  v: 1
  sessionId: string
  startedAtEpochMs: number
  /** Wall-clock of the last heartbeat. */
  heartbeatAtMs: number
  /** Elapsed recording time at last heartbeat. */
  elapsedMs: number
  channels: { kind: ChannelKind; media: 'video' | 'audio' }[]
  /** 'recording' -> orphan candidate; 'closed' -> clean shutdown. */
  state: 'recording' | 'closed'
}

export function readJournal(): JournalEntry | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as JournalEntry
    return parsed.v === 1 ? parsed : null
  } catch {
    return null
  }
}

export function clearJournal(): void {
  localStorage.removeItem(KEY)
}

function write(entry: JournalEntry): void {
  localStorage.setItem(KEY, JSON.stringify(entry))
}

/**
 * Attach journaling to a session via its public event surface. Returns a
 * detach function. Writes are synchronous on each tick (250ms cadence in
 * production), so the journal is never more than one tick stale.
 */
export function attachJournal(session: CaptureSession, sessionId: string): () => void {
  const channels = Object.entries(session.previewStreams).map(([kind, stream]) => ({
    kind: kind as ChannelKind,
    media: (stream?.getVideoTracks().length ? 'video' : 'audio') as 'video' | 'audio',
  }))

  const base: JournalEntry = {
    v: 1,
    sessionId,
    startedAtEpochMs: Date.now(),
    heartbeatAtMs: Date.now(),
    elapsedMs: 0,
    channels,
    state: 'recording',
  }

  const detach = session.on((e) => {
    if (e.type === 'tick') {
      base.heartbeatAtMs = Date.now()
      base.elapsedMs = e.elapsedMs
      write(base)
    } else if (e.type === 'state' && (e.state === 'stopping' || e.state === 'stopped')) {
      base.state = 'closed'
      write(base)
    }
  })

  write(base)
  return detach
}
