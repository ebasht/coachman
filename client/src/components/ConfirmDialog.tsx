interface Props {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Удалить',
  cancelLabel = 'Отмена',
  danger = true,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div
      className="modal-overlay confirm-dialog-overlay"
      role="presentation"
      onClick={onCancel}
    >
      <div
        className="modal confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-body"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        <p id="confirm-dialog-body" className="confirm-dialog-body">
          {body}
        </p>
        <div className="modal-actions">
          <button type="button" className="link-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'danger-btn' : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
