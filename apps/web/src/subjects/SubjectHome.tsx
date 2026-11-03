import { useEffect, useState } from 'react';
import { useApp } from '../state/app';
import { useLessons } from '../api/hooks';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { ProgressBar } from '../components/ProgressBar';
import { formatDateTime } from '../lib/format';
import type { ID } from '@studi0/shared';

function lastViewedPath(subjectId: ID): string | null {
  try {
    return localStorage.getItem(`studi0:lastLesson:${subjectId}`);
  } catch {
    return null;
  }
}

/**
 * Subject overview — the learner's home: continue where you left off, then
 * the topic checklist (✓ = lesson review passed).
 */
export function SubjectHome({ subjectId, version }: { subjectId: ID; version: number }) {
  const { openLesson } = useApp();
  const lessons = useLessons(subjectId, version);
  const [lastPath, setLastPath] = useState<string | null>(() => lastViewedPath(subjectId));

  // re-read on version bumps (coming back from a lesson session)
  useEffect(() => {
    setLastPath(lastViewedPath(subjectId));
  }, [subjectId, version]);

  const data = lessons.data ?? [];
  const reviewed = data.filter((l) => l.reviewedAt !== null).length;
  const last = data.find((l) => l.path === lastPath) ?? null;
  const lastIdx = last !== null ? data.findIndex((l) => l.path === lastPath) : -1;
  const next = last !== null && lastIdx >= 0 && lastIdx < data.length - 1 ? data[lastIdx + 1] : null;

  return (
    <div className="stack subject-home">
      {lessons.error !== null && <ErrorBanner message={lessons.error} />}
      <section className="panel" aria-labelledby="continue-title">
        <h3 id="continue-title">Continue</h3>
        {lessons.loading && <p className="muted">Loading…</p>}
        {last === null ? (
          <EmptyState
            title="Nothing read yet"
            hint="Open a lesson from the Lessons tab — it will show up here."
          />
        ) : (
          <div className="btn-row continue-row">
            <button type="button" className="btn" onClick={() => openLesson(last.path)}>
              ▶ Resume: {last.title}
              <span className="lesson-row-meta">opened {formatDateTime(last.updatedAt)}</span>
            </button>
            {next !== null && (
              <button type="button" className="btn-primary" onClick={() => openLesson(next.path)}>
                Next: {next.title}
              </button>
            )}
          </div>
        )}
      </section>
      <section className="panel" aria-labelledby="checklist-title">
        <h3 id="checklist-title">
          Topic checklist
          {data.length > 0 ? <span className="muted"> — {reviewed}/{data.length} reviewed</span> : null}
        </h3>
        {data.length > 0 && (
          <ProgressBar value={reviewed} max={data.length} label="lessons reviewed" />
        )}
        {lessons.loading && <p className="muted">Loading…</p>}
        {data.length === 0 && !lessons.loading ? (
          <EmptyState title="No lessons yet" hint="Lessons appear here as the teacher writes them." />
        ) : (
          <ul className="topic-checklist">
            {data.map((l) => (
              <li key={l.id}>
                <button type="button" className="checklist-row" onClick={() => openLesson(l.path)}>
                  <span
                    className={`check${l.reviewedAt !== null ? ' done' : ''}`}
                    aria-label={l.reviewedAt !== null ? 'review passed' : 'not reviewed yet'}
                  >
                    {l.reviewedAt !== null ? '✓' : '○'}
                  </span>
                  <span>{l.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
