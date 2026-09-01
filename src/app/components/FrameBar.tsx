import type { BackgroundStyle, EditState } from '@core/types'
import {
  BACKGROUND_PRESETS,
  DEFAULT_BACKGROUND,
  PAD_STEPS,
  backgroundIsActive,
} from '@core/compose/background'
import { Icon } from '@app/components/Icon'

/**
 * The background frame control (task F3), A VERTICAL RAIL BESIDE THE STAGE —
 * Robert: "move stuff ... from panel to float by right side of video frame
 * vertically", then "move zoom and frame setting outside of screen, next to
 * it". It used to be the tail of the tools row under the picture, which is the
 * one place a control about the picture's margin cannot be read against: you
 * set an inset here and measured it a screen away. Now the swatch and the step
 * sit level with the edge they move, so choosing one is a comparison rather
 * than a guess — and beside the frame rather than on it, so it hides none of
 * what it is there to judge.
 *
 * It renders as a sibling of `.stage`, in the space `.editor__player` reserves
 * for it (`--rail`), NOT as an overlay — the stage's `overflow: hidden` would
 * clip it and a zoom would have to be told not to scale it.
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

      {/* THE WHOLE CONTROL IS ALWAYS ON SCREEN. Robert: "cant see now other
          stuff of frame, only colors, fix it". They were hidden while
          `disabled` — no backdrop, nothing to inset — because standing ON the
          picture the strip cost 279 px of a 317 px stage and most of it was
          dead. Beside the picture it costs nothing that belongs to the take, so
          the reason is gone with the position: the inset steps and Shadow are
          visible again, greyed until there is a frame to apply them to, which
          is how the row under the timeline always showed them. */}
      <div className="frame-bar__rule" />

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
        className={`frame-bar__step frame-bar__step--shadow${active && current.shadow ? ' frame-bar__step--on' : ''}`}
        disabled={!active}
        aria-pressed={active && current.shadow}
        onClick={() => apply({ shadow: !current.shadow })}
      >
        Shadow
      </button>
    </div>
  )
}
