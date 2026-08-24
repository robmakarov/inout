/**
 * Page 1 — the index, and the only thing in this file an agent reads first
 * (task AI1).
 *
 * Every line is DERIVED: durations, counts, timestamps, channel windows, the
 * cut list, the keyframe table. Nothing here is written by a model — "no AI in
 * the product" is a standing PO ruling, and it covers export-time
 * summarization, so this file must never grow a sentence that interprets the
 * recording rather than states it.
 *
 * It is also the token budget's tightest page: an agent that reads only this
 * one should be able to answer "what is this recording" for ~200 tokens, and
 * then know exactly which page to turn to for anything else.
 */
import type { EditState, Recording } from '@core/types'
import { keptSegments, outputDurationMs, segmentSpeed } from '@core/timeline'

export interface KeyframeEntry {
  /** Recording-epoch ms — every timestamp in this file is on that clock. */
  atRecMs: number
  page: number
  hasCrop: boolean
  atCursor: boolean
}

export interface TrailPoint {
  atRecMs: number
  xFrac: number
  yFrac: number
}

export interface IndexInput {
  recording: Recording
  edit: EditState
  keyframes: KeyframeEntry[]
  /** Empty when the pointer detector was not reliable enough to ship. */
  trail: TrailPoint[]
  width: number
  height: number
  /** Sampling rate of the delta analysis, Hz. */
  sampleFps: number
  approxTokens: number
  /** Non-zero only if the picture's t=0 is not the recording's — declared, never assumed. */
  clockOffsetMs: number
}

const sec = (ms: number): string => (ms / 1000).toFixed(2)

function channelLines(recording: Recording): string[] {
  const out: string[] = []
  for (const c of recording.channels) {
    const from = c.startOffsetMs
    const to = c.startOffsetMs + c.durationMs
    const dims = c.width && c.height ? ` ${c.width}x${c.height}` : ''
    out.push(`  ${c.kind} ${sec(from)}-${sec(to)}s${dims}`)
  }
  return out
}

function editLines(recording: Recording, edit: EditState): string[] {
  const out: string[] = []
  const segs = keptSegments(edit)
  if (edit.globalTrimStartMs > 0 || edit.globalTrimEndMs < recording.durationMs) {
    out.push(`  trimmed to ${sec(edit.globalTrimStartMs)}-${sec(edit.globalTrimEndMs)}s of the take`)
  }
  for (let i = 1; i < segs.length; i++) {
    out.push(`  cut: ${sec(segs[i - 1]!.endMs)}-${sec(segs[i]!.startMs)}s removed`)
  }
  for (const s of segs) {
    const speed = segmentSpeed(s)
    if (speed !== 1) out.push(`  speed ${speed}x on ${sec(s.startMs)}-${sec(s.endMs)}s`)
  }
  for (const c of edit.channels) {
    if (c.enabled) continue
    const kind = recording.channels.find((r) => r.id === c.channelId)?.kind ?? c.channelId
    out.push(`  ${kind} channel switched off for this export`)
  }
  return out
}

export function buildIndexLines(input: IndexInput): string[] {
  const { recording, edit, keyframes, trail } = input
  const outMs = outputDurationMs(edit)
  const lines: string[] = []

  lines.push('INOUT screen recording - index for an AI reader')
  lines.push(
    `duration ${sec(outMs)}s (recorded ${sec(recording.durationMs)}s) - keyframes ${input.width}x${input.height} - sampled ${input.sampleFps}/s`,
  )
  lines.push(
    `clock: recording epoch, t=0 is the moment recording started; offset ${Math.round(input.clockOffsetMs)}ms`,
  )
  lines.push(
    'this file is pixels only: no DOM events, no transcript, no video track. keyframes are pixel-delta selected.',
  )

  lines.push('channels')
  lines.push(...channelLines(recording))
  if (recording.missing?.length) lines.push(`  missing (never delivered): ${recording.missing.join(', ')}`)
  if (recording.stalled?.length) {
    lines.push(`  stalled mid-take (frozen picture for seconds): ${recording.stalled.join(', ')}`)
  }

  const edits = editLines(recording, edit)
  if (edits.length) {
    lines.push('edit (this file follows it: cut content is absent)')
    lines.push(...edits)
  }

  if (trail.length) {
    lines.push('pointer trail (read out of the pixels, x/y as frame fractions)')
    let line = '  '
    for (const p of trail) {
      const point = `${sec(p.atRecMs)}@${p.xFrac.toFixed(2)},${p.yFrac.toFixed(2)} `
      if (line.length + point.length > 96) {
        lines.push(line.trimEnd())
        line = '  '
      }
      line += point
    }
    if (line.trim()) lines.push(line.trimEnd())
  }

  lines.push(`keyframes ${keyframes.length} (~${Math.round(input.approxTokens / 100) / 10}k tokens total)`)
  if (keyframes.length === 0) {
    lines.push('  none: this take has no video channel in the exported window')
  }
  for (const k of keyframes) {
    const tags = [k.hasCrop ? 'crop' : '', k.atCursor ? 'at cursor' : ''].filter(Boolean).join(' ')
    lines.push(`  p${k.page} t=${sec(k.atRecMs)}s${tags ? ` ${tags}` : ''}`)
  }
  return lines
}
