/**
 * EXPERIMENTAL — Session Log fact schema (Experiment 1).
 *
 * A capture session is modeled as an append-only sequence of timestamped
 * FACTS. Facts record what was observed, never interpretations; the
 * Recording shape is derived later by a pure fold (fold.ts).
 *
 * Timestamps: `atMs` is performance.now() at observation. `relMs` is atMs
 * minus the observed epoch (the moment state=recording was seen) — the same
 * time base the production session uses, observed from outside.
 *
 * Every fact carries a hash chained to its predecessor (FNV-1a over the
 * serialized predecessor hash + fact body). This is not cryptographic — it is
 * a placeholder demonstrating that integrity chaining costs ~nothing at
 * append time. A real implementation would use incremental SHA-256.
 */

import type { CaptureConfig, CaptureState, ChannelKind, MediaKind } from '@core/types'

export const SESSION_LOG_VERSION = 1

export type FactBody =
  | { kind: 'log-opened'; config: CaptureConfig; synthetic: boolean }
  | {
      kind: 'channel-armed'
      channel: ChannelKind
      media: MediaKind
      width?: number
      height?: number
    }
  | { kind: 'state'; state: CaptureState }
  | { kind: 'tick'; elapsedMs: number }
  | { kind: 'channel-ended'; channel: ChannelKind }
  | { kind: 'channel-error'; channel: ChannelKind; message: string }
  | { kind: 'auto-stopped' }
  | { kind: 'stop-returned'; recordingId: string }
  /** Sidecar events from other experiments can piggyback on the same log. */
  | { kind: 'data-event'; channel: string; payload: unknown }

export interface SessionFact {
  v: number
  seq: number
  /** performance.now() at observation. */
  atMs: number
  /** atMs - observed epoch; null before the epoch is known. */
  relMs: number | null
  body: FactBody
  /** Chained integrity hash (hex). */
  hash: string
}

/** FNV-1a 32-bit — placeholder chain hash, synchronous and allocation-free. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function chainHash(prevHash: string, seq: number, atMs: number, body: FactBody): string {
  return fnv1a(`${prevHash}|${seq}|${atMs.toFixed(3)}|${JSON.stringify(body)}`)
}

export const GENESIS_HASH = '00000000'

/** Verify the chain; returns the index of the first corrupt fact, or -1. */
export function verifyChain(facts: SessionFact[]): number {
  let prev = GENESIS_HASH
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i]
    if (f.hash !== chainHash(prev, f.seq, f.atMs, f.body)) return i
    prev = f.hash
  }
  return -1
}
