export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message?: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
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
