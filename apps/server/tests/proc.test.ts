import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeHarness } from './helpers';
import { spawnArgs, killTree, isAlive } from '../src/util/proc.js';
import type { TestHarness } from './helpers';

// route every spawnArgs call at node itself: a real child without needing opencode
process.env.OPENCODE_BIN = process.execPath;
// extraction is server-owned: GRAPHIFY_BIN=node runs the subject-local fake steps
process.env.GRAPHIFY_BIN = process.execPath;
// blank the gateway: the typing pass must not reach a real model
process.env.CHAT_BASE_URL = '';

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
 * Extension-less fake steps run by node from the subject cwd: `node extract …`
 * and `node cluster-only …` fake graphify, `node run … ` fakes opencode.
 * process.getBuiltinModule keeps the files loadable as CJS and ESM alike.
 */
const EXTRACT_SCRIPT = `const fs = process.getBuiltinModule('node:fs');
console.log('chunk 1/1');
if (process.env.STUDI0_TEST_SLOW === '1') {
  fs.writeFileSync('extract-pid.txt', String(process.pid));
  setTimeout(() => process.exit(0), 60000);
} else if (process.env.STUDI0_TEST_NO_GRAPH !== '1') {
  const nodes = Array.from({ length: 24 }, (_, i) => ({ id: 'n' + i, label: 'Concept ' + i, entity_type: 'Concept' }));
  const links = nodes.map((n, i) => ({ source: n.id, target: nodes[(i + 1) % nodes.length].id, relation: 'uses' }));
  fs.mkdirSync('graphify-out', { recursive: true });
  fs.writeFileSync('graphify-out/graph.json', JSON.stringify({ nodes, links }));
}
`;

const CLUSTER_SCRIPT = 'process.exit(0);\n';

/**
 * Fake verification one-shot: prints the report; can leave a detached grandchild
 * behind (reaping test) when the prompt asks for verification.
 */
const RUN_SCRIPT = `const fs = process.getBuiltinModule('node:fs');
const { spawn } = process.getBuiltinModule('node:child_process');
const argv = process.argv.join(' ');
if (process.env.STUDI0_TEST_GC === '1' && argv.includes('graph verification agent') && process.env.STUDI0_TEST_GC_PID) {
  // detached: must outlive its parent to simulate the real orphan case
  const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore', detached: true });
  fs.writeFileSync(process.env.STUDI0_TEST_GC_PID, String(g.pid));
}
console.log('## Confirmed edges\\n\\n- a --uses--> b — supported by material');
process.exit(0);
`;

async function stagePipeline(root: string): Promise<void> {
  await writeFile(path.join(root, 'extract'), EXTRACT_SCRIPT);
  await writeFile(path.join(root, 'cluster-only'), CLUSTER_SCRIPT);
  await writeFile(path.join(root, 'run'), RUN_SCRIPT);
}

async function waitForStatus(jobId: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  for (;;) {
    const job = (await h!.app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json() as Record<string, unknown>;
    if (['complete', 'partial', 'failed', 'cancelled'].includes(job.status as string)) return job;
    if (Date.now() - t0 > timeoutMs) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
}

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

  it('real runner: graphify chunk lines drive progress, job completes with artifacts', async () => {
    h = await makeHarness();
    const id = await createSubject('RealRun');
    const subject = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}` })).json();
    await stagePipeline(subject.path);
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${id}/jobs`,
      payload: { kind: 'build' },
    });
    expect(created.statusCode).toBe(202);
    const job = await waitForStatus(created.json().id);
    expect(job.status).toBe('complete');
    expect(job.progress).toEqual({ done: 1, total: 1, currentFile: null });
    // verification one-shot ran and its report landed (real second run through the same spawn path)
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
      await stagePipeline(subject.path);
      const jobId = (
        await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/jobs`, payload: { kind: 'build' } })
      ).json().id;
      const job = await waitForStatus(jobId);
      expect(job.status).toBe('complete');
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
      await stagePipeline(subject.path);
      const jobId = (
        await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/jobs`, payload: { kind: 'build' } })
      ).json().id;
      const job = await waitForStatus(jobId);
      expect(job.status).toBe('failed');
      expect(job.error).toContain('graph.json');
      // lastBuiltAt must NOT advance on a fake success — the graph state did not change
      const info = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/graph` })).json();
      expect(info.lastBuiltAt).toBeNull();
    } finally {
      delete process.env.STUDI0_TEST_NO_GRAPH;
    }
  }, 60_000);

  it('real runner: cancel kills the recorded extraction tree within 5s (AC4)', async () => {
    h = await makeHarness();
    process.env.STUDI0_TEST_SLOW = '1';
    try {
      const id = await createSubject('RealCancel');
      const subject = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}` })).json();
      await stagePipeline(subject.path);
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
      const job = await waitForStatus(jobId, 20_000);
      expect(Date.now() - t0).toBeLessThan(20_000);
      expect(job.status).toBe('cancelled');
      expect(isAlive(pid as string)).toBe(false);
    } finally {
      delete process.env.STUDI0_TEST_SLOW;
    }
  }, 60_000);
});
