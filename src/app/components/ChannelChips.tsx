import type { CaptureConfig, ChannelKind } from '@core/types'
import type { Capabilities } from '@core/capabilities'
import { CHANNEL_KINDS, CHANNEL_META, CONFIG_KEY, isKindSupported } from '@app/lib/channels'
import { Icon } from '@app/components/Icon'

export function ChannelChips({
  prefs,
  caps,
  recording,
  off,
  pending,
  onToggle,
}: {
  prefs: CaptureConfig
  caps: Capabilities
  recording: boolean
  /** During recording: kinds currently stopped (device released, file closed). */
  off: Partial<Record<ChannelKind, boolean>>
  /** During recording: kinds being re-acquired (the picker may be open). */
  pending: Partial<Record<ChannelKind, boolean>>
  onToggle: (kind: ChannelKind) => void
}) {
  return (
    <div className="chips">
      {CHANNEL_KINDS.map((kind) => {
        const meta = CHANNEL_META[kind]
        const on = prefs[CONFIG_KEY[kind]]
        const unsupported = !isKindSupported(kind, caps)
        // Unavailable inputs stay clickable so a press can explain WHY (red +
        // slashed icon signals it up front); never show them as "on".
        // While recording EVERY supported input toggles: off releases the
        // device and ends its file, on re-acquires and late-joins. Only a
        // re-acquire already in flight locks the chip, so a second press
        // cannot open a second picker.
        const busy = recording && !unsupported && !!pending[kind]
        const locked = unsupported ? false : busy
        // Mid-take the engine's own 'off' set is the truth (the browser's "Stop
        // sharing" darkens the chip through it too); before the take, prefs are.
        const isOff = recording && !unsupported ? (off[kind] ?? !on) : !on
        const lit = !unsupported && !isOff
        const cls = [
          'chip',
          unsupported ? 'chip--unavailable' : '',
          lit ? 'chip--on' : '',
          recording && !unsupported && isOff ? 'chip--muted' : '',
          busy ? 'chip--pending' : '',
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <button
            key={kind}
            className={cls}
            disabled={locked}
            title={meta.label}
            aria-pressed={lit}
            aria-busy={busy || undefined}
            onClick={() => onToggle(kind)}
          >
            <Icon name={meta.icon} size={16} slash={isOff || unsupported} />
            <span>{meta.label}</span>
          </button>
        )
      })}
    </div>
  )
}
