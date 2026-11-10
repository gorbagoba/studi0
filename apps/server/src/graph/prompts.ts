import { ENTITY_TYPES, RELATIONS } from './quality.js';

const ONTOLOGY = { entities: ENTITY_TYPES, relations: RELATIONS } as const;

const ONTOLOGY_FIELD =
  'ONTOLOGY FIELD: Put the ontology type in `entity_type`. Never use `file_type` for it (graphify rewrites it to a built-in enum).';

/** graphify extracts its own defaults; the server re-types and validates after the run. */
const SERVER_TYPES_RULE =
  "Do NOT assign, repair or verify entity types or relations yourself. graphify's extractor emits its own defaults; the SERVER re-types the graph (entity_type + relation) after your run and validates it. Your job is extraction and clustering only.";

/** Cluster/label reads the graph in place; a layout mismatch is a report, never a restructure.
 * graphify appends graphify-out/graph.json to the path argument, so "." is the subject root. */
const CLUSTER_RULE =
  'Re-cluster with `graphify cluster-only .` from the SUBJECT ROOT (or the label/cluster command you use — it reads `<cwd>/graphify-out/graph.json`; never pass graphify-out itself, graphify appends that path again). If it reports a missing file or unexpected layout, STOP and report the exact error — never move, delete or restructure graphify-out to satisfy it.';

const CONTAINMENT = `CONTAINMENT: Stay inside the subject root (the working directory). Every path you read or write — material/, graphify-out/, chunks/, scripts, caches — must be under this absolute subject root. Never write to the repo, to a parent folder, to your home directory, or to any global cache; never clone repos. If a command would write outside the subject root, do not run it — report it instead.
All subjects live at \`<repo>/data/subjects/<name>\` — derive absolute paths from the current working directory, never type them from memory.`;

const ONTOLOGY_RULES = `
Ontology (fixed — every node MUST carry one entity type, every edge one relation type):
- Entity types: ${ONTOLOGY.entities.join(', ')}
- Relation types: ${ONTOLOGY.relations.join(', ')}
${ONTOLOGY_FIELD}
${SERVER_TYPES_RULE}
`;

/** The pipeline shell is Windows PowerShell 5.1 — POSIX chain operators are parse errors there. */
const SHELL_RULE =
  'SHELL: The shell is Windows PowerShell 5.1. `&&`, `||` and `??` do not work — chain commands with `;`. Run each graphify command as a single line from the SUBJECT ROOT using absolute paths.';

/** Added to every graph prompt: the agent has burned minutes guessing PowerShell variants. */
const SHELL_CHEAT =
  'CHEAT: Shell is Windows PowerShell 5.1: no &&, ||, ??, no subshell bash-isms; write ONE command per tool call, quote paths with spaces, chain only with ;. If a command fails twice, stop and report the exact error text — do not keep retrying variants.';

/** Inspection goes through the server-written python file, never PowerShell JSON parsing. */
const INSPECT_RULE =
  'To inspect the graph run exactly: & "$env:STUDI0_GRAPH_PY" "graphify-out\\inspect_graph.py" — never parse JSON with PowerShell.';

/** graphify-out/graph.json is the subject's only graph — backups and cache clearing are the server's job. */
const DESTRUCTIVE_RULE =
  'Never delete graphify-out/, graph.json or its backups. The server owns backup and cache clearing. If graph.json is missing, report it and stop — do not clean up or rebuild the directory.';

/** Extraction itself is server-owned; the agent only re-clusters. */
export function reclusterPrompt(): string {
  return `You are the graph pipeline worker for this subject. graphify extraction is executed by the SERVER — never run \`graphify extract\` yourself.
Re-cluster the existing graph now: \`graphify cluster-only .\` from the SUBJECT ROOT.
${CLUSTER_RULE}
${SHELL_RULE}
${CONTAINMENT}
${SHELL_CHEAT}
${INSPECT_RULE}
${DESTRUCTIVE_RULE}`;
}

export const VERIFICATION_PROMPT = `You are the graph verification agent.
1. Read graphify-out/graph.json and sample a representative subset of its edges.
2. For each sampled edge, source-check it against material/ (slide PDFs, textbook MDs) and graphify-out/wiki/.
3. Judge each sampled edge as "confirmed" (the material supports it) or "flagged" (unsupported, contradictory, or uncertain).
Flagged edges must never be presented as fact downstream.
${ONTOLOGY_RULES}
${CONTAINMENT}
${SHELL_CHEAT}
${DESTRUCTIVE_RULE}
${INSPECT_RULE}
Reply with ONLY the full markdown report (no preamble, no fenced block) with two sections:
"## Confirmed edges" and "## Flagged edges", each edge as "- <source node> --<relation>--> <target node> — <one-line justification>".
`;

export function rotationPrompt(transcript: string): string {
  return `Summarize the following tutoring session transcript into durable learning notes for future sessions.
Keep: topics covered, the student's misconceptions and corrections, notation the student uses, open questions, and next steps.
Reply with ONLY the markdown summary body.

TRANSCRIPT:
${transcript}`;
}

export function generationPrompt(topic: string, count: number, difficulty: 'mixed' | 'easy' | 'medium' | 'hard'): string {
  const target =
    difficulty === 'mixed'
      ? 'a mix of easy, medium and hard'
      : `consistently ${difficulty}`;
  return `You are generating practice questions for topic "${topic}" from this course's material (material/, graphify-out/wiki/, lessons/).
Produce exactly ${count} questions of mixed types (mcq, short, code), at ${target} difficulty, grounded strictly in the material.
Reply with ONLY one fenced block:
\`\`\`studi0-quiz
{"topic":"<topic>","questions":[{"topic":"<topic>","type":"mcq|short|code","prompt":"...","options":[{"id":"a","text":"..."},{"id":"b","text":"..."}],"key":{"answerIndex":0},"rubric":"what a complete answer needs"}]}
\`\`\`
Rules: mcq questions have exactly 4 options (ids a,b,c,d) and key.answerIndex (0-based). short/code questions have key.answer (the model answer) and key.rubric. No text outside the block.`;
}

export function keyVerificationPrompt(q: {
  topic: string;
  type: string;
  payload: { prompt: string; options?: { id: string; text: string }[]; rubric?: string };
  key: { answerIndex?: number; answer?: string; rubric?: string };
}): string {
  return `You are verifying a practice-question ANSWER KEY against this course's material (material/, graphify-out/wiki/).
Question (topic "${q.topic}", type ${q.type}):
${JSON.stringify(q.payload, null, 2)}
Proposed key:
${JSON.stringify(q.key, null, 2)}
Check the key against the material: is it correct, complete, and unambiguous? If the key is an MCQ index, confirm the indexed option is the one the material supports.
Reply with ONLY one line of JSON: {"ok":true,"reason":"<short justification>"} or {"ok":false,"reason":"<what is wrong>"}`;
}

export function gradingPrompt(q: {
  type: string;
  payload: { prompt: string; rubric?: string };
  key: { answer?: string; rubric?: string };
  answer: string;
}): string {
  return `You are grading a student's answer against the answer key and rubric. Be fair but strict; partial credit where the rubric allows it.
Question:
${JSON.stringify(q.payload, null, 2)}
Key/rubric:
${JSON.stringify({ answer: q.key.answer, rubric: q.key.rubric ?? q.payload.rubric }, null, 2)}
Student answer:
"""
${q.answer}
"""
Reply with ONLY one line of JSON: {"verdict":"correct|partial|incorrect","feedback":"<one or two sentences explaining the verdict and what was missing>"}`;
}
