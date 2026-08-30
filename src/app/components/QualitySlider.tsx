import { useRef, type ReactNode } from 'react'

/**
 * THE QUALITY SLIDER (task UI1).
 *
 * Robert asked for a "chatgpt/claudecode effort-like slider", rejected the
 * first attempt ("slider dont look like claude code effort at all"), rejected
 * the second, and then sent a SCREENSHOT OF THE ACTUAL CONTROL. That ended the
 * guessing, and both of my guesses were wrong in the same way: I kept inventing
 * a progress indicator.
 *
 *   attempt 1 — a thin rail with a continuous accent FILL and a round handle.
 *               Reads as "43 % of the way through something".
 *   attempt 2 — the rail cut into accent-filled BLOCKS. Still a fill, just
 *               chunkier: a five-bar signal meter, which says "more is better"
 *               rather than "you are on step three of five".
 *   the real one — ONE continuous dark track, NO fill anywhere, a faint dot at
 *               each stop inside it, and a white rounded-rectangle handle
 *               sitting on the stop you are on. The only thing that moves is
 *               the handle. Nothing is coloured, because nothing is being
 *               measured — a step is a choice, not an amount.
 *
 * So: uniform track, dots, white pill handle. The handle travels INSET by half
 * its own width so it stays inside the track at both ends, and the dots use the
 * same inset so the handle lands exactly on one.
 *
 * The same component runs in both places it is needed — above the chips before
 * a take, and under the timeline in the editor — because Robert asked for the
 * same slider in both, and because a control that looks different in the two
 * places it appears is two controls.
 *
 * UNREACHABLE STEPS ARE SHOWN, NOT HIDDEN. In the editor the ladder stops at
 * whatever the take was recorded under. With no fill there is no "unfilled" to
 * lean on, so the locked stretch of track is darkened and its labels struck
 * through: a ladder that silently loses its top rungs looks broken, one that
 * shows them struck says "you chose this before you recorded" without a
 * sentence.
 */
export interface QualityStop {
  id: string
  label: string
  /** Small second line under the label — the editor puts the file size here. */
  sub?: ReactNode
}

export function QualitySlider({
  stops,
  value,
  onChange,
  maxIndex,
  note,
  hint,
  title = 'Quality',
  actions,
  disabled = false,
  compact = false,
  lockedHint,
}: {
  stops: QualityStop[]
  value: string
  onChange: (id: string) => void
  /** Highest index the user may reach. Defaults to the top of the ladder. */
  maxIndex?: number
  /** The sentence under the track — what the chosen step costs and buys.
   *  Not rendered in `compact`, which is now both places it is used. */
  note?: ReactNode
  /** The same thing as a tooltip, for where the sentence itself is not wanted. */
  hint?: string
  title?: string
  /**
   * Sits on the track's own line, to its right — Robert: "export buttons on
   * same line with slider right to it i said".
   */
  actions?: ReactNode
  disabled?: boolean
  /**
   * The editor's shape: no title row and no note (Robert: "second screenshot no
   * need for top and bottom captions"). The step names and their sizes stay,
   * because those are the choice itself rather than a caption about it.
   */
  compact?: boolean
  /** Called when a locked step is pressed, instead of moving the handle. */
  lockedHint?: (stop: QualityStop) => void
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const last = Math.max(0, stops.length - 1)
  /**
   * The handle's width, and it has to be known HERE as well as in the CSS: the
   * handle travels inset by half of itself at each end so it never hangs off
   * the track, which means a pointer at the very left edge is still step 0.
   * Must equal `--qs-tw` in app.css.
   */
  const THUMB_PX = 34
  const cap = Math.min(maxIndex ?? last, last)
  const index = Math.max(
    0,
    stops.findIndex((s) => s.id === value),
  )
  const current = stops[index] ?? stops[0]

  /** Nearest step to a pointer position, in the handle's own inset travel. */
  const indexAt = (clientX: number): number => {
    const el = railRef.current
    if (!el) return index
    const r = el.getBoundingClientRect()
    const travel = Math.max(1, r.width - THUMB_PX)
    const f = Math.min(1, Math.max(0, (clientX - r.left - THUMB_PX / 2) / travel))
    return Math.round(f * last)
  }

  /** Where step `i` sits on the track — one expression, used by the dots, the
   *  handle and the labels, so they cannot disagree about a position. */
  const at = (i: number): string =>
    `calc(var(--qs-tw) / 2 + (100% - var(--qs-tw)) * ${last === 0 ? 0 : i / last})`

  const pick = (next: number, viaPointer: boolean): void => {
    if (disabled) return
    const stop = stops[Math.min(last, Math.max(0, next))]
    if (!stop) return
    if (next > cap) {
      // A locked step is pressed on purpose more often than by accident — the
      // user is asking why it is locked, so answer instead of doing nothing.
      if (viaPointer) lockedHint?.(stop)
      return
    }
    if (stop.id !== value) onChange(stop.id)
  }

  const drag = (e: React.PointerEvent): void => {
    if (disabled) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // synthetic pointer — capture is a nicety, the gesture still works
    }
    pick(indexAt(e.clientX), true)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (disabled) return
    const go = (n: number) => {
      e.preventDefault()
      pick(n, false)
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') go(index - 1)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') go(index + 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(cap)
  }

  const pct = (i: number) => (last === 0 ? 0 : (i / last) * 100)

  return (
    <div className={`qs${disabled ? ' qs--disabled' : ''}${compact ? ' qs--compact' : ''}`}>
      {!compact && (
        <div className="qs__head">
          <span className="qs__title">{title}</span>
          <span className="qs__value">{current?.label}</span>
        </div>
      )}

      <div className="qs__row">
        <div className="qs__track-col">
          <div
            className="qs__railbox"
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={cap}
            aria-valuenow={index}
            aria-valuetext={current?.label}
            aria-disabled={disabled || undefined}
            title={hint}
            onKeyDown={onKey}
            onPointerDown={drag}
            onPointerMove={(e) => {
              if (e.buttons & 1) pick(indexAt(e.clientX), true)
            }}
          >
            <div ref={railRef} className="qs__rail">
              {cap < last && <span className="qs__lock" style={{ left: at(cap) }} />}
              {stops.map((s, i) => (
                <span
                  key={s.id}
                  className={`qs__dot${i > cap ? ' qs__dot--locked' : ''}`}
                  style={{ left: at(i) }}
                />
              ))}
              <span className="qs__thumb" style={{ left: at(index) }} />
            </div>
          </div>

          <div className="qs__labels">
            {stops.map((s, i) => (
              <button
                key={s.id}
                type="button"
                className={`qs__label${i === index ? ' qs__label--on' : ''}${
                  i > cap ? ' qs__label--locked' : ''
                }${i === 0 ? ' qs__label--first' : ''}${i === last ? ' qs__label--last' : ''}`}
                style={{ left: i === 0 || i === last ? `${pct(i)}%` : at(i) }}
                aria-hidden="true"
                tabIndex={-1}
                onClick={() => pick(i, true)}
              >
                <span className="qs__label-text">{s.label}</span>
                {s.sub !== undefined && <span className="qs__label-sub">{s.sub}</span>}
              </button>
            ))}
          </div>
        </div>

        {actions && <div className="qs__actions">{actions}</div>}
      </div>

      {!compact && note && <div className="qs__note">{note}</div>}
    </div>
  )
}
