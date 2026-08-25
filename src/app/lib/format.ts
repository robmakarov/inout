export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * How much longer, in words a person waiting will accept.
 *
 * Deliberately coarse: the estimate behind it is a measured slope, and quoting
 * it to the second would claim a precision it does not have. Rounded to 5 s
 * under a minute and to whole minutes above, so the number stops twitching.
 */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 10) return 'a few seconds left'
  if (s < 60) return `about ${Math.max(10, Math.round(s / 5) * 5)}s left`
  const m = Math.round(s / 60)
  return m <= 1 ? 'about a minute left' : `about ${m} min left`
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}
