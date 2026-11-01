import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// stub spawn/kill: pid bookkeeping must not need a real opencode
const mocks = vi.hoisted(() => ({
  spawnArgs: vi.fn(),
  killTreeWithDeadline: vi.fn(),
}));
vi.mock('../src/util/proc.js', () => ({
  spawnArgs: mocks.spawnArgs,
  killTreeWithDeadline: mocks.killTreeWithDeadline,
  killTree: async () => undefined,
  isAlive: () => true,
  commandLineMentions: async () => true,
  resolveOpencodeBin: () => 'opencode-stub',
}));

import { openDb } from '../src/db/index.js';
import * as jobsRepo from '../src/db/repos/jobs.js';
import { insertSubject } from '../src/db/repos/subjects.js';
import { makeRunPipeline } from '../src/pipeline/runner.js';
import { makeConfig } from '../src/config.js';

const made: string[] = [];

beforeEach(() => {
  mocks.spawnArgs.mockReset();
  mocks.killTreeWithDeadline.mockReset();
});

afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

describe('job pid bookkeeping', () => {
  it('runner persists the spawned child pid on the job row', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'studi0-pid-'));
    made.push(dir);
    await (await import('node:fs/promises')).mkdir(path.join(dir, 'graphify-out'), { recursive: true });
    await (await import('node:fs/promises')).writeFile(path.join(dir, 'graphify-out', 'graph.json'), '{}');
    const db = openDb(path.join(dir, 'studi0.db'));
    insertSubject(db, { id: 'subject-1', name: 'S', path: dir, created_at: new Date().toISOString() });
    const job = jobsRepo.insertJob(db, 'job-1', 'subject-1', 'build');
    mocks.spawnArgs.mockReturnValue({
      pid: 4242,
      done: Promise.resolve({ code: 0, stdout: '', stderr: '' }),
      child: { kill: () => undefined, stdout: null, stderr: null },
    });
    const subject = { id: 'subject-1', name: 'S', path: dir } as never;
    const outcome = await makeRunPipeline(async () => 'ok', db, makeConfig())(
      job,
      subject,
      () => undefined,
      new AbortController().signal,
    );
    expect(outcome.status).toBe('complete');
    expect(jobsRepo.getJob(db, 'job-1')?.pid).toBe('4242');
    db.close();
  });

  it('boot kill-trees pid-bearing stale running rows, then closes them as failed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'studi0-boot-'));
    made.push(dir);
    const seed = openDb(path.join(dir, 'studi0.db'));
    insertSubject(seed, { id: 'subject-1', name: 'S', path: dir, created_at: new Date().toISOString() });
    jobsRepo.insertJob(seed, 'stale-1', 'subject-1', 'build');
    jobsRepo.updateJob(seed, 'stale-1', { status: 'running', pid: '999' });
    seed.close();
    const { buildApp } = await import('../src/http/app.js');
    const boot = await buildApp({ dataDir: dir });
    expect(mocks.killTreeWithDeadline).toHaveBeenCalledWith('999');
    const row = jobsRepo.getJob(boot.ctx.db, 'stale-1');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('server restarted');
    boot.ctx.db.close();
  });
});
