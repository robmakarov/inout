import type { CaptureConfig, ChannelKind } from '@core/types'
import type { Capabilities } from '@core/capabilities'
import { CHANNEL_KINDS, CHANNEL_META, CONFIG_KEY, isKindSupported } from '@app/lib/channels'
import { Icon } from '@app/components/Icon'

export function ChannelChips({
  prefs,
  caps,
  recording,
  muted,
  onToggle,
}: {
  prefs: CaptureConfig
  caps: Capabilities
  recording: boolean
  /** During recording: live-muted audio kinds. */
  muted: Partial<Record<ChannelKind, boolean>>
  onToggle: (kind: ChannelKind) => void
}) {
  return (
    <div className="chips">
      {CHANNEL_KINDS.map((kind) => {
        const meta = CHANNEL_META[kind]
        const on = prefs[CONFIG_KEY[kind]]
        const isAudio = kind === 'mic' || kind === 'system-audio'
        const unsupported = !isKindSupported(kind, caps)
        // While recording, video chips are locked; audio chips live-mute,
        // but only if that channel was on at arm time (a stream exists).
        const locked = recording && (!isAudio || !on)
        const isMuted = recording && isAudio && !!muted[kind]
        const cls = [
          'chip',
          on && !isMuted ? 'chip--on' : '',
          isMuted ? 'chip--muted' : '',
          unsupported ? 'chip--unsupported' : '',
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <button
            key={kind}
            className={cls}
            disabled={unsupported || locked}
            title={unsupported ? 'Not supported in this browser' : meta.label}
            aria-pressed={on && !isMuted}
            onClick={() => onToggle(kind)}
          >
            <Icon name={meta.icon} size={16} slash={isMuted} />
            <span>{meta.label}</span>
          </button>
        )
      })}
    </div>
  )
}
