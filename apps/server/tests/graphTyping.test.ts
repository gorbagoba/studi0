import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// stub spawn: the runner's plan/merge/verification stages must not execute
process.env.GRAPHIFY_BIN = process.execPath;
const mocks = vi.hoisted(() => ({ spawnArgs: vi.fn(), chatCompletion: vi.fn() }));
vi.mock('../src/util/proc.js', () => ({
  spawnArgs: mocks.spawnArgs,
  killTreeWithDeadline: vi.fn(),
  killTree: async () => undefined,
  isAlive: () => true,
  commandLineMentions: async () => true,
  resolveOpencodeBin: () => 'opencode-stub',
}));
vi.mock('../src/teacher/llm.js', () => ({ chatCompletion: mocks.chatCompletion }));

import {
  applyTyping,
  classifyGraph,
  parseTypingAnswer,
  readGraph,
  writeGraph,
} from '../src/graph/typing.js';
import { INSPECT_SCRIPT } from '../src/graph/inspectScript.js';
import { openDb } from '../src/db/index.js';
import * as jobsRepo from '../src/db/repos/jobs.js';
import { insertSubject } from '../src/db/repos/subjects.js';
import { makeRunPipeline } from '../src/pipeline/runner.js';
import { makeConfig } from '../src/config.js';

/** graphify's real default output: no entity_type, `links`, default relations. */
const graphifyGraph = {
  nodes: [
    { id: 'a', label: 'Gradient descent', file_type: 'concept', description: 'An optimisation loop.' },
    { id: 'b', label: 'Loss function', file_type: 'document' },
  ],
  links: [{ source: 'a', target: 'b', relation: 'cites' }],
};

const answer = JSON.stringify({
  nodes: [
    { id: 'a', entity_type: 'Algorithm' },
    { id: 'b', entity_type: 'Concept' },
  ],
  edges: [{ source: 'a', target: 'b', relation: 'uses' }],
});

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

