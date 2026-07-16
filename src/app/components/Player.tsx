import { useRef } from 'react'
import type { EditState, Recording } from '@core/types'
import { activeChannelsAt, channelHasOutputWindow, hasEnabledVideo } from '@core/timeline'
import type { Playback } from '@app/hooks/usePlayback'
import { formatClock } from '@app/lib/format'
import { Icon } from '@app/components/Icon'

function Scrubber({
  value,
  max,
  onSeek,
}: {
  value: number
  max: number
  onSeek: (ms: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const toMs = (clientX: number) => {
    const el = ref.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
    return f * max
  }
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
        onSeek(toMs(e.clientX))
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) onSeek(toMs(e.clientX))
      }}
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

export function Player({
  recording,
  edit,
  pb,
}: {
  recording: Recording
  edit: EditState
  pb: Playback
}) {
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
      <div className="stage">
        {recording.channels.map((ch) => {
          const url = pb.urls[ch.id]
          if (!url) return null
          if (ch.media === 'audio') {
            return <audio key={ch.id} ref={pb.elementRef(ch.id)} src={url} preload="auto" />
          }
          const isActive = active.some((c) => c.id === ch.id)
          let cls: string
          if (ch.kind === 'camera') {
            cls = screenInComposition ? 'stage__pip' : 'stage__full'
          } else {
            cls = 'stage__screen'
          }
          if (!isActive) cls += ' is-hidden'
          return (
            <video
              key={ch.id}
              ref={pb.elementRef(ch.id)}
              className={cls}
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
      <div className="transport">
        <button
          className="transport__play"
          onClick={pb.toggle}
          disabled={!pb.ready}
          aria-label={pb.playing ? 'Pause' : 'Play'}
        >
          <Icon name={pb.playing ? 'pause' : 'play'} size={20} />
        </button>
        <span className="transport__time">
          {formatClock(pb.timeMs)} <span className="transport__time-sep">/</span>{' '}
          {formatClock(pb.durationMs)}
        </span>
        <Scrubber value={pb.timeMs} max={pb.durationMs} onSeek={pb.seek} />
      </div>
    </div>
  )
}
