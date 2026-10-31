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

export function generationPrompt(topic: string, count: number): string {
  return `You are generating practice questions for topic "${topic}" from this course's material (material/, graphify-out/wiki/, lessons/).
Produce exactly ${count} questions of mixed types (mcq, short, code), grounded strictly in the material.
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
