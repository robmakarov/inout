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

/** The declared origin, ms on the recording timeline. SIGNED — negative means
 *  the composite's clock began before the earliest raw channel delivered (B9).
 *  Absent = 0 = the old assumption, kept for takes recorded before the field
 *  existed. */
export function compositeOffsetMs(composite: Pick<CompositeRecording, 'startOffsetMs'>): number {
  const off = composite.startOffsetMs
  return typeof off === 'number' && Number.isFinite(off) ? off : 0
}

/**
 * B9 — THE STOP PATH'S REBASE, AND IT IS SIGNED.
 *
 * At stop every channel is shifted so the earliest media sits at t=0; the
 * composite sits on the same timeline and takes the same shift. It used to be
 * clamped at zero afterwards, on the reasoning that a composite reading
 * EARLIER than the earliest channel was measurement noise between two
 * first-arrival stamps. It is not noise. The composite's origin is whatever
 * reached the compositor worker first — the MIX, in every take measured — and
 * a raw video channel's origin is its own first FRAME, which waits on a
 * VideoEncoder configuring. Measured over seven takes through the shipped
 * capture session, the composite led by 64-198 ms on FIVE of them, and the
 * clamp discarded every one of those milliseconds. Both packet-copy paths then
 * wrote the copied picture that much LATE against audio they mix from the raw
 * channels: -2.25 to -6 frames against the render, which is the path that is
 * right (B8's census, .ai/TASKS).
 *
 * The offset is carried with its sign now. Placement handles either sign:
 * smart cut already converted through `recordingToCompositeSec` and simply
 * reads further into the composite, and the instant path floors the shift at
 * the copied file's own first key packet so no packet is asked to land before
 * zero.
 *
 * `minChannelOffsetMs` is the shift that was subtracted from the channels — a
 * take with no channels leaves it non-finite, and then nothing is subtracted.
 */
export function rebasedCompositeOffsetMs(startOffsetMs: number, minChannelOffsetMs: number): number {
  return startOffsetMs - (Number.isFinite(minChannelOffsetMs) ? minChannelOffsetMs : 0)
}

/** Where a packet-copy path may put the file it copies (B9). */
export interface CopyPlacement {
  /** Seconds added to every copied packet's timestamp. */
  shiftSec: number
  /** How much of the declared offset the output cannot hold, ms, always >= 0.
   *  Non-zero only for a file whose first key packet sits earlier than the lead
   *  it declares — never seen on a real take, and it is reported rather than
   *  silently absorbed the way the old clamp absorbed the whole lead. */
  unrepresentableMs: number
}

/**
 * B9 — HOW FAR THE COPIED PICTURE MAY MOVE, AND WHAT STOPS IT.
 *
 * The copied file is placed on the recording timeline at its declared origin.
 * Positive is the ordinary case and has always worked. NEGATIVE — the file's
 * clock started before the earliest raw channel — means its picture belongs
 * EARLIER than where it sits in its own file, and the only thing that cannot be
 * expressed is a packet before output zero. So the shift is floored at the
 * file's own first KEY packet: the first sample of a well-formed track, so
 * every packet still lands at or after zero and the muxed track still opens on
 * a keyframe.
 *
 * In practice the floor never bites — measured, the composite's video track
 * starts 133-300 ms into a file that leads by 64-198 ms — but a file that
 * pushed past it would have the remainder given up here, counted, and said out
 * loud.
 *
 * `firstKeyPacketSec` null = the file has no key packet to floor against, and
 * then nothing may move.
 */
export function copyPlacement(declaredOffsetMs: number, firstKeyPacketSec: number | null): CopyPlacement {
  const shiftSec = declaredOffsetMs / 1000
  if (!(shiftSec < 0)) return { shiftSec: Number.isFinite(shiftSec) ? shiftSec : 0, unrepresentableMs: 0 }
  const floorSec = firstKeyPacketSec !== null && Number.isFinite(firstKeyPacketSec) ? -firstKeyPacketSec : 0
  if (shiftSec < floorSec) {
    return { shiftSec: floorSec, unrepresentableMs: Math.round((floorSec - shiftSec) * 1000 * 10) / 10 }
  }
  return { shiftSec, unrepresentableMs: 0 }
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
