import { useState } from 'react';
import { useSubjects } from '../api/hooks';
import { deleteSubject } from '../api/client';
import { useApp } from '../state/app';
import { AddSubjectDialog } from './AddSubjectDialog';
import { Badge } from '../components/Badge';
import { ErrorBanner } from '../components/ErrorBanner';

export function Sidebar() {
  const { subjectId, selectSubject } = useApp();
  const subjects = useSubjects();
  const [addOpen, setAddOpen] = useState(false);

  async function onDelete(name: string, id: string) {
    // unregister only — server never touches the files on disk
    if (!window.confirm(`Remove "${name}" from studi0? Your files on disk are NOT deleted.`)) return;
    await deleteSubject(id);
    if (id === subjectId) selectSubject(null);
    subjects.reload();
  }

  return (
    <aside className="sidebar">
      <h1 className="brand">studi0</h1>
      <button className="btn" onClick={() => setAddOpen(true)}>
        Add subject
      </button>
      <nav aria-label="Subjects">
        {subjects.data !== null && subjects.data.length > 0 ? (
          <ul className="subject-list">
            {subjects.data.map((s) => (
              <li key={s.id} className="subject-row">
                <button
                  className={`subject-item${s.id === subjectId ? ' active' : ''}`}
                  aria-current={s.id === subjectId || undefined}
                  onClick={() => selectSubject(s.id)}
                >
                  <span>{s.name}</span>
                  {s.stale && <Badge tone="warn">stale</Badge>}
                </button>
                <button
                  type="button"
                  className="subject-delete"
                  aria-label={`Delete ${s.name}`}
                  title="Remove from studi0 (files on disk are kept)"
                  onClick={() => onDelete(s.name, s.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : subjects.loading ? (
          <p className="muted">Loading…</p>
        ) : (
          !subjects.error && <p className="muted">No subjects yet.</p>
        )}
      </nav>
      {subjects.error !== null && <ErrorBanner message={subjects.error} />}
      <AddSubjectDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(s) => {
          selectSubject(s.id);
          subjects.reload();
        }}
      />
    </aside>
  );
}
