/**
 * SILENCE TIGHTENING (task F5a) — the pure half.
 *
 * Robert rule for this whole family: deterministic DSP only, NO transcript, NO ML,
 * ever. So the only input here is the 100 ms window-RMS envelope the loudness
 * normalizer already computes, and every decision below is a threshold on it.
 *
 * The output is a PROPOSAL: a kept-segment list of exactly the shape F1 already
 * renders, cuts and exports. Nothing here applies anything — the editor shows
 * the proposal, the user applies it, and from that moment it is an ordinary F1
 * edit with no trace of where it came from. That is deliberate: a suggestion
 * the user cannot inspect and undo is a tool making edits behind their back.
 */
import type { EditState, KeptSegment } from '../types'
import { MIN_SEGMENT_MS, keptSegments } from './timeline'

export interface SilenceParams {
  /**
   * How far below the take's SPEECH level (p90 window RMS) a window has to sit
   * to count as quiet. 0.10 ≈ −20 dB, which is under any speech and over any
   * usual room tone.
   */
  relToLoud: number
  /** …but never below this multiple of the take's own noise floor (p20). */
  relToFloor: number
  /** Ceiling on the threshold, so a quiet take cannot swallow its own speech. */
  maxRelToLoud: number
  /** A quiet stretch shorter than this is a pause in speech, not a silence. */
  minSilenceMs: number
  /** Air left at each end of a cut, so no word is clipped by its own onset. */
  paddingMs: number
  /** After padding, a cut shorter than this is not worth making. */
  minCutMs: number
  /**
   * The take must have real dynamics for any of this to mean anything: if the
   * loud level is not this many times the floor, there is nothing to tighten
   * and we say so rather than cutting at a threshold nobody can trust.
   */
  minDynamicRange: number
}

export const SILENCE_DEFAULTS: SilenceParams = {
  relToLoud: 0.1,
  relToFloor: 2,
  maxRelToLoud: 0.35,
  minSilenceMs: 700,
  paddingMs: 120,
  minCutMs: 200,
  minDynamicRange: 3,
}

export interface Span {
  startMs: number
  endMs: number
}

export interface SilenceAnalysis {
  /** Quiet stretches, in OUTPUT time, already padded and worth cutting. */
  cuts: Span[]
  /** Every quiet stretch found, before padding — evidence, not a proposal. */
  raw: Span[]
  thresholdRms: number
  loudRms: number
  floorRms: number
  /** False when the take has no usable dynamic range (see minDynamicRange). */
  usable: boolean
  reason?: string
}

/**
 * Quiet stretches of an envelope, in output ms.
 *
 * The envelope is 100 ms windows in time order; a window is quiet when it sits
 * under the threshold. Runs of quiet windows become spans, spans shorter than
 * minSilenceMs are dropped, and what survives is shrunk by the padding.
 */
export function analyzeEnvelope(
  windowRms: ArrayLike<number>,
  windowMs: number,
  loudRms: number,
  floorRms: number,
  params: SilenceParams = SILENCE_DEFAULTS,
): SilenceAnalysis {
  const threshold = Math.min(
    loudRms * params.maxRelToLoud,
    Math.max(loudRms * params.relToLoud, floorRms * params.relToFloor),
  )
  const base: SilenceAnalysis = {
    cuts: [],
    raw: [],
    thresholdRms: threshold,
    loudRms,
    floorRms,
    usable: true,
  }
  if (!(loudRms > 0) || windowRms.length === 0) {
    return { ...base, usable: false, reason: 'no audio to analyse' }
  }
  if (floorRms > 0 && loudRms < floorRms * params.minDynamicRange) {
    return {
      ...base,
      usable: false,
      reason: 'this take has no clear quiet stretches — its loud and quiet parts are too close',
    }
  }

  const raw: Span[] = []
  let runStart = -1
  for (let i = 0; i < windowRms.length; i++) {
    const quiet = windowRms[i]! <= threshold
    if (quiet && runStart < 0) runStart = i
    if (!quiet && runStart >= 0) {
      raw.push({ startMs: runStart * windowMs, endMs: i * windowMs })
      runStart = -1
    }
  }
  if (runStart >= 0) raw.push({ startMs: runStart * windowMs, endMs: windowRms.length * windowMs })

  const cuts: Span[] = []
  for (const span of raw) {
    if (span.endMs - span.startMs < params.minSilenceMs) continue
    const startMs = span.startMs + params.paddingMs
    const endMs = span.endMs - params.paddingMs
    if (endMs - startMs >= params.minCutMs) cuts.push({ startMs, endMs })
  }
  return { ...base, raw, cuts }
}

/**
 * Output-time spans → RECORDING-time spans, walking the kept segments.
 *
 * A take that already has cuts has an output timeline that is a concatenation,
 * so one output span can land in two places on the recording — which is why
 * this returns a list rather than a pair.
 */
export function outputSpanToRecordingSpans(edit: EditState, span: Span): Span[] {
  const out: Span[] = []
  let cursor = 0
  for (const seg of keptSegments(edit)) {
    const len = Math.max(0, seg.endMs - seg.startMs)
    const from = Math.max(span.startMs, cursor)
    const to = Math.min(span.endMs, cursor + len)
    if (to > from) {
      out.push({ startMs: seg.startMs + (from - cursor), endMs: seg.startMs + (to - cursor) })
    }
    cursor += len
  }
  return out
}

/**
 * Subtract recording-time spans from the kept segments. Pieces shorter than
 * MIN_SEGMENT_MS are dropped rather than left as slivers nobody can grab, and
 * the result is never empty — tightening a take to nothing is not an edit, it
 * is a bug.
 */
export function removeRecordingSpans(edit: EditState, spans: Span[]): KeptSegment[] {
  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs)
  let pieces: KeptSegment[] = keptSegments(edit).map((s) => ({ ...s }))
  for (const cut of ordered) {
    const next: KeptSegment[] = []
    for (const piece of pieces) {
      const from = Math.max(piece.startMs, cut.startMs)
      const to = Math.min(piece.endMs, cut.endMs)
      if (to <= from) {
        next.push(piece)
        continue
      }
      if (from - piece.startMs >= MIN_SEGMENT_MS) {
        next.push({ startMs: piece.startMs, endMs: from })
      }
      if (piece.endMs - to >= MIN_SEGMENT_MS) {
        next.push({ startMs: to, endMs: piece.endMs })
      }
    }
    pieces = next
  }
  return pieces
}

export interface TightenProposal {
  /** The kept-segment list to apply — ordinary F1 segments. */
  segments: KeptSegment[]
  /** Where the cuts are, on the RECORDING timeline, for the ghost overlay. */
  cutSpans: Span[]
  removedMs: number
  analysis: SilenceAnalysis
}

/** Turn an envelope analysis into something the editor can show and apply. */
export function proposeTightening(
  edit: EditState,
  analysis: SilenceAnalysis,
): TightenProposal | null {
  if (!analysis.usable || analysis.cuts.length === 0) return null
  const cutSpans = analysis.cuts.flatMap((c) => outputSpanToRecordingSpans(edit, c))
  if (cutSpans.length === 0) return null
  const segments = removeRecordingSpans(edit, cutSpans)
  if (segments.length === 0) return null
  const before = keptSegments(edit).reduce((sum, s) => sum + (s.endMs - s.startMs), 0)
  const after = segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0)
  const removedMs = Math.max(0, before - after)
  if (removedMs <= 0) return null
  return { segments, cutSpans, removedMs, analysis }
}
