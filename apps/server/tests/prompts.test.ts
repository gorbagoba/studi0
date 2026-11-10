import { describe, expect, it } from 'vitest';
import { reclusterPrompt, VERIFICATION_PROMPT } from '../src/graph/prompts.js';

const ONTOLOGY_HEADER =
  'Ontology (fixed — every node MUST carry one entity type, every edge one relation type)';

const SERVER_TYPES_RULE =
  "Do NOT assign, repair or verify entity types or relations yourself. graphify's extractor emits its own defaults; the SERVER re-types the graph (entity_type + relation) after your run and validates it.";

const CONTAINMENT_PHRASES = [
  'Stay inside the subject root (the working directory)',
  'must be under this absolute subject root',
  'never clone repos',
  'derive absolute paths from the current working directory',
];

const SHELL_CHEAT =
  'CHEAT: Shell is Windows PowerShell 5.1: no &&, ||, ??, no subshell bash-isms; write ONE command per tool call, quote paths with spaces, chain only with ;.';

const DESTRUCTIVE_RULE =
  'Never delete graphify-out/, graph.json or its backups. The server owns backup and cache clearing.';

const INSPECT_RULE =
  'To inspect the graph run exactly: & "$env:STUDI0_GRAPH_PY" "graphify-out\\inspect_graph.py" — never parse JSON with PowerShell.';

describe('verification prompt keeps the accuracy rules', () => {
  it('carries the fixed ontology and the no-typing rule', () => {
    expect(VERIFICATION_PROMPT).toContain(ONTOLOGY_HEADER);
    expect(VERIFICATION_PROMPT).toContain('Put the ontology type in `entity_type`');
    expect(VERIFICATION_PROMPT).toContain(SERVER_TYPES_RULE);
  });

  it('stays inside the subject root and never deletes graph artifacts', () => {
    for (const phrase of CONTAINMENT_PHRASES) expect(VERIFICATION_PROMPT).toContain(phrase);
    expect(VERIFICATION_PROMPT).toContain(DESTRUCTIVE_RULE);
  });

  it('warns the shell is PowerShell 5.1 and inspects via the server-written script', () => {
    expect(VERIFICATION_PROMPT).toContain(SHELL_CHEAT);
    expect(VERIFICATION_PROMPT).toContain(INSPECT_RULE);
  });

  it('asks for the confirmed/flagged report', () => {
    expect(VERIFICATION_PROMPT).toContain('## Confirmed edges');
    expect(VERIFICATION_PROMPT).toContain('## Flagged edges');
  });
});

describe('recluster prompt', () => {
  const prompt = reclusterPrompt();

  it('re-clusters the subject-root graph with cluster-only', () => {
    expect(prompt).toContain('graphify cluster-only .');
    expect(prompt).toContain('from the SUBJECT ROOT');
  });

  it('states that the server executes extraction', () => {
    expect(prompt).toContain('graphify extraction is executed by the SERVER');
    expect(prompt).toContain('never run `graphify extract`');
  });

  it('keeps containment, shell and destructive guardrails', () => {
    for (const phrase of CONTAINMENT_PHRASES) expect(prompt).toContain(phrase);
    expect(prompt).toContain(SHELL_CHEAT);
    expect(prompt).toContain(DESTRUCTIVE_RULE);
    expect(prompt).toContain(INSPECT_RULE);
  });

  it('has no extraction or chunk-plan content left', () => {
    expect(prompt).not.toContain('--token-budget');
    expect(prompt).not.toContain('PLANNER');
  });
});
