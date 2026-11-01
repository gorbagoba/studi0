import { useCallback, useEffect, useState } from 'react';
import type { Health } from '@studi0/shared';
import { cancelJob, displayError, getHealth, restartTeacher } from '../api/client';
import { useApp } from '../state/app';
import { ErrorBanner } from '../components/ErrorBanner';

/** App-level diagnostics: probe every service, restart the teacher, cancel stuck jobs. */
export function SettingsPage() {
  const { setSettingsOpen } = useApp();
  const [health, setHealth] = useState<Health | null>(null);
  const [probing, setProbing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const probe = useCallback(async () => {
    setProbing(true);
    setError(null);
    try {
      setHealth(await getHealth());
    } catch (e) {
      setHealth(null);
      setError(displayError(e));
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  async function onRestartTeacher() {
    setRestarting(true);
    setNote(null);
    setError(null);
    try {
      await restartTeacher();
      setNote('Teacher restarted.');
      setHealth(await getHealth());
    } catch (e) {
      setError(displayError(e));
    } finally {
      setRestarting(false);
    }
  }

  async function onCancelJob(id: string) {
    setNote(null);
    try {
      await cancelJob(id);
      setHealth(await getHealth());
    } catch (e) {
      setError(displayError(e));
    }
  }

  const oc = health?.opencode;

  return (
    <section aria-labelledby="settings-title" className="panel settings-page">
      <h3 id="settings-title">Settings &amp; diagnostics</h3>
      <p className="muted">
        Probe every part of the stack, restart the teacher if it is wedged, and cancel stuck builds.
      </p>
      <div className="btn-row" style={{ marginBottom: '0.5rem' }}>
        <button type="button" className="btn btn-small" onClick={() => setSettingsOpen(false)}>
          ← Back
        </button>
      </div>
      {error !== null && <ErrorBanner message={error} />}
      {note !== null && (
        <p className="banner banner-ok" role="status">
          {note}
        </p>
      )}

      <div className="btn-row">
        <button type="button" className="btn-primary" onClick={() => void probe()} disabled={probing}>
          {probing ? 'Probing…' : 'Probe server'}
        </button>
      </div>

      {health === null ? (
        <p className="muted">No probe yet — the API server is not answering.</p>
      ) : (
        <dl className="diag-list">
          <div className="diag-row">
            <dt>API server</dt>
            <dd>
              up · uptime {Math.floor(health.uptime_s / 60)}m {health.uptime_s % 60}s
            </dd>
          </div>
          <div className="diag-row">
            <dt>Teacher (opencode)</dt>
            <dd>
              {oc?.running ? (
                <>
                  {oc.healthy ? 'healthy' : <strong>unhealthy</strong>} · pid {oc.pid ?? '—'} · port{' '}
                  {oc.port}
                </>
              ) : (
                <strong>not running</strong>
              )}
            </dd>
          </div>
          <div className="diag-row">
            <dt>Frontend (vite)</dt>
            <dd>this page loading proves it is up</dd>
          </div>
        </dl>
      )}

      {oc !== undefined && !oc.healthy && (
        <div className="btn-row">
          <button
            type="button"
            className="btn-danger"
            onClick={() => void onRestartTeacher()}
            disabled={restarting}
          >
            {restarting ? 'Restarting…' : 'Restart teacher'}
          </button>
        </div>
      )}

      <h4>Active jobs</h4>
      {health !== null && health.jobs.length === 0 ? (
        <p className="muted">No graph builds running.</p>
      ) : (
        health !== null && (
          <ul className="diag-list">
            {health.jobs.map((j) => (
              <li key={j.id} className="diag-row job-row">
                <span>
                  <strong>{j.subject}</strong> · {j.kind} · {j.status} · {j.done}/{j.total}
                </span>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => void onCancelJob(j.id)}
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )
      )}

      <h4>API server</h4>
      <p className="muted">
        Shut down lives in the sidebar — a restart from here is impossible: the process you would
        need to start it is the one being stopped. Run <code>pnpm dev</code> to bring the stack back.
      </p>
    </section>
  );
}
