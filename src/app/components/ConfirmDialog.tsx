/**
 * Two or three ways out, never one.
 *
 * UI1 added the third — Robert, 2026-08-30: "when going back from edit besides
 * buttons cancel and discard make button keep". The dialog on the way out of
 * the editor asked "Discard recording?" and offered Cancel or Discard, so the
 * only way back to the capture screen was to DELETE the take you had just made.
 * Keeping it was possible (the take is on disk either way, and the takes list
 * now shows it) but nothing said so, which is the same as it not existing.
 *
 * `neutralLabel` is that middle answer: leave, keep the file. It sits between
 * Cancel and the destructive action because that is the order of consequence.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  neutralLabel,
  danger = false,
  onConfirm,
  onNeutral,
  onCancel,
}: {
  open: boolean
  title: string
  message?: string
  confirmLabel: string
  /** The middle way out — omitted, this is exactly the two-button dialog. */
  neutralLabel?: string
  danger?: boolean
  onConfirm: () => void
  onNeutral?: () => void
  onCancel: () => void
}) {
  if (!open) return null
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog"
        role="alertdialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog__title">{title}</div>
        {message && <div className="dialog__message">{message}</div>}
        <div className="dialog__actions">
          <button className="btn btn--ghost" onClick={onCancel} autoFocus>
            Cancel
          </button>
          {neutralLabel && onNeutral && (
            <button className="btn btn--surface" onClick={onNeutral}>
              {neutralLabel}
            </button>
          )}
          <button
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
