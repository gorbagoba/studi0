import { extractJson } from '../pipeline/parse.js';
import { gradingPrompt } from '../graph/prompts.js';
import type { QuestionRow } from '../db/repos/questions.js';
import type { Grade, QuestionKey, QuestionPayload } from '@studi0/shared';
import type { OneshotFn } from '../util/oneshot.js';
import { HttpError } from '../util/errors.js';

const VERDICTS = ['correct', 'partial', 'incorrect'] as const;

/** MCQ grades offline (exact match); short/code are LLM-graded vs key + rubric. */
export async function gradeAnswer(
  oneshot: OneshotFn,
  cwd: string,
  row: QuestionRow,
  answer: string,
): Promise<Grade> {
  const payload = JSON.parse(row.payload_json) as QuestionPayload;
  const key = JSON.parse(row.key_json) as QuestionKey;
  if (row.type === 'mcq') {
    const indexed = key.answerIndex !== undefined ? payload.options?.[key.answerIndex] : undefined;
    const correct =
      answer === String(key.answerIndex) || (indexed !== undefined && answer === indexed.id);
    return {
      verdict: correct ? 'correct' : 'incorrect',
      feedback: correct ? 'Correct option.' : `Correct answer was option ${indexed ? `${key.answerIndex} (${indexed.text})` : String(key.answerIndex)}.`,
    };
  }
  const raw = await oneshot(cwd, gradingPrompt({ type: row.type, payload, key, answer }));
  const parsed = extractJson(raw) as { verdict?: unknown; feedback?: unknown } | null;
  if (
    parsed &&
    typeof parsed.verdict === 'string' &&
    (VERDICTS as readonly string[]).includes(parsed.verdict) &&
    typeof parsed.feedback === 'string'
  ) {
    return { verdict: parsed.verdict as Grade['verdict'], feedback: parsed.feedback };
  }
  throw new HttpError('INTERNAL', 'grading returned malformed output');
}
