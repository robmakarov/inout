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
  /** The recording had more in it than the page budget could hold. */
  budgetSpent: boolean
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

/**
 * The briefing, and it is the first thing shipping this taught us.
 *
 * V1's page 1 opened with machine facts — "clock: recording epoch", "keyframes
 * are pixel-delta selected" — and PO's first real test came back with the AI
 * ASKING WHAT TO DO WITH THE PDF. A reader that cannot tell what a file is
 * cannot use it, however cheap the file is, so the document now briefs its own
 * reader before it states anything.
 *
 * This is not the no-AI rule being bent: nothing here describes the RECORDING.
 * It describes the DOCUMENT — what its pages are, what its numbers mean, and
 * what to do with it when it arrives with no instructions — which is fixed text
 * about a format, not a model's account of what a user did.
 */
function briefing(outMs: number, frames: number, budgetSpent: boolean): string[] {
  return [
    `SCREEN RECORDING, flattened into a document so an AI can read it. ${sec(outMs)} seconds, ${frames} frames.`,
    'The pages after this one are frames from ONE screen recording, in time order, each captioned with' +
      ' its time in the recording. This is not a slide deck and not a pile of unrelated screenshots.' +
      ' There is no video to play: these frames ARE the recording.',
    'HOW TO READ IT: go through the pages in order to follow what happened, or jump straight to a moment' +
      ' using the frame list at the end of this page.',
    'FRAME SPACING IS NOT EVEN, and that is information. Frames are kept where the picture changed, and' +
      ' they come in fast runs (an eighth of a second apart) while something is moving or animating, so a' +
      ' transition can be reproduced from them. Where the times jump by seconds, the screen was still -' +
      ' nothing is missing there.' +
      (budgetSpent
        ? ' This recording had more happening in it than the file can hold, so the frames are spread' +
          ' across the whole of it rather than crowding the busiest part.'
        : ''),
    'IF YOU WERE HANDED THIS FILE WITH NO OTHER INSTRUCTION, the useful thing to do is read the frames in' +
      ' order and describe what happens in the recording, with the timestamps of each step.',
    '',
  ]
}

export function buildIndexLines(input: IndexInput): string[] {
  const { recording, edit, keyframes, trail } = input
  const outMs = outputDurationMs(edit)
  const lines: string[] = []

  lines.push(...briefing(outMs, keyframes.length, input.budgetSpent))

  lines.push('THE RECORDING')
  lines.push(
    `  ${sec(outMs)}s long${
      Math.abs(recording.durationMs - outMs) > 50 ? ` (${sec(recording.durationMs)}s recorded, then edited)` : ''
    }`,
  )
  lines.push(`  frames are ${input.width}x${input.height}, picked from ${input.sampleFps} looks per second`)
  lines.push(`  times are seconds from the start of the recording (offset ${Math.round(input.clockOffsetMs)}ms)`)
  lines.push('  what was captured')
  lines.push(...channelLines(recording))
  if (recording.missing?.length) lines.push(`    missing (never delivered): ${recording.missing.join(', ')}`)
  if (recording.stalled?.length) {
    lines.push(
      `    froze mid-take (a still picture for seconds, not an edit): ${recording.stalled.join(', ')}`,
    )
  }
  lines.push(
    '  no typed text, clicks or speech are recorded in this file - everything below was read out of the pixels',
  )

  const edits = editLines(recording, edit)
  if (edits.length) {
    lines.push('THE EDIT (this file follows it: cut content is absent)')
    lines.push(...edits)
  }

  if (trail.length) {
    lines.push('WHERE THE MOUSE POINTER WENT (time@x,y as fractions of the frame, low rate)')
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

  lines.push(
    `THE FRAMES - ${keyframes.length} of them, one per page, about ${Math.round(input.approxTokens / 100) / 10}k tokens to read all of it`,
  )
  if (keyframes.length === 0) {
    lines.push('  none: this recording has no picture in the exported window (audio-only take)')
  }
  for (const k of keyframes) {
    const tags = [
      k.hasCrop ? 'close-up of the change included' : '',
      k.atCursor ? 'change at the pointer' : '',
    ]
      .filter(Boolean)
      .join(', ')
    lines.push(`  page ${k.page}   t=${sec(k.atRecMs)}s${tags ? `   ${tags}` : ''}`)
  }
  return lines
}
