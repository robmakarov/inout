import { formatTimer } from '@app/lib/format'

export function TimerPill({ elapsedMs, remainingMs }: { elapsedMs: number; remainingMs: number }) {
  const warn = remainingMs < 60_000
  return (
    <div className={`timer${warn ? ' timer--warn' : ''}`}>
      <span className="timer__dot" />
      <span className="timer__text">{formatTimer(elapsedMs)}</span>
    </div>
  )
}
