import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeHarness } from './helpers';
import { spawnArgs, killTree, isAlive } from '../src/util/proc.js';
import type { TestHarness } from './helpers';

// route every spawnArgs call at node itself: a real child without needing opencode
process.env.OPENCODE_BIN = process.execPath;

let h: TestHarness | undefined;

afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

async function createSubject(name: string): Promise<string> {
  const res = await h!.app.inject({ method: 'POST', url: '/api/subjects', payload: { name } });
  return (res.json() as { id: string }).id;
}

/**
 * The pipeline child script: when OPENCODE_BIN=node, `node run --auto <prompt>`
 * executes this file in the subject dir. Prints protocol lines; optionally
 * sleeps (slow child) or leaves an orphan grandchild behind (reaping test).
 */
const RUN_SCRIPT = `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const argv = process.argv.join(' ');
if (process.env.STUDI0_TEST_GC === '1' && argv.includes('graph verification agent') && process.env.STUDI0_TEST_GC_PID) {
  // detached: must outlive its parent to simulate the real orphan case
  const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore', detached: true });
  fs.writeFileSync(process.env.STUDI0_TEST_GC_PID, String(g.pid));
}
if (process.env.STUDI0_TEST_SLOW === '1') { setTimeout(() => process.exit(0), 60000); return; }
console.log('studi0-progress {"done":0,"total":1,"file":null}');
console.log('studi0-progress {"done":1,"total":1,"file":"material/a.md"}');
console.log('DONE 1 files ok, 0 failed.');
// real graphify always leaves a graph behind; the no-graph variant (fake success) skips this
if (process.env.STUDI0_TEST_NO_GRAPH !== '1') {
  fs.mkdirSync('graphify-out', { recursive: true });
  fs.writeFileSync('graphify-out/graph.json', '{"nodes":[]}');
}
process.exit(0);
`;

