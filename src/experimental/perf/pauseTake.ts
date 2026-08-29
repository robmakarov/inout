/**
 * EXPERIMENTAL — F6 evidence: pause/resume, through the real capture session.
 *
 * F6's gates are about a take that survives being held: the segments have to
 * line up, the devices must not be released, and the pause must not appear in
 * the result. Each of those is a number here.
 *
 * WHAT A PAUSE IS, precisely, and it is what separates this from
 * setChannelActive(kind, false): nothing is released. The same MediaStreamTrack
 * that recorded segment 1 records segment 2 — no re-acquisition, no permission
 * prompt, no picker. The rig checks that by identity: it holds the track object
 * from before the pause and asserts the resumed channel is recording the same
 * one, still live.
 *
 * AND THE PAUSE MUST NOT BE IN THE TAKE. The session moves its epoch forward by
 * the gap on resume, so segment 2 lands where segment 1 ended. The rig measures
 * exactly that — the seam between the two segments — because the alternative
 * (one epoch, gap left in) would hand the user dead air to trim out of every
 * paused take, and would look identical in every other respect.
 */
import { blobStore } from '@core/store'
import { createCaptureSession } from '@core/capture/session'
import { warmRigEncoder } from '../rigWarm'
import { setSyntheticScreenSize } from '@core/capture/synthetic'
import { exportByBestPath } from '@core/compose'
import { clampEditState, defaultEditState } from '@core/timeline'
import type { CaptureSession, ChannelKind, Recording } from '@core/types'

export interface SegmentRow {
  kind: ChannelKind
  media: string
  startOffsetMs: number
  durationMs: number
  bytes: number
}

export interface F6Report {
  notes: string[]
  segment1Ms: number
  pauseMs: number
  segment2Ms: number
  /** Every ChannelRecording the take produced, in offset order. */
  segments: SegmentRow[]
  /** Per kind: how many segments, and the gap between them on the timeline. */
  seams: { kind: ChannelKind; segments: number; seamGapMs: number | null }[]
  recordingDurationMs: number
  /** Did the SAME track object record both segments? */
  sameTrackAcrossPause: { kind: ChannelKind; same: boolean; liveAfterPause: boolean }[]
  statesSeen: string[]
  exportPath: string
  exportBytes: number
  gates: Record<string, { pass: boolean; detail: string }>
}

