import { describe, expect, it, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeHarness, type TestHarness } from './helpers';

// fake graphify = node running the subject-local `extract` / `cluster-only` files
// (extension-less, so `node extract material …` runs the file from the subject cwd)
process.env.GRAPHIFY_BIN = process.execPath;
// fake opencode = node running the subject-local `run` file (verification / recluster)
process.env.OPENCODE_BIN = process.execPath;
// blank the gateway: the typing pass must not reach a real model
process.env.CHAT_BASE_URL = '';

let h: TestHarness | undefined;

afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

const healthyGraph = {
  nodes: Array.from({ length: 24 }, (_, i) => ({ id: `n${i}`, label: `Concept ${i}`, entity_type: 'Concept' })),
  links: Array.from({ length: 24 }, (_, i) => ({
    source: `n${i}`,
    target: `n${(i + 1) % 24}`,
    relation: 'uses',
  })),
};

const badGraph = {
  nodes: Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, label: `B${i}`, file_type: 'concept' })),
  links: Array.from({ length: 12 }, (_, i) => ({
    source: `b${i}`,
    target: `b${(i + 1) % 12}`,
    relation: 'cites',
  })),
};

/** Runs in CJS and ESM alike: no require/import, only process globals. */
const FAKE_HEAD = "const fs = process.getBuiltinModule('node:fs');\n";

function graphWriter(graph: unknown): string {
  return `fs.mkdirSync('graphify-out', { recursive: true });\nfs.writeFileSync('graphify-out/graph.json', ${JSON.stringify(JSON.stringify(graph))});\n`;
}

/** Subject-local fake graphify: records its argv, emits chunk progress, writes the graph. */
async function stageGraphify(root: string, graph: unknown = healthyGraph): Promise<void> {
  await writeFile(
    path.join(root, 'extract'),
    `${FAKE_HEAD}fs.appendFileSync('extract.log', process.argv.slice(2).join(' ') + '\\n');\nconsole.log('chunk 1/2');\nconsole.log('chunk 2/2');\n${graphWriter(graph)}`,
  );
  await writeFile(
    path.join(root, 'cluster-only'),
    `${FAKE_HEAD}fs.appendFileSync('cluster.log', process.argv.slice(2).join(' ') + '\\n');\n`,
  );
}

/** Subject-local fake opencode: records the (single-line) prompt; verification answers with a report. */
async function stageVerificationAgent(root: string): Promise<void> {
  await writeFile(
    path.join(root, 'run'),
    `${FAKE_HEAD}fs.appendFileSync('run.log', process.argv[process.argv.length - 1].replace(/\\s+/g, ' ') + '\\n');\nconsole.log('## Confirmed edges\\n\\n- a --uses--> b — supported by material');\n`,
  );
}

async function createSubject(name: string): Promise<{ id: string; root: string }> {
  const res = await h!.app.inject({ method: 'POST', url: '/api/subjects', payload: { name } });
  const body = res.json() as { id: string; path: string };
  return { id: body.id, root: body.path };
}

