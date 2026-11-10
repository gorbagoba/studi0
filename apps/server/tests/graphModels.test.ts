import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jobKindSchema } from '@studi0/shared';

// stub spawn: the whole point is reading the args each stage spawns with
// preflight probes GRAPHIFY_BIN for real — node itself answers --version
process.env.GRAPHIFY_BIN = process.execPath;
// blank the gateway: spawns are stubbed, so the typing pass must not reach a real model
process.env.CHAT_BASE_URL = '';
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

/** Typed graph so the hollow-extraction guard passes (no material/ files → count 0). */
const healthyGraph = {
  nodes: [
    { id: 'a', label: 'Gradient descent', entity_type: 'Algorithm' },
    { id: 'b', label: 'Loss function', entity_type: 'Concept' },
  ],
  links: [{ source: 'a', target: 'b', relation: 'uses' }],
};

afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

/** Run one pipeline job with stubbed spawns; returns every spawned arg array and the subject root. */
async function spawnedArgs(
  kind: 'build' | 'update' | 'recluster' | 'rebuild' = 'build',
  layout: 'root' | 'nested' = 'root',
): Promise<{ calls: string[][]; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'studi0-models-'));
  made.push(dir);
  await mkdir(path.join(dir, 'graphify-out', 'chunks'), { recursive: true });
  await writeFile(path.join(dir, CHUNK), 'x');
  // 'nested' reproduces an agent that cd-ed into graphify-out before extracting
  const graphDir = layout === 'nested' ? path.join(dir, 'graphify-out', 'graphify-out') : path.join(dir, 'graphify-out');
  await mkdir(graphDir, { recursive: true });
  await writeFile(path.join(graphDir, 'graph.json'), JSON.stringify(healthyGraph));
  const db = openDb(path.join(dir, 'studi0.db'));
  insertSubject(db, { id: 'subject-1', name: 'S', path: dir, created_at: new Date().toISOString() });
  const job = jobsRepo.insertJob(db, 'job-1', 'subject-1', kind);
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
  return { calls: mocks.spawnArgs.mock.calls.map((c) => c[0] as string[]), dir };
}

/** The `--model` value of the one spawn whose trailing prompt carries the stage marker. */
function modelFor(calls: string[][], marker: string): string | undefined {
  const args = calls.find((a) => a[a.length - 1].includes(marker));
  expect(args, `no spawn for ${marker}`).toBeTruthy();
  return args![args!.indexOf('--model') + 1];
}

describe('graph pipeline model per stage', () => {
  it('spawns plan/extract/merge on the fast model and verification on the thinking model', async () => {
    const { calls } = await spawnedArgs();
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
      const { calls } = await spawnedArgs();
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

  it('spawns every stage with the graphify backend env', async () => {
    const env = {
      STUDI0_GRAPH_BACKEND: 'openai',
      STUDI0_GRAPH_BASE_URL: 'http://gw.local/v1',
      STUDI0_GRAPH_API_KEY: 'gw-key',
      STUDI0_GRAPH_MODEL: 'm1',
    };
    Object.assign(process.env, env);
    try {
      await spawnedArgs();
      const envs = mocks.spawnArgs.mock.calls.map((c) => c[2] as Record<string, string>);
      expect(envs.length).toBeGreaterThan(0); // plan + chunk(s) + merge + verification
      for (const childEnv of envs) {
        expect(childEnv).toMatchObject({
          GRAPHIFY_BACKEND: 'openai',
          OPENAI_BASE_URL: 'http://gw.local/v1',
          OPENAI_API_KEY: 'gw-key',
          GRAPHIFY_OPENAI_MODEL: 'm1',
          ANTHROPIC_API_KEY: '',
          GEMINI_API_KEY: '',
        });
      }
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
    }
  });

  it('passes the configured token budget to every extraction stage', async () => {
    process.env.STUDI0_GRAPH_TOKEN_BUDGET = '1200';
    try {
      const { calls } = await spawnedArgs();
      const extract = calls.filter((a) =>
        /PLANNER|Execute this graphify chunk|per-chunk extraction outputs/.test(a[a.length - 1]),
      );
      expect(extract.length).toBeGreaterThan(0);
      for (const args of extract) expect(args[args.length - 1]).toContain('--token-budget 1200');
    } finally {
      delete process.env.STUDI0_GRAPH_TOKEN_BUDGET;
    }
  });

  it('runs a rebuild through the chunked wave path with the rebuild plan prompt', async () => {
    const { calls, dir } = await spawnedArgs('rebuild');
    const plan = calls.find((a) => a[a.length - 1].includes('PLANNER'));
    expect(plan, 'no plan stage spawned').toBeTruthy();
    expect(plan![plan!.length - 1]).toContain('REBUILD');
    // backup and cache clearing are server-owned now
    expect(plan![plan!.length - 1]).not.toContain('graph.json.pre-rebuild.bak');
    expect(existsSync(path.join(dir, 'graphify-out', 'graph.json.pre-rebuild.bak'))).toBe(true);
    expect(calls.some((a) => a[a.length - 1].includes('Execute this graphify chunk'))).toBe(true);
    const buildLog = await readFile(path.join(dir, 'graphify-out', 'build.log'), 'utf8');
    expect(buildLog).toContain('full rebuild (cache cleared)');
    expect(buildLog).toContain('rebuild prep: backed up graph.json');
  });

  it('normalises a nested graphify-out before the success check', async () => {
    const { dir } = await spawnedArgs('build', 'nested');

    expect(existsSync(path.join(dir, 'graphify-out', 'graph.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'graphify-out', 'graphify-out'))).toBe(false);
    const buildLog = await readFile(path.join(dir, 'graphify-out', 'build.log'), 'utf8');
    expect(buildLog).toContain('normalised nested graphify-out → graphify-out');
  });
});

describe('job kinds', () => {
  it('accepts rebuild and rejects unknown kinds', () => {
    expect(jobKindSchema.parse('rebuild')).toBe('rebuild');
    expect(jobKindSchema.safeParse('explode').success).toBe(false);
  });
});
