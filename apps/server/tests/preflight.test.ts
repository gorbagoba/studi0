import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// stub spawn: a failed preflight must never reach the agent spawn
const mocks = vi.hoisted(() => ({ spawnArgs: vi.fn() }));
vi.mock('../src/util/proc.js', () => ({
  spawnArgs: mocks.spawnArgs,
  killTreeWithDeadline: vi.fn(),
  killTree: async () => undefined,
  isAlive: () => true,
  commandLineMentions: async () => true,
  resolveOpencodeBin: () => 'opencode-stub',
}));

import { checkGraphify } from '../src/graph/preflight.js';
import { openDb } from '../src/db/index.js';
import * as jobsRepo from '../src/db/repos/jobs.js';
import { insertSubject } from '../src/db/repos/subjects.js';
import { makeRunPipeline } from '../src/pipeline/runner.js';
import { makeConfig } from '../src/config.js';

const saved = { ...process.env };
const made: string[] = [];

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  mocks.spawnArgs.mockReset();
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
});

describe('graphify preflight', () => {
  it('fails with the setup hint when the bin is missing (probe never runs)', async () => {
    const probe = vi.fn();
    const res = await checkGraphify(path.join(tmpdir(), 'no-such-venv', 'graphify'), probe);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('graphify venv missing');
      expect(res.error).toContain('run `pnpm setup`');
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it('passes and reports the version when the stub answers --version', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'studi0-preflight-'));
    made.push(dir);
    const bin = path.join(dir, 'graphify');
    await writeFile(bin, '');
    const res = await checkGraphify(bin, async () => ({ code: 0, stdout: 'graphify 0.9.95\n', stderr: '' }));
    expect(res).toEqual({ ok: true, version: 'graphify 0.9.95' });
  });

  it('fails the job before any spawn when the venv bin is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'studi0-preflight-job-'));
    made.push(dir);
    process.env.GRAPHIFY_BIN = path.join(dir, 'missing-venv', 'graphify');
    const db = openDb(path.join(dir, 'studi0.db'));
    insertSubject(db, { id: 'subject-1', name: 'S', path: dir, created_at: new Date().toISOString() });
    const job = jobsRepo.insertJob(db, 'job-1', 'subject-1', 'build');
    const outcome = await makeRunPipeline(db, makeConfig(dir))(
      job,
      { id: 'subject-1', name: 'S', path: dir } as never,
      () => undefined,
      new AbortController().signal,
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('run `pnpm setup`');
    expect(mocks.spawnArgs).not.toHaveBeenCalled();
    db.close();
  });
});
