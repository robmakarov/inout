/**
 * EXPERIMENTAL — Shadow observer (Experiment 1).
 *
 * Attaches to an EXISTING, UNMODIFIED CaptureSession through its public
 * surface only (`on`, `state`, `config`, `previewStreams`) and appends facts
 * to a SessionLog. The production session is never wrapped, patched, or
 * slowed: every observation happens in an event listener the session already
 * supports, and log writes are buffered + flushed off the hot path.
 *
 * Persistence: NDJSON, one fact per line, appended to
 * OPFS experimental/<sessionId>.slog.ndjson. NDJSON was chosen over a binary
 * frame format for the prototype because every prefix of a crashed write is
 * still parseable line-by-line — the property the experiment exists to prove.
 */

import type { CaptureEvent, CaptureSession, ChannelKind, Recording } from '@core/types'
import { expWritable } from '../shared/opfs'
import {
  chainHash,
  GENESIS_HASH,
  SESSION_LOG_VERSION,
  type FactBody,
  type SessionFact,
} from './facts'

const FLUSH_MS = 500

export interface ShadowLog {
  readonly sessionId: string
  readonly facts: readonly SessionFact[]
  /** Record a fact not observable via CaptureEvent (e.g. stop() result). */
  append(body: FactBody): void
  /** Detach listeners, flush, close the OPFS file. */
  close(): Promise<void>
}

export function attachShadowLog(
  session: CaptureSession,
  sessionId: string,
  opts?: { synthetic?: boolean; persist?: boolean },
): ShadowLog {
  const facts: SessionFact[] = []
  let prevHash = GENESIS_HASH
  let seq = 0
  let epochMs: number | null = null
  let pendingLines: string[] = []
  let writer: Promise<FileSystemWritableFileStream> | null = null
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let closed = false

  const persist = opts?.persist ?? true
  if (persist) {
    writer = expWritable(`${sessionId}.slog.ndjson`)
    flushTimer = setInterval(() => void flush(), FLUSH_MS)
  }

  async function flush(): Promise<void> {
    if (!writer || pendingLines.length === 0) return
    const lines = pendingLines
    pendingLines = []
    try {
      const w = await writer
      await w.write(lines.join(''))
    } catch (err) {
      console.warn('[exp/session-log] flush failed (experiment continues in memory)', err)
      writer = null
    }
  }

  function append(body: FactBody): void {
    if (closed) return
    const atMs = performance.now()
    if (body.kind === 'state' && body.state === 'recording' && epochMs === null) {
      // First observation of the recording state = observed epoch. This is
      // the documented gap vs the session's internal epoch; measured below.
      epochMs = atMs
    }
    const fact: SessionFact = {
      v: SESSION_LOG_VERSION,
      seq: seq++,
      atMs,
      relMs: epochMs === null ? null : atMs - epochMs,
      body,
      hash: chainHash(prevHash, seq - 1, atMs, body),
    }
    prevHash = fact.hash
    facts.push(fact)
    if (persist) pendingLines.push(JSON.stringify(fact) + '\n')
  }

  // -- observe ---------------------------------------------------------------
  append({ kind: 'log-opened', config: session.config, synthetic: opts?.synthetic ?? false })
  for (const [kind, stream] of Object.entries(session.previewStreams) as [
    ChannelKind,
    MediaStream | undefined,
  ][]) {
    const track = stream?.getTracks()[0]
    if (!track) continue
    const settings = track.getSettings()
    const body: FactBody = {
      kind: 'channel-armed',
      channel: kind,
      media: track.kind === 'video' ? 'video' : 'audio',
    }
    if (body.kind === 'channel-armed') {
      if (settings.width) body.width = settings.width
      if (settings.height) body.height = settings.height
    }
    append(body)
  }

  const detach = session.on((e: CaptureEvent) => {
    switch (e.type) {
      case 'state':
        append({ kind: 'state', state: e.state })
        break
      case 'tick':
        append({ kind: 'tick', elapsedMs: e.elapsedMs })
        break
      case 'channel-ended':
        append({ kind: 'channel-ended', channel: e.kind })
        break
      case 'channel-error':
        append({ kind: 'channel-error', channel: e.kind, message: e.message })
        break
      case 'auto-stopped':
        append({ kind: 'auto-stopped' })
        break
    }
  })

  return {
    sessionId,
    facts,
    append,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      detach()
      if (flushTimer !== null) clearInterval(flushTimer)
      await flush()
      if (writer) {
        try {
          const w = await writer
          await w.close()
        } catch (err) {
          console.warn('[exp/session-log] close failed', err)
        }
      }
    },
  }
}

/** Convenience: record the Recording returned by stop() into the log. */
export function recordStopResult(log: ShadowLog, recording: Recording): void {
  log.append({ kind: 'stop-returned', recordingId: recording.id })
}
