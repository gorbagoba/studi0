import { generateQuestions } from '../practice/generate.js';
import { verifyQuestionKey } from '../practice/verifyKey.js';
import * as questionsRepo from '../db/repos/questions.js';
import type { Db } from '../db/index.js';
import type { EventBus } from '../http/sse.js';
import type { OneshotFn } from '../util/oneshot.js';
import type { LessonRow } from '../db/repos/lessons.js';
import type { SubjectRow } from '../db/repos/subjects.js';
import type { Question } from '@studi0/shared';

export type FeedQuestionsFn = (subject: SubjectRow, lesson: LessonRow) => void;

/**
 * Shared tail of both deposit paths (contract: "verification runs right after
 * and completes asynchronously; a `questions` SSE event fires when done"):
 * verify every key, then one `questions` event with the final rows.
 */
export function verifyKeysAndEmit(
  db: Db,
  events: EventBus,
  oneshot: OneshotFn,
  subject: SubjectRow,
  questions: Question[],
): void {
  void (async () => {
    for (const dto of questions) {
      const row = questionsRepo.getQuestion(db, dto.id);
      if (row) await verifyQuestionKey(oneshot, db, subject, row);
    }
    const final = questions
      .map((q) => questionsRepo.getQuestion(db, q.id))
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map(questionsRepo.questionToDto);
    events.emit(subject.id, 'questions', { subjectId: subject.id, questions: final });
  })().catch(() => {
    // verification is best-effort; the user can re-run verify-key manually
  });
}

/**
 * Auto-deposit after a lesson write (fire-and-forget): one-shot generation for
 * the lesson topic, then key verification; one `questions` SSE event at the end.
 */
export function makeFeedQuestions(db: Db, events: EventBus, oneshot: OneshotFn): FeedQuestionsFn {
  return (subject, lesson) => {
    void (async () => {
      const questions = await generateQuestions(oneshot, db, subject, {
        topic: lesson.title,
        count: 5,
        lessonId: lesson.id,
        source: 'auto',
      });
      verifyKeysAndEmit(db, events, oneshot, subject, questions);
    })().catch(() => {
      // auto-deposit is best-effort; the bank can be filled on demand
    });
  };
}
