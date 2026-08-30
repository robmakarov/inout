import type {
  ChannelEdit,
  ChannelRecording,
  EditState,
  KeptSegment,
  Recording,
} from '../types'
import { cameraTrackIsActive, normalizeCameraTrack } from './cameraTrack'
// Direct module path, never the compose barrel: this file is in the first-paint
// bundle and the barrel would drag the whole export engine in with it (O7).
import { backgroundIsActive, clampBackground } from '../compose/background'
import { normalizeViewportTrack, viewportTrackIsActive } from './viewportTrack'

const MIN_SPAN_MS = 100
/** A cut may not leave a segment shorter than this. */
export const MIN_SEGMENT_MS = 200

/**
 * Speed bounds for a span (task F5b). The floor is 1 — F5b is "tighten the
 * boring parts", not a slow-motion tool, and slowing a 30 fps capture down
 * invents frames that were never recorded. The ceiling is 3, where a
 * pitch-preserved voice stops being intelligible.
 */
export const MIN_SEGMENT_SPEED = 1
export const MAX_SEGMENT_SPEED = 3

/**
 * A span's speed, normalised. Absent, 1, NaN and out-of-range all mean "no
 * speed change", so a segment list written before F5b behaves exactly as it
 * did — and a rounding artefact can never make an untouched take non-default.
 */
export function segmentSpeed(s: KeptSegment): number {
  const v = s.speed
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  return Math.min(MAX_SEGMENT_SPEED, Math.max(MIN_SEGMENT_SPEED, v))
}

/** How much OUTPUT time a span occupies: its length divided by its speed. */
export function segmentOutputMs(s: KeptSegment): number {
  return Math.max(0, s.endMs - s.startMs) / segmentSpeed(s)
}

/**
 * The speed in force at an OUTPUT instant — 1 outside any sped span, and 1 past
 * the end. The editor preview needs it because an element's playbackRate is its
 * base rate, not a correction: slewing a 2x span around 1.0 would fall a second
 * behind per second and hard-seek forever.
 */
export function speedAtOutputMs(e: EditState, outputMs: number): number {
  if (outputMs < 0) return 1
  let acc = 0
  for (const s of keptSegments(e)) {
    const len = segmentOutputMs(s)
    if (outputMs < acc + len) return segmentSpeed(s)
    acc += len
  }
  return 1
}

/** True when any kept span plays at a speed other than 1. */
export function hasSpeedChange(e: EditState): boolean {
  return keptSegments(e).some((s) => segmentSpeed(s) !== 1)
}

export function defaultEditState(r: Recording): EditState {
  return {
    recordingId: r.id,
    globalTrimStartMs: 0,
    globalTrimEndMs: r.durationMs,
    channels: r.channels.map(defaultChannelEdit),
    // UI1: a take whose PiP was moved DURING capture opens on that composition.
    // The composite was written with this pose and the default export copies
    // that file, so an editor that started from the default corner would be
    // previewing a frame the export cannot produce. Absent on every take made
    // before the PiP could be moved during a take, which is the identity.
    ...(r.cameraPose
      ? { camera: { keyframes: [{ ...r.cameraPose, atMs: 0 }] } }
      : null),
  }
}

function defaultChannelEdit(c: ChannelRecording): ChannelEdit {
  return { channelId: c.id, enabled: true, trimStartMs: 0, trimEndMs: c.durationMs }
}

function clampSpan(start: number, end: number, maxMs: number): [number, number] {
  const minSpan = Math.min(MIN_SPAN_MS, maxMs)
  let s = Math.min(Math.max(start, 0), maxMs)
  let e = Math.min(Math.max(end, 0), maxMs)
  if (e - s < minSpan) {
    e = Math.min(maxMs, s + minSpan)
    s = Math.max(0, e - minSpan)
  }
  return [s, e]
}

