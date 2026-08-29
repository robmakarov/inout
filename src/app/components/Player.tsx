import { useEffect, useRef, useState } from 'react'
import type { CameraPose, ChannelRecording, EditState, Recording, Viewport } from '@core/types'
import {
  activeChannelsAt,
  cameraPoseAt,
  cameraTrackIsActive,
  channelHasOutputWindow,
  clampPose,
  clampViewport,
  hasEnabledVideo,
  outputToRecordingMs,
  poseToRect,
  viewportAt,
  viewportToRect,
  viewportTrackIsActive,
  writeCameraKeyframe,
  writeViewportKeyframe,
  zoomAround,
  type CameraGeometry,
} from '@core/timeline'
import {
  backgroundCss,
  backgroundIsActive,
  containRect,
  screenInsetRect,
  shadowFor,
} from '@core/compose/background'
import type { Playback } from '@app/hooks/usePlayback'
import { formatClock } from '@app/lib/format'
import { Icon } from '@app/components/Icon'

function Scrubber({
  value,
  max,
  onSeek,
  onScrubStart,
  onScrubEnd,
}: {
  value: number
  max: number
  onSeek: (ms: number) => void
  onScrubStart: () => void
  onScrubEnd: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  /** Latest pointer position, and the frame that will consume it. */
  const pending = useRef<number | null>(null)
  const raf = useRef(0)
  const toMs = (clientX: number) => {
    const el = ref.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
    return f * max
  }
  /**
   * ONE SEEK PER FRAME, not one per pointer event. A trackpad drag delivers
   * pointermove at up to 120 Hz and each seek re-seeks every media element in
   * the take; coalescing to the frame the user can actually see costs nothing
   * and stops the drag from queueing work faster than the elements retire it.
   */
  const queueSeek = (clientX: number) => {
    pending.current = clientX
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      const x = pending.current
      pending.current = null
      if (x !== null) onSeek(toMs(x))
    })
  }
  const endDrag = () => {
    if (raf.current) {
      cancelAnimationFrame(raf.current)
      raf.current = 0
    }
    // Land on the last position the pointer actually reached — a drag that
    // ends between frames must not be rounded back to the previous one.
    const x = pending.current
    pending.current = null
    if (x !== null) onSeek(toMs(x))
    onScrubEnd()
  }
  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current)
  }, [])
  return (
    <div
      ref={ref}
      className="scrubber"
      onPointerDown={(e) => {
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // synthetic or already-released pointer
        }
        onScrubStart()
        onSeek(toMs(e.clientX))
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) queueSeek(e.clientX)
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className="scrubber__fill"
        style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }}
      />
    </div>
  )
}

function WaveGlyph() {
  const bars = [8, 16, 26, 14, 22, 10, 18, 25, 12, 20, 9, 15]
  return (
    <svg width="120" height="40" viewBox="0 0 120 40" aria-hidden="true" className="stage__wave">
      {bars.map((h, i) => (
        <rect
          key={i}
          x={i * 10 + 3}
          y={20 - h / 2}
          width="4"
          height={h}
          rx="2"
          fill="currentColor"
        />
      ))}
    </svg>
  )
}

/** 16:9, matching .stage's aspect-ratio and every export tier. */
const STAGE_ASPECT = 16 / 9

/**
 * The camera PiP, movable directly on the stage (task F4). Drag it and the
 * export moves it AT the playhead instant you dragged it — the pose the
 * compositor samples is the same function this box is positioned by, which is
 * what makes preview↔export parity a property instead of a coincidence.
 */
