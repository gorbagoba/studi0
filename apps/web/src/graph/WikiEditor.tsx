import { useEffect, useState } from 'react';
import type { ID } from '@studi0/shared';
import { useWiki, useWikiPage } from '../api/hooks';
import { displayError, saveWikiPage } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';

export function WikiEditor({ subjectId }: { subjectId: ID }) {
  const [version, setVersion] = useState(0);
  const wiki = useWiki(subjectId, version);
  const [page, setPage] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useWikiPage(subjectId, page, version);

  useEffect(() => {
    if (current.data !== null) setDraft(current.data.markdown);
  }, [current.data]);

  async function save(): Promise<void> {
    if (page === null || draft === null) return;
    setBusy(true);
    setError(null);
    try {
      await saveWikiPage(subjectId, page, draft);
      setNote('Saved — your edits are canon for the teacher.');
      setVersion((v) => v + 1);
    } catch (e) {
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  }

  const pages = wiki.data?.pages ?? [];
  return (
    <section aria-labelledby="wiki-title" className="panel">
      <h3 id="wiki-title">Wiki</h3>
      <p className="muted">Graphify-generated pages. Your edits are treated as canon.</p>
      {error !== null && <ErrorBanner message={error} />}
      {pages.length === 0 && !wiki.loading ? (
        <EmptyState title="No wiki pages yet" hint="They are generated when the graph is built." />
      ) : (
        <>
          <label htmlFor="wiki-page">Page</label>
          <select
            id="wiki-page"
            value={page ?? ''}
            onChange={(e) => {
              setPage(e.target.value === '' ? null : e.target.value);
              setNote(null);
              setError(null);
            }}
          >
            <option value="">Select a page…</option>
            {pages.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          {page !== null &&
            (current.loading ? (
              <p className="muted">Loading…</p>
            ) : current.error !== null ? (
              <ErrorBanner message={current.error} />
            ) : (
              <>
                <textarea
                  aria-label={`Edit wiki page ${page}`}
                  className="wiki-editor"
                  rows={12}
                  value={draft ?? ''}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="btn-row">
                  <button
                    className="btn-primary"
                    disabled={busy || draft === null || draft === (current.data?.markdown ?? '')}
                    onClick={() => void save()}
                  >
                    {busy ? 'Saving…' : 'Save page'}
                  </button>
                  {note !== null && (
                    <span role="status" className="muted">
                      {note}
                    </span>
                  )}
                </div>
              </>
            ))}
        </>
      )}
    </section>
  );
}