export function clampEditState(r: Recording, e: EditState): EditState {
  const [gs, ge] = clampSpan(e.globalTrimStartMs, e.globalTrimEndMs, r.durationMs)
  const byId = new Map(e.channels.map((ce) => [ce.channelId, ce]))
  const channels = r.channels.map((c): ChannelEdit => {
    const prev = byId.get(c.id)
    if (!prev) return defaultChannelEdit(c)
    const [ts, te] = clampSpan(prev.trimStartMs, prev.trimEndMs, c.durationMs)
    return { channelId: c.id, enabled: prev.enabled, trimStartMs: ts, trimEndMs: te }
  })
  const base: EditState = {
    recordingId: r.id,
    globalTrimStartMs: gs,
    globalTrimEndMs: ge,
    channels,
  }
  // F4: keyframes are RECORDING-timeline instants, so they are bounded by the
  // take, not by the trim — trimming must not silently delete camera motion
  // that reappears the moment the user drags the trim handle back.
  if (cameraTrackIsActive(e.camera)) {
    const camera = normalizeCameraTrack(e.camera!, r.durationMs)
    if (camera.keyframes.length > 0) base.camera = camera
  }
  // F3: a background that paints and insets nothing is the old full-bleed
  // frame, so it is dropped rather than stored — an untouched take must stay
  // indistinguishable from one recorded before F3.
  const background = clampBackground(e.background)
  if (backgroundIsActive(background)) base.background = background
  // F2: keyframes are RECORDING-timeline instants, bounded by the take and not
  // by the trim — same rule as the camera track, for the same reason.
  if (viewportTrackIsActive(e.viewport)) {
    const viewport = normalizeViewportTrack(e.viewport!, r.durationMs)
    if (viewport.keyframes.length > 0) base.viewport = viewport
  }
  if (!e.segments || e.segments.length === 0) return base
  const segments = normalizeSegments(base, e.segments)
  // A single span covering the whole trim is the same as no cuts; keep the
  // field absent so untouched takes stay byte-identical to before F1. UNLESS it
  // carries a speed (F5b): then it is not "no cuts", it is the whole take
  // played faster, and dropping it here would silently discard the edit.
  if (
    segments.length === 0 ||
    (segments.length === 1 &&
      segments[0]!.startMs <= gs &&
      segments[0]!.endMs >= ge &&
      segmentSpeed(segments[0]!) === 1)
  ) {
    return base
  }
  return { ...base, segments }
}

/**
 * The spans as the EDITOR holds them — a split the user made is two adjacent
 * spans even though nothing has been removed yet, because the marker has to
 * survive until they delete or drag it.
 */
export function editSegments(e: EditState): KeptSegment[] {
  if (!e.segments || e.segments.length === 0) {
    return [{ startMs: e.globalTrimStartMs, endMs: e.globalTrimEndMs }]
  }
  return e.segments
}

/**
 * The spans as the ENGINE sees them: adjacent spans merged, because material
 * that is still contiguous is not a cut. This is what keeps a split-with-
 * nothing-deleted free — no extra mixers, no seam fade, and the take still
 * qualifies for the instant packet-copy path.
 */
export function keptSegments(e: EditState): KeptSegment[] {
  const raw = editSegments(e)
  const out: KeptSegment[] = []
  for (const s of raw) {
    const last = out[out.length - 1]
    // Adjacent spans merge only when they play at the SAME speed: fusing a 2x
    // span into the 1x one beside it would silently discard the speed change
    // the user just made (F5b).
    if (last && s.startMs <= last.endMs && segmentSpeed(last) === segmentSpeed(s)) {
      last.endMs = Math.max(last.endMs, s.endMs)
    } else {
      out.push({ ...s })
    }
  }
  return out
}

export function outputDurationMs(e: EditState): number {
  let total = 0
  for (const s of keptSegments(e)) total += segmentOutputMs(s)
  return total
}

/**
 * Output time → recording time. With cuts the mapping is piecewise: walk the
 * kept spans accumulating their lengths until the requested output time falls
 * inside one. Returns null past the end of the output.
 */
export function outputToRecordingMs(e: EditState, outputMs: number): number | null {
  if (outputMs < 0) return null
  let acc = 0
  for (const s of keptSegments(e)) {
    const len = segmentOutputMs(s)
    // Affine inside the span: at 2x, one output ms covers two recording ms.
    if (outputMs < acc + len) return s.startMs + (outputMs - acc) * segmentSpeed(s)
    acc += len
  }
  return null
}

