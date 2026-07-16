/**
 * EXPERIMENTAL — Pure fold + differential comparison (Experiment 1).
 *
 * `foldSession` derives a Recording-shaped view from a fact sequence. It is a
 * pure function — the whole point: the production session derives the same
 * information from mutable bookkeeping spread across callbacks; here it is a
 * testable reduction over recorded facts.
 *
 * IMPORTANT HONESTY NOTE (the documented gap): the shadow observer sees the
 * session only through its public event surface. Chunk-level facts
 * (ondataavailable timing/sizes) and the recorder-start instants that define
 * `startOffsetMs` are NOT observable from outside. The fold therefore derives
 * what IS observable and `diffAgainstRecording` classifies each field as
 * MATCHED / APPROXIMATE / UNOBSERVABLE. The gap list is the experiment's key
 * deliverable: it enumerates the exact capture-side emits (one additive event
 * with per-channel recorder-start timestamps + chunk facts) that a primary
 * log would need.
 */

import type { ChannelKind, Recording } from '@core/types'
import type { SessionFact } from './facts'
import { verifyChain } from './facts'

export interface FoldedChannel {
  channel: ChannelKind
  media: 'video' | 'audio'
  width?: number
  height?: number
  /** Observed end, relative to observed epoch (null if never ended before stop). */
  endedAtRelMs: number | null
}

export interface FoldedSession {
  chainValid: boolean
  synthetic: boolean
  /** Channels armed at attach time. */
  channels: FoldedChannel[]
  /** Observed lifecycle. */
  sawRecording: boolean
  sawStopping: boolean
  sawStopped: boolean
  autoStopped: boolean
  errors: { channel: ChannelKind; message: string }[]
  /** Duration estimate: last observed elapsedMs tick, plus stop bound. */
  lastTickElapsedMs: number | null
  /** relMs of the state->stopping fact (upper bound on recording duration). */
  stoppingAtRelMs: number | null
  stopReturnedRecordingId: string | null
}

