import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// stub spawn + extraction: the runner's verification stage must not execute, and
// extraction is server-owned (a fake graphify would need a real binary)
process.env.GRAPHIFY_BIN = process.execPath;
const mocks = vi.hoisted(() => ({ spawnArgs: vi.fn(), chatCompletion: vi.fn(), extract: vi.fn() }));
vi.mock('../src/util/proc.js', () => ({
  spawnArgs: mocks.spawnArgs,
  killTreeWithDeadline: vi.fn(),
  killTree: async () => undefined,
  isAlive: () => true,
  commandLineMentions: async () => true,
  resolveOpencodeBin: () => 'opencode-stub',
}));
vi.mock('../src/graph/extract.js', () => ({ runGraphifyExtract: mocks.extract }));
vi.mock('../src/teacher/llm.js', () => ({ chatCompletion: mocks.chatCompletion }));

import {
  applyTyping,
  classifyGraph,
  graphAsk,
  mapRelation,
  parseTypingAnswer,
  readGraph,
  writeGraph,
} from '../src/graph/typing.js';
import { auditGraph, ontologyProblems, RELATIONS } from '../src/graph/quality.js';
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

const answer = ['N a Algorithm', 'N b Concept', 'E a b uses'].join('\n');

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

  it('parses line answers, ignoring garbage lines and unknown values', () => {
    const result = parseTypingAnswer(
      [
        '  N a algorithm ',
        'sure, here you go:',
        '```text',
        'E a b USES',
        'N c Banana',
        'N d Concept extra',
        'E d e banana_of',
        'E e f contradicts',
      ].join('\n'),
    );

    expect(result.nodes).toEqual([{ id: 'a', entity_type: 'Algorithm' }]);
    expect(result.edges).toEqual([
      { source: 'a', target: 'b', relation: 'uses' },
      { source: 'e', target: 'f', relation: 'contradicts' },
    ]);
  });

  it('has the five-relation ontology with a generic fallback', () => {
    expect(RELATIONS).toEqual([
      'prerequisite_of',
      'uses',
      'confused_with',
      'contradicts',
      'related_to',
    ]);
  });

  it.each([
    ['requires', 'prerequisite_of'],
    ['depends_on', 'prerequisite_of'],
    ['assumes', 'prerequisite_of'],
    ['leads_to', 'prerequisite_of'],
    ['confused_with', 'confused_with'],
    ['contrasts_with', 'confused_with'],
    ['often_confused', 'confused_with'],
    ['contradicts', 'contradicts'],
    ['violates', 'contradicts'],
    ['conflicts_with', 'contradicts'],
    ['uses', 'uses'],
    ['implements', 'uses'],
    ['derives', 'uses'],
    ['computes', 'uses'],
    ['illustrates', 'uses'],
    ['tests', 'uses'],
    ['contains', 'related_to'],
    ['cites', 'related_to'],
    ['references', 'related_to'],
    ['covers', 'related_to'],
    ['part_of', 'related_to'],
    ['related_to', 'related_to'],
  ])('maps %s to %s', (raw, relation) => {
    expect(mapRelation(raw)).toBe(relation);
  });

  it('maps verb families case-insensitively across spaces and hyphens', () => {
    expect(mapRelation('  DEPENDS ON ')).toBe('prerequisite_of');
    expect(mapRelation('does-not-imply')).toBe('contradicts');
  });

  it('keeps a known relation and maps an unknown verb', () => {
    const kept = applyTyping(graphifyGraph, parseTypingAnswer('E a b uses'));
    const mapped = applyTyping(graphifyGraph, parseTypingAnswer('N a Banana\nE a b banana_of'));

    expect(kept.graph.links).toEqual([{ source: 'a', target: 'b', relation: 'uses' }]);
    expect(mapped.nodes).toBe(0);
    expect((mapped.graph as { nodes: unknown[] }).nodes[0]).toEqual(graphifyGraph.nodes[0]); // no entity_type added
    expect(mapped.edges).toBe(1);
    expect((mapped.graph as { links: unknown[] }).links).toEqual([
      { source: 'a', target: 'b', relation: 'related_to' },
    ]);
  });

  it('does not mutate the input graph', () => {
    const before = JSON.stringify(graphifyGraph);
    const typed = applyTyping(graphifyGraph, parseTypingAnswer(answer));

    expect(JSON.stringify(graphifyGraph)).toBe(before);
    expect(typed.graph).not.toBe(graphifyGraph);
    expect(typed.graph.nodes).not.toBe(graphifyGraph.nodes);
  });

  it('asks in batches of 60 with only in-batch edges', async () => {
    const nodes = Array.from({ length: 61 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` }));
    const links = [
      { source: 'n0', target: 'n1', relation: 'cites' },
      { source: 'n59', target: 'n60', relation: 'cites' },
    ];
    const prompts: string[] = [];
    await classifyGraph({ nodes, links }, async (prompt) => {
      prompts.push(prompt);
      return '';
    });

    expect(prompts[0]).toContain('- n59 | Node 59');
    expect(prompts[0]).not.toContain('n60');
    expect(prompts[0]).toContain('- n0 (Node 0) -> n1 (Node 1), cites');
    expect(prompts[0]).not.toContain('- n59 (Node 59) -> n60');
  });

  it('runs one second pass over the leftover nodes and logs coverage', async () => {
    const answers = ['N a Algorithm', 'N b Concept'];
    const logs: string[] = [];
    const result = await classifyGraph(
      graphifyGraph,
      async () => answers.shift() ?? '',
      (message) => logs.push(message),
    );

    expect(answers).toHaveLength(0);
    expect(result.nodes).toEqual([
      { id: 'a', entity_type: 'Algorithm' },
      { id: 'b', entity_type: 'Concept' },
    ]);
    expect(result.edges).toEqual([]); // relations are mapped deterministically, never retried
    expect(logs).toContain('typed 2/2 nodes, 1/1 edges');
  });

  it('skips a failed batch (~60 nodes) and keeps later batches', async () => {
    const nodes = Array.from({ length: 61 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` }));
    const prompts: string[] = [];
    let calls = 0;
    const result = await classifyGraph({ nodes }, async (prompt) => {
      prompts.push(prompt);
      calls++;
      if (calls === 1) throw new Error('gateway down');
      return prompt.includes('n60') ? 'N n60 Pitfall' : '';
    });

    expect(prompts[0]).toContain('n59');
    expect(prompts[0]).not.toContain('n60');
    expect(result.nodes).toEqual([{ id: 'n60', entity_type: 'Pitfall' }]);
    expect(applyTyping({ nodes }, result)).toMatchObject({ nodes: 1, edges: 0 });
  });

  it('leaves no disallowed relation on a graphify-shaped graph', async () => {
    const graph = {
      nodes: [
        { id: 'a', label: 'Gradient descent', file_type: 'concept' },
        { id: 'b', label: 'Loss function', file_type: 'concept' },
        { id: 'c', label: 'Learning rate', file_type: 'concept' },
      ],
      links: [
        { source: 'a', target: 'b', relation: 'depends_on' },
        { source: 'a', target: 'c', relation: 'cites' },
        { source: 'b', target: 'c', relation: 'contrasted_with' },
      ],
    };
    const result = await classifyGraph(graph, async () => 'N a Algorithm\nN b Concept\nN c Concept');

    const typed = applyTyping(graph, result);

    expect(typed.edges).toBe(3);
    expect(ontologyProblems(auditGraph(typed.graph)).error).toBeNull();
    expect((typed.graph as { links: { relation: string }[] }).links.map((e) => e.relation)).toEqual([
      'prerequisite_of',
      'related_to',
      'confused_with',
    ]);
  });

  it('asks the graph model, not the chat model', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'studi0-typing-model-'));
    made.push(dir);
    const cfg = { ...makeConfig(dir), graphModel: 'qwen3-coder-next', chatModel: 'chat-model' };
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion.mockResolvedValue({ choices: [{ message: { content: '' } }] });

    await graphAsk(cfg, new AbortController().signal)('prompt');

    expect(mocks.chatCompletion.mock.calls[0][1]).toMatchObject({ model: 'qwen3-coder-next' });
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

