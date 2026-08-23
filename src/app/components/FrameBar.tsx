import type { BackgroundStyle, EditState } from '@core/types'
import {
  BACKGROUND_PRESETS,
  DEFAULT_BACKGROUND,
  PAD_STEPS,
  backgroundIsActive,
} from '@core/compose/background'
import { Icon } from '@app/components/Icon'

/**
 * The background frame control (task F3).
 *
 * Every take starts full-bleed and stays that way until the user asks for
 * something — the frozen rule. So "None" is a real, reachable state and picking
 * it deletes the field rather than storing a do-nothing style.
 *
 * Picking a backdrop while the surface is flush also gives it a medium inset:
 * a background nobody can see is a control that looks broken.
 */
export function FrameBar({
  edit,
  onEdit,
}: {
  edit: EditState
  onEdit: (next: EditState) => void
}) {
  const bg = edit.background
  const active = backgroundIsActive(bg)
  const current = bg ?? DEFAULT_BACKGROUND

  const apply = (patch: Partial<BackgroundStyle>): void => {
    const next: BackgroundStyle = { ...current, ...patch }
    if (!backgroundIsActive(next)) {
      const { background: _dropped, ...rest } = edit
      onEdit(rest)
      return
    }
    onEdit({ ...edit, background: next })
  }

  const pickPreset = (id: string): void => {
    if (id === 'none') {
      const { background: _dropped, ...rest } = edit
      onEdit(rest)
      return
    }
    const medium = PAD_STEPS.find((s) => s.id === 'm')!
    const flush = current.padFrac <= 0
    apply({
      preset: id,
      padFrac: flush ? medium.padFrac : current.padFrac,
      radiusFrac: flush ? medium.radiusFrac : current.radiusFrac,
    })
  }

  const activePresetId = active ? current.preset : 'none'
  const padStepId =
    PAD_STEPS.find((s) => Math.abs(s.padFrac - (active ? current.padFrac : 0)) < 0.005)?.id ??
    'custom'

  return (
    <div className="frame-bar">
      <span className="frame-bar__label">Frame</span>
      <div className="frame-bar__swatches" role="radiogroup" aria-label="Background">
        {BACKGROUND_PRESETS.map((p) => (
          <button
            key={p.id}
            role="radio"
            aria-checked={p.id === activePresetId}
            aria-label={p.label}
            title={p.label}
            className={`frame-bar__swatch${p.id === activePresetId ? ' frame-bar__swatch--on' : ''}${
              p.id === 'none' ? ' frame-bar__swatch--none' : ''
            }`}
            style={p.id === 'none' ? undefined : { background: p.swatch }}
            onClick={() => pickPreset(p.id)}
          >
            {p.id === 'none' ? <Icon name="x" size={11} /> : null}
          </button>
        ))}
      </div>

      <div className="frame-bar__steps" role="radiogroup" aria-label="Frame inset">
        {PAD_STEPS.map((s) => (
          <button
            key={s.id}
            role="radio"
            aria-checked={s.id === padStepId}
            disabled={!active}
            className={`frame-bar__step${s.id === padStepId && active ? ' frame-bar__step--on' : ''}`}
            onClick={() => apply({ padFrac: s.padFrac, radiusFrac: s.radiusFrac })}
          >
            {s.label}
          </button>
        ))}
      </div>

      <button
        className={`frame-bar__step${active && current.shadow ? ' frame-bar__step--on' : ''}`}
        disabled={!active}
        aria-pressed={active && current.shadow}
        onClick={() => apply({ shadow: !current.shadow })}
      >
        Shadow
      </button>
    </div>
  )
}