/**
 * Recording time → output time, or null when that instant was cut out.
 * Used by the editor to keep the playhead where the user left it after a cut.
 */
export function recordingToOutputMs(e: EditState, recordingMs: number): number | null {
  let acc = 0
  for (const s of keptSegments(e)) {
    const len = segmentOutputMs(s)
    if (recordingMs >= s.startMs && recordingMs < s.endMs) {
      return acc + (recordingMs - s.startMs) / segmentSpeed(s)
    }
    acc += len
  }
  return null
}

/**
 * Output-time positions where material was actually REMOVED. Uses the merged
 * view, so a split with nothing deleted contributes no join — fading a seam
 * that has continuous audio either side would put a notch where none belongs.
 */
export function segmentJoinsMs(e: EditState): number[] {
  const joins: number[] = []
  let acc = 0
  const segs = keptSegments(e)
  for (let i = 0; i < segs.length; i++) {
    acc += segmentOutputMs(segs[i]!)
    if (i < segs.length - 1) joins.push(acc)
  }
  return joins
}

/**
 * Normalize: clip to the trim, drop empties, sort, merge OVERLAPPING spans.
 * Only overlaps merge — adjacent spans are left alone, because that is exactly
 * what a fresh split looks like and collapsing it would undo the user's edit
 * the instant they made it.
 */
export function normalizeSegments(e: EditState, segments: KeptSegment[]): KeptSegment[] {
  const clipped = segments
    .map((s) => {
      const span: KeptSegment = {
        startMs: Math.max(e.globalTrimStartMs, Math.min(s.startMs, s.endMs)),
        endMs: Math.min(e.globalTrimEndMs, Math.max(s.startMs, s.endMs)),
      }
      // Stored only when it MEANS something: a span carrying speed 1 must be
      // indistinguishable from one carrying nothing (see KeptSegment.speed).
      const speed = segmentSpeed(s)
      if (speed !== 1) span.speed = speed
      return span
    })
    .filter((s) => s.endMs - s.startMs > 0)
    .sort((a, b) => a.startMs - b.startMs)
  const out: KeptSegment[] = []
  for (const s of clipped) {
    const last = out[out.length - 1]
    if (last && s.startMs < last.endMs && segmentSpeed(last) === segmentSpeed(s)) {
      last.endMs = Math.max(last.endMs, s.endMs)
    } else {
      out.push({ ...s })
    }
  }
  return out
}

/** Split the segment containing this OUTPUT time into two, at that point. */
export function splitAtOutputMs(e: EditState, outputMs: number): EditState {
  const recordingMs = outputToRecordingMs(e, outputMs)
  if (recordingMs === null) return e
  const segs = editSegments(e)
  const next: KeptSegment[] = []
  for (const s of segs) {
    if (
      recordingMs > s.startMs + MIN_SEGMENT_MS &&
      recordingMs < s.endMs - MIN_SEGMENT_MS
    ) {
      const speed = segmentSpeed(s)
      const carry = speed !== 1 ? { speed } : {}
      next.push({ startMs: s.startMs, endMs: recordingMs, ...carry })
      next.push({ startMs: recordingMs, endMs: s.endMs, ...carry })
    } else {
      next.push({ ...s })
    }
  }
  if (next.length === segs.length) return e
  return { ...e, segments: next }
}

/** Remove one kept span. The last remaining span is never removed. */
export function removeSegment(e: EditState, index: number): EditState {
  const segs = editSegments(e)
  if (segs.length <= 1 || index < 0 || index >= segs.length) return e
  return { ...e, segments: segs.filter((_, i) => i !== index) }
}

/**
 * True when the kept material is NOT simply the whole global trim — i.e. the
 * output really differs from "everything". A split with nothing deleted is not
 * a cut; deleting the tail clip is, even though it leaves one span.
 */
export function hasCuts(e: EditState): boolean {
  const segs = keptSegments(e)
  if (segs.length !== 1) return true
  const only = segs[0]!
  return only.startMs > e.globalTrimStartMs || only.endMs < e.globalTrimEndMs
}

