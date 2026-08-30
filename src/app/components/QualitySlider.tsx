import { useRef, type ReactNode } from 'react'

/**
 * THE QUALITY SLIDER (task UI1).
 *
 * Robert, 2026-08-30: "make chatgpt/claudecode effort-like slider for our
 * quality choosing", then on the first attempt: "slider dont look like claude
 * code effort at all, fix it".
 *
 * WHAT WAS WRONG WITH THE FIRST ONE, and it is worth writing down because it is
 * a whole class of mistake: it was a PROGRESS BAR with dots on it. A 4 px hair
 * of a rail, a continuous accent fill, a small round handle. Nothing about it
 * said "there are five discrete levels here and you are on the third" — the
 * fill read as "43 % of the way through something", which is the one thing a
 * stepped control must never look like.
 *
 * An effort control reads as a METER: discrete blocks, filled up to where you
 * are, empty above it. So the track is SEGMENTED — one block per step, real
 * gaps between them, filled blocks in accent and empty ones in surface — and it
 * is thick enough (10 px) to read as blocks rather than as a line. The handle
 * sits on the boundary you are at, so the thing is still obviously draggable.
 *
 * The blocks are positioned ABSOLUTELY from the same percentages the handle and
 * the labels use, rather than being flex children with a gap: a flex gap
 * accumulates, so the fourth boundary would sit a few pixels off the fourth
 * label, and a control whose parts disagree about where they are is worse than
 * a plain bar.
 *
 * The same component runs in both places it is needed — above the chips before
 * a take, and under the timeline in the editor — because Robert asked for the
 * same slider in both ("make same slider of quality"), and because a control
 * that looks different in the two places it appears is two controls.
 *
 * UNREACHABLE STEPS ARE SHOWN, NOT HIDDEN. In the editor the ladder stops at
 * whatever the take was recorded under, and the blocks above it stay on the
 * track hatched out: a ladder that silently loses its top two rungs looks
 * broken, while one that shows them struck through says "you chose this before
 * you recorded" without a sentence.
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
  compact = false,
  lockedHint,
}: {
  stops: QualityStop[]
  value: string
  onChange: (id: string) => void
  /** Highest index the user may reach. Defaults to the top of the ladder. */
  maxIndex?: number
  /** The sentence under the track — what the chosen step costs and buys. */
  note?: ReactNode
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
  const cap = Math.min(maxIndex ?? last, last)
  const index = Math.max(
    0,
    stops.findIndex((s) => s.id === value),
  )
  const current = stops[index] ?? stops[0]

  /** Nearest step to a pointer position. */
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
  /** One block per step. The first block is the floor, so there are `last` of
   *  them: block i spans step i → i+1 and is lit once you are past step i. */
  const blocks = Array.from({ length: Math.max(1, last) }, (_, i) => i)

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
            onKeyDown={onKey}
            onPointerDown={drag}
            onPointerMove={(e) => {
              if (e.buttons & 1) pick(indexAt(e.clientX), true)
            }}
          >
            <div ref={railRef} className="qs__rail">
              {blocks.map((i) => (
                <span
                  key={i}
                  className={`qs__block${i < index ? ' qs__block--on' : ''}${
                    i >= cap ? ' qs__block--locked' : ''
                  }`}
                  style={{ left: `${pct(i)}%`, width: `${pct(1)}%` }}
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
                }${i === 0 ? ' qs__label--first' : ''}${i === last ? ' qs__label--last' : ''}`}
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
        </div>

        {actions && <div className="qs__actions">{actions}</div>}
      </div>

      {!compact && note && <div className="qs__note">{note}</div>}
    </div>
  )
}
