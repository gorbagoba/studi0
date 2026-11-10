import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jobKindSchema } from '@studi0/shared';

// stub the opencode spawn (verification only) and the server-side extraction:
// preflight probes GRAPHIFY_BIN for real — node itself answers --version
process.env.GRAPHIFY_BIN = process.execPath;
// blank the gateway: the typing pass must not reach a real model
process.env.CHAT_BASE_URL = '';
const mocks = vi.hoisted(() => ({ spawnArgs: vi.fn(), extract: vi.fn() }));
vi.mock('../src/util/proc.js', () => ({
  spawnArgs: mocks.spawnArgs,
  killTreeWithDeadline: vi.fn(),
  killTree: async () => undefined,
  isAlive: () => true,
  commandLineMentions: async () => true,
  resolveOpencodeBin: () => 'opencode-stub',
}));
vi.mock('../src/graph/extract.js', () => ({ runGraphifyExtract: mocks.extract }));

import { openDb } from '../src/db/index.js';
import * as jobsRepo from '../src/db/repos/jobs.js';
import { insertSubject } from '../src/db/repos/subjects.js';
import { makeRunPipeline } from '../src/pipeline/runner.js';
import { makeConfig } from '../src/config.js';

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

/** Run one pipeline job with stubbed opencode + extraction; returns spawn args, extraction calls, dir. */
async function runJob(
  kind: 'build' | 'update' | 'recluster' | 'rebuild' = 'build',
  layout: 'root' | 'nested' = 'root',
): Promise<{ calls: string[][]; extractions: unknown[][]; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'studi0-models-'));
  made.push(dir);
  // 'nested' reproduces an agent that cd-ed into graphify-out before extracting
  const graphDir = layout === 'nested' ? path.join(dir, 'graphify-out', 'graphify-out') : path.join(dir, 'graphify-out');
  await mkdir(graphDir, { recursive: true });
  await writeFile(path.join(graphDir, 'graph.json'), JSON.stringify(healthyGraph));
  const db = openDb(path.join(dir, 'studi0.db'));
  insertSubject(db, { id: 'subject-1', name: 'S', path: dir, created_at: new Date().toISOString() });
  const job = jobsRepo.insertJob(db, 'job-1', 'subject-1', kind);
  mocks.spawnArgs.mockReset();
  mocks.spawnArgs.mockImplementation(() => ({
    pid: 4242,
    done: Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    child: { kill: () => undefined, stdout: null, stderr: null },
  }));
  mocks.extract.mockReset();
  mocks.extract.mockResolvedValue({ ok: true });
  const outcome = await makeRunPipeline(db, makeConfig(dir))(
    job,
    { id: 'subject-1', name: 'S', path: dir } as never,
    () => undefined,
    new AbortController().signal,
  );
  expect(outcome.status).toBe('complete');
  db.close();
  return {
    calls: mocks.spawnArgs.mock.calls.map((c) => c[0] as string[]),
    extractions: mocks.extract.mock.calls.map((c) => c as unknown[]),
    dir,
  };
}

/** The `--model` value of the one spawn whose trailing prompt carries the stage marker. */
function modelFor(calls: string[][], marker: string): string | undefined {
  const args = calls.find((a) => a[a.length - 1].includes(marker));
  expect(args, `no spawn for ${marker}`).toBeTruthy();
  return args![args!.indexOf('--model') + 1];
}

describe('graph pipeline models', () => {
  it('runs extraction on the server and verification on the thinking model', async () => {
    const { calls, extractions } = await runJob();
    expect(extractions).toHaveLength(1);
    expect(modelFor(calls, 'graph verification agent')).toBe('soclaas/x-test-2');
  });

  it('honours the STUDI0_GRAPH_VERIFY_MODEL override', async () => {
    process.env.STUDI0_GRAPH_VERIFY_MODEL = 'ghost/verify';
    try {
      const { calls } = await runJob();
      expect(modelFor(calls, 'graph verification agent')).toBe('ghost/verify');
    } finally {
      delete process.env.STUDI0_GRAPH_VERIFY_MODEL;
    }
  });

  it('spawns verification with the graphify backend env', async () => {
    const env = {
      STUDI0_GRAPH_BACKEND: 'openai',
      STUDI0_GRAPH_BASE_URL: 'http://gw.local/v1',
      STUDI0_GRAPH_API_KEY: 'gw-key',
      STUDI0_GRAPH_MODEL: 'm1',
    };
    Object.assign(process.env, env);
    try {
      await runJob();
      const envs = mocks.spawnArgs.mock.calls.map((c) => c[2] as Record<string, string>);
      expect(envs.length).toBeGreaterThan(0);
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

  it('runs a rebuild through server prep + server extraction, never an extraction agent', async () => {
    const { calls, extractions, dir } = await runJob('rebuild');
    expect(extractions).toHaveLength(1);
    expect(existsSync(path.join(dir, 'graphify-out', 'graph.json.pre-rebuild.bak'))).toBe(true);
    expect(calls.every((a) => a[a.length - 1].includes('graph verification agent'))).toBe(true);
    const buildLog = await readFile(path.join(dir, 'graphify-out', 'build.log'), 'utf8');
    expect(buildLog).toContain('full rebuild (cache cleared)');
    expect(buildLog).toContain('rebuild prep: backed up graph.json');
  });

  it('normalises a nested graphify-out before the success check', async () => {
    const { dir } = await runJob('build', 'nested');

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
