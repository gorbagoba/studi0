import { useEffect, useRef, useState } from 'react';
import type { ID, LessonContent } from '@studi0/shared';
import { displayError, getLessonContent } from '../api/client';
import { useLessons } from '../api/hooks';
import { useApp } from '../state/app';
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
  const { openLesson } = useApp();
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

  // Arrow-key lesson navigation (skips while typing in a form field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (lessons.data === null || lessons.data.length < 2) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const idx = lessons.data.findIndex((l) => l.path === path);
      if (idx < 0) return;
      const next = e.key === 'ArrowRight' ? idx + 1 : idx - 1;
      if (next < 0 || next >= lessons.data.length) return;
      e.preventDefault();
      openLesson(lessons.data[next].path);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lessons.data, path, openLesson]);

  const idx = lessons.data?.findIndex((l) => l.path === path) ?? -1;
  const prev = idx > 0 ? lessons.data?.[idx - 1] : undefined;
  const next = lessons.data !== null && idx >= 0 && idx < lessons.data.length - 1 ? lessons.data[idx + 1] : undefined;

  return (
    <section
      className="lesson-viewer"
      aria-label={content !== null ? `Lesson: ${content.title}` : 'Lesson viewer'}
    >
      <div className="lesson-main">
        <div className="lesson-head">
          <button className="btn" onClick={onClosed} aria-label="Close lesson">
            ← All lessons
          </button>
          <div className="lesson-nav" aria-label="Lesson navigation">
            <select
              className="lesson-select"
              value={path}
              onChange={(e) => {
                const target = lessons.data?.find((l) => l.path === e.target.value);
                if (target !== undefined) openLesson(target.path);
              }}
              aria-label="Go to lesson"
            >
              {(lessons.data ?? []).map((l) => (
                <option key={l.id} value={l.path}>
                  {l.title}
                </option>
              ))}
            </select>
          </div>
          {content !== null && <span className="muted">updated {formatDateTime(content.updatedAt)}</span>}
        </div>
        {error !== null && <ErrorBanner message={error} />}
        {content !== null ? (
          <iframe
            title={`Lesson content: ${content.title}`}
            className="lesson-frame"
            sandbox="allow-scripts"
            srcDoc={content.html}
          />
        ) : (
          error === null && <p className="muted">Loading lesson…</p>
        )}
        <div className="lesson-pager" aria-label="Lesson pager">
          <button
            type="button"
            className="btn"
            onClick={() => prev !== undefined && openLesson(prev.path)}
            disabled={prev === undefined}
            title={prev !== undefined ? prev.title : 'No previous lesson'}
          >
            ◀ {prev !== undefined ? prev.title : 'Previous'}
          </button>
          <span className="lesson-pager-pos">
            {idx >= 0 ? `${idx + 1} / ${lessons.data?.length ?? 0}` : ''}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => next !== undefined && openLesson(next.path)}
            disabled={next === undefined}
            title={next !== undefined ? next.title : 'No next lesson'}
          >
            {next !== undefined ? next.title : 'Next'} ▶
          </button>
        </div>
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