export function foldSession(facts: SessionFact[]): FoldedSession {
  const out: FoldedSession = {
    chainValid: verifyChain(facts) === -1,
    synthetic: false,
    channels: [],
    sawRecording: false,
    sawStopping: false,
    sawStopped: false,
    autoStopped: false,
    errors: [],
    lastTickElapsedMs: null,
    stoppingAtRelMs: null,
    stopReturnedRecordingId: null,
  }

  for (const f of facts) {
    const b = f.body
    switch (b.kind) {
      case 'log-opened':
        out.synthetic = b.synthetic
        break
      case 'channel-armed':
        out.channels.push({
          channel: b.channel,
          media: b.media,
          ...(b.width !== undefined ? { width: b.width } : {}),
          ...(b.height !== undefined ? { height: b.height } : {}),
          endedAtRelMs: null,
        })
        break
      case 'state':
        if (b.state === 'recording') out.sawRecording = true
        if (b.state === 'stopping') {
          out.sawStopping = true
          out.stoppingAtRelMs = f.relMs
        }
        if (b.state === 'stopped') out.sawStopped = true
        break
      case 'tick':
        out.lastTickElapsedMs = b.elapsedMs
        break
      case 'channel-ended': {
        const ch = out.channels.find((c) => c.channel === b.channel && c.endedAtRelMs === null)
        if (ch) ch.endedAtRelMs = f.relMs
        break
      }
      case 'channel-error':
        out.errors.push({ channel: b.channel, message: b.message })
        break
      case 'auto-stopped':
        out.autoStopped = true
        break
      case 'stop-returned':
        out.stopReturnedRecordingId = b.recordingId
        break
      case 'data-event':
        break
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Differential comparison with the production Recording
// ---------------------------------------------------------------------------

export type FieldVerdict = 'matched' | 'approximate' | 'mismatched' | 'unobservable'

export interface FieldDiff {
  field: string
  verdict: FieldVerdict
  expected: string
  derived: string
  /** Numeric error where applicable (ms). */
  errorMs?: number
  note?: string
}

export interface SessionDiff {
  recordingId: string
  fields: FieldDiff[]
  /** Facts the current public surface cannot provide (the promotion backlog). */
  gaps: string[]
}

/** Duration agreement tolerance: one tick interval + stop latency allowance. */
const DURATION_TOLERANCE_MS = 600

export function diffAgainstRecording(folded: FoldedSession, recording: Recording): SessionDiff {
  const fields: FieldDiff[] = []

  // Channel set: observable, must match exactly (modulo zero-byte drops).
  const derivedKinds = folded.channels.map((c) => c.channel).sort()
  const actualKinds = recording.channels.map((c) => c.kind).sort()
  const kindsEqual = JSON.stringify(derivedKinds) === JSON.stringify(actualKinds)
  fields.push({
    field: 'channels',
    verdict: kindsEqual ? 'matched' : 'mismatched',
    expected: actualKinds.join(','),
    derived: derivedKinds.join(','),
    note: kindsEqual
      ? undefined
      : 'zero-byte channels are dropped at stop(); armed-set vs kept-set can legitimately differ',
  })

  // Duration: approximate by construction (tick granularity + observer skew).
  const durationEstimate = folded.stoppingAtRelMs ?? folded.lastTickElapsedMs
  if (durationEstimate === null) {
    fields.push({
      field: 'durationMs',
      verdict: 'unobservable',
      expected: String(recording.durationMs),
      derived: 'null',
      note: 'no tick or stopping fact observed',
    })
  } else {
    const errorMs = Math.abs(durationEstimate - recording.durationMs)
    fields.push({
      field: 'durationMs',
      verdict: errorMs <= DURATION_TOLERANCE_MS ? 'approximate' : 'mismatched',
      expected: String(recording.durationMs),
      derived: durationEstimate.toFixed(1),
      errorMs,
      note: 'derived from observed epoch → stopping transition; production subtracts recorder startup latency (min startOffset normalization), observer cannot',
    })
  }

  // Video dimensions: observable via preview track settings.
  for (const ch of recording.channels) {
    if (ch.media !== 'video') continue
    const derived = folded.channels.find((c) => c.channel === ch.kind)
    const ok = !!derived && derived.width === ch.width && derived.height === ch.height
    fields.push({
      field: `${ch.kind}.dimensions`,
      verdict: ok ? 'matched' : 'approximate',
      expected: `${ch.width}x${ch.height}`,
      derived: derived ? `${derived.width}x${derived.height}` : 'missing',
      note: ok ? undefined : 'recorder re-reads settings at onstart; observer reads at attach',
    })
  }

  // startOffsetMs: fundamentally unobservable from the public surface.
  for (const ch of recording.channels) {
    fields.push({
      field: `${ch.kind}.startOffsetMs`,
      verdict: 'unobservable',
      expected: String(ch.startOffsetMs),
      derived: 'n/a',
      note: 'defined by MediaRecorder.onstart inside the session; requires one additive capture-side fact',
    })
  }

  const gaps = [
    'per-channel recorder-start timestamps (defines startOffsetMs; internal onstart)',
    'chunk facts: ondataavailable timing + byte counts (durability accounting; internal)',
    'per-channel exact durationMs (internal onstop timing; observer sees session-level stopping only)',
    'blobKey assignment (internal naming; observable only after stop via the returned Recording)',
    'epoch instant (session captures performance.now() in start(); observer sees the state event a tick later)',
  ]

  return { recordingId: recording.id, fields, gaps }
}

/** One-line summary for harness output. */
export function summarizeDiff(diff: SessionDiff): string {
  const counts: Record<FieldVerdict, number> = {
    matched: 0,
    approximate: 0,
    mismatched: 0,
    unobservable: 0,
  }
  for (const f of diff.fields) counts[f.verdict]++
  return (
    `rec=${diff.recordingId} matched=${counts.matched} approx=${counts.approximate} ` +
    `mismatch=${counts.mismatched} unobservable=${counts.unobservable} gaps=${diff.gaps.length}`
  )
}
