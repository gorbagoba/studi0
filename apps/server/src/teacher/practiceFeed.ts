import { generateQuestions } from '../practice/generate.js';
import { verifyQuestionKey } from '../practice/verifyKey.js';
import * as questionsRepo from '../db/repos/questions.js';
import type { Db } from '../db/index.js';
import type { EventBus } from '../http/sse.js';
import type { OneshotFn } from '../util/oneshot.js';
import type { LessonRow } from '../db/repos/lessons.js';
import type { SubjectRow } from '../db/repos/subjects.js';

export type FeedQuestionsFn = (subject: SubjectRow, lesson: LessonRow) => void;

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
      // auto-deposit is best-effort; the bank can be filled on demand
    });
  };
}
