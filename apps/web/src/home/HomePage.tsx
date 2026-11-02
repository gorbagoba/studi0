import { useEffect, useState } from 'react';
import type { Lesson, Stats, Subject } from '@studi0/shared';
import { displayError, getLessons, getStats } from '../api/client';
import { useSubjects } from '../api/hooks';
import { useApp } from '../state/app';
import { AddSubjectDialog } from '../subjects/AddSubjectDialog';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatDateTime } from '../lib/format';

interface SubjectRow {
  subject: Subject;
  stats: Stats | null;
  lessons: Lesson[];
}

/** Dashboard home: due-today, per-subject progress, recent lessons, quick actions. */
export function HomePage() {
  const { selectSubject, openLesson, setSettingsOpen } = useApp();
  const subjects = useSubjects();  const [rows, setRows] = useState<SubjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    const list = subjects.data;
    if (list === null) return;
    let live = true;
    setRows(null);
    setError(null);
    void Promise.all(
      list.map(async (subject): Promise<SubjectRow> => {
        // the dashboard is an overview — per-subject failures degrade, not block
        const [stats, lessons] = await Promise.all([
          getStats(subject.id).catch(() => null),
          getLessons(subject.id).catch(() => [] as Lesson[]),
        ]);
        return { subject, stats, lessons };
      }),
    )
      .then((r) => {
        if (live) setRows(r);
      })
      .catch((e: unknown) => {
        if (live) setError(displayError(e));
      });
    return () => {
      live = false;
    };
  }, [subjects.data]);

  const list = rows ?? [];
  const totalDue = list.reduce((n, r) => n + (r.stats?.dueCount ?? 0), 0);
  const dueSubjects = list.filter((r) => (r.stats?.dueCount ?? 0) > 0);
  const recent = list
    .flatMap((r) => r.lessons.map((lesson) => ({ lesson, subject: r.subject })))
    .sort((a, b) => b.lesson.updatedAt.localeCompare(a.lesson.updatedAt))
    .slice(0, 5);
  const loading = subjects.loading || (subjects.data !== null && rows === null);

  return (
    <div className="home">
      <header className="home-head">
        <h2>Home</h2>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
            Add subject
          </button>
        </div>
      </header>
      {error !== null && <ErrorBanner message={error} />}
      {subjects.error !== null && <ErrorBanner message={subjects.error} />}
      {loading && <p className="muted">Loading…</p>}
      {!loading && subjects.data !== null && subjects.data.length === 0 && (
        <EmptyState
          title="No subjects yet"
          hint="Add a subject, upload material, and the teacher takes it from there."
        />
      )}
      {rows !== null && rows.length > 0 && (
        <>
          <section aria-labelledby="home-due-title" className="panel">
            <h3 id="home-due-title">Due today</h3>
            {totalDue === 0 ? (
              <p className="muted">
                Nothing due — each answer schedules the next review (1/3/7 days).
              </p>
            ) : (
              <div className="home-rows">
                {dueSubjects.map((r) => (
                  <button
                    key={r.subject.id}
                    type="button"
                    className="home-row"
                    onClick={() => selectSubject(r.subject.id)}
                  >
                    <span className="home-row-main">
                      <span className="home-row-title">
                        {r.subject.icon !== null && (
                          <span className="subject-icon">{r.subject.icon}</span>
                        )}{' '}
                        {r.subject.name}
                      </span>
                      <span className="home-row-meta">
                        {r.stats?.dueCount} question{r.stats?.dueCount === 1 ? '' : 's'} scheduled
                        for review
                      </span>
                    </span>
                    <Badge tone={r.stats !== null && r.stats.dueCount > 0 ? 'warn' : 'neutral'}>
                      {r.stats?.dueCount} due
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </section>
          <section aria-labelledby="home-subjects-title" className="panel">
            <h3 id="home-subjects-title">Subjects</h3>
            <div className="home-rows">
              {list.map((r) => {
                const perTopic = r.stats?.perTopic ?? [];
                const attempts = perTopic.reduce((n, t) => n + t.attempts, 0);
                const correct = perTopic.reduce((n, t) => n + t.correct, 0);
                const accuracy = attempts > 0 ? Math.round((correct / attempts) * 100) : null;
                return (
                  <button
                    key={r.subject.id}
                    type="button"
                    className="home-row"
                    onClick={() => selectSubject(r.subject.id)}
                  >
                    <span className="home-row-main">
                      <span className="home-row-title">
                        {r.subject.icon !== null && (
                          <span className="subject-icon">{r.subject.icon}</span>
                        )}{' '}
                        {r.subject.name}
                        {r.subject.stale && <Badge tone="warn">stale</Badge>}
                      </span>
                      <span className="home-row-meta">
                        {r.subject.groupName ?? 'No group'} · {r.lessons.length} lesson
                        {r.lessons.length === 1 ? '' : 's'} · {r.stats?.totalQuestions ?? 0} questions
                      </span>
                    </span>
                    <span className="home-row-side">
                      {accuracy !== null && <span className="muted">{accuracy}% accuracy</span>}
                      {(r.stats?.dueCount ?? 0) > 0 && (
                        <Badge tone="warn">{r.stats?.dueCount} due</Badge>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          <section aria-labelledby="home-lessons-title" className="panel">
            <h3 id="home-lessons-title">Recent lessons</h3>
            {recent.length === 0 ? (
              <p className="muted">No lessons yet — ask the teacher in Chat to write one.</p>
            ) : (
              <div className="home-rows">
                {recent.map(({ lesson, subject }) => (
                  <button
                    key={lesson.id}
                    type="button"
                    className="home-row"
                    onClick={() => {
                      selectSubject(subject.id);
                      openLesson(lesson.path);
                    }}
                  >
                    <span className="home-row-main">
                      <span className="home-row-title">{lesson.title}</span>
                      <span className="home-row-meta">
                        {subject.name} · updated {formatDateTime(lesson.updatedAt)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      <AddSubjectDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(s) => {
          selectSubject(s.id);
          subjects.reload();
        }}
      />
    </div>
  );
}
