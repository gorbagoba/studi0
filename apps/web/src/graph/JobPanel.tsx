import { useEffect, useRef, useState } from 'react';
import type { ID, Job, JobKind } from '@studi0/shared';
import { cancelJob, displayError, getBuildLog, startJob } from '../api/client';
import { openSubjectEvents } from '../api/sse';
import { TERMINAL_JOB_STATUSES } from './jobStatuses';
import { ErrorBanner } from '../components/ErrorBanner';
import { ProgressBar } from '../components/ProgressBar';

export function JobPanel({
  subjectId,
  job,
  stale,
  onStarted,
}: {
  subjectId: ID;
  job: Job | null;
  stale: boolean;
  onStarted: (job: Job) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = job !== null && !TERMINAL_JOB_STATUSES.has(job.status);

  async function start(kind: JobKind): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onStarted(await startJob(subjectId, kind));
    } catch (e) {
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (job === null) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(await cancelJob(job.id));
    } catch (e) {
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="jobs-title" className="panel">
      <h3 id="jobs-title">Graph pipeline</h3>
      {stale && job === null && (
        <p className="banner banner-warn" role="status">
          Material changed since the last build — run “Update graph” to catch up.
        </p>
      )}
      {error !== null && <ErrorBanner message={error} />}
      <div className="btn-row">
        <button className="btn" disabled={active || busy} onClick={() => void start('build')}>
          Build graph
        </button>
        <button className="btn" disabled={active || busy} onClick={() => void start('update')}>
          Update graph
        </button>
        <button className="btn" disabled={active || busy} onClick={() => void start('recluster')}>
          Re-cluster
        </button>
        {active && (
          <button className="btn-danger" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </button>
        )}
      </div>
      {job !== null && <JobStatus job={job} />}
      <BuildLog subjectId={subjectId} active={active} jobId={job?.id ?? null} />
    </section>
  );
}

/** Live-tailing view of graphify-out/build.log via SSE `log` events, with one history tail fetch. */
function BuildLog({ subjectId, active, jobId }: { subjectId: ID; active: boolean; jobId: string | null }) {
  const [log, setLog] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let stopped = false;
    // one tail fetch for pre-connection history; refetched per job — build.log starts over
    void getBuildLog(subjectId)
      .then((r) => {
        if (!stopped) setLog(r.log);
      })
      .catch(() => undefined); // the log pane is best-effort — never surface fetch errors here
    return () => {
      stopped = true;
    };
  }, [subjectId, jobId]);

  useEffect(() => {
    const close = openSubjectEvents(subjectId, {
      onLog: (ev) => setLog((cur) => (cur ?? '') + ev.line + '\n'),
    });
    return close;
  }, [subjectId]);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [log]);

  if (log === null) return null;
  return (
    <details className="build-log" open={active}>
      <summary>Build log</summary>
      <pre ref={preRef} aria-live="polite" aria-label="Graph pipeline log">
        {log}
      </pre>
    </details>
  );
}

function JobStatus({ job }: { job: Job }) {
  if (job.status === 'queued') {
    return (
      <p role="status" className="muted">
        Queued — waiting for a pipeline slot…
      </p>
    );
  }
  if (job.status === 'running' || job.status === 'cancelling') {
    return (
      <div role="status" aria-live="polite">
        <p>
          {job.status === 'cancelling' ? 'Cancelling… ' : ''}
          {job.progress.currentFile ?? 'Working…'} ({job.progress.done}/{job.progress.total})
        </p>
        <ProgressBar value={job.progress.done} max={Math.max(job.progress.total, 1)} label="Job progress" />
      </div>
    );
  }
  if (job.status === 'complete') {
    return (
      <p className="banner banner-ok" role="status">
        Graph build complete — {job.progress.done}/{job.progress.total} files processed.
      </p>
    );
  }
  if (job.status === 'partial') {
    const failed = job.partial ?? [];
    return (
      <div className="banner banner-warn" role="status">
        <strong>
          {job.progress.done}/{job.progress.total} complete, {failed.length} failed:
        </strong>
        <ul>
          {failed.map((f) => (
            <li key={f.file}>
              <code>{f.file}</code> — {f.reason}
            </li>
          ))}
        </ul>
        <p className="muted">The graph is still usable from the files that succeeded.</p>
      </div>
    );
  }
  if (job.status === 'failed') {
    return (
      <div className="banner banner-error" role="alert">
        Job failed: {job.error ?? 'unknown error'}
      </div>
    );
  }
  return (
    <div className="banner banner-warn" role="status">
      Cancelled — {job.progress.done}/{job.progress.total} files were completed before the stop.
    </div>
  );
}
