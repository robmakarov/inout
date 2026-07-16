import { useAppStore } from '@app/state/store'

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts)
  const dismiss = useAppStore((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <button
          key={t.id}
          className={`toast${t.variant === 'error' ? ' toast--error' : ''}`}
          onClick={() => dismiss(t.id)}
        >
          {t.message}
        </button>
      ))}
    </div>
  )
}
