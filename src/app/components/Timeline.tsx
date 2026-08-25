import { useEffect, useRef, useState } from 'react'
import type { ChannelEdit, ChannelRecording, EditState, Recording } from '@core/types'
import {
  MIN_SEGMENT_MS,
  editSegments,
  normalizeSegments,
  moveViewportKeyframe,
  outputToRecordingMs,
  recordingToOutputMs,
  removeSegment,
  segmentSpeed,
  splitAtOutputMs,
  ZOOM_MOVE_MS,
  type TightenProposal,
} from '@core/timeline'
import { CHANNEL_META } from '@app/lib/channels'
import { useFilmstrips } from '@app/hooks/useFilmstrips'
import { FILM_LANE_HEIGHT_PX } from '@app/lib/filmstripPlan'
import { FrameBar } from '@app/components/FrameBar'
import { SpeedBar } from '@app/components/SpeedBar'
import { formatClock } from '@app/lib/format'
import { Icon } from '@app/components/Icon'

const TICK_STEPS_MS = [
  1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000,
]
const MIN_TICK_PX = 64

function startDrag(e: React.PointerEvent, onMove: (clientX: number) => void) {
  const target = e.currentTarget as HTMLElement
  try {
    target.setPointerCapture(e.pointerId)
  } catch {
    // synthetic or already-released pointer; window listeners still work via bubbling
  }
  onMove(e.clientX)
  const move = (ev: PointerEvent) => onMove(ev.clientX)
  const stop = () => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', stop)
    target.removeEventListener('pointercancel', stop)
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', stop)
  target.addEventListener('pointercancel', stop)
}

function fallbackChannelEdit(ch: ChannelRecording): ChannelEdit {
  return { channelId: ch.id, enabled: true, trimStartMs: 0, trimEndMs: ch.durationMs }
}

