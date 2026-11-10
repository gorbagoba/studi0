import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// stub spawn: the whole point is reading the args each stage spawns with
const mocks = vi.hoisted(() => ({ spawnArgs: vi.fn() }));
vi.mock('../src/util/proc.js', () => ({
  spawnArgs: mocks.spawnArgs,
  killTreeWithDeadline: vi.fn(),
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

const CHUNK = 'graphify-out/chunks/chunk-01.md';
const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

/** Run one build job with stubbed spawns; returns every spawned arg array. */
async function spawnedArgs(): Promise<string[][]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'studi0-models-'));
  made.push(dir);
  await mkdir(path.join(dir, 'graphify-out', 'chunks'), { recursive: true });
  await writeFile(path.join(dir, CHUNK), 'x');
  await writeFile(path.join(dir, 'graphify-out', 'graph.json'), '{}');
  const db = openDb(path.join(dir, 'studi0.db'));
  insertSubject(db, { id: 'subject-1', name: 'S', path: dir, created_at: new Date().toISOString() });
  const job = jobsRepo.insertJob(db, 'job-1', 'subject-1', 'build');
  mocks.spawnArgs.mockReset();
  mocks.spawnArgs.mockImplementation((args: string[]) => ({
    pid: 4242,
    done: Promise.resolve({
      code: 0,
      // the planner must return its chunk list; every other stage just exits 0
      stdout: args[args.length - 1].includes('PLANNER')
        ? JSON.stringify({ chunks: [CHUNK], total: 1 })
        : '',
      stderr: '',
    }),
    child: { kill: () => undefined, stdout: null, stderr: null },
  }));
  const outcome = await makeRunPipeline(db, makeConfig(dir))(
    job,
    { id: 'subject-1', name: 'S', path: dir } as never,
    () => undefined,
    new AbortController().signal,
  );
  expect(outcome.status).toBe('complete');
  db.close();
  return mocks.spawnArgs.mock.calls.map((c) => c[0] as string[]);
}

/** The `--model` value of the one spawn whose trailing prompt carries the stage marker. */
function modelFor(calls: string[][], marker: string): string | undefined {
  const args = calls.find((a) => a[a.length - 1].includes(marker));
  expect(args, `no spawn for ${marker}`).toBeTruthy();
  return args![args!.indexOf('--model') + 1];
}

describe('graph pipeline model per stage', () => {
  it('spawns plan/extract/merge on the fast model and verification on the thinking model', async () => {
    const calls = await spawnedArgs();
    expect(modelFor(calls, 'PLANNER')).toBe('soclaas/nemotron3.5:30b');
    expect(modelFor(calls, 'Execute this graphify chunk')).toBe('soclaas/nemotron3.5:30b');
    expect(modelFor(calls, 'per-chunk extraction outputs')).toBe('soclaas/nemotron3.5:30b');
    expect(modelFor(calls, 'graph verification agent')).toBe('soclaas/x-test-2');
  });

  it('honours the STUDI0_GRAPH_*_MODEL overrides', async () => {
    process.env.STUDI0_GRAPH_PLAN_MODEL = 'ghost/plan';
    process.env.STUDI0_GRAPH_EXTRACT_MODEL = 'ghost/extract';
    process.env.STUDI0_GRAPH_MERGE_MODEL = 'ghost/merge';
    process.env.STUDI0_GRAPH_VERIFY_MODEL = 'ghost/verify';
    try {
      const calls = await spawnedArgs();
      expect(modelFor(calls, 'PLANNER')).toBe('ghost/plan');
      expect(modelFor(calls, 'Execute this graphify chunk')).toBe('ghost/extract');
      expect(modelFor(calls, 'per-chunk extraction outputs')).toBe('ghost/merge');
      expect(modelFor(calls, 'graph verification agent')).toBe('ghost/verify');
    } finally {
      for (const key of [
        'STUDI0_GRAPH_PLAN_MODEL',
        'STUDI0_GRAPH_EXTRACT_MODEL',
        'STUDI0_GRAPH_MERGE_MODEL',
        'STUDI0_GRAPH_VERIFY_MODEL',
      ]) {
        delete process.env[key];
      }
    }
  });
});
