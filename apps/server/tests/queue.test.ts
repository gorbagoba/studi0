import { describe, expect, it, afterEach } from 'vitest';
import { makeHarness } from './helpers';
import { buildApp } from '../src/http/app.js';
import { parseProgress, parseFailures, extractJson } from '../src/pipeline/parse.js';
import type { RunPipelineFn, PipelineOutcome } from '../src/pipeline/runner.js';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

const complete: PipelineOutcome = { status: 'complete', partial: null, error: null };

async function createSubject(name: string): Promise<string> {
  const res = await h.app.inject({ method: 'POST', url: '/api/subjects', payload: { name } });
  return (res.json() as { id: string }).id;
}

describe('pipeline job queue (T04)', () => {
  it('runs a job to complete, persists terminal state, emits SSE transitions', async () => {
    h = await makeHarness();
    const id = await createSubject('Queue1');
    const seen: string[] = [];
    h.ctx.events.subscribe(id, (event, data) => {
      if (event === 'job') seen.push((data as { status: string }).status);
    });
    h.ctx.queue.setRunPipeline(async (_job, _subject, onUpdate) => {
      onUpdate({ done: 3, total: 8, currentFile: 'material/w3.pdf' });
      return complete;
    });
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${id}/jobs`,
      payload: { kind: 'build' },
    });
    expect(created.statusCode).toBe(202);
    expect(created.json().status).toBe('queued');

    await new Promise((r) => setTimeout(r, 50));
    const job = (await h.app.inject({ method: 'GET', url: `/api/jobs/${created.json().id}` })).json();
    expect(job.status).toBe('complete');
    expect(job.startedAt).toBeTruthy();
    expect(job.finishedAt).toBeTruthy();
    // every transition emits a full snapshot; progress updates re-emit 'running'
    expect(seen[0]).toBe('queued');
    expect(seen).toContain('running');
    expect(seen[seen.length - 1]).toBe('complete');
    const subject = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}` })).json();
    expect(subject.lastBuiltAt).toBeTruthy();
  });

  it('enforces 1 active job per subject (409) and max 2 concurrent (FIFO)', async () => {
    h = await makeHarness();
    const s1 = await createSubject('A');
    const s2 = await createSubject('B');
    const s3 = await createSubject('C');
    let resolveA!: () => void;
    let resolveB!: () => void;
    const gateA = new Promise<void>((r) => (resolveA = r));
    const gateB = new Promise<void>((r) => (resolveB = r));
    const run = async (job: { subject_id: string }, signal: AbortSignal): Promise<PipelineOutcome> => {
      if (job.subject_id === s1) await gateA;
      if (job.subject_id === s2) await gateB;
      if (signal.aborted) return { status: 'cancelled', partial: null, error: null };
      return complete;
    };
    h.ctx.queue.setRunPipeline(async (job, _s, _u, signal) => run(job, signal));
    await h.app.inject({ method: 'POST', url: `/api/subjects/${s1}/jobs`, payload: { kind: 'build' } });
    const conflict = await h.app.inject({ method: 'POST', url: `/api/subjects/${s1}/jobs`, payload: { kind: 'update' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('JOB_CONFLICT');
    await h.app.inject({ method: 'POST', url: `/api/subjects/${s2}/jobs`, payload: { kind: 'build' } });
    const j3 = await h.app.inject({ method: 'POST', url: `/api/subjects/${s3}/jobs`, payload: { kind: 'build' } });
    await new Promise((r) => setTimeout(r, 40));
    const queued3 = (await h.app.inject({ method: 'GET', url: `/api/jobs/${j3.json().id}` })).json();
    expect(queued3.status).toBe('queued'); // 2 running, third waits FIFO
    resolveA();
    await new Promise((r) => setTimeout(r, 40));
    const now3 = (await h.app.inject({ method: 'GET', url: `/api/jobs/${j3.json().id}` })).json();
    expect(['running', 'complete']).toContain(now3.status);
    resolveB();
    await new Promise((r) => setTimeout(r, 60));
  });

  it('cancels a running job and reaches a terminal state within 5s (AC4)', async () => {
    h = await makeHarness();
    const s = await createSubject('Cancel');
    h.ctx.queue.setRunPipeline(async (_job, _s, _u, signal) => {
      // behaves like the real runner: child dies promptly when abort arrives
      await new Promise<void>((r) => {
        const t = setTimeout(r, 10_000);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          r();
        }, { once: true });
      });
      return signal.aborted ? { status: 'cancelled', partial: null, error: null } : complete;
    });
    const job = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${s}/jobs`, payload: { kind: 'build' } })
    ).json();
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    const cancelled = await h.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelling');
    let final = '';
    while (Date.now() - t0 < 5000) {
      final = (await h.app.inject({ method: 'GET', url: `/api/jobs/${job.id}` })).json().status;
      if (['cancelled', 'failed', 'complete'].includes(final)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(final).toBe('cancelled');
    const again = await h.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('JOB_NOT_CANCELLABLE');
  });

  it('reports partial failures honestly (AC6) and keeps the graph usable', async () => {
    h = await makeHarness();
    const s = await createSubject('Partial');
    h.ctx.queue.setRunPipeline(async () => ({
      status: 'partial',
      partial: [{ file: 'material/w4.pdf', reason: 'chunk extraction failed' }],
      error: null,
    }));
    const job = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${s}/jobs`, payload: { kind: 'update' } })
    ).json();
    await new Promise((r) => setTimeout(r, 50));
    const final = (await h.app.inject({ method: 'GET', url: `/api/jobs/${job.id}` })).json();
    expect(final.status).toBe('partial');
    expect(final.partial).toEqual([{ file: 'material/w4.pdf', reason: 'chunk extraction failed' }]);
    const subject = (await h.app.inject({ method: 'GET', url: `/api/subjects/${s}` })).json();
    expect(subject.lastBuiltAt).toBeTruthy(); // stale badge clears on partial too
  });

  it('closes jobs left running by a restart as failed ("server restarted")', async () => {
    h = await makeHarness();
    const s = await createSubject('Zombie');
    h.ctx.db
      .prepare(
        'INSERT INTO jobs (id, subject_id, kind, status, created_at, pid) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('stale-job', s, 'build', 'running', new Date().toISOString(), '1234');
    // simulate a server restart on the same data dir
    await h.app.close();
    h.ctx.db.close();
    const restarted = await buildApp({ dataDir: h.dataDir });
    const row = restarted.ctx.db
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get('stale-job') as unknown as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toBe('server restarted');
    const res = await restarted.app.inject({ method: 'GET', url: '/api/jobs?active=true' });
    expect(res.json()).toHaveLength(0);
    restarted.ctx.db.close();
  });

  it('setRunPipeline keeps RunPipelineFn shape (abort → cancelled)', async () => {
    h = await makeHarness();
    const s = await createSubject('Abort');
    const run: RunPipelineFn = async (_job, _s, _u, signal) =>
      signal.aborted ? { status: 'cancelled', partial: null, error: null } : complete;
    h.ctx.queue.setRunPipeline(run);
    const job = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${s}/jobs`, payload: { kind: 'recluster' } })
    ).json();
    await new Promise((r) => setTimeout(r, 40));
    expect((await h.app.inject({ method: 'GET', url: `/api/jobs/${job.id}` })).json().status).toBe('complete');
  });

  it('parses protocol lines and oneshot JSON out of noisy stdout', () => {
    const stdout = [
      'some prose the model wrote',
      'studi0-progress {"done":1,"total":8,"file":"material/w1.pdf"}',
      'studi0-progress {"done":2,"total":8,"file":"material/w2.pdf"}',
      'studi0-failed {"file":"material/w3.pdf","reason":"timeout"}',
      'DONE 7 files ok, 1 failed.',
    ].join('\n');
    expect(parseProgress(stdout)).toEqual({ done: 2, total: 8, file: 'material/w2.pdf' });
    expect(parseFailures(stdout)).toEqual([{ file: 'material/w3.pdf', reason: 'timeout' }]);
    expect(extractJson('blah\n```json\n{"ok":true,"reason":"fine"}\n```\ntrailing')).toEqual({
      ok: true,
      reason: 'fine',
    });
    expect(extractJson('no json here')).toBeNull();
  });
});