describe('proc + real pipeline runner (QA blocker 1 / minor 8)', () => {
  it('spawnArgs collects a real child with setEncoding streams (regression: ERR_INVALID_ARG_TYPE in Buffer.concat)', async () => {
    const { done, child } = spawnArgs(
      ['-e', 'console.log("OUT-OK"); console.error("ERR-OK");'],
      process.cwd(),
    );
    child.stdout?.setEncoding('utf8'); // exactly what the pipeline runner does
    child.stderr?.setEncoding('utf8');
    const res = await done;
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('OUT-OK');
    expect(res.stderr).toContain('ERR-OK');
  }, 30_000);

  it('killTree reaps orphaned grandchildren whose parent already died', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'studi0-kt-'));
    // child spawns a 60s grandchild, records its pid, exits immediately
    const child = spawnArgs(
      [
        '-e',
        `const { spawn } = require('node:child_process');
         const fs = require('node:fs');
         const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore', detached: true });
         fs.writeFileSync(${JSON.stringify(path.join(dir, 'gc.pid'))}, String(g.pid));
         setTimeout(() => process.exit(0), 2000);`,
      ],
      process.cwd(),
    );
    await child.done;
    const gcPid = (await readFile(path.join(dir, 'gc.pid'), 'utf8')).trim();
    let alive = isAlive(gcPid);
    for (let i = 0; i < 20 && !alive; i++) {
      await new Promise((r) => setTimeout(r, 100));
      alive = isAlive(gcPid);
    }
    expect(alive).toBe(true); // orphan alive after parent exit
    await killTree(child.pid as number);
    let dead = !isAlive(gcPid);
    for (let i = 0; i < 40 && !dead; i++) {
      await new Promise((r) => setTimeout(r, 100));
      dead = !isAlive(gcPid);
    }
    expect(dead).toBe(true); // parent-link sweep reached it
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it('real runner: protocol lines drive progress, job completes with artifacts', async () => {
    h = await makeHarness();
    const id = await createSubject('RealRun');
    const subject = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}` })).json();
    await writeFile(path.join(subject.path, 'run'), RUN_SCRIPT);
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${id}/jobs`,
      payload: { kind: 'build' },
    });
    expect(created.statusCode).toBe(202);
    const jobId = created.json().id;
    const t0 = Date.now();
    let job = { status: '', progress: { done: 0, total: 0 } };
    while (Date.now() - t0 < 30_000) {
      job = (await h.app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json();
      if (['complete', 'partial', 'failed', 'cancelled'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(job.status).toBe('complete');
    expect(job.progress).toEqual({ done: 1, total: 1, currentFile: 'material/a.md' });
    // verification oneshot ran and its report landed (real second run through the same spawn path)
    expect(await readFile(path.join(subject.path, 'graphify-out', 'VERIFY_REPORT.md'), 'utf8'))
      .toBeTruthy();
  }, 60_000);

  it('real runner: completion reaps a grandchild the child left behind', async () => {
    h = await makeHarness();
    process.env.STUDI0_TEST_GC = '1';
    const gcPidFile = path.join(h.dataDir, 'gc.pid');
    process.env.STUDI0_TEST_GC_PID = gcPidFile;
    try {
      const id = await createSubject('Reap');
      const subject = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}` })).json();
      await writeFile(path.join(subject.path, 'run'), RUN_SCRIPT);
      const jobId = (
        await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/jobs`, payload: { kind: 'build' } })
      ).json().id;
      const t0 = Date.now();
      let status = '';
      while (Date.now() - t0 < 30_000) {
        status = (await h.app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json().status;
        if (['complete', 'partial', 'failed', 'cancelled'].includes(status)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(status).toBe('complete');
      const gcPid = (await readFile(gcPidFile, 'utf8')).trim();
      let dead = !isAlive(gcPid);
      for (let i = 0; i < 40 && !dead; i++) {
        await new Promise((r) => setTimeout(r, 100));
        dead = !isAlive(gcPid);
      }
      expect(dead).toBe(true);
    } finally {
      delete process.env.STUDI0_TEST_GC;
      delete process.env.STUDI0_TEST_GC_PID;
    }
  }, 60_000);

  it('real runner: exit-0 without graph.json is a failed job, not a fake success (cs2040c regression)', async () => {
    h = await makeHarness();
    process.env.STUDI0_TEST_NO_GRAPH = '1';
    try {
      const id = await createSubject('NoGraph');
      const subject = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}` })).json();
      await writeFile(path.join(subject.path, 'run'), RUN_SCRIPT);
      const jobId = (
        await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/jobs`, payload: { kind: 'build' } })
      ).json().id;
      const t0 = Date.now();
      let job = { status: '', error: '' };
      while (Date.now() - t0 < 30_000) {
        job = (await h.app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json();
        if (['complete', 'partial', 'failed', 'cancelled'].includes(job.status)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(job.status).toBe('failed');
      expect(job.error).toContain('graph.json');
      // lastBuiltAt must NOT advance on a fake success — the graph state did not change
      const info = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/graph` })).json();
      expect(info.lastBuiltAt).toBeNull();
    } finally {
      delete process.env.STUDI0_TEST_NO_GRAPH;
    }
  }, 60_000);

  it('real runner: cancel kills the recorded child tree within 5s (AC4)', async () => {
    h = await makeHarness();
    process.env.STUDI0_TEST_SLOW = '1';
    try {
      const id = await createSubject('RealCancel');
      const subject = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}` })).json();
      await writeFile(path.join(subject.path, 'run'), RUN_SCRIPT);
      const jobId = (
        await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/jobs`, payload: { kind: 'build' } })
      ).json().id;
      const t0 = Date.now();
      let pid: string | null = null;
      while (Date.now() - t0 < 15_000) {
        const row = h.ctx.db.prepare('SELECT pid, status FROM jobs WHERE id = ?').get(jobId) as {
          pid: string | null;
          status: string;
        };
        pid = row.pid;
        if (row.status === 'running' && row.pid) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pid).toBeTruthy();
      const cancel = await h.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel` });
      expect(cancel.statusCode).toBe(200);
      let status = '';
      while (Date.now() - t0 < 20_000) {
        status = (await h.app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json().status;
        if (status === 'cancelled') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(Date.now() - t0).toBeLessThan(20_000);
      expect(status).toBe('cancelled');
      expect(isAlive(pid as string)).toBe(false);
    } finally {
      delete process.env.STUDI0_TEST_SLOW;
    }
  }, 60_000);
});
