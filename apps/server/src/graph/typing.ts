import { readFile } from 'node:fs/promises';
import { isInside, safeResolve } from '../fs/paths.js';
import { safeWriteFile } from '../fs/safeWrite.js';
import { extractJson } from '../pipeline/parse.js';
import { chatCompletion } from '../teacher/llm.js';
import {
  edgeKey,
  edgeList,
  edgeRelation,
  endpoint,
  ENTITY_TYPES,
  knownRelation,
  knownType,
  list,
  nodeId,
  nodeLabel,
  nodeList,
  rec,
  RELATIONS,
  type Rec,
} from './quality.js';
import type { Config } from '../config.js';

/** One model call per slice: large enough to amortise, small enough to stay fast and parsable. */
const BATCH_SIZE = 40;
const MAX_TEXT = 400;
const GRAPH_REL = 'graphify-out/graph.json';

export type GraphAsk = (prompt: string) => Promise<string>;

export interface TypingResult {
  nodes: { id: string; entity_type: string }[];
  edges: { source: string; target: string; relation: string }[];
}

export interface TypingOutcome {
  graph: Rec;
  /** nodes/edges whose values were applied (unknown enums are left untouched) */
  nodes: number;
  edges: number;
}

function clip(text: string): string {
  return text.trim().slice(0, MAX_TEXT);
}

function brief(node: Rec): string {
  for (const key of ['description', 'rationale']) {
    const v = node[key];
    if (typeof v === 'string' && v.trim()) return clip(v);
  }
  return '';
}

function buildPrompt(nodes: Rec[], edges: Rec[], labelOf: Map<string, string>): string {
  const lines = [
    'Assign the fixed studi0 ontology to this slice of a study graph.',
    `Nodes: entity_type from ${ENTITY_TYPES.join(' | ')}.`,
    `Edges: relation from ${RELATIONS.join(' | ')}.`,
    'Answer STRICT JSON only (no prose, no code fences):',
    '{"nodes":[{"id":"<id>","entity_type":"Concept"}],"edges":[{"source":"<id>","target":"<id>","relation":"uses"}]}',
    'Nodes (id | label | description):',
    ...nodes.map((n) => `- ${nodeId(n)} | ${clip(nodeLabel(n))} | ${brief(n)}`),
    'Edges (sourceLabel -> targetLabel, current relation):',
    ...edges.map((e) => {
      const source = labelOf.get(endpoint(e.source)) ?? endpoint(e.source);
      const target = labelOf.get(endpoint(e.target)) ?? endpoint(e.target);
      return `- ${source} -> ${target}, ${edgeRelation(e)}`;
    }),
  ];
  return lines.join('\n');
}

/** Strict-parse one answer; anything else is dropped, never thrown. */
export function parseTypingAnswer(text: string): TypingResult {
  const parsed = rec(extractJson(text));
  const out: TypingResult = { nodes: [], edges: [] };
  if (!parsed) return out;
  for (const raw of list(parsed.nodes)) {
    const n = rec(raw);
    if (n && typeof n.id === 'string' && typeof n.entity_type === 'string') {
      out.nodes.push({ id: n.id, entity_type: n.entity_type });
    }
  }
  for (const raw of list(parsed.edges)) {
    const e = rec(raw);
    if (
      e &&
      typeof e.source === 'string' &&
      typeof e.target === 'string' &&
      typeof e.relation === 'string'
    ) {
      out.edges.push({ source: e.source, target: e.target, relation: e.relation });
    }
  }
  return out;
}

/**
 * Ask the model for entity types and relations, one batch at a time. A failed
 * batch is logged and skipped — the ontology gate then reports what is missing.
 */
export async function classifyGraph(
  graphJson: unknown,
  ask: GraphAsk,
  log: (message: string) => void = () => undefined,
): Promise<TypingResult> {
  const nodes = nodeList(graphJson).filter((n) => nodeId(n));
  const edges = edgeList(graphJson);
  const labelOf = new Map(nodes.map((n) => [nodeId(n), nodeLabel(n) || nodeId(n)]));
  const result: TypingResult = { nodes: [], edges: [] };
  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    const batch = nodes.slice(i, i + BATCH_SIZE);
    const ids = new Set(batch.map(nodeId));
    const batchEdges = edges.filter(
      (e) => ids.has(endpoint(e.source)) && ids.has(endpoint(e.target)),
    );
    try {
      const answer = parseTypingAnswer(await ask(buildPrompt(batch, batchEdges, labelOf)));
      result.nodes.push(...answer.nodes);
      result.edges.push(...answer.edges);
    } catch (e) {
      log(`typing batch ${i / BATCH_SIZE + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

/** Apply the accepted guesses to a copy of the graph; nodes keep `file_type`, edges keep everything else. */
export function applyTyping(graphJson: unknown, result: TypingResult): TypingOutcome {
  const graph = rec(graphJson) ?? {};
  const typeById = new Map(
    result.nodes.filter((n) => knownType(n.entity_type)).map((n) => [n.id, n.entity_type]),
  );
  const relationByEdge = new Map(
    result.edges
      .filter((e) => knownRelation(e.relation))
      .map((e) => [`${e.source}\0${e.target}`, e.relation]),
  );
  let nodes = 0;
  const typedNodes = nodeList(graph).map((node) => {
    const type = typeById.get(nodeId(node));
    if (!type) return node;
    nodes++;
    return { ...node, entity_type: type };
  });
  const out: Rec = { ...graph, nodes: typedNodes };
  let edges = 0;
  const key = edgeKey(graph);
  if (key) {
    out[key] = list(graph[key]).map((raw) => {
      const edge = rec(raw) ?? {};
      const relation = relationByEdge.get(`${endpoint(edge.source)}\0${endpoint(edge.target)}`);
      if (!relation) return edge;
      edges++;
      return { ...edge, relation };
    });
  }
  return { graph: out, nodes, edges };
}

export async function readGraph(subjectPath: string): Promise<unknown> {
  return JSON.parse(await readFile(safeResolve(subjectPath, GRAPH_REL), 'utf8'));
}

/** Atomic write, confined to the subject. `rel` is the containment seam for tests. */
export async function writeGraph(
  subjectPath: string,
  graph: unknown,
  rel = GRAPH_REL,
): Promise<void> {
  const target = safeResolve(subjectPath, rel);
  if (!isInside(subjectPath, target)) {
    throw new Error(`refusing to write outside the subject: ${rel}`);
  }
  await safeWriteFile(target, JSON.stringify(graph, null, 2) + '\n');
}

/** Read → classify → apply → write when anything changed. */
export async function typeGraphFile(
  subjectPath: string,
  ask: GraphAsk,
  log?: (message: string) => void,
): Promise<TypingOutcome> {
  const graph = await readGraph(subjectPath);
  const outcome = applyTyping(graph, await classifyGraph(graph, ask, log));
  if (outcome.nodes + outcome.edges > 0) await writeGraph(subjectPath, outcome.graph);
  return outcome;
}

interface ChatReply {
  choices?: { message?: { content?: string } }[];
}

/** Production ask: chatCompletion with the graph-model config, thinking off via the config default. */
export function graphAsk(cfg: Config, signal: AbortSignal): GraphAsk {
  return async (prompt) => {
    const reply = (await chatCompletion(
      cfg,
      {
        model: cfg.chatModel,
        messages: [
          { role: 'system', content: 'You assign ontology types. Reply with strict JSON only.' },
          { role: 'user', content: prompt },
        ],
      },
      signal,
    )) as ChatReply;
    return reply.choices?.[0]?.message?.content ?? '';
  };
}
