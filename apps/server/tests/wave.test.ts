import { describe, expect, it, afterEach } from 'vitest';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { makeHarness } from './helpers';
import { isAlive } from '../src/util/proc.js';
import { makeConfig } from '../src/config.js';
import { planChunks, PLAN_LIMITS } from '../src/graph/plan.js';
import type { TestHarness } from './helpers';

// route every spawnArgs call at node itself: a real child without needing opencode
process.env.OPENCODE_BIN = process.execPath;
// preflight probes GRAPHIFY_BIN for real — node itself answers --version
process.env.GRAPHIFY_BIN = process.execPath;
// blank the gateway: the typing pass must not reach a real model
process.env.CHAT_BASE_URL = '';

// the wave size the harness app actually uses (cfg.maxChunkConcurrency)
const WAVE = makeConfig().maxChunkConcurrency;

let h: TestHarness | undefined;

afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

async function createSubject(name: string): Promise<{ id: string; root: string }> {
  const res = await h!.app.inject({ method: 'POST', url: '/api/subjects', payload: { name } });
  const body = res.json() as { id: string; path: string };
  return { id: body.id, root: body.path };
}

/** Write `count` small material files and report the sizes planChunks will see. */
async function stageMaterial(root: string, count: number): Promise<{ relPath: string; bytes: number }[]> {
  await mkdir(path.join(root, 'material'), { recursive: true });
  const files: { relPath: string; bytes: number }[] = [];
  for (let i = 0; i < count; i++) {
    const relPath = `material/f-${String(i).padStart(2, '0')}.md`;
    const body = 'x'.repeat(100 + i);
    await writeFile(path.join(root, relPath), body);
    files.push({ relPath, bytes: Buffer.byteLength(body) });
  }
  return files;
}

function stageScript(): string {
  // The fake `opencode` (executed as `node run ...`): stages are told apart by
  // stable phrases from the real prompts (PLANNER / Execute this graphify chunk /
  // per-chunk extraction outputs / graph verification agent); anything else is
  // the fallback single-run pipeline.
  return `const fs = require('node:fs');
const prompt = process.argv[process.argv.length - 1];
// typed graph with real edges: the hollow-extraction guard must pass
function healthyGraph() {
  const nodes = Array.from({ length: 24 }, (_, i) => ({ id: 'n' + i, label: 'Concept ' + i, entity_type: 'Concept' }));
  const links = nodes.map((n, i) => ({ source: n.id, target: nodes[(i + 1) % nodes.length].id, relation: 'uses' }));
  return { nodes, links };
}
// graphify defaults, one node per file: the ontology gate must fail it
function badGraph() {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: 'b' + i, label: 'B' + i, file_type: 'concept' }));
  const links = nodes.map((n, i) => ({ source: n.id, target: nodes[(i + 1) % nodes.length].id, relation: 'cites' }));
  return { nodes, links };
}
if (prompt.includes('graph verification agent')) {
  console.log('## Confirmed edges\\n\\n- a --uses--> b — supported by material');
  process.exit(0);
}
if (prompt.includes('per-chunk extraction outputs')) { // merge + export
  fs.mkdirSync('graphify-out', { recursive: true });
  const graph = process.env.STUDI0_TEST_BAD_GRAPH === '1' ? badGraph() : healthyGraph();
  fs.writeFileSync('graphify-out/graph.json', JSON.stringify(graph));
  console.log('DONE 0 files ok, 0 failed.');
  process.exit(0);
}
if (prompt.includes('PLANNER')) { // plan one-shot: write chunk files + JSON plan
  if (process.env.STUDI0_TEST_PLAN_LOG) fs.appendFileSync(process.env.STUDI0_TEST_PLAN_LOG, 'planned\\n');
  if (process.env.STUDI0_TEST_PLAN_GARBAGE === '1') {
    console.log('sorry, I cannot produce a plan today');
    process.exit(0);
  }
  const n = Number(process.env.STUDI0_TEST_CHUNKS || '2');
  fs.mkdirSync('graphify-out/chunks', { recursive: true });
  const chunks = [];
  for (let i = 1; i <= n; i++) {
    const p = 'graphify-out/chunks/chunk-' + String(i).padStart(2, '0') + '.md';
    fs.writeFileSync(p, 'extract chunk ' + i);
    chunks.push(p);
  }
  console.log('thinking about the split...');
  console.log(JSON.stringify({ chunks, total: n }));
  process.exit(0);
}
if (prompt.includes('Execute this graphify chunk')) { // one wave child per chunk
  const full = (prompt.match(/graphify-out\\/chunks\\/chunk-\\d+\\.md/) || ['chunks/chunk-x.md'])[0];
  const short = full.split('/').pop().replace(/\\.md$/, '');
  fs.appendFileSync(process.env.STUDI0_TEST_WAVELOG, 'start:' + short + '\\n');
  if (process.env.STUDI0_TEST_CHUNK_FAILS === short) {
    console.log('studi0-failed {"file":"' + full + '","reason":"boom"}');
    fs.appendFileSync(process.env.STUDI0_TEST_WAVELOG, 'end:' + short + '\\n');
    process.exit(0);
  }
  if (process.env.STUDI0_TEST_CHUNK_CRASH === short) process.exit(3);
  if (process.env.STUDI0_TEST_CHUNK_SLOW === '1') {
    fs.mkdirSync(process.env.STUDI0_TEST_PID_DIR, { recursive: true });
    fs.writeFileSync(process.env.STUDI0_TEST_PID_DIR + '/' + short + '.pid', String(process.pid));
    setTimeout(() => process.exit(0), 60000);
  }
  const t = Date.now();
  while (Date.now() - t < 150) {} // busy-wait so wave overlap is observable in the log
  fs.appendFileSync(process.env.STUDI0_TEST_WAVELOG, 'end:' + short + '\\n');
  console.log('DONE 1 files ok, 0 failed.');
  process.exit(0);
}
// fallback single-run pipeline (extractionPrompt)
console.log('studi0-progress {"done":0,"total":1,"file":null}');
console.log('studi0-progress {"done":1,"total":1,"file":"material/a.md"}');
console.log('DONE 1 files ok, 0 failed.');
fs.mkdirSync('graphify-out', { recursive: true });
fs.writeFileSync('graphify-out/graph.json', JSON.stringify(healthyGraph()));
process.exit(0);
`;
}

