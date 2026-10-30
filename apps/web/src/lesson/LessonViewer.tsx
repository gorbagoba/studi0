import { useEffect, useRef, useState } from 'react';
import type { ID, LessonContent } from '@studi0/shared';
import { displayError, getLessonContent } from '../api/client';
import { useLessons } from '../api/hooks';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatDateTime } from '../lib/format';
import { ChatPanel } from '../chat/ChatPanel';

const POLL_MS = 2500;

export function LessonViewer({
  subjectId,
  path,
  version,
  onClosed,
  onLessonSaved,
}: {
  subjectId: ID;
  path: string;
  version: number;
  onClosed: () => void;
  onLessonSaved?: () => void;
}) {
  const lessons = useLessons(subjectId, version);
  const lesson = lessons.data?.find((l) => l.path === path) ?? null;
  const [content, setContent] = useState<LessonContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<string | null>(null);

  // Hot-reload: poll while open, skip re-render while updatedAt is unchanged, visibility-gated.
  useEffect(() => {
    seen.current = null;
    setContent(null);
    setError(null);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (first: boolean): Promise<void> => {
      if (!first && document.visibilityState !== 'visible') {
        timer = setTimeout(() => void poll(false), POLL_MS);
        return;
      }
      try {
        const c = await getLessonContent(subjectId, path);
        if (stopped) return;
        if (seen.current === null || c.updatedAt !== seen.current) {
          seen.current = c.updatedAt;
          setContent(c);
          setError(null);
        }
      } catch (e) {
        if (!stopped) setError(displayError(e));
      }
      if (!stopped) timer = setTimeout(() => void poll(false), POLL_MS);
    };
    void poll(true);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [subjectId, path]);

  return (
    <section
      className="lesson-viewer"
      aria-label={content !== null ? `Lesson: ${content.title}` : 'Lesson viewer'}
    >
      <div className="lesson-main">
        <div className="lesson-head">
          <button className="btn" onClick={onClosed}>
            Close
          </button>
          <h3 className="lesson-title">{content?.title ?? path}</h3>
          {content !== null && <span className="muted">updated {formatDateTime(content.updatedAt)}</span>}
        </div>
        {error !== null && <ErrorBanner message={error} />}
        {content !== null ? (
          <iframe
            title={`Lesson content: ${content.title}`}
            className="lesson-frame"
            sandbox=""
            srcDoc={content.html}
          />
        ) : (
          error === null && <p className="muted">Loading lesson…</p>
        )}
      </div>
      <aside className="lesson-chat">
        {lessons.loading ? (
          <p className="muted">Loading…</p>
        ) : lesson !== null ? (
          <ChatPanel subjectId={subjectId} lessonId={lesson.id} onLessonSaved={onLessonSaved} />
        ) : (
          <p className="muted">
            This lesson is not indexed yet, so lesson-scoped chat is unavailable. It appears here
            once the teacher registers it.
          </p>
        )}
      </aside>
    </section>
  );
}