function CameraPip({
  channel,
  videoRef,
  url,
  hidden,
  edit,
  recording,
  playheadMs,
  onEdit,
  zoomWidthFrac,
}: {
  channel: ChannelRecording
  videoRef: (el: HTMLVideoElement | null) => void
  url: string
  hidden: boolean
  edit: EditState
  recording: Recording
  playheadMs: number
  onEdit: (next: EditState) => void
  /** Visible fraction of the frame (F2). A drag of N stage pixels moves the PiP
   *  by fewer FRAME fractions when the view is zoomed in. */
  zoomWidthFrac: number
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  // The source aspect decides the box's height. Older takes have no dimensions
  // stored, so the element itself reports them once it has metadata.
  const [aspect, setAspect] = useState<number>(() =>
    channel.width && channel.height ? channel.width / channel.height : 4 / 3,
  )
  /** Live pose while a gesture is in flight — committed on release.
   * The REF is the source of truth and the state only exists to re-render:
   * a drag whose move and up land in the same task (a fast flick, or a
   * scripted gesture) never lets React re-render in between, so reading the
   * state in the release handler would read a stale closure and silently
   * commit nothing. */
  const [, setDragTick] = useState(0)
  const gesture = useRef<{
    kind: 'move' | 'resize'
    startX: number
    startY: number
    from: CameraPose
    /** Recording-timeline instant the gesture began at — a playhead that keeps
     * running must not smear where the move lands. */
    atMs: number
    stageW: number
    stageH: number
    live: CameraPose | null
  } | null>(null)
  const dragPose = gesture.current?.live ?? null

  const geometry: CameraGeometry = { frameAspect: STAGE_ASPECT, cameraAspect: aspect }
  const recordingMs = outputToRecordingMs(edit, playheadMs) ?? edit.globalTrimStartMs
  const committed = cameraPoseAt(edit.camera, recordingMs, geometry)
  const pose = dragPose ?? committed
  const rect = poseToRect(pose, geometry)
  const moved = cameraTrackIsActive(edit.camera)

  const begin = (kind: 'move' | 'resize') => (e: React.PointerEvent) => {
    const stage = boxRef.current?.parentElement
    if (!stage) return
    e.preventDefault()
    e.stopPropagation()
    const r = stage.getBoundingClientRect()
    gesture.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      from: committed,
      atMs: recordingMs,
      stageW: Math.max(1, r.width),
      stageH: Math.max(1, r.height),
      live: null,
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // synthetic pointer — capture is a nicety, the gesture still works
    }
  }

  const move = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g) return
    // Stage pixels -> FRAME fractions. Under a zoom the stage shows only
    // zoomWidthFrac of the frame, so the same gesture is a smaller move.
    const dx = ((e.clientX - g.startX) / g.stageW) * zoomWidthFrac
    const dy = ((e.clientY - g.startY) / g.stageH) * zoomWidthFrac
    const next =
      g.kind === 'move'
        ? { ...g.from, xFrac: g.from.xFrac + dx, yFrac: g.from.yFrac + dy }
        : // Resize from the corner: the far edges stay put, so the box grows
          // away from the handle and the centre moves half as far.
          {
            widthFrac: g.from.widthFrac - dx * 2,
            xFrac: g.from.xFrac,
            yFrac: g.from.yFrac,
          }
    g.live = clampPose(next, geometry)
    setDragTick((n) => n + 1)
  }

  const end = () => {
    const g = gesture.current
    gesture.current = null
    setDragTick((n) => n + 1)
    if (!g?.live) return
    onEdit({
      ...edit,
      camera: writeCameraKeyframe(edit.camera, g.atMs, g.live, geometry, recording.durationMs),
    })
  }

  const reset = (e: React.MouseEvent) => {
    e.stopPropagation()
    const { camera: _dropped, ...rest } = edit
    onEdit(rest)
  }

  return (
    <div
      ref={boxRef}
      className={`pip${hidden ? ' is-hidden' : ''}${dragPose ? ' pip--dragging' : ''}`}
      style={{
        left: `${rect.leftFrac * 100}%`,
        top: `${rect.topFrac * 100}%`,
        width: `${rect.widthFrac * 100}%`,
        height: `${rect.heightFrac * 100}%`,
      }}
      onPointerDown={begin('move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <video
        ref={videoRef}
        className="pip__video"
        src={url}
        preload="auto"
        playsInline
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          if (v.videoWidth > 0 && v.videoHeight > 0) setAspect(v.videoWidth / v.videoHeight)
        }}
      />
      <div
        className="pip__grip"
        onPointerDown={begin('resize')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        aria-label="Resize camera"
      />
      {moved && (
        <button className="pip__reset" onClick={reset} aria-label="Reset camera position">
          <Icon name="x" size={11} />
        </button>
      )}
    </div>
  )
}

