import { useEffect, useRef, useState } from 'react';
import type { ID, Job, JobStatus } from '@studi0/shared';
import { openSubjectEvents } from '../api/sse';
import { useSubject } from '../api/hooks';
import { useApp } from '../state/app';
import type { Tab } from '../state/app';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { FileBrowser } from './FileBrowser';
import { UploadZone } from './UploadZone';
import { GraphView } from '../graph/GraphView';
import { JobPanel, TERMINAL_JOB_STATUSES } from '../graph/JobPanel';
import { ReportView } from '../graph/ReportView';
import { WikiEditor } from '../graph/WikiEditor';
import { LessonsList } from '../lesson/LessonsList';
import { LessonViewer } from '../lesson/LessonViewer';
import { ChatPanel } from '../chat/ChatPanel';
import { PracticePage } from '../practice/PracticePage';
import { CourseSetupForm } from './CourseSetupForm';

const TABS: { id: Tab; label: string }[] = [
  { id: 'material', label: 'Material' },
  { id: 'graph', label: 'Graph' },
  { id: 'lessons', label: 'Lessons' },
  { id: 'chat', label: 'Chat' },
  { id: 'practice', label: 'Practice' },
  { id: 'setup', label: 'Setup' },
];

// lifecycle order — a snapshot must never move backwards through it
const JOB_STATUS_RANK: Record<JobStatus, number> = {
  queued: 0,
  running: 1,
  cancelling: 2,
  complete: 3,
  partial: 3,
  failed: 3,
  cancelled: 3,
};

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
          setLiveJob(job);
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
            <h2>{s.name}</h2>
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
          {tab === 'setup' && <CourseSetupForm subjectId={subjectId} />}
          {tab === 'material' && (
            <div className="stack">
              <UploadZone
                subjectId={subjectId}
                onUploaded={() => {
                  subjectRef.current.reload();
                  setFileV((x) => x + 1);
                }}
              />
              <FileBrowser subjectId={subjectId} version={fileV} onOpenLesson={openLesson} />
            </div>
          )}
          {tab === 'graph' && (
            <div className="stack">
              <JobPanel
                subjectId={subjectId}
                job={job}
                stale={s.stale}
                onStarted={(j) => {
                  // the POST response can resolve after SSE already advanced the job — keep the newer snapshot
                  setLiveJob((cur) =>
                    cur !== null &&
                    cur.id === j.id &&
                    JOB_STATUS_RANK[cur.status] > JOB_STATUS_RANK[j.status]
                      ? cur
                      : j,
                  );
                  subjectRef.current.reload();
                }}
              />
              <GraphView subjectId={subjectId} version={v.graph} />
              <ReportView subjectId={subjectId} version={v.graph} />
              <WikiEditor subjectId={subjectId} />
            </div>
          )}
          {tab === 'lessons' && (
            <div className="lessons-pane">
              <LessonsList subjectId={subjectId} version={v.lesson} />
              {lessonPath !== null ? (
                <LessonViewer
                  subjectId={subjectId}
                  path={lessonPath}
                  version={v.lesson}
                  onClosed={closeLesson}
                  onLessonSaved={() => setV((x) => ({ ...x, lesson: x.lesson + 1 }))}
                />
              ) : (
                <EmptyState
                  title="Select a lesson"
                  hint="Pick one from the list, or ask the teacher in Chat to write one."
                />
              )}
            </div>
          )}
          {tab === 'chat' && (
            <ChatPanel
              subjectId={subjectId}
              showSessions
              onLessonSaved={() => setV((x) => ({ ...x, lesson: x.lesson + 1 }))}
            />
          )}
          {tab === 'practice' && <PracticePage subjectId={subjectId} version={v.questions} />}
        </>
      )}
    </div>
  );
}
