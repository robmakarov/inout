/**
 * EXPERIMENTAL — Browser runner for Experiment 1 (used by the harness page).
 *
 * Runs one full shadow-mode session against the PRODUCTION capture path:
 * createCaptureSession (synthetic mode) → attach observer → record → stop →
 * fold → diff derived view vs the Recording production saved. The production
 * recording is deleted afterwards so the experiment leaves no residue in the
 * user's library.
 */

import { isSyntheticMode } from '@core/capture'
import { createCaptureSession } from '@core/capture/session'
import { recordingsRepo } from '@core/store'
import { attachShadowLog, recordStopResult } from './shadow'
import { diffAgainstRecording, foldSession, summarizeDiff, type SessionDiff } from './fold'
import { replayLog } from './replay'

export interface ShadowRunReport {
  summary: string
  diff: SessionDiff
  factCount: number
  chainValid: boolean
  /** Re-fold from OPFS equals in-memory fold (replayability proof). */
  replayConsistent: boolean
  logFile: string
}

export async function runShadowSession(recordMs = 4000): Promise<ShadowRunReport> {
  if (!isSyntheticMode()) {
    throw new Error('Run with ?synthetic=1 — the experiment must not prompt for permissions')
  }

  const session = await createCaptureSession({
    screen: true,
    camera: true,
    mic: true,
    systemAudio: true,
  })
  const sessionId = `shadow-${Date.now()}`
  const log = attachShadowLog(session, sessionId, { synthetic: true })

  session.start()
  await new Promise((r) => setTimeout(r, recordMs))
  const recording = await session.stop()
  recordStopResult(log, recording)
  await log.close()

  const folded = foldSession([...log.facts])
  const diff = diffAgainstRecording(folded, recording)

  const logFile = `${sessionId}.slog.ndjson`
  const replayed = await replayLog(logFile)
  const replayConsistent = JSON.stringify(replayed.folded) === JSON.stringify(folded)

  // Leave no residue in the production library.
  await recordingsRepo.remove(recording.id).catch(() => undefined)

  return {
    summary: summarizeDiff(diff),
    diff,
    factCount: log.facts.length,
    chainValid: folded.chainValid,
    replayConsistent,
    logFile,
  }
}
