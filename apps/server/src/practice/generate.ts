import { extractJson } from '../pipeline/parse.js';
import { generationPrompt } from '../graph/prompts.js';
import { quizSpecSchema, type Question, type QuizSpec } from '@studi0/shared';
import * as questionsRepo from '../db/repos/questions.js';
import * as scheduleRepo from '../db/repos/schedule.js';
import type { Db } from '../db/index.js';
import type { SubjectRow } from '../db/repos/subjects.js';
import type { OneshotFn } from '../util/oneshot.js';
import { HttpError } from '../util/errors.js';

/**
 * One-shot generation of questions+keys; inserts rows (source, unverified keys)
 * and schedule entries due immediately.
 */
export async function generateQuestions(
  oneshot: OneshotFn,
  db: Db,
  subject: SubjectRow,
  opts: { topic: string; count?: number; lessonId?: string | null; source: Question['source'] },
): Promise<Question[]> {
  const count = Math.min(Math.max(opts.count ?? 5, 1), 10);
  const raw = await oneshot(subject.path, generationPrompt(opts.topic, count));
  const parsed = quizSpecSchema.safeParse(extractJson(raw));
  if (!parsed.success) {
    throw new HttpError('INTERNAL', 'question generation returned malformed output');
  }
  const spec: QuizSpec = parsed.data;
  return spec.questions.map((q) => {
    const row = questionsRepo.insertQuestion(db, {
      subjectId: subject.id,
      lessonId: opts.lessonId ?? null,
      topic: q.topic,
      type: q.type,
      payload: { prompt: q.prompt, options: q.options, rubric: q.rubric },
      key: q.key,
      source: opts.source,
    });
    // new questions are due immediately
    scheduleRepo.upsertSchedule(db, {
      question_id: row.id,
      subject_id: subject.id,
      due_at: new Date().toISOString(),
      interval_index: 0,
      correct_streak: 0,
    });
    return questionsRepo.questionToDto(row);
  });
}