export async function runPauseTake(
  opts: { segment1Sec?: number; pauseSec?: number; segment2Sec?: number } = {},
): Promise<F6Report> {
  // NOTE 6: prearm warms production's first VideoEncoder at mount; a rig that
  // opens a session directly does not, and a cold first encoder eats the take.
  await warmRigEncoder()
  const seg1 = (opts.segment1Sec ?? 5) * 1000
  const pauseMs = (opts.pauseSec ?? 3) * 1000
  const seg2 = (opts.segment2Sec ?? 5) * 1000
  const notes: string[] = []
  const statesSeen: string[] = []
  setSyntheticScreenSize({ width: 1920, height: 1080 })

  let recording: Recording
  const trackBefore = new Map<ChannelKind, MediaStreamTrack>()
  const sameTrackAcrossPause: F6Report['sameTrackAcrossPause'] = []
  try {
    const session: CaptureSession = await createCaptureSession({
      screen: true,
      camera: true,
      mic: true,
      systemAudio: false,
    })
    session.on((e) => {
      if (e.type === 'state') statesSeen.push(e.state)
    })
    session.start()
    await new Promise((r) => setTimeout(r, seg1))

    // Identity, not equality: the point of a pause is that this exact device
    // keeps running. Read BEFORE the pause so the comparison is meaningful.
    for (const [kind, stream] of Object.entries(session.previewStreams)) {
      const t = (stream as MediaStream | undefined)?.getTracks()[0]
      if (t) trackBefore.set(kind as ChannelKind, t)
    }

    session.pause()
    await new Promise((r) => setTimeout(r, pauseMs))
    // Mid-pause, the devices must still be live — this is the assertion that
    // separates a pause from a stop, and it is checked WHILE paused rather than
    // after, because a track stopped and re-acquired would look the same later.
    for (const [kind, t] of trackBefore) {
      sameTrackAcrossPause.push({
        kind,
        same: true, // filled properly below, after resume
        liveAfterPause: t.readyState === 'live',
      })
    }

    session.resume()
    await new Promise((r) => setTimeout(r, seg2))

    for (const row of sameTrackAcrossPause) {
      const now = (session.previewStreams[row.kind] as MediaStream | undefined)?.getTracks()[0]
      row.same = !!now && now === trackBefore.get(row.kind)
    }

    recording = await session.stop()
  } finally {
    setSyntheticScreenSize(null)
  }

  const segments: SegmentRow[] = []
  for (const ch of recording.channels) {
    const blob = await blobStore.read(ch.blobKey).catch(() => null)
    segments.push({
      kind: ch.kind,
      media: ch.media,
      startOffsetMs: Math.round(ch.startOffsetMs),
      durationMs: Math.round(ch.durationMs),
      bytes: blob?.size ?? 0,
    })
  }
  segments.sort((a, b) => a.startOffsetMs - b.startOffsetMs)

  const kinds = [...new Set(segments.map((s) => s.kind))]
  const seams = kinds.map((kind) => {
    const own = segments.filter((s) => s.kind === kind).sort((a, b) => a.startOffsetMs - b.startOffsetMs)
    const seamGapMs =
      own.length >= 2
        ? Math.round(own[1]!.startOffsetMs - (own[0]!.startOffsetMs + own[0]!.durationMs))
        : null
    return { kind, segments: own.length, seamGapMs }
  })

  const edit = clampEditState(recording, defaultEditState(recording))
  const chosen = await exportByBestPath({ recording, edit, allowPacketCopy: true })

  for (const ch of recording.channels) await blobStore.remove(ch.blobKey).catch(() => undefined)
  if (recording.composite) await blobStore.remove(recording.composite.blobKey).catch(() => undefined)

  const videoSeams = seams.filter((s) => s.segments >= 2)
  const expectedMs = seg1 + seg2

  const gates: F6Report['gates'] = {
    'the take is TWO segments per channel, not one': {
      pass: videoSeams.length === kinds.length && kinds.length > 0,
      detail: seams.map((s) => `${s.kind} ×${s.segments}`).join(' · '),
    },
    'THE PAUSE IS NOT IN THE TAKE: segment 2 starts where segment 1 ended': {
      // ±400 ms covers the close/open of a segment, which is real work; it does
      // NOT cover the 3 s pause, which is the thing being tested.
      pass:
        videoSeams.length > 0 &&
        videoSeams.every((s) => s.seamGapMs !== null && Math.abs(s.seamGapMs) <= 400),
      detail: videoSeams.map((s) => `${s.kind} seam ${s.seamGapMs} ms`).join(' · '),
    },
    'the take is as long as what was RECORDED, not as long as the wall clock': {
      pass: Math.abs(recording.durationMs - expectedMs) <= 1500,
      detail: `${Math.round(recording.durationMs)} ms recorded against ${expectedMs} ms of segments (wall clock was ${expectedMs + pauseMs} ms)`,
    },
    'nothing was released: the SAME track recorded both segments, live throughout': {
      pass:
        sameTrackAcrossPause.length > 0 &&
        sameTrackAcrossPause.every((r) => r.same && r.liveAfterPause),
      detail: sameTrackAcrossPause
        .map((r) => `${r.kind} same=${r.same} liveWhilePaused=${r.liveAfterPause}`)
        .join(' · '),
    },
    'the paused state is visible to the UI': {
      pass: statesSeen.includes('paused') && statesSeen.indexOf('paused') < statesSeen.lastIndexOf('recording'),
      detail: statesSeen.join(' → '),
    },
    'every segment holds bytes': {
      pass: segments.length > 0 && segments.every((s) => s.bytes > 0),
      detail: segments.map((s) => `${s.kind}@${s.startOffsetMs} ${s.bytes} B`).join(' · '),
    },
    'a paused take EXPORTS, through the render': {
      // The composite is one continuous file and cannot represent a gap, so it
      // is cancelled at the pause — the same fallback a late join takes.
      pass: chosen.path === 'render' && chosen.result.blob.size > 0,
      detail: `path ${chosen.path}, ${chosen.result.blob.size} B, declined: ${chosen.declined.map((d) => `${d.path}=${d.reason}`).join('; ') || 'none'}`,
    },
  }

  notes.push(
    'the same-track check is by IDENTITY and is read before the pause, because a track stopped and re-acquired would be indistinguishable afterwards',
  )
  notes.push(
    'the seam band is ±400 ms — enough for closing one segment and opening the next, nowhere near the 3 s pause it has to catch',
  )

  return {
    notes,
    segment1Ms: seg1,
    pauseMs,
    segment2Ms: seg2,
    segments,
    seams,
    recordingDurationMs: Math.round(recording.durationMs),
    sameTrackAcrossPause,
    statesSeen,
    exportPath: chosen.path,
    exportBytes: chosen.result.blob.size,
    gates,
  }
}
