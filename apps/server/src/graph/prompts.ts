const ONTOLOGY = {
  entities: ['Concept', 'Algorithm', 'DataStructure', 'Proof', 'Pitfall', 'ExamNote'],
  relations: ['prerequisite_of', 'uses', 'confused_with', 'contradicts'],
} as const;

const ONTOLOGY_RULES = `
Ontology (fixed — every node MUST carry one entity type, every edge one relation type):
- Entity types: ${ONTOLOGY.entities.join(', ')}
- Relation types: ${ONTOLOGY.relations.join(', ')}
`;

const PROGRESS_PROTOCOL = `
Progress protocol (mandatory — the server parses these lines from your streamed reply text, so they must appear in your reply as plain lines while you work):
- As soon as you know how many files will be processed, emit: studi0-progress {"done":0,"total":<m>,"file":null}
- As each file/chunk completes, emit: studi0-progress {"done":<n>,"total":<m>,"file":"<relative path>"}
If a file/chunk fails, emit: studi0-failed {"file":"<relative path>","reason":"<short reason>"}
Never fake success for a failed file — report it and continue with the remaining files.
`;

/** graphify's backend is provisioned by the server env — prompts must not invite auto-detection. */
const GRAPH_ENV_RULE =
  'Run graphify with the environment already configured (GRAPHIFY_BACKEND is set); never set or request Google/Anthropic/Codex API keys.';

export function extractionPrompt(kind: 'build' | 'update' | 'recluster', subjectName: string): string {
  const graphifyTask =
    kind === 'build'
      ? 'Run graphify (pinned version 0.9.95, Python 3) to BUILD the knowledge graph from all supported files under material/ into graphify-out/ (graph.json + graph.html + wiki/ + GRAPH_REPORT.md).'
      : kind === 'update'
        ? 'Run graphify (pinned version 0.9.95) with its update/incremental mode so only material/ files changed since the last build are re-extracted; merge into the existing graphify-out/ artifacts.'
        : 'Run graphify (pinned version 0.9.95) re-clustering over the existing graphify-out/graph.json to merge near-duplicate nodes; keep all node and edge metadata intact.';
  return `You are the graph extraction pipeline for the course subject "${subjectName}".
${graphifyTask}
${ONTOLOGY_RULES}
The extraction must pass the ontology to graphify so graph.json nodes/edges carry these exact types.
${PROGRESS_PROTOCOL}
When finished, reply with one line: DONE <n> files ok, <k> failed.`;
}

/** Stage 1 of the wave pipeline: plan ONLY — no extraction happens in this run. */
export function planPrompt(kind: 'build' | 'update', subjectName: string): string {
  const task =
    kind === 'build'
      ? 'BUILD the knowledge graph from all supported files under material/'
      : 'UPDATE the knowledge graph from the material/ files changed since the last build';
  return `You are the graph extraction PLANNER for the course subject "${subjectName}". Do NOT extract anything in this run — another process executes each chunk later.
1. List the material/ files that need graphify extraction to ${task} (graphify pinned version 0.9.95, Python 3).
2. Split them into chunks of roughly equal size and write one chunk prompt file per chunk under graphify-out/chunks/ (e.g. graphify-out/chunks/chunk-01.md). Each chunk prompt must tell graphify exactly which material/ files to extract in that chunk and must include the ontology below so extraction passes it to graphify.
3. Reply with ONLY one line of strict JSON, no other text:
{"chunks":["graphify-out/chunks/chunk-01.md","graphify-out/chunks/chunk-02.md"],"total":<number of chunk files>}
Paths are relative to the subject root and must match the files you wrote.
${GRAPH_ENV_RULE}
${ONTOLOGY_RULES}
${PROGRESS_PROTOCOL}`;
}

/** Stage 2 of the wave pipeline: one headless run per chunk (executed by the runner, ≤ maxChunkConcurrency concurrent). */
export function chunkWavePrompt(chunkPath: string): string {
  return `Execute this graphify chunk extraction: read "${chunkPath}" and run graphify (pinned version 0.9.95, Python 3) for exactly the material/ files it lists, resuming from the graphify chunk cache where results already exist.
Run graphify in this turn — do NOT use the task/subagent tool and do NOT spawn background workers; the runner parallelizes chunks for you.
${ONTOLOGY_RULES}
The extraction must pass the ontology to graphify so chunk outputs carry these exact types.
${GRAPH_ENV_RULE}
${PROGRESS_PROTOCOL}
When finished, reply with one line: DONE <n> files ok, <k> failed.`;
}

/** Stage 3 of the wave pipeline: merge chunk outputs and export the final artifacts. */
export function mergePrompt(subjectName: string): string {
  return `You are the graph extraction pipeline for the course subject "${subjectName}".
All chunk extractions are done. Run graphify (pinned version 0.9.95, Python 3) to merge the per-chunk extraction outputs under graphify-out/ into the final knowledge graph and export graphify-out/ (graph.json + graph.html + wiki/ + GRAPH_REPORT.md). Do not re-extract files that already have chunk outputs; resume from cache.
${ONTOLOGY_RULES}
The merged graph must carry these exact types.
${GRAPH_ENV_RULE}
${PROGRESS_PROTOCOL}
When finished, reply with one line: DONE <n> files ok, <k> failed.`;
}

export const VERIFICATION_PROMPT = `You are the graph verification agent.
1. Read graphify-out/graph.json and sample a representative subset of its edges.
2. For each sampled edge, source-check it against material/ (slide PDFs, textbook MDs) and graphify-out/wiki/.
3. Judge each sampled edge as "confirmed" (the material supports it) or "flagged" (unsupported, contradictory, or uncertain).
Flagged edges must never be presented as fact downstream.
${ONTOLOGY_RULES}
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