describe('classifyGraph / applyTyping', () => {
  it('types nodes and edges from the model answer, leaving file_type alone', async () => {
    const prompts: string[] = [];
    const result = await classifyGraph(graphifyGraph, async (prompt) => {
      prompts.push(prompt);
      return answer;
    });

    const typed = applyTyping(graphifyGraph, result);

    expect(typed).toMatchObject({ nodes: 2, edges: 1 });
    expect(typed.graph.nodes).toEqual([
      { ...graphifyGraph.nodes[0], entity_type: 'Algorithm' },
      { ...graphifyGraph.nodes[1], entity_type: 'Concept' },
    ]);
    expect(typed.graph.links).toEqual([{ source: 'a', target: 'b', relation: 'uses' }]);
    expect(prompts[0]).toContain('Gradient descent');
    expect(prompts[0]).toContain('An optimisation loop.');
    expect(prompts[0]).toContain('cites');
  });

  it('tolerates a code-fenced JSON answer', async () => {
    const result = await classifyGraph(graphifyGraph, async () => '```json\n' + answer + '\n```');
    expect(applyTyping(graphifyGraph, result)).toMatchObject({ nodes: 2, edges: 1 });
  });

  it('keeps the original value when the answer uses an invalid enum', async () => {
    const result = parseTypingAnswer(
      JSON.stringify({
        nodes: [{ id: 'a', entity_type: 'Banana' }],
        edges: [{ source: 'a', target: 'b', relation: 'banana_of' }],
      }),
    );
    const typed = applyTyping(graphifyGraph, result);

    expect(typed).toMatchObject({ nodes: 0, edges: 0 });
    const graph = typed.graph as { nodes: unknown[]; links: unknown[] };
    expect(graph.nodes[0]).toEqual(graphifyGraph.nodes[0]); // no entity_type added
    expect(graph.links[0]).toEqual({ source: 'a', target: 'b', relation: 'cites' });
  });

  it('does not mutate the input graph', async () => {
    const before = JSON.stringify(graphifyGraph);
    const typed = applyTyping(graphifyGraph, parseTypingAnswer(answer));

    expect(JSON.stringify(graphifyGraph)).toBe(before);
    expect(typed.graph).not.toBe(graphifyGraph);
    expect(typed.graph.nodes).not.toBe(graphifyGraph.nodes);
  });

  it('skips a failed batch (~40 nodes) and keeps later batches', async () => {
    const nodes = Array.from({ length: 41 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` }));
    const prompts: string[] = [];
    let calls = 0;
    const result = await classifyGraph({ nodes }, async (prompt) => {
      prompts.push(prompt);
      calls++;
      if (calls === 1) throw new Error('gateway down');
      return JSON.stringify({ nodes: [{ id: 'n40', entity_type: 'Pitfall' }], edges: [] });
    });

    expect(calls).toBe(2);
    expect(prompts[0]).toContain('n39');
    expect(prompts[0]).not.toContain('n40');
    expect(result.nodes).toEqual([{ id: 'n40', entity_type: 'Pitfall' }]);
    expect(applyTyping({ nodes }, result)).toMatchObject({ nodes: 1, edges: 0 });
  });
});

describe('graph file helpers', () => {
  it('writes atomically and refuses a path outside the subject', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'studi0-typing-'));
    made.push(dir);

    await writeGraph(dir, { nodes: [] });
    expect(await readGraph(dir)).toEqual({ nodes: [] });
    await expect(writeGraph(dir, {}, '../escape/graph.json')).rejects.toThrow(/escapes the subject/);
  });
});

/** Run one pipeline job with stubbed spawns and a stub typing answer. */
async function runJob(
  kind: 'build' | 'update' | 'recluster' | 'rebuild',
  graph: unknown = graphifyGraph,
): Promise<{ outcome: Awaited<ReturnType<ReturnType<typeof makeRunPipeline>>>; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'studi0-typing-run-'));
  made.push(dir);
  const chunk = 'graphify-out/chunks/chunk-01.md';
  await mkdir(path.join(dir, 'graphify-out', 'chunks'), { recursive: true });
  await writeFile(path.join(dir, chunk), 'x');
  await writeFile(path.join(dir, 'graphify-out', 'graph.json'), JSON.stringify(graph));
  const db = openDb(path.join(dir, 'studi0.db'));
  insertSubject(db, { id: 'subject-1', name: 'S', path: dir, created_at: new Date().toISOString() });
  const job = jobsRepo.insertJob(db, 'job-1', 'subject-1', kind);
  mocks.spawnArgs.mockReset();
  mocks.spawnArgs.mockImplementation((args: string[]) => ({
    pid: 4242,
    done: Promise.resolve({
      code: 0,
      stdout: args[args.length - 1].includes('PLANNER')
        ? JSON.stringify({ chunks: [chunk], total: 1 })
        : '',
      stderr: '',
    }),
    child: { kill: () => undefined, stdout: null, stderr: null },
  }));
  mocks.chatCompletion.mockReset();
  mocks.chatCompletion.mockResolvedValue({ choices: [{ message: { content: answer } }] });

  const outcome = await makeRunPipeline(db, makeConfig(dir))(
    job,
    { id: 'subject-1', name: 'S', path: dir } as never,
    () => undefined,
    new AbortController().signal,
  );
  db.close();
  return { outcome, dir };
}

/** Poll the build log until the quality line lands — appends are fire-and-forget. */
async function buildLog(dir: string): Promise<string> {
  const file = path.join(dir, 'graphify-out', 'build.log');
  for (let i = 0; i < 20; i++) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (text.includes('graph quality:')) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return readFile(file, 'utf8');
}

describe('runner typing pass', () => {
  it.each(['build', 'update', 'rebuild'] as const)('types before the gate for %s', async (kind) => {
    const { outcome, dir } = await runJob(kind);

    // the gate would have failed on graphify's defaults, so a complete outcome
    // plus typed graph.json means typing ran first
    expect(outcome.status).toBe('complete');
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
    const written = JSON.parse(
      await readFile(path.join(dir, 'graphify-out', 'graph.json'), 'utf8'),
    ) as { nodes: { entity_type?: string }[]; links: { relation?: string }[] };
    expect(written.nodes[0].entity_type).toBe('Algorithm');
    expect(written.links[0].relation).toBe('uses');
    expect(await buildLog(dir)).toContain('typed 2 nodes, 1 edges (graph model');
    // the zero-shell inspector is written for every job kind
    await expect(
      readFile(path.join(dir, 'graphify-out', 'inspect_graph.py'), 'utf8'),
    ).resolves.toBe(INSPECT_SCRIPT);
  });

  it('skips typing for recluster', async () => {
    const typedGraph = {
      nodes: [
        { id: 'a', label: 'Gradient descent', entity_type: 'Algorithm' },
        { id: 'b', label: 'Loss function', entity_type: 'Concept' },
      ],
      links: [{ source: 'a', target: 'b', relation: 'uses' }],
    };
    const { outcome, dir } = await runJob('recluster', typedGraph);

    expect(outcome.status).toBe('complete');
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
    expect(await buildLog(dir)).not.toContain('typed ');
    await expect(
      readFile(path.join(dir, 'graphify-out', 'inspect_graph.py'), 'utf8'),
    ).resolves.toBe(INSPECT_SCRIPT);
  });
});
