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
  ZOOM_MOVE_MS,
  type TightenProposal,
} from '@core/timeline'
import { CHANNEL_META } from '@app/lib/channels'
import { timelineLanes } from '@app/lib/timelineLanes'
import { useLaneArt } from '@app/hooks/useLaneArt'
import { FILM_LANE_HEIGHT_PX } from '@app/lib/filmstripPlan'
import { formatClock } from '@app/lib/format'
import { Icon } from '@app/components/Icon'

/**
 * Tick spacings, coarse to fine. The five under a second are new with the zoom:
 * a ruler whose finest mark is one second says nothing useful about a window
 * two seconds wide, which is exactly where a fine adjustment is made.
 */
const TICK_STEPS_MS = [
  20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000,
  900000, 1800000, 3600000,
]
const MIN_TICK_PX = 64

/**
 * THE FINEST WINDOW THE TIMELINE WILL SHOW, and it is one second across the
 * whole width — about a millisecond per pixel on the editor's own 900 px lane,
 * which is finer than a frame at any rate this product records. Zooming past
 * that would buy nothing and start losing the shape of the thing being cut.
 */
const MIN_VIEW_MS = 1000
/** One press of − or +. Doubling reaches a second of a 90-minute take in 13. */
const ZOOM_STEP = 2

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The window of the take the timeline draws, in shown-ms. `null` = all of it. */
type Viewport = { startMs: number; spanMs: number } | null

/** A stored window, bounded by the take as it is drawn NOW — a collapsed hole
 *  shortens the axis under a zoom that was set before it, so every read goes
 *  through here rather than trusting what was stored. */
function fitView(v: Viewport, shownMs: number): { startMs: number; spanMs: number } {
  if (!v) return { startMs: 0, spanMs: shownMs }
  const spanMs = clamp(v.spanMs, Math.min(MIN_VIEW_MS, shownMs), shownMs)
  return { startMs: clamp(v.startMs, 0, Math.max(0, shownMs - spanMs)), spanMs }
}

/**
 * A tick's label. `formatClock` is m:ss, which is the right thing for a take
 * measured in minutes and useless at both ends of a zoom: an hour-long take
 * reads "78:24" and a two-second window reads "0:03" three times in a row.
 * Hours appear when the take has them, tenths when the spacing is finer than a
 * second — nothing is rounded away that the eye can see it was told
 * (DECISIONS robert (21)).
 */
function tickLabel(ms: number, stepMs: number, totalMs: number): string {
  const t = Math.max(0, ms)
  const h = Math.floor(t / 3600000)
  const m = Math.floor((t % 3600000) / 60000)
  const s = (t % 60000) / 1000
  const secs = stepMs < 1000 ? s.toFixed(stepMs < 100 ? 2 : 1) : String(Math.round(s))
  const pad = secs.indexOf('.') === 1 || secs.length === 1 ? `0${secs}` : secs
  return totalMs >= 3600000
    ? `${h}:${String(m).padStart(2, '0')}:${pad}`
    : `${h * 60 + m}:${pad}`
}

