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
    <nav aria-labelledby="lessons-title" className="panel lessons-list">
      <h3 id="lessons-title">Lessons</h3>
      {lessons.loading && <p className="muted">Loading…</p>}
      {lessons.error !== null && <ErrorBanner message={lessons.error} />}
      {lessons.data !== null &&
        (lessons.data.length === 0 ? (
          <EmptyState title="No lessons yet" hint="Ask the teacher in Chat to write one." />
        ) : (
          <ul>
            {lessons.data.map((l) => (
              <li key={l.id}>
                <button className="lesson-item" onClick={() => openLesson(l.path)}>
                  <span>{l.title}</span>
                  <span className="muted">{formatDateTime(l.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </nav>
  );
}