async function waitForTerminal(jobId: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  for (;;) {
    const job = (await h!.app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json() as Record<
      string,
      unknown
    >;
    if (['complete', 'partial', 'failed', 'cancelled'].includes(job.status as string)) return job;
    if (Date.now() - t0 > timeoutMs) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('wave pipeline runner (T-P1/T-P2)', () => {
  it(`plans, runs chunks in waves of ≤${WAVE}, merges, verifies; progress + log SSE events flow`, async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('Waves');
    await writeFile(path.join(root, 'run'), stageScript());
    const wavelog = path.join(root, 'wave.log');
    process.env.STUDI0_TEST_CHUNKS = '9';
    process.env.STUDI0_TEST_WAVELOG = wavelog;
    const logEvents: { line: string; at: string }[] = [];
    h.ctx.events.subscribe(id, (event, data) => {
      if (event === 'log') logEvents.push(data as { line: string; at: string });
    });
    try {
      const jobId = (
        await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/jobs`, payload: { kind: 'build' } })
      ).json().id;
      const job = await waitForTerminal(jobId, 60_000);
      expect(job.status).toBe('complete');
      expect(job.progress).toEqual({ done: 9, total: 9, currentFile: null });
      // artifacts: merge wrote the graph, verification one-shot wrote the report
      await expect(readFile(path.join(root, 'graphify-out', 'graph.json'), 'utf8')).resolves.toBeTruthy();
      await expect(readFile(path.join(root, 'graphify-out', 'VERIFY_REPORT.md'), 'utf8')).resolves.toContain('Confirmed edges');
      // every chunk ran exactly once, and never more than the configured wave in flight
      const lines = (await readFile(wavelog, 'utf8')).trim().split('\n');
      const started = lines.filter((l) => l.startsWith('start:'));
      expect(started).toHaveLength(9);
      let inFlight = 0;
      let maxInFlight = 0;
      for (const l of lines) {
        if (l.startsWith('start:')) inFlight++;
        else inFlight--;
        maxInFlight = Math.max(maxInFlight, inFlight);
      }
      expect(maxInFlight).toBeLessThanOrEqual(WAVE);
      // build.log passthrough + SSE log events share the same lines
      const tail = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/graph/log` })).json() as {
        log: string;
      };
      expect(tail.log).toContain('chunk plan: 9 chunks');
      expect(logEvents.length).toBeGreaterThan(0);
      for (const e of logEvents) {
        expect(e.line).toMatch(/^\[T\+\d+s\] /);
        expect(Number.isNaN(Date.parse(e.at))).toBe(false);
      }
      expect(logEvents.some((e) => e.line.includes('started (job'))).toBe(true);
      expect(tail.log).toContain(logEvents[0].line);
    } finally {
      delete process.env.STUDI0_TEST_CHUNKS;
      delete process.env.STUDI0_TEST_WAVELOG;
    }
  }, 90_000);

  it('reports chunk failures honestly (partial) without stopping the remaining waves', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('WavePartial');
    await writeFile(path.join(root, 'run'), stageScript());
    process.env.STUDI0_TEST_CHUNKS = '3';
    process.env.STUDI0_TEST_WAVELOG = path.join(root, 'wave.log');
    process.env.STUDI0_TEST_CHUNK_FAILS = 'chunk-01';
    process.env.STUDI0_TEST_CHUNK_CRASH = 'chunk-02';
    try {
      const jobId = (
        await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/jobs`, payload: { kind: 'build' } })
      ).json().id;
      const job = await waitForTerminal(jobId, 60_000);
      expect(job.status).toBe('partial');
      expect(job.progress).toEqual({ done: 3, total: 3, currentFile: null });
      expect(job.partial).toEqual([
        { file: 'graphify-out/chunks/chunk-01.md', reason: 'boom' },
        { file: 'graphify-out/chunks/chunk-02.md', reason: 'chunk run exited with code 3' },
      ]);
    } finally {
      delete process.env.STUDI0_TEST_CHUNKS;
      delete process.env.STUDI0_TEST_WAVELOG;
      delete process.env.STUDI0_TEST_CHUNK_FAILS;
      delete process.env.STUDI0_TEST_CHUNK_CRASH;
    }
  }, 90_000);

  it('cancel aborts every in-flight wave child within the deadline (AC4)', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('WaveCancel');
    await writeFile(path.join(root, 'run'), stageScript());
    process.env.STUDI0_TEST_CHUNKS = String(WAVE + 2); // wave 1 = WAVE children, wave 2 = the rest
    process.env.STUDI0_TEST_CHUNK_SLOW = '1';
    process.env.STUDI0_TEST_WAVELOG = path.join(root, 'wave.log');
    const pidDir = path.join(root, 'pids');
    process.env.STUDI0_TEST_PID_DIR = pidDir;
    const fsp = await import('node:fs/promises');
    await rm(pidDir, { recursive: true, force: true });
    await fsp.mkdir(pidDir, { recursive: true });
    try {
      const jobId = (
        await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/jobs`, payload: { kind: 'build' } })
      ).json().id;
      // wait until wave 1 (WAVE children) is in flight
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        const files = await fsp.readdir(pidDir).catch(() => [] as string[]);
        if (files.length >= WAVE) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const cancel = await h.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel` });
      expect(cancel.statusCode).toBe(200);
      const job = await waitForTerminal(jobId, 20_000);
      expect(job.status).toBe('cancelled');
      // only wave 1 spawned (WAVE children); all of them were killed
      const files = await fsp.readdir(pidDir);
      expect(files).toHaveLength(WAVE);
      for (const f of files) {
        const pid = (await readFile(path.join(pidDir, f), 'utf8')).trim();
        expect(isAlive(pid)).toBe(false);
      }
    } finally {
      delete process.env.STUDI0_TEST_CHUNKS;
      delete process.env.STUDI0_TEST_CHUNK_SLOW;
      delete process.env.STUDI0_TEST_WAVELOG;
      delete process.env.STUDI0_TEST_PID_DIR;
    }
  }, 60_000);

  it('falls back to the single-run pipeline when the planner produces no usable plan', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('WaveFallback');
    await writeFile(path.join(root, 'run'), stageScript());
    process.env.STUDI0_TEST_PLAN_GARBAGE = '1';
    try {
      const jobId = (
        await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/jobs`, payload: { kind: 'build' } })
      ).json().id;
      const job = await waitForTerminal(jobId, 60_000);
      expect(job.status).toBe('complete');
      expect(job.progress).toEqual({ done: 1, total: 1, currentFile: 'material/a.md' });
      const tail = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/graph/log` })).json() as {
        log: string;
      };
      expect(tail.log).toContain('falling back to single-run pipeline');
      await expect(readFile(path.join(root, 'graphify-out', 'VERIFY_REPORT.md'), 'utf8')).resolves.toBeTruthy();
    } finally {
      delete process.env.STUDI0_TEST_PLAN_GARBAGE;
    }
  }, 60_000);

  it.each(['build', 'update', 'rebuild'] as const)(
    'skips the planner and writes deterministic chunk prompts for %s',
    async (kind) => {
      h = await makeHarness();
      const { id, root } = await createSubject(`Det-${kind}`);
      await writeFile(path.join(root, 'run'), stageScript());
      const material = await stageMaterial(root, 18);
      const expected = planChunks(material, PLAN_LIMITS).length;
      const planLog = path.join(root, 'plan.log');
      process.env.STUDI0_TEST_PLAN_LOG = planLog;
      process.env.STUDI0_TEST_WAVELOG = path.join(root, 'wave.log');
      try {
        const jobId = (
          await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/jobs`, payload: { kind } })
        ).json().id;
        const job = await waitForTerminal(jobId, 60_000);
        expect(job.status).toBe('complete');
        expect(job.progress).toEqual({ done: expected, total: expected, currentFile: null });
        // the planner one-shot never spawned
        await expect(readFile(planLog, 'utf8')).rejects.toThrow();
        const chunk = await readFile(path.join(root, 'graphify-out', 'chunks', 'chunk-01.md'), 'utf8');
        expect(chunk).toContain('- material/f-00.md');
        expect(chunk).toContain('entity_type');
        expect(chunk).toContain('inside the subject root');
        const tail = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/graph/log` })).json() as {
          log: string;
        };
        expect(tail.log).toContain(`chunk plan: ${expected} chunks (deterministic, 18 files)`);
        expect(tail.log).toContain('graph quality:');
      } finally {
        delete process.env.STUDI0_TEST_PLAN_LOG;
        delete process.env.STUDI0_TEST_WAVELOG;
      }
    },
    90_000,
  );

  it('fails the build when extraction kept graphify default ontology', async () => {
    // typing must not silently fix the defaults here: blank the gateway so every
    // typing batch fails and the ontology gate reports the raw extraction
    const prevBaseUrl = process.env.CHAT_BASE_URL;
    process.env.CHAT_BASE_URL = '';
    h = await makeHarness();
    const { id, root } = await createSubject('BadOntology');
    await writeFile(path.join(root, 'run'), stageScript());
    await stageMaterial(root, 2);
    process.env.STUDI0_TEST_BAD_GRAPH = '1';
    process.env.STUDI0_TEST_WAVELOG = path.join(root, 'wave.log');
    try {
      const jobId = (
        await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/jobs`, payload: { kind: 'build' } })
      ).json().id;
      const job = await waitForTerminal(jobId, 60_000);
      expect(job.status).toBe('failed');
      const error = job.error as string;
      expect(error).toContain('graph ontology invalid: 12/12 nodes have unexpected entity_type');
      expect(error).toContain('extraction must set entity_type, not file_type');
      const tail = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/graph/log` })).json() as {
        log: string;
      };
      expect(tail.log).toContain('graph quality:');
      expect(tail.log).toContain('ontology violations');
    } finally {
      delete process.env.STUDI0_TEST_BAD_GRAPH;
      delete process.env.STUDI0_TEST_WAVELOG;
      if (prevBaseUrl === undefined) delete process.env.CHAT_BASE_URL;
      else process.env.CHAT_BASE_URL = prevBaseUrl;
    }
  }, 60_000);
});
