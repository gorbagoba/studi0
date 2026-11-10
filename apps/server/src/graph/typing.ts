import { readFile } from 'node:fs/promises';
import { isInside, safeResolve } from '../fs/paths.js';
import { safeWriteFile } from '../fs/safeWrite.js';
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
const BATCH_SIZE = 60;
/** Catalogue descriptions are cut here — enough to classify, short enough to keep the prompt tight. */
const MAX_TEXT = 120;
const GRAPH_REL = 'graphify-out/graph.json';

const TYPE_BY_LOWER = new Map(ENTITY_TYPES.map((t) => [t.toLowerCase(), t as string]));
const RELATION_BY_LOWER = new Map(RELATIONS.map((r) => [r.toLowerCase(), r as string]));

/**
 * keyword → fixed relation, checked in order (first match wins). graphify emits
 * 120+ free-form verbs, so every one of them must land in the ontology.
 */
const RELATION_KEYWORDS: [string, string[]][] = [
  [
    'prerequisite_of',
    ['prerequisite', 'precede', 'depend', 'require', 'assum', 'basis', 'foundation', 'background', 'leads_to', 'enables'],
  ],
  ['confused_with', ['confus', 'contrast', 'distinguish', 'alternative', 'similar', 'synonym', 'compar', 'versus']],
  ['contradicts', ['contradict', 'violat', 'reject', 'conflict', 'oppos', 'does_not_imply', 'warns']],
  [
    'uses',
    ['use', 'appl', 'implement', 'comput', 'calcul', 'model', 'estimat', 'deriv', 'generat', 'produce', 'solv', 'illustrat', 'exemplif', 'demonstrat', 'measur', 'evaluat', 'verif', 'test', 'check', 'construct', 'find'],
  ],
];

/** Map any relation verb to the fixed ontology; the generic fallback is `related_to`. */
export function mapRelation(raw: string): string {
  const text = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  for (const [relation, keywords] of RELATION_KEYWORDS) {
    if (keywords.some((keyword) => text.includes(keyword))) return relation;
  }
  return 'related_to';
}

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
  const label = (id: string) => labelOf.get(id) ?? id;
  return [
    'Assign the fixed studi0 ontology to this slice of a study graph.',
    `Node types: ${ENTITY_TYPES.join(' | ')}.`,
    `Edge relations: ${RELATIONS.join(' | ')}.`,
    'Reply with one line per item and nothing else — no prose, no JSON, no code fences:',
    'N <nodeId> <Type>',
    'E <sourceId> <targetId> <relation>',
    'Nodes (id | label | description):',
    ...nodes.map((n) => `- ${nodeId(n)} | ${clip(nodeLabel(n))} | ${brief(n)}`),
    'Edges (sourceId (label) -> targetId (label), current relation):',
    ...edges.map(
      (e) =>
        `- ${endpoint(e.source)} (${label(endpoint(e.source))}) -> ${endpoint(e.target)} (${label(endpoint(e.target))}), ${edgeRelation(e)}`,
    ),
  ].join('\n');
}

/**
 * Parse the line grammar `N <id> <type>` / `E <source> <target> <relation>`.
 * Anything else is dropped, never thrown; type/relation words are case-insensitive.
 */
export function parseTypingAnswer(text: string): TypingResult {
  const out: TypingResult = { nodes: [], edges: [] };
  for (const line of text.split('\n')) {
    const [tag, ...fields] = line.trim().split(/\s+/);
    if (tag === 'N' && fields.length === 2) {
      const entity_type = TYPE_BY_LOWER.get(fields[1].toLowerCase());
      if (entity_type) out.nodes.push({ id: fields[0], entity_type });
    } else if (tag === 'E' && fields.length === 3) {
      const relation = RELATION_BY_LOWER.get(fields[2].toLowerCase());
      if (relation) out.edges.push({ source: fields[0], target: fields[1], relation });
    }
  }
  return out;
}

