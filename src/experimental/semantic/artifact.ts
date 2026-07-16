/**
 * EXPERIMENTAL — Semantic layer research prototype (Experiment 8).
 *
 * Question under research: can a recording become a SEARCHABLE ARTIFACT
 * without any product feature being built? This module fixes the artifact
 * contract and proves the alignment/search plumbing with a deterministic
 * fake transcriber; the real on-device ASR engine (whisper-class model via
 * WebGPU) is a swappable implementation of the same one-method interface and
 * is intentionally NOT included (no heavy deps on the research branch —
 * see RESEARCH.md for the engine evaluation plan).
 *
 * Design decisions the prototype encodes:
 *  - words are timestamped in CHANNEL-LOCAL time of the source audio channel,
 *    so every existing timeline rule (offsets, trims, global window) applies
 *    to text exactly as it applies to media — one time model, no special case;
 *  - the artifact is a SIDECAR keyed by recordingId: Recording/EditState
 *    contracts are never touched;
 *  - queries return OUTPUT-time hits, ready for click-to-seek.
 */

import type { EditState, Recording } from '@core/types'
import { channelTimeMap, invert, sourceAt } from '../timemap/timemap'

export const TRANSCRIPT_VERSION = 1

export interface TranscriptWord {
  text: string
  /** Channel-local start/end, ms. */
  startMs: number
  endMs: number
  confidence: number
}

export interface TranscriptArtifact {
  v: number
  recordingId: string
  /** The audio channel the words are timed against (normally the mic). */
  channelId: string
  engine: string
  words: TranscriptWord[]
}

/** The only surface a real ASR engine must implement. */
export interface Transcriber {
  readonly engine: string
  transcribe(audio: Float32Array, sampleRate: number): Promise<TranscriptWord[]>
}

/**
 * Deterministic fake engine: emits one pseudo-word per 400ms window whose
 * text encodes the window index. Lets every downstream property (alignment,
 * search, trim behavior) be tested exactly, independent of any model.
 */
export function fakeTranscriber(): Transcriber {
  return {
    engine: 'fake-deterministic-v1',
    transcribe(audio: Float32Array, sampleRate: number): Promise<TranscriptWord[]> {
      const durMs = (audio.length / sampleRate) * 1000
      const words: TranscriptWord[] = []
      for (let start = 0; start + 200 <= durMs; start += 400) {
        words.push({
          text: `word${words.length}`,
          startMs: start,
          endMs: start + 200,
          confidence: 1,
        })
      }
      return Promise.resolve(words)
    },
  }
}

export interface SearchHit {
  text: string
  /** Where the word lands on the OUTPUT timeline under the given edit. */
  outStartMs: number
  outEndMs: number
  confidence: number
}

/**
 * Search the transcript and return hits mapped to output time under the
 * CURRENT edit — words trimmed away (channel or global) drop out naturally
 * because the time map has no segment covering them.
 */
export function searchTranscript(
  artifact: TranscriptArtifact,
  r: Recording,
  e: EditState,
  query: string,
): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const localToOut = invert(channelTimeMap(r, e, artifact.channelId))
  const hits: SearchHit[] = []
  for (const w of artifact.words) {
    if (!w.text.toLowerCase().includes(q)) continue
    const outStart = sourceAt(localToOut, w.startMs)
    const outEnd = sourceAt(localToOut, Math.max(w.startMs, w.endMs - 1))
    if (outStart === null || outEnd === null) continue
    hits.push({ text: w.text, outStartMs: outStart, outEndMs: outEnd, confidence: w.confidence })
  }
  return hits.sort((a, b) => a.outStartMs - b.outStartMs)
}

/** Silence-gap candidates for a future "tighten" pass: gaps between words. */
export function silenceGaps(artifact: TranscriptArtifact, minGapMs: number): { startMs: number; endMs: number }[] {
  const gaps: { startMs: number; endMs: number }[] = []
  const words = [...artifact.words].sort((a, b) => a.startMs - b.startMs)
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].startMs - words[i - 1].endMs
    if (gap >= minGapMs) gaps.push({ startMs: words[i - 1].endMs, endMs: words[i].startMs })
  }
  return gaps
}
