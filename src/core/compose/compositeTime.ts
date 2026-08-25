/**
 * P0-instant-sync (2026-08-25) — the one place that knows what a composite
 * timestamp means.
 *
 * The composite is a second file with its own clock. Its zero is NOT the
 * recording epoch: v1's file starts when its MediaRecorder does, v2's starts at
 * whichever of audio or video reached the worker first. CompositeRecording now
 * declares the difference (startOffsetMs); every consumer converts through
 * here rather than assuming, which is the assumption that put both
 * packet-copying export paths outside the sync band.
 *
 * Pure on purpose: this arithmetic is the whole fix, so it is the part that
 * gets unit tests.
 */
import type { CompositeRecording } from '@core/types'

/** The declared origin, ms on the recording timeline. Absent = 0 = the old
 *  assumption, kept for takes recorded before the field existed. */
export function compositeOffsetMs(composite: Pick<CompositeRecording, 'startOffsetMs'>): number {
  const off = composite.startOffsetMs
  return typeof off === 'number' && Number.isFinite(off) ? off : 0
}

/** Composite time → recording time, both in seconds. */
export function compositeToRecordingSec(compositeSec: number, offsetMs: number): number {
  return compositeSec + offsetMs / 1000
}

/**
 * Recording time → composite time, both in seconds. NEGATIVE means the instant
 * asked about is before the composite's first frame — the composite simply has
 * no picture there, and the caller must not silently pretend its first frame
 * belongs at that moment.
 */
export function recordingToCompositeSec(recordingSec: number, offsetMs: number): number {
  return recordingSec - offsetMs / 1000
}

/** The recording-timeline window the composite covers: [start, end) in ms. */
export function compositeWindowMs(composite: CompositeRecording): { startMs: number; endMs: number } {
  const startMs = compositeOffsetMs(composite)
  return { startMs, endMs: startMs + composite.durationMs }
}