interface Batch {
  nodes: Rec[];
  edges: Rec[];
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) out.push(items.slice(i, i + BATCH_SIZE));
  return out;
}

/** Edges are only asked about when both endpoints are in the same node batch — the model needs their catalogue. */
function inBatch(nodes: Rec[], edges: Rec[]): Rec[] {
  const ids = new Set(nodes.map(nodeId));
  return edges.filter((e) => ids.has(endpoint(e.source)) && ids.has(endpoint(e.target)));
}

function endpointKey(edge: { source?: unknown; target?: unknown }): string {
  return `${endpoint(edge.source)}\0${endpoint(edge.target)}`;
}

/** Nodes that still lack an ontology type after the answers so far. */
function untypedNodes(graphJson: unknown, result: TypingResult): Rec[] {
  const answered = new Set(result.nodes.map((n) => n.id));
  return nodeList(graphJson).filter((node) => {
    const type = node.entity_type;
    const typed = typeof type === 'string' && knownType(type.trim());
    return Boolean(nodeId(node)) && !typed && !answered.has(nodeId(node));
  });
}

/** One sweep of batches; a failed batch is logged and skipped, never thrown. */
async function sweep(
  batches: Batch[],
  labelOf: Map<string, string>,
  ask: GraphAsk,
  log: (message: string) => void,
  result: TypingResult,
): Promise<void> {
  for (const [index, batch] of batches.entries()) {
    try {
      const answer = parseTypingAnswer(await ask(buildPrompt(batch.nodes, batch.edges, labelOf)));
      result.nodes.push(...answer.nodes);
      result.edges.push(...answer.edges);
    } catch (e) {
      log(`typing batch ${index + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Ask the model for entity types and relations: one sweep in batches of 60, then
 * one retry sweep over whatever is still untyped. A failed batch is logged and
 * skipped — the ontology gate then reports what is missing.
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
  await sweep(
    chunks(nodes).map((batch) => ({ nodes: batch, edges: inBatch(batch, edges) })),
    labelOf,
    ask,
    log,
    result,
  );

  const leftNodes = untypedNodes(graphJson, result);
  if (leftNodes.length > 0) {
    // pass 2 covers leftover nodes only: relations are mapped deterministically in applyTyping
    await sweep(
      chunks(leftNodes).map((batch) => ({ nodes: batch, edges: [] })),
      labelOf,
      ask,
      log,
      result,
    );
  }
  log(
    `typed ${nodes.length - untypedNodes(graphJson, result).length}/${nodes.length} nodes, ` +
      `${edges.length}/${edges.length} edges`,
  );
  return result;
}

/**
 * Apply the accepted guesses to a copy of the graph: nodes keep `file_type`, and
 * every edge gets a known relation — the model answer when it is valid, else the
 * deterministic `mapRelation` of the original verb.
 */
export function applyTyping(graphJson: unknown, result: TypingResult): TypingOutcome {
  const graph = rec(graphJson) ?? {};
  const typeById = new Map(
    result.nodes.filter((n) => knownType(n.entity_type)).map((n) => [n.id, n.entity_type]),
  );
  const relationByEdge = new Map(
    result.edges
      .filter((e) => knownRelation(e.relation))
      .map((e) => [endpointKey(e), e.relation]),
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
      const relation = relationByEdge.get(endpointKey(edge)) ?? mapRelation(edgeRelation(edge));
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

/** Production ask: the graph model (fast, non-thinking, line-disciplined), via the chat gateway. */
export function graphAsk(cfg: Config, signal: AbortSignal): GraphAsk {
  return async (prompt) => {
    const reply = (await chatCompletion(
      cfg,
      {
        model: cfg.graphModel,
        messages: [
          {
            role: 'system',
            content: 'You assign ontology types and relations. Reply with one line per item, nothing else.',
          },
          { role: 'user', content: prompt },
        ],
      },
      signal,
    )) as ChatReply;
    return reply.choices?.[0]?.message?.content ?? '';
  };
}
