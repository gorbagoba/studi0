import { describe, expect, it } from 'vitest';
import { auditGraph, mergeDuplicateNodes, ontologyProblems } from '../src/graph/quality.js';

/** graphify's real default output: file_type instead of entity_type, links, default relations. */
const graphifyDefault = {
  nodes: [
    { id: 'a', label: 'Random Variables', file_type: 'concept' },
    { id: 'b', label: 'Joint Distributions', file_type: 'document' },
  ],
  links: [{ source: 'a', target: 'b', relation: 'cites' }],
};

describe('auditGraph', () => {
  it('counts graphify defaults as unexpected types and relations', () => {
    expect(auditGraph(graphifyDefault)).toEqual({
      nodes: 2,
      edges: 1,
      entityTypes: { concept: 1, document: 1 },
      relations: { cites: 1 },
      orphans: 0,
      duplicateLabels: 0,
    });
  });

  it('tolerates missing fields', () => {
    expect(auditGraph({})).toEqual({
      nodes: 0,
      edges: 0,
      entityTypes: {},
      relations: {},
      orphans: 0,
      duplicateLabels: 0,
    });
    expect(auditGraph(null).nodes).toBe(0);
  });

  it('counts orphan nodes and duplicate labels', () => {
    const graph = {
      nodes: [
        { id: '1', label: 'Random Variables', entity_type: 'Concept' },
        { id: '2', label: ' random   variables ', entity_type: 'Concept' },
        { id: '3', label: 'Joint Distributions', entity_type: 'Concept' },
        { id: '4', label: 'Lonely', entity_type: 'ExamNote' },
      ],
      edges: [{ source: '1', target: '3', relation: 'uses' }],
    };
    const audit = auditGraph(graph);
    expect(audit.orphans).toBe(2); // '2' was never connected; '4' has no edges
    expect(audit.duplicateLabels).toBe(1);
  });
});

describe('ontologyProblems', () => {
  it('fails graphify defaults with the precise node message', () => {
    const problems = ontologyProblems(auditGraph(graphifyDefault));
    expect(problems.nodeViolations).toBe(2);
    expect(problems.error).toContain('graph ontology invalid: 2/2 nodes have unexpected entity_type');
    expect(problems.error).toContain('extraction must set entity_type, not file_type');
  });

  it('fails any default relation even when node types are clean', () => {
    const graph = {
      nodes: [
        { id: 'a', label: 'A', entity_type: 'Concept' },
        { id: 'b', label: 'B', entity_type: 'Concept' },
        { id: 'c', label: 'C', entity_type: 'Concept' },
        { id: 'd', label: 'D', entity_type: 'Concept' },
        { id: 'e', label: 'E', entity_type: 'Concept' },
        { id: 'f', label: 'F', entity_type: 'Concept' },
        { id: 'g', label: 'G', entity_type: 'Concept' },
        { id: 'h', label: 'H', entity_type: 'Concept' },
        { id: 'i', label: 'I', entity_type: 'Concept' },
        { id: 'j', label: 'J', entity_type: 'Concept' },
        { id: 'k', label: 'K', entity_type: 'Concept' },
        { id: 'l', label: 'L', entity_type: 'Concept' },
        { id: 'm', label: 'M', entity_type: 'Concept' },
        { id: 'n', label: 'N', entity_type: 'Concept' },
        { id: 'o', label: 'O', entity_type: 'Concept' },
        { id: 'p', label: 'P', entity_type: 'Concept' },
        { id: 'q', label: 'Q', entity_type: 'Concept' },
        { id: 'r', label: 'R', entity_type: 'Concept' },
        { id: 's', label: 'S', entity_type: 'Concept' },
        { id: 't', label: 'T', entity_type: 'Concept' },
      ],
      edges: [
        ...Array.from({ length: 19 }, (_, i) => ({
          source: String.fromCharCode(97 + i),
          target: String.fromCharCode(98 + i),
          relation: 'uses',
        })),
        { source: 't', target: 'a', relation: 'references' },
      ],
    };
    const problems = ontologyProblems(auditGraph(graph));
    expect(problems.nodeViolations).toBe(0);
    expect(problems.error).toContain('graphify default relations (references)');
  });

  it('accepts a clean graph', () => {
    const graph = {
      nodes: [
        { id: 'a', label: 'A', entity_type: 'Concept' },
        { id: 'b', label: 'B', entity_type: 'Proof' },
      ],
      edges: [{ source: 'a', target: 'b', relation: 'prerequisite_of' }],
    };
    expect(ontologyProblems(auditGraph(graph)).error).toBeNull();
  });
});

describe('mergeDuplicateNodes', () => {
  it('merges identical normalised labels, keeps the richer description and dedupes edges', () => {
    const graph = {
      nodes: [
        { id: 'n1', label: 'Random Variables', entity_type: 'Concept', description: 'short' },
        { id: 'n2', label: ' random   variables ', entity_type: 'Concept', description: 'a much richer description' },
        { id: 'n3', label: 'Probability', entity_type: 'Concept' },
        { id: 'n4', label: 'Pitfall', entity_type: 'Pitfall' },
      ],
      edges: [
        { source: 'n1', target: 'n3', relation: 'uses' },
        { source: 'n2', target: 'n3', relation: 'uses' },
        { source: 'n3', target: 'n1', relation: 'prerequisite_of' },
      ],
    };

    const { graph: merged, merged: count } = mergeDuplicateNodes(graph);

    expect(count).toBe(1);
    expect(merged.nodes).toEqual([
      { id: 'n1', label: 'Random Variables', entity_type: 'Concept', description: 'a much richer description' },
      { id: 'n3', label: 'Probability', entity_type: 'Concept' },
      { id: 'n4', label: 'Pitfall', entity_type: 'Pitfall' },
    ]);
    expect(merged.edges).toEqual([
      { source: 'n1', target: 'n3', relation: 'uses' },
      { source: 'n3', target: 'n1', relation: 'prerequisite_of' },
    ]);
    // input is untouched
    expect(graph.nodes).toHaveLength(4);
    expect(graph.nodes[0].description).toBe('short');
  });

  it('is a no-op for graphs without duplicates', () => {
    const graph = { nodes: [{ id: 'a', label: 'A' }], edges: [] };
    expect(mergeDuplicateNodes(graph)).toEqual({ graph, merged: 0 });
  });
});
