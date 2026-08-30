import { useEffect, useRef, useState } from 'react'
import type { ChannelEdit, ChannelRecording, EditState, Recording } from '@core/types'
import {
  MIN_SEGMENT_MS,
  editSegments,
  normalizeSegments,
  moveViewportKeyframe,
  outputToRecordingMs,
  removeSegment,
  segmentSpeed,
  ZOOM_MOVE_MS,
  type TightenProposal,
} from '@core/timeline'
import { CHANNEL_META } from '@app/lib/channels'
import { useLaneArt } from '@app/hooks/useLaneArt'
import { FILM_LANE_HEIGHT_PX } from '@app/lib/filmstripPlan'
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
  proposal = null,
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
  /** F5a: the PROPOSED cuts, drawn over the take. The controls that make and
   *  apply them live in ToolsBar, under the picture (UI1). */
  proposal?: TightenProposal | null
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

  /**
   * GAPS THE USER HAS DELETED — the timeline stops spending width on them
   * (Robert: "add delete button, which will remove it completle and other part
   * will slide to each other smoothly").
   *
   * Held here and not on the EditState, because it changes NOTHING about the
   * output: the material was already excluded the moment the cut was made, and
   * this only decides whether the timeline still draws the hole it left.
   * `EditState` is a core contract the export reads; a view preference has no
   * business in it.
   *
   * Keyed by the gap's own start instant rather than by index, so adding a cut
   * somewhere else does not collapse the wrong hole.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set())
  /** The take's own head and tail, closed the same way a mid-cut is. Held apart
   *  from `collapsed` because they are bounded by the trim rather than by a
   *  segment edge, so an instant is not a stable key for them. */
  const [closedEnds, setClosedEnds] = useState({ head: false, tail: false })
  useEffect(() => {
    setCollapsed(new Set())
    setClosedEnds({ head: false, tail: false })
  }, [recording.id])
  /**
   * Robert asked for the clips to "slide to each other smoothly", so the
   * collapse is animated — and ONLY the collapse. The same transition left on
   * permanently would put 240 ms of lag behind every trim drag, which is the
   * opposite of what a timeline is for. So it is a class that lives for the
   * length of one slide.
   */
  const [sliding, setSliding] = useState(false)
  const slideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (slideTimer.current) clearTimeout(slideTimer.current)
    },
    [],
  )
  const closeGap = (atMs: number | null, end?: 'head' | 'tail') => {
    if (end) setClosedEnds((prev) => ({ ...prev, [end]: true }))
    else if (atMs !== null) setCollapsed((prev) => new Set(prev).add(atMs))
    setSliding(true)
    if (slideTimer.current) clearTimeout(slideTimer.current)
    slideTimer.current = setTimeout(() => setSliding(false), 280)
  }

  const allSegments = editSegments(edit)
  /** Every hole between kept spans, and whether it is still drawn. */
  const holes = allSegments
    .slice(0, -1)
    .map((sg, i) => ({ index: i, startMs: sg.endMs, endMs: allSegments[i + 1]!.startMs }))
    .filter((h) => h.endMs > h.startMs)
  const headSpan = { startMs: 0, endMs: edit.globalTrimStartMs }
  const tailSpan = { startMs: edit.globalTrimEndMs, endMs: totalMs }
  const hidden = [
    ...(closedEnds.head && headSpan.endMs > 0 ? [headSpan] : []),
    ...holes.filter((h) => collapsed.has(h.startMs)),
    ...(closedEnds.tail && tailSpan.endMs > tailSpan.startMs ? [tailSpan] : []),
  ]
  const hiddenMs = hidden.reduce((n, h) => n + (h.endMs - h.startMs), 0)
  /** The take's length as the timeline DRAWS it. */
  const shownMs = Math.max(1, totalMs - hiddenMs)

  /**
   * THE AXIS. Linear in recording time everywhere except across a collapsed
   * hole, which takes no width at all — so the clips either side of it close
   * up. Every position on this timeline goes through here, which is what makes
   * the collapse one change rather than one per element.
   */
  const shownAt = (ms: number): number => {
    let out = ms
    for (const h of hidden) {
      if (ms >= h.endMs) out -= h.endMs - h.startMs
      else if (ms > h.startMs) out -= ms - h.startMs
    }
    return out
  }
  const x = (ms: number) => (shownAt(ms) / shownMs) * width
  /** A WIDTH, not a position. `x(duration)` is only the width of a span when
   *  the axis is linear, and across a collapsed hole it is not. */
  const spanW = (aMs: number, bMs: number) => Math.max(0, x(bMs) - x(aMs))
  /** The inverse of `shownAt`, so a click lands on the instant under it. */
  const msAtShown = (shown: number): number => {
    let out = shown
    for (const h of hidden) {
      if (out >= h.startMs) out += h.endMs - h.startMs
    }
    return Math.min(totalMs, Math.max(0, out))
  }
  const msAtClient = (clientX: number) => {
    const el = trackRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
    return msAtShown(f * shownMs)
  }

  /** `[a, b)` broken into the stretches the timeline actually draws. */
  const visibleSpans = (aMs: number, bMs: number): { startMs: number; endMs: number }[] => {
    let spans = [{ startMs: aMs, endMs: bMs }]
    for (const h of hidden) {
      const next: typeof spans = []
      for (const sp of spans) {
        if (h.endMs <= sp.startMs || h.startMs >= sp.endMs) {
          next.push(sp)
          continue
        }
        if (h.startMs > sp.startMs) next.push({ startMs: sp.startMs, endMs: h.startMs })
        if (h.endMs < sp.endMs) next.push({ startMs: h.endMs, endMs: sp.endMs })
      }
      spans = next
    }
    return spans.filter((sp) => sp.endMs > sp.startMs)
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

  /**
   * A BOUNDARY WHERE TWO CLIPS TOUCH IS ONE HANDLE, NOT TWO.
   *
   * Robert: "when i split record i cant drag left part but right part grabber
   * dont moves". Both halves of that are the same defect. A fresh split leaves
   * the end of one clip and the start of the next on the SAME pixel, and each
   * of those edges can only move ONE way — the left clip's end is clamped by
   * the next clip's start, the right clip's start by the previous clip's end.
   * So half of every grab was a no-op, on a 7 px target, with nothing on screen
   * saying which half you had hold of.
   *
   * One gesture instead: the boundary stays where it was pressed, and dragging
   * opens the cut on whichever SIDE you drag towards. Dragging back through the
   * boundary closes that side and opens the other, so the gesture is reversible
   * — which the two-handle version could not be, because each handle could only
   * ever travel away from the other.
   *
   * `at` is captured at pointerdown deliberately: it is the boundary the user
   * grabbed, not the moving edge, and every frame of the drag is measured
   * against it.
   */
  const dragTightBoundary = (index: number) => (e: React.PointerEvent) => {
    e.stopPropagation()
    const at = editSegments(editRef.current)[index]?.endMs ?? 0
    startDrag(e, (clientX) => {
      const cur = editRef.current
      const segs = editSegments(cur).map((sg) => ({ ...sg }))
      const before = segs[index]
      const after = segs[index + 1]
      if (!before || !after) return
      const ms = msAtClient(clientX)
      if (ms < at) {
        before.endMs = Math.max(before.startMs + MIN_SEGMENT_MS, ms)
        after.startMs = at
      } else {
        before.endMs = at
        after.startMs = Math.min(after.endMs - MIN_SEGMENT_MS, ms)
      }
      // Never let a drag swallow a neighbour outside the pair.
      const prev = segs[index - 1]
      const next = segs[index + 2]
      if (prev) before.startMs = Math.max(before.startMs, prev.endMs)
      if (next) after.endMs = Math.min(after.endMs, next.startMs)
      onEdit({ ...cur, segments: normalizeSegments(cur, segs) })
    })
  }

  /**
   * EVERY EXCLUDED STRETCH LOOKS AND BEHAVES THE SAME (Robert: "for cutted zone
   * from beggining and end apply same shit"). The take's head and tail are cuts
   * too — the global trim excludes them exactly as a mid-cut excludes what is
   * between two clips — so they get the same scrim, the same undo and the same
   * close, and differ only in which edit field the undo resets.
   */
  const zoneActions = (
    startMs: number,
    endMs: number,
    key: string,
    onRestore: () => void,
    onClose: () => void,
  ) => {
    const w = spanW(startMs, endMs)
    return (
      <div key={key} className="tl__gap" style={{ left: x(startMs), width: Math.max(1, w) }}>
        {w >= 24 && (
          <div className="tl__gap-acts">
            <button
              className={`tl__gap-btn${w >= 64 ? ' tl__gap-btn--wide' : ''}`}
              title={`Put back ${formatClock(endMs - startMs)} — undo this cut`}
              aria-label={`Undo this cut and put back ${formatClock(endMs - startMs)}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onRestore()
              }}
            >
              <Icon name="undo" size={12} />
              {w >= 64 && <span>{formatClock(endMs - startMs)}</span>}
            </button>
            {/* CLOSE THE HOLE. The material was already excluded — this only
                stops the timeline spending width on it, so what is kept closes
                up. Robert: "remove it completle and other part will slide to
                each other smoothly". */}
            <button
              className="tl__gap-btn tl__gap-btn--close"
              title="Close this gap — the timeline stops showing it and the rest slides together"
              aria-label="Close this gap"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        )}
      </div>
    )
  }

  /** A closed stretch, and the way back into it. */
  const seam = (atMs: number, key: string, onOpen: () => void) => (
    <button
      key={key}
      type="button"
      className="tl__seam"
      style={{ left: x(atMs) }}
      title="Material was cut out here — click to show it again"
      aria-label="Show what was cut here"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
    />
  )

  /**
   * PUT THE MATERIAL BACK — the undo inside the cut zone itself (UI1, Robert:
   * "make cutted out zone shrink with button undo inside").
   *
   * It extends the clip BEFORE the gap up to the clip after it, rather than
   * merging the two spans into one. That is deliberate: the two clips can carry
   * different speeds (F5b), and merging would silently throw one of them away.
   * `normalizeSegments` decides afterwards whether what is left is really one
   * span, which is the one place that question is answered.
   */
  const restoreGap = (index: number) => {
    const cur = editRef.current
    const segs = editSegments(cur).map((sg) => ({ ...sg }))
    const before = segs[index]
    const after = segs[index + 1]
    if (!before || !after) return
    before.endMs = after.startMs
    onEdit({ ...cur, segments: normalizeSegments(cur, segs) })
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
   * F8: what each lane shows — the take's own frames on a video lane, its own
   * sound on an audio one. Two pixels off the lane height because the bar is
   * inset 1 px top and bottom, so the art fills it exactly.
   */
  const laneArt = useLaneArt(recording, width, FILM_LANE_HEIGHT_PX - 2)
  const anyStrip = Object.values(laneArt).some((a) => a.kind === 'film')

  const step = TICK_STEPS_MS.find((s) => (s / totalMs) * width >= MIN_TICK_PX) ?? 900000
  const ticks: number[] = []
  for (let t = 0; t <= totalMs; t += step) ticks.push(t)

  const gStart = edit.globalTrimStartMs
  const gEnd = edit.globalTrimEndMs

  return (
    <div className={`tl${sliding ? ' tl--sliding' : ''}`}>
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

      <div className={`tl__lanes${anyStrip ? ' tl__lanes--film' : ''}`}>
        {recording.channels.map((ch) => {
          const meta = CHANNEL_META[ch.kind]
          const ce = edit.channels.find((c) => c.channelId === ch.id) ?? fallbackChannelEdit(ch)
          /**
           * THE LANE IS DRAWN IN PIECES, one per stretch of this channel the
           * timeline still shows. With no collapsed hole that is exactly one
           * piece spanning the whole channel, which is the bar this always was.
           *
           * A piece cannot simply stretch the whole filmstrip: the strip was
           * built for the channel's FULL width, so each piece shows a SLICE of
           * it — sized up by how much of the channel it covers and offset to
           * where that slice begins. Getting this wrong is invisible in the
           * geometry and glaring in the picture, which is why the strip is
           * positioned from the channel's own fractions rather than from px.
           */
          const chStart = ch.startOffsetMs
          const chEnd = ch.startOffsetMs + ch.durationMs
          const pieces = visibleSpans(chStart, chEnd)
          /** The kept window, on the RECORDING timeline. */
          const keptStart = chStart + ce.trimStartMs
          const keptEnd = chStart + ce.trimEndMs
          /**
           * F8. The picture is the lane's background and the colour language
           * stays exactly what it was — the kept span keeps its channel tint,
           * only lighter so the frames read through it, and the cut spans turn
           * into a dark scrim rather than a paler tint, because "excluded" over
           * a picture has to be darker and not merely fainter.
           */
          const strip = laneArt[ch.id]?.kind === 'film' ? laneArt[ch.id] : undefined
          const wave = laneArt[ch.id]?.kind === 'wave' ? laneArt[ch.id] : undefined
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
                {width > 0 &&
                  pieces.map((p) => {
                    const left = x(p.startMs)
                    const w = Math.max(2, spanW(p.startMs, p.endMs))
                    // Where this piece sits inside the channel, 0..1 — the
                    // strip and the waveform are both sliced by these.
                    const f0 = (p.startMs - chStart) / Math.max(1, ch.durationMs)
                    const f1 = (p.endMs - chStart) / Math.max(1, ch.durationMs)
                    const fullW = w / Math.max(1e-6, f1 - f0)
                    const slice = (url: string) => ({
                      backgroundImage: `url(${url})`,
                      backgroundSize: `${fullW}px 100%`,
                      backgroundPosition: `${-f0 * fullW}px 0`,
                      backgroundRepeat: 'no-repeat' as const,
                    })
                    // The kept window, clipped to this piece, in piece pixels.
                    const kFrom = Math.max(p.startMs, Math.min(keptStart, p.endMs))
                    const kTo = Math.max(p.startMs, Math.min(keptEnd, p.endMs))
                    const kLeft = spanW(p.startMs, kFrom)
                    const kWidth = spanW(kFrom, kTo)
                    return (
                      <div
                        key={`${ch.id}-${p.startMs}`}
                        className={`lane__bar${ce.enabled ? '' : ' lane__bar--disabled'}`}
                        style={{ left, width: w, ...(strip ? slice(strip.url) : null) }}
                      >
                        <div
                          className="lane__seg lane__seg--cut"
                          style={{ left: 0, width: kLeft, ...cutPaint }}
                        />
                        <div
                          className="lane__seg lane__seg--kept"
                          style={{ left: kLeft, width: kWidth, background: meta.colorVar }}
                        />
                        {/* F8: the sound itself, over the channel's own tint —
                            the opposite layering to the filmstrip, because here
                            the colour is the background and the wave is the
                            content. Pointer-events off so the lane still seeks
                            when clicked. */}
                        {wave && <div className="lane__wave" style={slice(wave.url)} />}
                        <div
                          className="lane__seg lane__seg--cut"
                          style={{ left: kLeft + kWidth, right: 0, ...cutPaint }}
                        />
                      </div>
                    )
                  })}
                {/* The trim edges belong to the CHANNEL, not to a piece — they
                    are one instant each and a collapsed hole must not give them
                    two homes. Positioned in the track, over the pieces. */}
                {width > 0 && (
                  <>
                    <div
                      className="lane__edge lane__edge--l"
                      style={{ left: x(keptStart) - 3 }}
                      onPointerDown={dragChannelTrim(ch, 'start')}
                    />
                    <div
                      className="lane__edge lane__edge--r"
                      style={{ left: x(keptEnd) - 3 }}
                      onPointerDown={dragChannelTrim(ch, 'end')}
                    />
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {width > 0 && (
        <div className="tl__overlay">
          {gStart > 0 &&
            (closedEnds.head
              ? seam(0, 'seam-head', () => setClosedEnds((p) => ({ ...p, head: false })))
              : zoneActions(
                  0,
                  gStart,
                  'zone-head',
                  () => onEdit({ ...editRef.current, globalTrimStartMs: 0 }),
                  () => closeGap(null, 'head'),
                ))}
          {gEnd < totalMs &&
            (closedEnds.tail
              ? seam(totalMs, 'seam-tail', () => setClosedEnds((p) => ({ ...p, tail: false })))
              : zoneActions(
                  gEnd,
                  totalMs,
                  'zone-tail',
                  () => onEdit({ ...editRef.current, globalTrimEndMs: totalMs }),
                  () => closeGap(null, 'tail'),
                ))}
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
                    style={{ left: x(prev.atMs), width: Math.max(2, spanW(prev.atMs, k.atMs)) }}
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
              style={{ left: x(sp.startMs), width: Math.max(2, spanW(sp.startMs, sp.endMs)) }}
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
          {/* Material cut out of the middle. It is drawn RECESSED rather than as
              a band of timeline — there is nothing in it to look at — and it
              carries its own undo, so putting a cut back does not need a
              sentence explaining where the control is (UI1). */}
          {segments.length > 1 &&
            segments.slice(0, -1).map((sg, i) => {
              const removedMs = segments[i + 1]!.startMs - sg.endMs
              // A bare split removes nothing: there is no zone to draw and no
              // cut to undo — the boundary handle is the whole of it.
              if (removedMs <= 0) return null
              if (collapsed.has(sg.endMs)) {
                return seam(sg.endMs, `seam-${i}`, () =>
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    next.delete(sg.endMs)
                    return next
                  }),
                )
              }
              return zoneActions(
                sg.endMs,
                segments[i + 1]!.startMs,
                `gap-${i}`,
                () => restoreGap(i),
                () => closeGap(sg.endMs),
              )
            })}
          {segments.length > 1 &&
            segments.map((sg, i) => {
              /**
               * TWO HANDLES CAN SIT ON THE SAME PIXEL, and that is what a fresh
               * split IS — the clip before it ends exactly where the next one
               * begins. Both were 12 px wide and centred on the boundary, so
               * they overlapped completely and the later one in the DOM won
               * every press: dragging LEFT (trim the clip before) was
               * unreachable, and the handle felt dead. Robert: "cant grab
               * normally grabers after split".
               *
               * When the gap is too narrow to hold both, the hit area is split
               * down the boundary instead — the left half trims the clip that
               * ends there, the right half trims the clip that starts there.
               * Which is also what the gesture already meant.
               */
              const tightBefore =
                i > 0 && spanW(segments[i - 1]!.endMs, sg.startMs) < 14
              const tightAfter =
                i < segments.length - 1 && spanW(sg.endMs, segments[i + 1]!.startMs) < 14
              return (
              /* KEYED BY POSITION, NOT BY TIME, and that is the whole of
                 "still cant drag right grabber after split, barely moves".
                 This used to be `seg-${sg.startMs}`. Dragging the boundary
                 RIGHT moves the NEXT clip's startMs — which was this key — so
                 React unmounted the subtree holding the very handle under the
                 pointer, taking its listeners and its pointer capture with it.
                 The drag died after one move. Dragging LEFT moves the previous
                 clip's endMs, which is in no key, so that direction always
                 worked: exactly the asymmetry reported. */
              <div key={`seg-${i}`}>
                {i > 0 && (
                  <div
                    className={`tl__cut tl__cut--l${tightBefore ? ' tl__cut--tight' : ''}`}
                    style={{ left: x(sg.startMs) }}
                    onPointerDown={
                      tightBefore ? dragTightBoundary(i - 1) : dragCutEdge(i, 'start')
                    }
                    title={tightBefore ? 'Drag either way to cut from here' : 'Drag to move this edge'}
                  />
                )}
                {i < segments.length - 1 && (
                  <div
                    className={`tl__cut tl__cut--r${tightAfter ? ' tl__cut--tight' : ''}`}
                    style={{ left: x(sg.endMs) }}
                    onPointerDown={tightAfter ? dragTightBoundary(i) : dragCutEdge(i, 'end')}
                    title={tightAfter ? 'Drag either way to cut from here' : 'Drag to move this edge'}
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
              )
            })}
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
