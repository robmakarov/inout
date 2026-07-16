import type { ChannelEdit, ChannelRecording, EditState, Recording } from '../types'

const MIN_SPAN_MS = 100

export function defaultEditState(r: Recording): EditState {
  return {
    recordingId: r.id,
    globalTrimStartMs: 0,
    globalTrimEndMs: r.durationMs,
    channels: r.channels.map(defaultChannelEdit),
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
  return { recordingId: r.id, globalTrimStartMs: gs, globalTrimEndMs: ge, channels }
}

export function outputDurationMs(e: EditState): number {
  return e.globalTrimEndMs - e.globalTrimStartMs
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
  const recordingT = outputMs + e.globalTrimStartMs
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
  // Channel's kept window on the recording timeline, intersected with the global trim.
  const start = Math.max(c.startOffsetMs + Math.max(edit.trimStartMs, 0), e.globalTrimStartMs)
  const end = Math.min(c.startOffsetMs + Math.min(edit.trimEndMs, c.durationMs), e.globalTrimEndMs)
  return end > start
}

export function hasEnabledVideo(r: Recording, e: EditState): boolean {
  return r.channels.some((c) => c.media === 'video' && channelHasOutputWindow(r, e, c.id))
}

/** True when the edit changes nothing: instant-export can use the live composite. */
export function isDefaultEdit(r: Recording, e: EditState): boolean {
  if (e.globalTrimStartMs > 0 || e.globalTrimEndMs < r.durationMs) return false
  for (const c of r.channels) {
    const edit = e.channels.find((x) => x.channelId === c.id)
    if (!edit) continue
    if (!edit.enabled || edit.trimStartMs > 0 || edit.trimEndMs < c.durationMs) return false
  }
  return true
}