/** Set (or clear) the speed of one kept span, by its index in editSegments. */
export function setSegmentSpeed(e: EditState, index: number, speed: number): EditState {
  const segs = editSegments(e)
  if (index < 0 || index >= segs.length) return e
  const clamped = Math.min(MAX_SEGMENT_SPEED, Math.max(MIN_SEGMENT_SPEED, speed))
  const next = segs.map((s, i) => {
    if (i !== index) return { ...s }
    const span: KeptSegment = { startMs: s.startMs, endMs: s.endMs }
    if (clamped !== 1) span.speed = clamped
    return span
  })
  return { ...e, segments: next }
}

export function channelSourceTimeAt(
  r: Recording,
  e: EditState,
  channelId: string,
  outputMs: number,
): number | null {
  const channel = r.channels.find((c) => c.id === channelId)
  if (!channel) return null
  // Missing edit behaves like the default one (clampEditState fills the same).
  const edit = e.channels.find((ce) => ce.channelId === channelId) ?? defaultChannelEdit(channel)
  if (!edit.enabled) return null
  if (outputMs < 0 || outputMs >= outputDurationMs(e)) return null
  const recordingT = outputToRecordingMs(e, outputMs)
  if (recordingT === null) return null
  if (recordingT < channel.startOffsetMs || recordingT >= channel.startOffsetMs + channel.durationMs) {
    return null
  }
  const localT = recordingT - channel.startOffsetMs
  if (localT < edit.trimStartMs || localT >= edit.trimEndMs) return null
  return localT
}

export function activeChannelsAt(r: Recording, e: EditState, outputMs: number): ChannelRecording[] {
  return r.channels.filter((c) => channelSourceTimeAt(r, e, c.id, outputMs) !== null)
}

/** True if the channel contributes to any part of the output window. */
export function channelHasOutputWindow(r: Recording, e: EditState, channelId: string): boolean {
  const c = r.channels.find((ch) => ch.id === channelId)
  if (!c) return false
  const edit = e.channels.find((ce) => ce.channelId === c.id) ?? defaultChannelEdit(c)
  if (!edit.enabled) return false
  // Channel's kept window on the recording timeline, intersected with the
  // global trim AND with at least one kept span (a channel can be cut away
  // entirely by the segment list even though its trim still overlaps).
  const start = Math.max(c.startOffsetMs + Math.max(edit.trimStartMs, 0), e.globalTrimStartMs)
  const end = Math.min(c.startOffsetMs + Math.min(edit.trimEndMs, c.durationMs), e.globalTrimEndMs)
  if (end <= start) return false
  return keptSegments(e).some((s) => Math.min(end, s.endMs) > Math.max(start, s.startMs))
}

export function hasEnabledVideo(r: Recording, e: EditState): boolean {
  return r.channels.some((c) => c.media === 'video' && channelHasOutputWindow(r, e, c.id))
}

/** True when the edit changes nothing: instant-export can use the live composite. */
export function isDefaultEdit(r: Recording, e: EditState): boolean {
  if (hasCuts(e)) return false
  // A camera track means the PIXELS differ from the burned-in composite, so the
  // packet copy would silently ship a video that ignores the user's move (F4).
  if (cameraTrackIsActive(e.camera)) return false
  // Same reasoning for a background frame (F3): the composite is full bleed.
  if (backgroundIsActive(e.background)) return false
  // …and for a zoom (F2): the composite is the whole frame.
  if (viewportTrackIsActive(e.viewport)) return false
  // …and for a speed change (F5b): the composite plays at 1x, so a packet copy
  // would ship a file that ignores it. hasCuts already rejects multi-span
  // edits; this covers the single span the user sped up without cutting.
  if (hasSpeedChange(e)) return false
  if (e.globalTrimStartMs > 0 || e.globalTrimEndMs < r.durationMs) return false
  for (const c of r.channels) {
    const edit = e.channels.find((x) => x.channelId === c.id)
    if (!edit) continue
    if (!edit.enabled || edit.trimStartMs > 0 || edit.trimEndMs < c.durationMs) return false
  }
  return true
}