export function Timeline({
  recording,
  edit,
  timeMs,
  durationMs,
  onSeek,
  onEdit,
  tighten,
}: {
  recording: Recording
  edit: EditState
  /** Output-domain playhead time. */
  timeMs: number
  /** Output duration. */
  durationMs: number
  onSeek: (outputMs: number) => void
  /** Parent clamps via clampEditState. */
  onEdit: (next: EditState) => void
  /** Silence tightening (F5a). The proposal is preview-only until onApply. */
  tighten?: {
    analysing: boolean
    proposal: TightenProposal | null
    onRun: () => void
    onApply: () => void
    onDismiss: () => void
  }
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const editRef = useRef(edit)
  editRef.current = edit

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const totalMs = Math.max(1, recording.durationMs)
  const x = (ms: number) => (ms / totalMs) * width
  const msAtClient = (clientX: number) => {
    const el = trackRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
    return f * totalMs
  }

  const seekAtClient = (clientX: number) => {
    // Output clock clamps to [0, duration]; outside-trim clicks land on the bound.
    onSeek(msAtClient(clientX) - editRef.current.globalTrimStartMs)
  }

  const dragGlobalTrim = (side: 'start' | 'end') => (e: React.PointerEvent) => {
    e.stopPropagation()
    startDrag(e, (clientX) => {
      const ms = msAtClient(clientX)
      const cur = editRef.current
      onEdit(
        side === 'start'
          ? { ...cur, globalTrimStartMs: ms }
          : { ...cur, globalTrimEndMs: ms },
      )
    })
  }

  const updateChannel = (channelId: string, patch: Partial<ChannelEdit>) => {
    const cur = editRef.current
    onEdit({
      ...cur,
      channels: cur.channels.map((c) => (c.channelId === channelId ? { ...c, ...patch } : c)),
    })
  }

  const dragChannelTrim =
    (ch: ChannelRecording, side: 'start' | 'end') => (e: React.PointerEvent) => {
      e.stopPropagation()
      startDrag(e, (clientX) => {
        const local = msAtClient(clientX) - ch.startOffsetMs
        updateChannel(ch.id, side === 'start' ? { trimStartMs: local } : { trimEndMs: local })
      })
    }

  // ---- mid-take cuts (F1) ----
  const segments = editSegments(edit)
  /**
   * The clip under the playhead, and the recording instant it sits at. Both
   * Split and the speed steps act on THIS clip, so they can never mean
   * different things. Via outputToRecordingMs, not trimStart + t: with cuts (and
   * now speed) output time is not an offset of recording time, and the old
   * arithmetic was quietly wrong on any take with a cut in it.
   */
  const playheadAt = outputToRecordingMs(edit, Math.min(timeMs, durationMs))
  /** Never null for DRAWING: past the last frame the playhead sits at the end. */
  const playheadRecMs = playheadAt ?? edit.globalTrimEndMs
  const playheadSegment =
    playheadAt === null
      ? null
      : segments.findIndex((sg) => playheadAt >= sg.startMs && playheadAt < sg.endMs)
  const activeSegment = playheadSegment === null || playheadSegment < 0 ? null : playheadSegment
  const canSplit =
    playheadAt !== null &&
    segments.some(
      (sg) => playheadAt > sg.startMs + MIN_SEGMENT_MS && playheadAt < sg.endMs - MIN_SEGMENT_MS,
    )
  const splitHere = () => {
    onEdit(splitAtOutputMs(editRef.current, Math.min(timeMs, durationMs)))
  }
  const dropSegment = (index: number) => {
    onEdit(removeSegment(editRef.current, index))
  }
  /** Drag the boundary between two kept spans — i.e. move the cut. */
  const dragCutEdge = (index: number, side: 'end' | 'start') => (e: React.PointerEvent) => {
    e.stopPropagation()
    startDrag(e, (clientX) => {
      const cur = editRef.current
      const segs = editSegments(cur).map((sg) => ({ ...sg }))
      const target = segs[index]
      if (!target) return
      const ms = msAtClient(clientX)
      if (side === 'end') {
        target.endMs = Math.max(target.startMs + MIN_SEGMENT_MS, Math.min(ms, target.endMs + totalMs))
      } else {
        target.startMs = Math.min(target.endMs - MIN_SEGMENT_MS, Math.max(ms, 0))
      }
      // Never let a drag swallow a neighbour: clamp against the adjacent spans.
      const prev = segs[index - 1]
      const next = segs[index + 1]
      if (prev) target.startMs = Math.max(target.startMs, prev.endMs)
      if (next) target.endMs = Math.min(target.endMs, next.startMs)
      onEdit({ ...cur, segments: normalizeSegments(cur, segs) })
    })
  }

  /** Drag a zoom marker along the take (F2b). Recording-timeline, like the
   *  keyframes themselves, so the pointer maps straight onto them. */
  const dragZoomMarker = (index: number) => (e: React.PointerEvent) => {
    e.stopPropagation()
    startDrag(e, (clientX) => {
      const cur = editRef.current
      if (!cur.viewport) return
      onEdit({
        ...cur,
        viewport: moveViewportKeyframe(cur.viewport, index, msAtClient(clientX), totalMs),
      })
    })
  }

  /**
   * F8: the take's own picture under the lanes. Two frames of the lane bar (the
   * bar itself is inset 1 px top and bottom) so the strip fills it exactly.
   */
  const strips = useFilmstrips(recording, width, FILM_LANE_HEIGHT_PX - 2)
  const anyStrip = Object.keys(strips).length > 0

  const hasScreen = recording.channels.some((c) => c.kind === 'screen' && c.media === 'video')
  const hasAudio = recording.channels.some((c) => c.media === 'audio')
  const proposal = tighten?.proposal ?? null

  const step = TICK_STEPS_MS.find((s) => (s / totalMs) * width >= MIN_TICK_PX) ?? 900000
  const ticks: number[] = []
  for (let t = 0; t <= totalMs; t += step) ticks.push(t)

  const gStart = edit.globalTrimStartMs
  const gEnd = edit.globalTrimEndMs

  return (
    <div className="tl">
      <div className={`tl__lanes${anyStrip ? ' tl__lanes--film' : ''}`}>
        {recording.channels.map((ch) => {
          const meta = CHANNEL_META[ch.kind]
          const ce = edit.channels.find((c) => c.channelId === ch.id) ?? fallbackChannelEdit(ch)
          const barLeft = x(ch.startOffsetMs)
          const barWidth = Math.max(2, x(ch.durationMs))
          const keptLeft = x(ce.trimStartMs)
          const keptWidth = Math.max(0, x(ce.trimEndMs - ce.trimStartMs))
          /**
           * F8. The picture is the lane's background and the colour language
           * stays exactly what it was — the kept span keeps its channel tint,
           * only lighter so the frames read through it, and the cut spans turn
           * into a dark scrim rather than a paler tint, because "excluded" over
           * a picture has to be darker and not merely fainter.
           */
          const strip = strips[ch.id]
          const cutPaint = { background: strip ? 'rgba(6,6,10,1)' : meta.colorVar }
          return (
            <div key={ch.id} className={`tl__row lane${strip ? ' lane--film' : ''}`}>
              <div className="tl__gutter lane__gutter">
                <span className="lane__icon" style={{ color: meta.colorVar }}>
                  <Icon name={meta.icon} size={14} />
                </span>
                <span className="lane__label">{meta.label}</span>
                <button
                  className="lane__eye"
                  title={ce.enabled ? 'Hide channel' : 'Show channel'}
                  aria-pressed={ce.enabled}
                  onClick={() => updateChannel(ch.id, { enabled: !ce.enabled })}
                >
                  <Icon name={ce.enabled ? 'eye' : 'eye-off'} size={14} />
                </button>
              </div>
              <div className="lane__track" onPointerDown={(e) => startDrag(e, seekAtClient)}>
                {width > 0 && (
                  <div
                    className={`lane__bar${ce.enabled ? '' : ' lane__bar--disabled'}`}
                    style={{
                      left: barLeft,
                      width: barWidth,
                      ...(strip
                        ? {
                            backgroundImage: `url(${strip.url})`,
                            // The strip was built for THIS bar's width, so it
                            // stretches to it exactly and never tiles.
                            backgroundSize: '100% 100%',
                            backgroundRepeat: 'no-repeat',
                          }
                        : null),
                    }}
                  >
                    <div
                      className="lane__seg lane__seg--cut"
                      style={{ left: 0, width: keptLeft, ...cutPaint }}
                    />
                    <div
                      className="lane__seg lane__seg--kept"
                      style={{ left: keptLeft, width: keptWidth, background: meta.colorVar }}
                    />
                    <div
                      className="lane__seg lane__seg--cut"
                      style={{
                        left: keptLeft + keptWidth,
                        right: 0,
                        ...cutPaint,
                      }}
                    />
                    <div
                      className="lane__edge lane__edge--l"
                      style={{ left: keptLeft - 3 }}
                      onPointerDown={dragChannelTrim(ch, 'start')}
                    />
                    <div
                      className="lane__edge lane__edge--r"
                      style={{ left: keptLeft + keptWidth - 3 }}
                      onPointerDown={dragChannelTrim(ch, 'end')}
                    />
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="tl__row tl__row--tools">
        <div className="tl__gutter" />
        <div className="tl__tools">
          <button
            className="tl__tool"
            onClick={splitHere}
            disabled={!canSplit}
            title={canSplit ? 'Split at playhead' : 'Move the playhead inside a clip to split'}
          >
            <Icon name="scissors" size={14} />
            <span>Split</span>
          </button>
          {tighten && hasAudio && !proposal && (
            <button
              className="tl__tool"
              onClick={tighten.onRun}
              disabled={tighten.analysing}
              title="Find the silent stretches and propose cuts"
            >
              <Icon name="waves" size={14} />
              <span>{tighten.analysing ? 'Listening…' : 'Tighten'}</span>
            </button>
          )}
          {tighten && proposal && (
            <span className="tl__propose">
              <span className="tl__propose-text">
                {proposal.cutSpans.length} silence{proposal.cutSpans.length === 1 ? '' : 's'} ·{' '}
                −{formatClock(proposal.removedMs)}
              </span>
              <button className="tl__tool tl__tool--go" onClick={tighten.onApply}>
                Apply
              </button>
              <button className="tl__tool" onClick={tighten.onDismiss}>
                Dismiss
              </button>
            </span>
          )}
          {segments.length > 1 && !proposal && (
            <span className="tl__tools-hint">
              {segments.length} clips — drag a cut edge to move it, × to delete a clip
            </span>
          )}
          {/* F5b: per-clip speed, acting on the clip under the playhead. */}
          {!proposal && (
            <SpeedBar
              edit={edit}
              onEdit={(next) => {
                onEdit(next)
                // Hold the RECORDING instant, not the output one: compressing
                // the clip under the playhead moves every later output time, so
                // keeping the output number would slide the playhead off the
                // clip the user just changed — and the control would light up
                // for a different clip than the one it acted on.
                if (playheadAt !== null) {
                  const at = recordingToOutputMs(next, playheadAt)
                  if (at !== null) onSeek(at)
                }
              }}
              index={activeSegment}
            />
          )}
          {/* F3: the frame only exists around a screen surface, so a
              camera-only take never shows a control that would do nothing. */}
          {hasScreen && <FrameBar edit={edit} onEdit={onEdit} />}
        </div>
      </div>

      <div className="tl__row tl__row--ruler">
        <div className="tl__gutter" />
        <div
          ref={trackRef}
          className="tl__ruler"
          onPointerDown={(e) => startDrag(e, seekAtClient)}
        >
          {width > 0 &&
            ticks.map((t) => (
              <div key={t} className="tl__tick" style={{ left: x(t) }}>
                <span className="tl__tick-label">{formatClock(t)}</span>
              </div>
            ))}
        </div>
      </div>

      {width > 0 && (
        <div className="tl__overlay">
          <div className="tl__dim" style={{ left: 0, width: x(gStart) }} />
          <div className="tl__dim" style={{ left: x(gEnd), right: 0 }} />
          {/* Timed zooms (F2): a dot where the view lands, and a bar showing
              the move it eased through. Draggable in time since F2b — the
              gesture on the stage still writes them, this only moves WHEN. */}
          {(edit.viewport?.keyframes ?? []).map((k, i, all) => {
            const prev = all[i - 1]
            const moved = prev && k.atMs - prev.atMs <= ZOOM_MOVE_MS + 1
            return (
              <div key={`zoom-${k.atMs}`}>
                {moved && (
                  <div
                    className="tl__zoom-move"
                    style={{ left: x(prev.atMs), width: Math.max(2, x(k.atMs - prev.atMs)) }}
                  />
                )}
                <div
                  className="tl__zoom-dot"
                  style={{ left: x(k.atMs) }}
                  title={`Zoom ${Math.round((1 / k.widthFrac) * 10) / 10}× — drag to move it in time`}
                  onPointerDown={dragZoomMarker(i)}
                />
              </div>
            )
          })}
          {/* Proposed cuts (F5a): shown, never applied. */}
          {proposal?.cutSpans.map((sp) => (
            <div
              key={`prop-${sp.startMs}`}
              className="tl__propose-span"
              style={{ left: x(sp.startMs), width: Math.max(2, x(sp.endMs - sp.startMs)) }}
            />
          ))}
          {/* F5b: which clips are sped up, said on the clip itself — the tools
              row shows the playhead's clip, and a take can have several. */}
          {segments.map((sg, i) =>
            segmentSpeed(sg) === 1 ? null : (
              <div
                key={`speed-${i}-${sg.startMs}`}
                className="tl__seg-speed"
                style={{ left: x((sg.startMs + sg.endMs) / 2) }}
              >
                {segmentSpeed(sg)}×
              </div>
            ),
          )}
          {/* Material cut out of the middle, plus the handles that move each cut. */}
          {segments.length > 1 &&
            segments.slice(0, -1).map((sg, i) => (
              <div
                key={`gap-${sg.endMs}`}
                className="tl__gap"
                style={{ left: x(sg.endMs), width: Math.max(1, x(segments[i + 1]!.startMs - sg.endMs)) }}
              />
            ))}
          {segments.length > 1 &&
            segments.map((sg, i) => (
              <div key={`seg-${sg.startMs}`}>
                {i > 0 && (
                  <div
                    className="tl__cut tl__cut--l"
                    style={{ left: x(sg.startMs) }}
                    onPointerDown={dragCutEdge(i, 'start')}
                    title="Move this cut"
                  />
                )}
                {i < segments.length - 1 && (
                  <div
                    className="tl__cut tl__cut--r"
                    style={{ left: x(sg.endMs) }}
                    onPointerDown={dragCutEdge(i, 'end')}
                    title="Move this cut"
                  />
                )}
                <button
                  className="tl__seg-del"
                  style={{ left: x((sg.startMs + sg.endMs) / 2) }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    dropSegment(i)
                  }}
                  title="Delete this clip"
                  aria-label={`Delete clip ${i + 1}`}
                >
                  ×
                </button>
              </div>
            ))}
          <div
            className="tl__trim tl__trim--l"
            style={{ left: x(gStart) }}
            onPointerDown={dragGlobalTrim('start')}
          >
            <span className="tl__trim-grip" />
          </div>
          <div
            className="tl__trim tl__trim--r"
            style={{ left: x(gEnd) }}
            onPointerDown={dragGlobalTrim('end')}
          >
            <span className="tl__trim-grip" />
          </div>
          <div
            className="tl__playhead"
            style={{ left: x(playheadRecMs) }}
            onPointerDown={(e) => startDrag(e, seekAtClient)}
          />
        </div>
      )}
    </div>
  )
}