function startDrag(
  e: React.PointerEvent,
  onMove: (clientX: number) => void,
  /** Called once when the gesture ends, however it ends (up or cancel). */
  onEnd?: () => void,
) {
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
    onEnd?.()
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
  onScrubStart,
  onScrubEnd,
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
  /**
   * A DRAG ON THIS TIMELINE IS A SCRUB, and until 2026-09-02 it was not told
   * so. Robert: "especially annoying noises when i drag now line in timeline
   * around".
   *
   * B2 fixed exactly this noise for the transport Scrubber and the fix is the
   * pair below: a held gesture pauses every element and ramps the preview bus
   * to zero, so the picture follows the hand and nothing is heard. Only the
   * Scrubber ever called it. Dragging the playhead HERE — or the ruler, or a
   * lane — went straight to `seek`, so while playing, every pointermove landed
   * past the audio resync threshold and each one hard-seeked and re-played
   * every audio element: a fresh burst of sound per pointer event, which is
   * the noise. Optional so a caller with no playback can still draw a timeline.
   */
  onScrubStart?: () => void
  onScrubEnd?: () => void
  /** Parent clamps via clampEditState. */
  onEdit: (next: EditState) => void
  /** F5a: the PROPOSED cuts, drawn over the take. The controls that make and
   *  apply them live in ToolsBar, under the picture (UI1). */
  proposal?: TightenProposal | null
}) {
  const rootRef = useRef<HTMLDivElement>(null)
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

  /**
   * ZOOM — THE WINDOW OF THE TAKE THE TIMELINE DRAWS (Robert 2026-09-05: "i
   * also need zoom for timeline for fine adjustment at long take").
   *
   * A 90-minute take on a 900 px lane is six seconds per pixel: every cut, trim
   * and split on it is made with a tolerance of six seconds, which is not an
   * adjustment. The window is held in SHOWN-ms — the axis after collapsed holes
   * are removed — so zooming and collapsing compose instead of fighting: a hole
   * the user closed stays closed at every magnification.
   *
   * `null` is the whole take, and it is the identity: every number below
   * reduces to exactly the arithmetic this timeline had before the zoom
   * existed, so a take nobody zooms behaves as it always did.
   */
  const [view, setView] = useState<Viewport>(null)
  useEffect(() => setView(null), [recording.id])
  const { startMs: viewStart, spanMs: viewSpan } = fitView(view, shownMs)
  const zoomed = viewSpan < shownMs - 0.5
  /**
   * Zoom by a FACTOR, holding one fraction of the window still — the point the
   * gesture was aimed at, so the thing being looked at stays where it is.
   *
   * EVERY UPDATE HERE IS FUNCTIONAL, and that is not style. React batches, so
   * three quick presses of + are three handlers reading ONE window: written the
   * obvious way they all compute "half of 20 s" and the third press does
   * nothing the first did not. Caught on the rig — twelve presses of + moved a
   * 20 s take to 10 s and stopped, because eleven of them were arguing about
   * the same number. Written this way each one halves what the last one left.
   */
  const zoomBy = (factor: number, anchorFrac: number) => {
    setView((prev) => {
      const cur = fitView(prev, shownMs)
      const span = clamp(cur.spanMs * factor, Math.min(MIN_VIEW_MS, shownMs), shownMs)
      if (span >= shownMs) return null
      const anchor = cur.startMs + anchorFrac * cur.spanMs
      return { startMs: clamp(anchor - anchorFrac * span, 0, shownMs - span), spanMs: span }
    })
  }
  const panBy = (deltaShownMs: number) => {
    setView((prev) => {
      if (!prev) return prev
      const cur = fitView(prev, shownMs)
      return {
        startMs: clamp(cur.startMs + deltaShownMs, 0, Math.max(0, shownMs - cur.spanMs)),
        spanMs: cur.spanMs,
      }
    })
  }

  const x = (ms: number) => ((shownAt(ms) - viewStart) / viewSpan) * width
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
  /** Where the pointer is ACROSS the drawn window, 0..1. Pure geometry, so it
   *  is the same answer whatever the window is — which is what lets a batch of
   *  wheel events zoom around one point instead of drifting. */
  const fracAtClient = (clientX: number) => {
    const el = trackRef.current
    if (!el) return 0.5
    const r = el.getBoundingClientRect()
    return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1)
  }
  /** Where the pointer is on the drawn axis, in shown-ms. */
  const shownAtClient = (clientX: number) => viewStart + fracAtClient(clientX) * viewSpan
  const msAtClient = (clientX: number) => msAtShown(shownAtClient(clientX))

  /**
   * PINCH TO ZOOM, TWO FINGERS TO SLIDE — the gesture every timeline on this
   * machine already answers to, so nothing has to be learnt. A trackpad pinch
   * arrives as a wheel event with `ctrlKey`, which is also the browser's own
   * page-zoom gesture: it MUST be prevented, and a passive listener cannot,
   * which is why this is attached by hand rather than through `onWheel` (React
   * registers that one passive and the preventDefault would be ignored).
   *
   * Held in a ref and re-pointed every render, so the listener is attached once
   * and still sees the current window instead of the one it was born with.
   */
  const wheelRef = useRef<(e: WheelEvent) => void>(() => undefined)
  wheelRef.current = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      // Exponential in the wheel delta: the same flick zooms by the same
      // FACTOR wherever it is made, which is the only way a zoom feels linear.
      zoomBy(Math.exp(e.deltaY * 0.006), fracAtClient(e.clientX))
      return
    }
    // A horizontal swipe slides the window; a vertical one is left alone, so a
    // page that scrolls still scrolls under the pointer.
    if (zoomed && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault()
      panBy((e.deltaX / Math.max(1, width)) * viewSpan)
    }
  }
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const handler = (e: WheelEvent) => wheelRef.current(e)
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  /**
   * A DRAWN PIECE NEVER LEAVES THE SCREEN BY MORE THAN A SCREENFUL.
   *
   * A lane bar is one element whose width is the whole of its file, so at the
   * zoom floor of a 90-minute take that element would be five million pixels
   * wide with a background scaled to match — which is not a wide bar, it is a
   * layer no compositor will make. Clipped to the window (with a screenful of
   * slack either side so a pan has something to slide in), the widest bar on
   * screen is about three times the lane and the art still lands on the exact
   * frames it belongs on, because the slice is computed from the clipped span.
   *
   * Empty when the file is nowhere near the window, which is the other half of
   * the saving: at deep zoom most of the take is not drawn at all.
   */
  const clipToView = (sp: { startMs: number; endMs: number }) => {
    const from = msAtShown(viewStart - viewSpan)
    const to = msAtShown(viewStart + viewSpan * 2)
    const startMs = Math.max(sp.startMs, from)
    const endMs = Math.min(sp.endMs, to)
    return endMs > startMs ? [{ startMs, endMs }] : []
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

  /**
   * Every drag that MOVES THE PLAYHEAD — the ruler, a lane, the "now" line —
   * goes through here rather than through startDrag directly, so all three are
   * a scrub and none of them can be forgotten separately again.
   *
   * It also throttles to ~one seek per frame, which the transport Scrubber
   * already did and this did not: a trackpad delivers pointermove at up to
   * 120 Hz and each seek re-seeks every media element in the take, so an
   * unthrottled drag queues work faster than the elements retire it. The first
   * move of a gesture seeks immediately, so nothing feels slower.
   */
  const startSeekDrag = (e: React.PointerEvent) => {
    onScrubStart?.()
    let pending: number | null = null
    let lastAt = 0
    let timer = 0
    const MIN_SEEK_MS = 16
    const flush = () => {
      timer = 0
      const x = pending
      pending = null
      if (x === null) return
      lastAt = performance.now()
      seekAtClient(x)
    }
    startDrag(
      e,
      (clientX) => {
        pending = clientX
        if (performance.now() - lastAt >= MIN_SEEK_MS) flush()
        else if (!timer) timer = window.setTimeout(flush, MIN_SEEK_MS)
      },
      () => {
        if (timer) {
          clearTimeout(timer)
          timer = 0
        }
        // The last position the hand reached must land, or the playhead stops
        // one throttle window short of where it was let go.
        flush()
        onScrubEnd?.()
      },
    )
  }

  /**
   * KEEP THE "NOW" LINE ON THE FRAME IT IS ON.
   *
   * Robert: "split grabber moving that shit on timeline that 'now' line".
   * The playhead is stored as an OUTPUT time and drawn at the RECORDING instant
   * that output time maps to — and cutting is precisely the operation that
   * changes that mapping. So every pixel of a cut drag re-pointed an unchanged
   * output time at a different recording instant, and the line crawled across
   * the timeline while the picture under it never moved.
   *
   * The instant is captured when the gesture starts and re-derived into output
   * time on every move, which is the same trick the speed control already uses
   * for the same reason. If the drag swallows the instant the playhead was on,
   * `recordingToOutputMs` answers null and the line is left alone rather than
   * thrown to an arbitrary place.
   */
  const holdPlayhead = (next: EditState, recMs: number | null) => {
    if (recMs === null) return
    const at = recordingToOutputMs(next, recMs)
    if (at !== null) onSeek(at)
  }
  /** The recording instant under the playhead right now. */
  const playheadNow = () => outputToRecordingMs(editRef.current, Math.min(timeMs, durationMs))

  const dragGlobalTrim = (side: 'start' | 'end') => (e: React.PointerEvent) => {
    e.stopPropagation()
    const hold = playheadNow()
    startDrag(e, (clientX) => {
      const ms = msAtClient(clientX)
      const cur = editRef.current
      const next =
        side === 'start' ? { ...cur, globalTrimStartMs: ms } : { ...cur, globalTrimEndMs: ms }
      onEdit(next)
      holdPlayhead(next, hold)
    })
  }

  const updateChannel = (channelId: string, patch: Partial<ChannelEdit>) => {
    const cur = editRef.current
    onEdit({
      ...cur,
      channels: cur.channels.map((c) => (c.channelId === channelId ? { ...c, ...patch } : c)),
    })
  }

  /**
   * The eye belongs to the INPUT now, so it takes every file that input wrote —
   * one press, one gesture. Hiding "the camera" and getting two of its three
   * stretches back would be the same defect one layer down.
   */
  const setLaneEnabled = (channels: readonly ChannelRecording[], enabled: boolean) => {
    const ids = new Set(channels.map((c) => c.id))
    const cur = editRef.current
    onEdit({
      ...cur,
      channels: cur.channels.map((c) => (ids.has(c.channelId) ? { ...c, enabled } : c)),
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

  /**
   * A ZOOMED TIMELINE FOLLOWS THE PLAYHEAD OUT OF ITS OWN WINDOW. Without this
   * the picture plays on and the timeline sits on a stretch that is no longer
   * happening — the one behaviour that would make the zoom useless for the
   * thing it was asked for.
   *
   * It moves ONLY when the playhead has actually left the window, so it can
   * never fight a hand that is panning or scrubbing: during a scrub the
   * playhead is under the pointer, which is inside the window by construction.
   * The window jumps a page rather than centring, so the eye is not asked to
   * track a constantly sliding ruler.
   */
  const headShown = shownAt(playheadRecMs)
  const headFrac = (headShown - viewStart) / Math.max(1, viewSpan)
  useEffect(() => {
    if (!zoomed) return
    if (headFrac >= 0 && headFrac <= 1) return
    setView((prev) => {
      if (!prev) return prev
      const cur = fitView(prev, shownMs)
      return {
        startMs: clamp(headShown - cur.spanMs * 0.1, 0, Math.max(0, shownMs - cur.spanMs)),
        spanMs: cur.spanMs,
      }
    })
  }, [headShown, headFrac, zoomed, shownMs])

  /** The − / + / fit control, anchored on the playhead when it is on screen so
   *  a press zooms into the frame the user is looking at. */
  const zoomAnchor = () => (headFrac >= 0 && headFrac <= 1 ? headFrac : 0.5)
  const zoomIn = () => zoomBy(1 / ZOOM_STEP, zoomAnchor())
  const zoomOut = () => zoomBy(ZOOM_STEP, zoomAnchor())
  const dropSegment = (index: number) => {
    onEdit(removeSegment(editRef.current, index))
  }
  /** Drag the boundary between two kept spans — i.e. move the cut. */
  const dragCutEdge = (index: number, side: 'end' | 'start') => (e: React.PointerEvent) => {
    e.stopPropagation()
    const hold = playheadNow()
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
      const edited = { ...cur, segments: normalizeSegments(cur, segs) }
      onEdit(edited)
      holdPlayhead(edited, hold)
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
    const hold = playheadNow()
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
      const edited = { ...cur, segments: normalizeSegments(cur, segs) }
      onEdit(edited)
      holdPlayhead(edited, hold)
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
   * AND UNDO MEANS UNDO: the two clips become ONE again, so the boundary
   * handles go with the cut that created them. Robert: "when split undone
   * remove grabbers too, merge back". It used to only extend the clip before
   * the gap up to the clip after it, leaving two spans touching at a point —
   * `normalizeSegments` merges overlaps, never adjacencies (a fresh split IS an
   * adjacency, and collapsing that would undo the split the instant it was
   * made). So pressing undo gave back the material and left a pair of grabbers
   * on an edge that no longer cut anything: a control standing on nothing.
   *
   * THE ONE CASE THAT STILL DOES NOT MERGE is two clips at DIFFERENT speeds
   * (F5b) — merging would silently throw one of them away, and there the
   * boundary is real, so it keeps its handles and only the hole closes.
   */
  const restoreGap = (index: number) => {
    const cur = editRef.current
    const segs = editSegments(cur).map((sg) => ({ ...sg }))
    const before = segs[index]
    const after = segs[index + 1]
    if (!before || !after) return
    if (segmentSpeed(before) === segmentSpeed(after)) {
      segs.splice(index, 2, { ...before, endMs: after.endMs })
    } else {
      before.endMs = after.startMs
    }
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

  /** One row per INPUT, holding every file that input wrote. See timelineLanes. */
  const lanes = timelineLanes(recording.channels)

  /**
   * The ruler reads the WINDOW, not the take: the spacing is chosen for what is
   * on screen and only the marks inside it are built. At a second per screen on
   * a 90-minute take, marking the whole take at that spacing would be a third
   * of a million DOM nodes to draw twenty.
   */
  const step =
    TICK_STEPS_MS.find((s) => (s / Math.max(1, viewSpan)) * width >= MIN_TICK_PX) ?? 3600000
  const ticks: number[] = []
  {
    const from = Math.max(0, Math.floor(msAtShown(viewStart) / step) * step)
    const to = Math.min(totalMs, msAtShown(viewStart + viewSpan))
    for (let t = from; t <= to; t += step) ticks.push(t)
  }

  const gStart = edit.globalTrimStartMs
  const gEnd = edit.globalTrimEndMs

  return (
    <div ref={rootRef} className={`tl${sliding ? ' tl--sliding' : ''}`}>
      <div className="tl__row tl__row--ruler">
        {/* THE ZOOM LIVES IN THE RULER'S OWN GUTTER — dead space until now, and
            the one place on this control where a length belongs. The readout is
            what is ON SCREEN, not a magnification factor: "0:12" answers the
            question a person actually has, and pressing it fits the take back.
            Robert 2026-09-05: "i also need zoom for timeline for fine
            adjustment at long take". */}
        <div className="tl__gutter tl__zoombar">
          <button
            className="tl__zoombtn"
            onClick={zoomOut}
            disabled={!zoomed}
            title="Show more of the take (or pinch on the timeline)"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            className="tl__zoomspan"
            onClick={() => setView(null)}
            disabled={!zoomed}
            title={zoomed ? 'Fit the whole take' : 'The whole take is on screen'}
          >
            {formatClock(viewSpan)}
          </button>
          <button
            className="tl__zoombtn"
            onClick={zoomIn}
            disabled={viewSpan <= Math.min(MIN_VIEW_MS, shownMs) + 0.5}
            title="Zoom in for a finer cut (or pinch on the timeline)"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
        <div
          ref={trackRef}
          className="tl__ruler"
          onPointerDown={(e) => startSeekDrag(e)}
        >
          {width > 0 &&
            ticks.map((t) => (
              <div key={t} className="tl__tick" style={{ left: x(t) }}>
                <span className="tl__tick-label">{tickLabel(t, step, totalMs)}</span>
              </div>
            ))}
        </div>
      </div>

      <div className={`tl__lanes${anyStrip ? ' tl__lanes--film' : ''}`}>
        {lanes.map(({ kind, channels }) => {
        const meta = CHANNEL_META[kind]
        const laneEdits = channels.map(
          (c) => edit.channels.find((ce) => ce.channelId === c.id) ?? fallbackChannelEdit(c),
        )
        const laneShown = laneEdits.some((ce) => ce.enabled)
        const laneFilm = channels.some((c) => laneArt[c.id]?.kind === 'film')
        return (
          <div key={kind} className={`tl__row lane${laneFilm ? ' lane--film' : ''}`}>
            <div className="tl__gutter lane__gutter">
              <span className="lane__icon" style={{ color: meta.colorVar }}>
                <Icon name={meta.icon} size={14} />
              </span>
              <span className="lane__label">{meta.label}</span>
              <button
                className="lane__eye"
                title={laneShown ? 'Hide channel' : 'Show channel'}
                aria-pressed={laneShown}
                onClick={() => setLaneEnabled(channels, !laneShown)}
              >
                <Icon name={laneShown ? 'eye' : 'eye-off'} size={14} />
              </button>
            </div>
            <div className="lane__track" onPointerDown={(e) => startSeekDrag(e)}>
              {channels.map((ch, ci) => {
          const ce = laneEdits[ci]!
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
          const pieces = visibleSpans(chStart, chEnd).flatMap(clipToView)
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
            <div key={ch.id} className="lane__clip">
                {width > 0 &&
                  pieces.map((p, pi) => {
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
                        /* By POSITION, not by instant: a clipped piece's start
                           moves with every pan, and keying on it would unmount
                           and rebuild every bar on the screen each frame. */
                        key={`${ch.id}-${pi}`}
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
          )
              })}
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
            onPointerDown={(e) => startSeekDrag(e)}
          />
        </div>
      )}
    </div>
  )
}
