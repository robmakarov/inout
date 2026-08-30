import { useRef, type ReactNode } from 'react'

/**
 * THE QUALITY SLIDER (task UI1).
 *
 * Robert, 2026-08-30: "make chatgpt/claudecode effort-like slider for our
 * quality choosing". So it is that control and not a row of buttons: one rail,
 * discrete detents, a filled track behind the thumb, the step's name under each
 * detent, and a single sentence underneath saying what the chosen step costs.
 *
 * The same component runs in both places it is needed — above the chips before
 * a take, and under the player in the editor — because Robert asked for the
 * same slider in both ("make same slider of quality"), and because a control
 * that looks different in the two places it appears is two controls.
 *
 * IT IS A LADDER, NOT A RANGE. `<input type=range>` was the obvious reach and
 * is the wrong one: it has no per-detent labels, its thumb travels continuously
 * between values, and the browser's own track cannot carry the "unreachable
 * above here" state the editor needs. So the rail is drawn and the ARIA is
 * declared by hand — `role="slider"` with the index as its value, which is what
 * a screen reader gets from a range anyway.
 *
 * UNREACHABLE STEPS ARE SHOWN, NOT HIDDEN. In the editor the ladder stops at
 * whatever the take was recorded under, and the steps above it stay on the rail
 * greyed out: a ladder that silently loses its top two rungs looks broken,
 * while one that shows them dimmed says "you chose this before you recorded"
 * without a sentence.
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
  title = 'Quality',
  actions,
  disabled = false,
  lockedHint,
}: {
  stops: QualityStop[]
  value: string
  onChange: (id: string) => void
  /** Highest index the user may reach. Defaults to the top of the ladder. */
  maxIndex?: number
  /** The sentence under the rail — what the chosen step costs and buys. */
  note?: ReactNode
  title?: string
  /** Right-hand slot. The editor puts Export and For AI here — Robert:
   *  "buttons export and for ai right to it not under". */
  actions?: ReactNode
  disabled?: boolean
  /** Shown when a locked step is pressed, instead of moving the thumb. */
  lockedHint?: (stop: QualityStop) => void
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const last = Math.max(0, stops.length - 1)
  const cap = Math.min(maxIndex ?? last, last)
  const index = Math.max(
    0,
    stops.findIndex((s) => s.id === value),
  )
  const current = stops[index] ?? stops[0]

  /** Nearest detent to a pointer position, clamped to the reachable range. */
  const indexAt = (clientX: number): number => {
    const el = railRef.current
    if (!el) return index
    const r = el.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
    return Math.round(f * last)
  }

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
    <div className={`qs${disabled ? ' qs--disabled' : ''}`}>
      <div className="qs__head">
        <span className="qs__title">{title}</span>
        <span className="qs__value">{current?.label}</span>
        {actions && <span className="qs__actions">{actions}</span>}
      </div>

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
        onKeyDown={onKey}
        onPointerDown={drag}
        onPointerMove={(e) => {
          if (e.buttons & 1) pick(indexAt(e.clientX), true)
        }}
      >
        <div ref={railRef} className="qs__rail">
          <div className="qs__rail-fill" style={{ width: `${pct(index)}%` }} />
          {/* Everything past the take's ceiling, drawn as a distinct stretch of
              rail rather than simply absent — see the note above. */}
          {cap < last && (
            <div className="qs__rail-locked" style={{ left: `${pct(cap)}%`, right: 0 }} />
          )}
          {stops.map((s, i) => (
            <span
              key={s.id}
              className={`qs__dot${i <= index ? ' qs__dot--on' : ''}${i > cap ? ' qs__dot--locked' : ''}`}
              style={{ left: `${pct(i)}%` }}
            />
          ))}
          <span className="qs__thumb" style={{ left: `${pct(index)}%` }} />
        </div>
      </div>

      <div className="qs__labels">
        {stops.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`qs__label${i === index ? ' qs__label--on' : ''}${
              i > cap ? ' qs__label--locked' : ''
            }`}
            style={{ left: `${pct(i)}%` }}
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => pick(i, true)}
          >
            <span className="qs__label-text">{s.label}</span>
            {s.sub !== undefined && <span className="qs__label-sub">{s.sub}</span>}
          </button>
        ))}
      </div>

      {note && <div className="qs__note">{note}</div>}
    </div>
  )
}