/**
 * The screen surface, framed (task F3).
 *
 * Without a background this is exactly the old element: inset 0, object-fit
 * contain, no radius. With one, the element is positioned ON the picture — the
 * contain box computed by the same function the export compositor uses — so the
 * rounded corners hug the video rather than the letterbox, in both renderers.
 * Falling back to the padding box until the source aspect is known keeps the
 * first frame sane rather than exact for a few milliseconds.
 */
function StageScreen({
  channel,
  videoRef,
  url,
  hidden,
  background,
  stageHeightPx,
}: {
  channel: ChannelRecording
  videoRef: (el: HTMLVideoElement | null) => void
  url: string
  hidden: boolean
  background: EditState['background']
  /** Measured, because radius and shadow are fractions of frame HEIGHT and a
   *  CSS percentage would resolve them per-axis into an ellipse. */
  stageHeightPx: number
}) {
  const [aspect, setAspect] = useState<number | null>(() =>
    channel.width && channel.height ? channel.width / channel.height : null,
  )
  const framed = backgroundIsActive(background)
  let style: React.CSSProperties | undefined
  if (framed) {
    const box = screenInsetRect(background, STAGE_ASPECT)
    const rect = aspect ? containRect(box, STAGE_ASPECT, aspect) : box
    const shadow = shadowFor(background, stageHeightPx)
    style = {
      left: `${rect.leftFrac * 100}%`,
      top: `${rect.topFrac * 100}%`,
      width: `${rect.widthFrac * 100}%`,
      height: `${rect.heightFrac * 100}%`,
      borderRadius: `${(background?.radiusFrac ?? 0) * stageHeightPx}px`,
      boxShadow: shadow
        ? `0 ${shadow.offsetY}px ${shadow.blur}px ${shadow.color}`
        : undefined,
      objectFit: aspect ? 'fill' : 'contain',
    }
  }
  return (
    <video
      ref={videoRef}
      className={`stage__screen${hidden ? ' is-hidden' : ''}${framed ? ' stage__screen--framed' : ''}`}
      src={url}
      preload="auto"
      playsInline
      style={style}
      onLoadedMetadata={(e) => {
        const v = e.currentTarget
        if (v.videoWidth > 0 && v.videoHeight > 0) setAspect(v.videoWidth / v.videoHeight)
      }}
    />
  )
}

/**
 * Timed zoom and pan on the stage (task F2).
 *
 * The stage shows the visible rect by applying the SAME transform the export
 * compositor applies — one scale about the frame's top-left — so the preview is
 * not an approximation of the file, it is the same arithmetic. Gestures write
 * keyframes through the same writeViewportKeyframe the pure module exposes.
 */