/** Run one pipeline job with a stubbed spawn, a stubbed extraction and a stub typing answer. */
async function runJob(
  kind: 'build' | 'update' | 'recluster' | 'rebuild',
  graph: unknown = graphifyGraph,
): Promise<{ outcome: Awaited<ReturnType<ReturnType<typeof makeRunPipeline>>>; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'studi0-typing-run-'));
  made.push(dir);
  await mkdir(path.join(dir, 'graphify-out'), { recursive: true });
  await writeFile(path.join(dir, 'graphify-out', 'graph.json'), JSON.stringify(graph));
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
    expect(await buildLog(dir)).toContain('typed 2/2 nodes, 1/1 edges');
    // the zero-shell inspector is written for every job kind
    await expect(
      readFile(path.join(dir, 'graphify-out', 'inspect_graph.py'), 'utf8'),
    ).resolves.toBe(INSPECT_SCRIPT);
  });

  it('fails a hollow graph before typing and never types it', async () => {
    const hollow = {
      nodes: [
        { id: 'a', label: 'lecture-01.pdf', file_type: 'document' },
        { id: 'b', label: 'lecture-02.pdf', file_type: 'document' },
      ],
      links: [],
    };
    const { outcome } = await runJob('build', hollow);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('graph extraction produced no semantic content');
    expect(outcome.error).toContain('graphify returned hollow responses');
    expect(outcome.error).toContain('extraction model qwen3-coder-next');
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
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
