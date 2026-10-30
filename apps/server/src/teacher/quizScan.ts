import { quizSpecSchema, type Question, type QuizSpec } from '@studi0/shared';
import * as questionsRepo from '../db/repos/questions.js';
import * as scheduleRepo from '../db/repos/schedule.js';
import type { Db } from '../db/index.js';

/** Extract every ```studi0-quiz``` fenced block from assistant text. */
export function extractQuizBlocks(text: string): QuizSpec[] {
  const specs: QuizSpec[] = [];
  for (const m of text.matchAll(/```studi0-quiz\s*\r?\n([\s\S]*?)```/g)) {
    try {
      const parsed = quizSpecSchema.safeParse(JSON.parse(m[1]));
      if (parsed.success) specs.push(parsed.data);
    } catch {
      // malformed block — skip; the teacher can be asked to regenerate
    }
  }
  return specs;
}

/** Insert quiz-block questions into the bank (keys unverified), due immediately. */
export function depositQuiz(
  db: Db,
  subjectId: string,
  spec: QuizSpec,
  lessonId: string | null,
): Question[] {
  return spec.questions.map((q) => {
    const row = questionsRepo.insertQuestion(db, {
      subjectId,
      lessonId,
      topic: q.topic,
      type: q.type,
      payload: { prompt: q.prompt, options: q.options, rubric: q.rubric },
      key: q.key,
      source: 'auto',
    });
    scheduleRepo.upsertSchedule(db, {
      question_id: row.id,
      subject_id: subjectId,
      due_at: new Date().toISOString(),
      interval_index: 0,
      correct_streak: 0,
    });
    return questionsRepo.questionToDto(row);
  });
}
