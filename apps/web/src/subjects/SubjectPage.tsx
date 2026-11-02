import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ID, Job } from '@studi0/shared';
import { openSubjectEvents } from '../api/sse';
import { useSubject } from '../api/hooks';
import { useApp } from '../state/app';

import type { Tab } from '../state/app';
import { Badge } from '../components/Badge';
import { ErrorBanner } from '../components/ErrorBanner';
import { FileBrowser } from './FileBrowser';
import { UploadZone } from './UploadZone';
import { TERMINAL_JOB_STATUSES, keepNewerJob } from '../graph/jobStatuses';

// heavy tab panels load on demand — the tab bar must stay instant
const GraphView = lazy(() => import('../graph/GraphView').then((m) => ({ default: m.GraphView })));
const JobPanel = lazy(() => import('../graph/JobPanel').then((m) => ({ default: m.JobPanel })));
const ReportView = lazy(() => import('../graph/ReportView').then((m) => ({ default: m.ReportView })));
const WikiEditor = lazy(() => import('../graph/WikiEditor').then((m) => ({ default: m.WikiEditor })));
const LessonsList = lazy(() => import('../lesson/LessonsList').then((m) => ({ default: m.LessonsList })));
const LessonViewer = lazy(() => import('../lesson/LessonViewer').then((m) => ({ default: m.LessonViewer })));
const ChatPanel = lazy(() => import('../chat/ChatPanel').then((m) => ({ default: m.ChatPanel })));
const PracticePage = lazy(() => import('../practice/PracticePage').then((m) => ({ default: m.PracticePage })));
const CourseSetupForm = lazy(() => import('./CourseSetupForm').then((m) => ({ default: m.CourseSetupForm })));

const TAB_FALLBACK = <p className="muted">Loading…</p>;

const TABS: { id: Tab; label: string }[] = [
  { id: 'material', label: 'Material' },
  { id: 'graph', label: 'Graph' },
  { id: 'lessons', label: 'Lessons' },
  { id: 'chat', label: 'Chat' },
  { id: 'practice', label: 'Practice' },
  { id: 'setup', label: 'Setup' },
];

export function SubjectPage({ subjectId }: { subjectId: ID }) {
  const { tab, setTab, lessonPath, openLesson, closeLesson } = useApp();
  const subject = useSubject(subjectId);
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  const [liveJob, setLiveJob] = useState<Job | null>(null);
  const [fileV, setFileV] = useState(0);
  const [v, setV] = useState({ graph: 0, lesson: 0, questions: 0 });

  useEffect(
    () =>
      openSubjectEvents(subjectId, {
        onJob: (job) => {
          // never let a late/duplicate frame regress the snapshot (QA #7)
          setLiveJob((cur) => (cur === null ? job : keepNewerJob(cur, job)));
          if (TERMINAL_JOB_STATUSES.has(job.status)) {
            subjectRef.current.reload();
            setV((s) => ({ ...s, graph: s.graph + 1 }));
          }
        },
        onLesson: () => setV((s) => ({ ...s, lesson: s.lesson + 1 })),
        onQuestions: () => setV((s) => ({ ...s, questions: s.questions + 1 })),
      }),
    [subjectId],
  );

  const s = subject.data;
  const job = liveJob ?? s?.activeJob ?? null;

  return (
    <div className="subject-page">
      {subject.error !== null && <ErrorBanner message={subject.error} />}
      {s === null ? (
        subject.loading && <p className="muted">Loading subject…</p>
      ) : (
        <>
          <header className="page-header">
            <h2>
              {s.icon !== null && <span className="subject-icon page-icon">{s.icon}</span>}
              {s.name}
            </h2>
            {s.stale && <Badge tone="warn">stale</Badge>}
            <Badge tone={s.graphStatus === 'ready' ? 'ok' : 'neutral'}>graph: {s.graphStatus}</Badge>
            <span className="muted">
              {s.counts.lessons} lessons · {s.counts.questions} questions · {s.counts.due} due
            </span>
          </header>
          <nav className="tabs" aria-label="Subject sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`tab${tab === t.id ? ' active' : ''}`}
                aria-current={tab === t.id || undefined}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          {tab === 'setup' && (
            <Suspense fallback={TAB_FALLBACK}>
              <CourseSetupForm subjectId={subjectId} />
            </Suspense>
          )}
          {tab === 'material' && (
            <div className="stack">
              <UploadZone
                subjectId={subjectId}
                onUploaded={() => {
                  subjectRef.current.reload();
                  setFileV((x) => x + 1);
                }}
              />
              <FileBrowser
                subjectId={subjectId}
                version={fileV}
                onOpenLesson={openLesson}
                onFilesChanged={() => setFileV((x) => x + 1)}
              />
            </div>
          )}
          {tab === 'graph' && (
            <Suspense fallback={TAB_FALLBACK}>
              <div className="stack">
                <JobPanel
                  subjectId={subjectId}
                  job={job}
                  stale={s.stale}
                  onStarted={(j) => {
                    // the POST response can resolve after SSE already advanced the job — keep the newer snapshot
                    setLiveJob((cur) => (cur === null ? j : keepNewerJob(cur, j)));
                    subjectRef.current.reload();
                  }}
                />
                <GraphView subjectId={subjectId} version={v.graph} />
                <ReportView subjectId={subjectId} version={v.graph} />
                <WikiEditor subjectId={subjectId} />
              </div>
            </Suspense>
          )}
          {tab === 'lessons' && (
            <Suspense fallback={TAB_FALLBACK}>
              <div className={`lessons-pane${lessonPath !== null ? ' lesson-open' : ''}`}>
                {lessonPath === null && <LessonsList subjectId={subjectId} version={v.lesson} />}
                {lessonPath !== null && (
                  <LessonViewer
                    subjectId={subjectId}
                    path={lessonPath}
                    version={v.lesson}
                    onClosed={closeLesson}
                    onLessonSaved={() => setV((x) => ({ ...x, lesson: x.lesson + 1 }))}
                  />
                )}
              </div>
            </Suspense>
          )}
          {tab === 'chat' && (
            <Suspense fallback={TAB_FALLBACK}>
              <ChatPanel
                subjectId={subjectId}
                showSessions
                onLessonSaved={() => setV((x) => ({ ...x, lesson: x.lesson + 1 }))}
              />
            </Suspense>
          )}
          {tab === 'practice' && (
            <Suspense fallback={TAB_FALLBACK}>
              <PracticePage subjectId={subjectId} version={v.questions} />
            </Suspense>
          )}
        </>
      )}
    </div>
  );
}