function useViewportGesture(
  edit: EditState,
  recording: Recording,
  playheadMs: number,
  onEdit: (next: EditState) => void,
  stageRef: React.RefObject<HTMLDivElement | null>,
) {
  const [, tick] = useState(0)
  /** Live view during a gesture; the ref is the truth, the state only redraws
   *  (same reason CameraPip keeps one: a flick can move and release inside a
   *  single task, and a state read would be stale). */
  const live = useRef<Viewport | null>(null)
  const pan = useRef<{ startX: number; startY: number; from: Viewport; atMs: number; w: number; h: number } | null>(null)
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const recordingMs = outputToRecordingMs(edit, playheadMs) ?? edit.globalTrimStartMs
  const committed = viewportAt(edit.viewport, recordingMs)
  const view = live.current ?? committed

  const commit = (next: Viewport, atMs: number): void => {
    onEdit({
      ...edit,
      viewport: writeViewportKeyframe(edit.viewport, atMs, next, recording.durationMs),
    })
  }

  /** Stage-relative pointer -> FRAME fractions, through the current view. */
  const toFrameFrac = (clientX: number, clientY: number): { x: number; y: number } => {
    const el = stageRef.current
    if (!el) return { x: 0.5, y: 0.5 }
    const r = el.getBoundingClientRect()
    const rect = viewportToRect(view)
    return {
      x: rect.leftFrac + ((clientX - r.left) / Math.max(1, r.width)) * rect.widthFrac,
      y: rect.topFrac + ((clientY - r.top) / Math.max(1, r.height)) * rect.heightFrac,
    }
  }

  const onWheel = (e: React.WheelEvent): void => {
    // Wheel-to-zoom only makes sense on a composition with pixels in it.
    if (!recording.channels.some((c) => c.media === 'video')) return
    e.preventDefault()
    const anchor = toFrameFrac(e.clientX, e.clientY)
    // Exponential in the wheel delta: the same flick zooms by the same RATIO
    // whether the view is wide or tight.
    const next = zoomAround(view, view.widthFrac * Math.exp(e.deltaY * 0.0015), anchor.x, anchor.y)
    live.current = next
    tick((n) => n + 1)
    // A wheel has no release, so the commit is debounced — and because a commit
    // replaces the keyframes it travels through, the last one wins cleanly.
    if (commitTimer.current) clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => {
      const settled = live.current
      live.current = null
      if (settled) commit(settled, recordingMs)
    }, 180)
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (view.widthFrac >= 1) return
    const el = stageRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    e.preventDefault()
    pan.current = {
      startX: e.clientX,
      startY: e.clientY,
      from: view,
      atMs: recordingMs,
      w: Math.max(1, r.width),
      h: Math.max(1, r.height),
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // synthetic pointer — capture is a nicety, the gesture still works
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const g = pan.current
    if (!g) return
    // Dragging moves the PICTURE, so the view moves the other way.
    const dx = ((e.clientX - g.startX) / g.w) * g.from.widthFrac
    const dy = ((e.clientY - g.startY) / g.h) * g.from.widthFrac
    live.current = clampViewport({
      widthFrac: g.from.widthFrac,
      xFrac: g.from.xFrac - dx,
      yFrac: g.from.yFrac - dy,
    })
    tick((n) => n + 1)
  }

  const onPointerUp = (): void => {
    const g = pan.current
    pan.current = null
    const settled = live.current
    live.current = null
    tick((n) => n + 1)
    if (g && settled) commit(settled, g.atMs)
  }

  const reset = (): void => {
    live.current = null
    if (commitTimer.current) clearTimeout(commitTimer.current)
    const { viewport: _dropped, ...rest } = edit
    onEdit(rest)
  }

  useEffect(
    () => () => {
      if (commitTimer.current) clearTimeout(commitTimer.current)
    },
    [],
  )

  const rect = viewportToRect(view)
  return {
    view,
    rect,
    active: viewportTrackIsActive(edit.viewport) || view.widthFrac < 1,
    zoomed: view.widthFrac < 0.999,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
    reset,
  }
}

