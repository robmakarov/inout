const R = 28
const CIRC = 2 * Math.PI * R

export function ProgressRing({ ratio, size = 64 }: { ratio: number; size?: number }) {
  const clamped = Math.min(1, Math.max(0, ratio))
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="ring" aria-hidden="true">
      <circle cx="32" cy="32" r={R} fill="none" stroke="var(--surface-3)" strokeWidth="4" />
      <circle
        cx="32"
        cy="32"
        r={R}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={CIRC}
        strokeDashoffset={CIRC * (1 - clamped)}
        transform="rotate(-90 32 32)"
        style={{ transition: 'stroke-dashoffset var(--t-fast) var(--ease)' }}
      />
    </svg>
  )
}
