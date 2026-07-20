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
        // Unavailable inputs stay clickable so a press can explain WHY (red +
        // slashed icon signals it up front); never show them as "on".
        // While recording, video chips are locked; audio chips live-mute,
        // but only if that channel was on at arm time (a stream exists).
        const locked = !unsupported && recording && (!isAudio || !on)
        const isMuted = !unsupported && recording && isAudio && !!muted[kind]
        const cls = [
          'chip',
          unsupported ? 'chip--unavailable' : '',
          !unsupported && on && !isMuted ? 'chip--on' : '',
          isMuted ? 'chip--muted' : '',
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <button
            key={kind}
            className={cls}
            disabled={locked}
            title={meta.label}
            aria-pressed={!unsupported && on && !isMuted}
            onClick={() => onToggle(kind)}
          >
            <Icon name={meta.icon} size={16} slash={isMuted || unsupported} />
            <span>{meta.label}</span>
          </button>
        )
      })}
    </div>
  )
}