export function Player({
  recording,
  edit,
  pb,
  onBack,
  onExport,
  onEdit,
  showExport,
}: {
  recording: Recording
  edit: EditState
  pb: Playback
  onBack: () => void
  onExport: () => void
  onEdit: (next: EditState) => void
  /** Hidden while the export panel owns the bottom slot. */
  showExport: boolean
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageHeight, setStageHeight] = useState(0)
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageHeight(el.clientHeight))
    ro.observe(el)
    setStageHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const zoom = useViewportGesture(edit, recording, pb.timeMs, onEdit, stageRef)
  const active = activeChannelsAt(recording, edit, pb.timeMs)
  // Slot is decided per composition, not per instant, so the camera never
  // jumps between PiP and full-frame across momentary screen gaps.
  const screenInComposition = recording.channels.some(
    (c) => c.kind === 'screen' && c.media === 'video' && channelHasOutputWindow(recording, edit, c.id),
  )
  // The wave glyph marks an audio-only composition, not a momentary video gap.
  const audioOnly = !hasEnabledVideo(recording, edit)

  return (
    <div className="player">
      <div
        ref={stageRef}
        className={`stage${zoom.zoomed ? ' stage--zoomed' : ''}`}
        style={{ background: backgroundCss(edit.background) }}
        {...zoom.handlers}
      >
        {/* F2: one transform, the same arithmetic the export compositor uses —
            scale about the frame's top-left, so a preview pixel and an exported
            pixel are the same pixel. */}
        <div
          className="stage__view"
          style={
            zoom.zoomed
              ? {
                  transform: `scale(${1 / zoom.rect.widthFrac}) translate(${-zoom.rect.leftFrac * 100}%, ${-zoom.rect.topFrac * 100}%)`,
                }
              : undefined
          }
        >
        {recording.channels.map((ch) => {
          const url = pb.urls[ch.id]
          if (!url) return null
          if (ch.media === 'audio') {
            return <audio key={ch.id} ref={pb.elementRef(ch.id)} src={url} preload="auto" />
          }
          const isActive = active.some((c) => c.id === ch.id)
          // The PiP is the one surface the user can move (F4). Camera-full has
          // no PiP to grab, and that rule is unchanged.
          if (ch.kind === 'camera' && screenInComposition) {
            return (
              <CameraPip
                key={ch.id}
                channel={ch}
                videoRef={pb.elementRef(ch.id)}
                url={url}
                hidden={!isActive}
                edit={edit}
                recording={recording}
                playheadMs={pb.timeMs}
                onEdit={onEdit}
                zoomWidthFrac={zoom.rect.widthFrac}
              />
            )
          }
          if (ch.kind === 'screen') {
            return (
              <StageScreen
                key={ch.id}
                channel={ch}
                videoRef={pb.elementRef(ch.id)}
                url={url}
                hidden={!isActive}
                background={edit.background}
                stageHeightPx={stageHeight}
              />
            )
          }
          return (
            <video
              key={ch.id}
              ref={pb.elementRef(ch.id)}
              className={`stage__full${isActive ? '' : ' is-hidden'}`}
              src={url}
              preload="auto"
              playsInline
            />
          )
        })}
        {audioOnly && (
          <div className="stage__audio">
            <WaveGlyph />
          </div>
        )}
        </div>
        {zoom.active && (
          <button
            className="stage__zoom-reset"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              zoom.reset()
            }}
            title="Reset zoom"
          >
            {Math.round((1 / zoom.rect.widthFrac) * 10) / 10}× <Icon name="x" size={11} />
          </button>
        )}
      </div>
      <div className="transport">
        <button
          className="transport__back"
          onClick={onBack}
          aria-label="Back to capture"
        >
          <Icon name="chevron-left" size={20} />
        </button>
        <button
          className="transport__play"
          onClick={pb.toggle}
          disabled={!pb.ready}
          aria-label={pb.playing ? 'Pause' : 'Play'}
        >
          <Icon name={pb.playing ? 'pause' : 'play'} size={18} />
        </button>
        <span className="transport__time">
          {formatClock(pb.timeMs)} <span className="transport__time-sep">/</span>{' '}
          {formatClock(pb.durationMs)}
        </span>
        <Scrubber
          value={pb.timeMs}
          max={pb.durationMs}
          onSeek={pb.seek}
          onScrubStart={pb.scrubStart}
          onScrubEnd={pb.scrubEnd}
        />
        {showExport && (
          <button className="btn btn--primary transport__export" onClick={onExport}>
            Export
          </button>
        )}
      </div>
    </div>
  )
}