async function waitForTerminal(jobId: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  for (;;) {
    const job = (await h!.app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json() as Record<string, unknown>;
    if (['complete', 'partial', 'failed', 'cancelled'].includes(job.status as string)) return job;
    if (Date.now() - t0 > timeoutMs) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runJob(id: string, kind: 'build' | 'update' | 'rebuild' | 'recluster') {
  const jobId = (
    await h!.app.inject({ method: 'POST', url: `/api/subjects/${id}/jobs`, payload: { kind } })
  ).json().id as string;
  return waitForTerminal(jobId);
}

async function buildLog(root: string): Promise<string> {
  return readFile(path.join(root, 'graphify-out', 'build.log'), 'utf8').catch(() => '');
}

describe('server-owned graph extraction (build/update/rebuild)', () => {
  it.each(['build', 'update', 'rebuild'] as const)('%s runs graphify on the server and only verifies with the agent', async (kind) => {
    h = await makeHarness();
    const { id, root } = await createSubject(`Extract-${kind}`);
    await stageGraphify(root);
    await stageVerificationAgent(root);

    const job = await runJob(id, kind);

    expect(job.status).toBe('complete');
    // graphify itself ran once, with the exact pinned args
    expect((await readFile(path.join(root, 'extract.log'), 'utf8')).trim()).toBe(
      'material --out . --token-budget 3000',
    );
    expect((await readFile(path.join(root, 'cluster.log'), 'utf8')).trim()).toBe('.');
    // the extraction agent never spawned: the only opencode run is verification
    const prompts = (await readFile(path.join(root, 'run.log'), 'utf8')).split('\n').filter(Boolean);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('graph verification agent');
    expect(prompts[0]).not.toContain('PLANNER');
    expect(prompts[0]).not.toContain('Execute this graphify chunk');
    expect(prompts[0]).not.toContain('--token-budget');
    // progress came from graphify's chunk lines
    expect(job.progress).toEqual({ done: 2, total: 2, currentFile: null });
    expect(await buildLog(root)).toContain('progress 2/2');
    await expect(readFile(path.join(root, 'graphify-out', 'VERIFY_REPORT.md'), 'utf8')).resolves.toContain(
      'Confirmed edges',
    );
  }, 60_000);

  it('rebuild backs up the previous graph before extraction', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('Rebuild');
    await mkdir(path.join(root, 'graphify-out'), { recursive: true });
    await writeFile(path.join(root, 'graphify-out', 'graph.json'), JSON.stringify(healthyGraph));
    await stageGraphify(root);
    await stageVerificationAgent(root);

    const job = await runJob(id, 'rebuild');

    expect(job.status).toBe('complete');
    expect(existsSync(path.join(root, 'graphify-out', 'graph.json.pre-rebuild.bak'))).toBe(true);
    const log = await buildLog(root);
    expect(log).toContain('full rebuild (cache cleared)');
    expect(log).toContain('rebuild prep: backed up graph.json');
  }, 60_000);

  it('fails the build when extraction kept graphify default ontology', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('BadOntology');
    await stageGraphify(root, badGraph);
    await stageVerificationAgent(root);

    const job = await runJob(id, 'build');

    expect(job.status).toBe('failed');
    const error = job.error as string;
    expect(error).toContain('graph ontology invalid: 12/12 nodes have unexpected entity_type');
    expect(error).toContain('extraction must set entity_type, not file_type');
    const log = await buildLog(root);
    expect(log).toContain('graph quality:');
    expect(log).toContain('ontology violations');
  }, 60_000);
});

describe('recluster stays agent-driven', () => {
  it('asks the agent for cluster-only and never runs extraction', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('Recluster');
    await mkdir(path.join(root, 'graphify-out'), { recursive: true });
    await writeFile(path.join(root, 'graphify-out', 'graph.json'), JSON.stringify(healthyGraph));
    // no extract / cluster-only fakes: any server extraction would fail the job
    await stageVerificationAgent(root);

    const job = await runJob(id, 'recluster');

    expect(job.status).toBe('complete');
    const prompts = (await readFile(path.join(root, 'run.log'), 'utf8')).split('\n').filter(Boolean);
    expect(prompts[0]).toContain('graphify cluster-only .');
    // no extract.log means the server never spawned graphify extraction
    expect(existsSync(path.join(root, 'extract.log'))).toBe(false);
    await expect(readFile(path.join(root, 'graphify-out', 'VERIFY_REPORT.md'), 'utf8')).resolves.toBeTruthy();
  }, 60_000);
});

describe('job progress + SSE log', () => {
  it('log events carry graphify output and progress lines', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('Logs');
    await stageGraphify(root);
    await stageVerificationAgent(root);
    const lines: string[] = [];
    h.ctx.events.subscribe(id, (event, data) => {
      if (event === 'log') lines.push((data as { line: string }).line);
    });

    const job = await runJob(id, 'build');

    expect(job.status).toBe('complete');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^\[T\+\d+s\] /);
    expect(lines.some((l) => l.includes('graphify: chunk 2/2'))).toBe(true);
    expect(lines.some((l) => l.includes('progress 2/2'))).toBe(true);
    expect(lines.some((l) => l.includes('started (job'))).toBe(true);
  }, 60_000);
});
