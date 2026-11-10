/** The fixed studi0 ontology. Extraction must set these; graphify's defaults are a build failure. */
export const ENTITY_TYPES = ['Concept', 'Algorithm', 'DataStructure', 'Proof', 'Pitfall', 'ExamNote'] as const;
export const RELATIONS = ['prerequisite_of', 'uses', 'confused_with', 'contradicts'] as const;
/** graphify's built-in enums — seeing any of these means the ontology never reached extraction. */
export const DEFAULT_RELATIONS = ['cites', 'references', 'conceptually_related_to', 'related_to'];

export type Rec = Record<string, unknown>;

export function rec(v: unknown): Rec | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null;
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function nodeList(graphJson: unknown): Rec[] {
  return list(rec(graphJson)?.nodes).map((n) => rec(n) ?? {});
}

export function edgeKey(graphJson: unknown): 'edges' | 'links' | null {
  const g = rec(graphJson);
  if (!g) return null;
  if (Array.isArray(g.edges)) return 'edges';
  if (Array.isArray(g.links)) return 'links';
  return null;
}

export function edgeList(graphJson: unknown): Rec[] {
  const key = edgeKey(graphJson);
  if (!key) return [];
  return list((rec(graphJson) as Rec)[key]).map((e) => rec(e) ?? {});
}

export function nodeId(node: Rec): string {
  const id = node.id;
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '';
}

export function nodeLabel(node: Rec): string {
  const label = node.label ?? node.name;
  return typeof label === 'string' ? label : '';
}

function nodeType(node: Rec): string {
  for (const key of ['entity_type', 'file_type', 'type']) {
    const v = node[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '(missing)';
}

export function edgeRelation(edge: Rec): string {
  const v = edge.relation ?? edge.type;
  return typeof v === 'string' && v.trim() ? v.trim() : '(missing)';
}

export function endpoint(v: unknown): string {
  if (typeof v === 'string') return v;
  const r = rec(v);
  const id = r?.id;
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '';
}

/** trim, case-fold, collapse whitespace */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface GraphAudit {
  nodes: number;
  edges: number;
  entityTypes: Record<string, number>;
  relations: Record<string, number>;
  orphans: number;
  duplicateLabels: number;
}

/** Read a graphify graph without trusting its shape; missing fields count as empty. */
export function auditGraph(graphJson: unknown): GraphAudit {
  const nodes = nodeList(graphJson);
  const edges = edgeList(graphJson);
  const entityTypes: Record<string, number> = {};
  const relations: Record<string, number> = {};
  const connected = new Set<string>();
  for (const node of nodes) {
    const type = nodeType(node);
    entityTypes[type] = (entityTypes[type] ?? 0) + 1;
  }
  for (const edge of edges) {
    const relation = edgeRelation(edge);
    relations[relation] = (relations[relation] ?? 0) + 1;
    for (const id of [endpoint(edge.source), endpoint(edge.target)]) if (id) connected.add(id);
  }
  const labels = new Map<string, number>();
  for (const node of nodes) {
    const key = normalizeLabel(nodeLabel(node));
    if (key) labels.set(key, (labels.get(key) ?? 0) + 1);
  }
  let duplicateLabels = 0;
  for (const count of labels.values()) duplicateLabels += count - 1;
  return {
    nodes: nodes.length,
    edges: edges.length,
    entityTypes,
    relations,
    orphans: nodes.filter((node) => !connected.has(nodeId(node))).length,
    duplicateLabels,
  };
}

export interface OntologyProblems {
  nodeViolations: number;
  edgeViolations: number;
  /** non-null when the build must fail */
  error: string | null;
}

export const knownType = (t: string) => (ENTITY_TYPES as readonly string[]).includes(t);
export const knownRelation = (r: string) => (RELATIONS as readonly string[]).includes(r);

/** >5% unexpected types/relations, or any graphify default relation, fails the build. */
export function ontologyProblems(audit: GraphAudit): OntologyProblems {
  const unexpectedTypes = Object.keys(audit.entityTypes).filter((t) => !knownType(t));
  const unexpectedRelations = Object.keys(audit.relations).filter((r) => !knownRelation(r));
  const nodeViolations = unexpectedTypes.reduce((n, t) => n + audit.entityTypes[t], 0);
  const edgeViolations = unexpectedRelations.reduce((n, r) => n + audit.relations[r], 0);
  const defaults = unexpectedRelations.filter((r) => DEFAULT_RELATIONS.includes(r));
  let error: string | null = null;
  if (audit.nodes > 0 && nodeViolations / audit.nodes > 0.05) {
    error = `graph ontology invalid: ${nodeViolations}/${audit.nodes} nodes have unexpected entity_type (${unexpectedTypes.join(', ')}); extraction must set entity_type, not file_type`;
  } else if (defaults.length > 0) {
    error = `graph ontology invalid: edges use graphify default relations (${defaults.join(', ')}); extraction must set relation types from the fixed ontology`;
  } else if (audit.edges > 0 && edgeViolations / audit.edges > 0.05) {
    error = `graph ontology invalid: ${edgeViolations}/${audit.edges} edges have unexpected relation (${unexpectedRelations.join(', ')}); extraction must set relation types from the fixed ontology`;
  }
  return { nodeViolations, edgeViolations, error };
}

function description(node: Rec): { key: string; value: string } | null {
  for (const key of ['description', 'rationale']) {
    const v = node[key];
    if (typeof v === 'string' && v.trim()) return { key, value: v };
  }
  return null;
}

function remapEndpoint(v: unknown, remap: Map<string, string>): unknown {
  if (typeof v === 'string') return remap.get(v) ?? v;
  const r = rec(v);
  const id = r?.id;
  const mapped = typeof id === 'string' ? remap.get(id) : undefined;
  return mapped ? { ...r, id: mapped } : v;
}

export interface MergeOutcome {
  graph: Rec;
  merged: number;
}

/**
 * Merge nodes whose normalised label matches into the first occurrence, keep the
 * richer description, and union edges with the duplicate ids remapped + deduped.
 */
export function mergeDuplicateNodes(graphJson: unknown): MergeOutcome {
  const graph = rec(graphJson);
  if (!graph) return { graph: {}, merged: 0 };
  const nodes: Rec[] = [];
  const firstByLabel = new Map<string, number>();
  const remap = new Map<string, string>();
  let merged = 0;
  for (const raw of list(graph.nodes)) {
    const node = { ...(rec(raw) ?? {}) };
    const key = normalizeLabel(nodeLabel(node));
    const firstIndex = key ? firstByLabel.get(key) : undefined;
    if (firstIndex === undefined) {
      if (key) firstByLabel.set(key, nodes.length);
      nodes.push(node);
      continue;
    }
    merged++;
    const first = nodes[firstIndex];
    const from = nodeId(node);
    const to = nodeId(first);
    if (from && to) remap.set(from, to);
    const richer = description(node);
    const kept = description(first);
    if (richer && (!kept || richer.value.length > kept.value.length)) first[richer.key] = richer.value;
  }
  const key = edgeKey(graph);
  const out: Rec = { ...graph, nodes };
  if (key) {
    const seen = new Set<string>();
    const edges: Rec[] = [];
    for (const raw of list(graph[key])) {
      const edge = { ...(rec(raw) ?? {}) };
      edge.source = remapEndpoint(edge.source, remap);
      edge.target = remapEndpoint(edge.target, remap);
      const dedupe = `${endpoint(edge.source)}\0${edgeRelation(edge)}\0${endpoint(edge.target)}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      edges.push(edge);
    }
    out[key] = edges;
  }
  return { graph: out, merged };
}
