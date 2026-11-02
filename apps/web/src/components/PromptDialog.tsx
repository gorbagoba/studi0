import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { displayError } from '../api/client';
import { ErrorBanner } from './ErrorBanner';

/**
 * Styled prompt dialog (native <dialog>) replacing window.prompt.
 * `mustMatch` turns it into a type-to-confirm gate: submit stays disabled
 * until the typed value echoes the string exactly (used for irreversible deletes).
 * Submit is disabled while the trimmed value is empty or unchanged from the
 * initial value (rename semantics). onSubmit runs the mutation; a rejection
 * surfaces in the dialog and keeps it open.
 */
export function PromptDialog({
  open,
  title,
  label,
  initialValue = '',
  submitLabel = 'Save',
  mustMatch,
  danger = false,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label?: string;
  initialValue?: string;
  submitLabel?: string;
  mustMatch?: string;
  danger?: boolean;
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputId = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) {
      setValue(mustMatch !== undefined ? '' : initialValue);
      setError(null);
      setBusy(false);
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open, initialValue, mustMatch]);

  const trimmed = value.trim();
  const valid =
    trimmed !== '' &&
    (mustMatch === undefined ? trimmed !== initialValue.trim() : trimmed === mustMatch);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (err) {
      setError(displayError(err));
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="prompt-title"
      className="dialog"
      onClick={(e) => {
        if (e.target === ref.current && !busy) onClose();
      }}
    >
      <form onSubmit={(e) => void submit(e)}>
        <h2 id="prompt-title">{title}</h2>
        {error !== null && <ErrorBanner message={error} />}
        <label htmlFor={inputId}>{label}</label>
        <input
          id={inputId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          disabled={busy}
        />
        {mustMatch !== undefined && trimmed !== mustMatch && (
          <p className="muted">Type “{mustMatch}” exactly to confirm.</p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={danger ? 'btn-danger' : 'btn-primary'}
            disabled={!valid || busy}
          >
            {busy ? 'Working…' : submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
