import { useEffect, useRef } from 'react';
import { ErrorBanner } from './ErrorBanner';

/**
 * Styled confirm dialog (native <dialog>, Escape + backdrop close).
 * Replaces window.confirm for destructive/interrupting actions.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  danger = false,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="confirm-title"
      className="dialog"
      onClick={(e) => {
        // backdrop click (target is the dialog itself, not its children) cancels
        if (e.target === ref.current) onClose();
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      {error !== null && <ErrorBanner message={error} />}
      {body !== undefined && <p className="confirm-body">{body}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={danger ? 'btn-danger' : 'btn-primary'}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
