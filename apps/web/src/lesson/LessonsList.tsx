import { useApp } from '../state/app';
import { useLessons } from '../api/hooks';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatDateTime } from '../lib/format';
import type { ID } from '@studi0/shared';

export function LessonsList({
  subjectId,
  version,
}: {
  subjectId: ID;
  version: number;
}) {
  const { openLesson } = useApp();
  const lessons = useLessons(subjectId, version);

  return (
    <nav aria-labelledby="lessons-title" className="lessons-list">
      <h3 id="lessons-title">Lessons</h3>
      {lessons.loading && <p className="muted">Loading…</p>}
      {lessons.error !== null && <ErrorBanner message={lessons.error} />}
      {lessons.data !== null &&
        (lessons.data.length === 0 ? (
          <EmptyState title="No lessons yet" hint="Ask the teacher in Chat to write one." />
        ) : (
          <div className="lesson-rows" role="list" aria-label="All lessons">
            {lessons.data.map((l) => (
              <div key={l.id} role="listitem" className="lesson-row-wrap">
                <button type="button" className="lesson-row" onClick={() => openLesson(l.path)}>
                  <span className="lesson-row-title">{l.title}</span>
                  <span className="lesson-row-meta">
                    updated {formatDateTime(l.updatedAt)}
                    {l.nodeTags.length > 0 ? ` · ${l.nodeTags.length} graph topics` : ''}
                  </span>
                </button>
              </div>
            ))}
          </div>
        ))}
    </nav>
  );
}
