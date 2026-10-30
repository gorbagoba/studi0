import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SubjectDetail } from '@studi0/shared';
import { createSubject, displayError } from '../api/client';
import { ErrorBanner } from '../components/ErrorBanner';

export function AddSubjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (s: SubjectDetail) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) {
      setName('');
      setPath('');
      setError(null);
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmedPath = path.trim();
      const s = await createSubject({
        name: name.trim(),
        ...(trimmedPath === '' ? {} : { path: trimmedPath }),
      });
      onCreated(s);
      onClose();
    } catch (err) {
      setError(displayError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="add-subject-title" className="dialog">
      <form onSubmit={(e) => void submit(e)}>
        <h2 id="add-subject-title">Add subject</h2>
        {error !== null && <ErrorBanner message={error} />}
        <label htmlFor="sub-name">Name</label>
        <input
          id="sub-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. cs2040C"
          required
        />
        <label htmlFor="sub-path">Existing folder path (optional)</label>
        <input
          id="sub-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="e.g. C:\Users\me\courses\cs2040C"
        />
        <p className="muted">
          An existing folder is used in place — nothing is copied or moved. Leave empty to create a
          fresh subject folder.
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || name.trim() === ''}>
            {busy ? 'Adding…' : 'Add subject'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
