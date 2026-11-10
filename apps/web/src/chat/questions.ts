export type Question = { id: string; prompt: string; options?: string[] };
export type QuestionsBlock = { questions: Question[] };

export const QUESTIONS_FENCE = '```studi0-questions';

function isQuestion(value: unknown): value is Question {
  if (typeof value !== 'object' || value === null) return false;
  const q = value as Record<string, unknown>;
  return (
    typeof q.id === 'string' &&
    q.id !== '' &&
    typeof q.prompt === 'string' &&
    (q.options === undefined ||
      (Array.isArray(q.options) && q.options.every((o) => typeof o === 'string')))
  );
}

// The teacher appends at most one fenced block; anything unparseable is treated as absent.
export function extractQuestions(text: string): { visibleText: string; questions: QuestionsBlock | null } {
  const start = text.indexOf(QUESTIONS_FENCE);
  if (start === -1) return { visibleText: text, questions: null };
  const bodyStart = text.indexOf('\n', start);
  const end = bodyStart === -1 ? -1 : text.indexOf('```', bodyStart + 1);
  if (bodyStart === -1 || end === -1) return { visibleText: text, questions: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(bodyStart + 1, end));
  } catch {
    return { visibleText: text, questions: null };
  }
  if (typeof parsed !== 'object' || parsed === null) return { visibleText: text, questions: null };
  const questions = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0 || !questions.every(isQuestion)) {
    return { visibleText: text, questions: null };
  }
  return {
    visibleText: (text.slice(0, start) + text.slice(end + 3)).trimEnd(),
    questions: { questions },
  };
}
