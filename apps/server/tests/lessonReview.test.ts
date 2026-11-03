import { describe, expect, it, afterEach } from 'vitest';
import { makeHarness } from './helpers';
import * as lessonsRepo from '../src/db/repos/lessons.js';
import * as questionsRepo from '../src/db/repos/questions.js';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

const mcq = {
  topic: 'heaps',
  type: 'mcq',
  prompt: 'What does a binary min-heap guarantee?',
  options: [
    { id: 'a', text: 'root is the minimum' },
    { id: 'b', text: 'root is the maximum' },
    { id: 'c', text: 'sorted order' },
    { id: 'd', text: 'O(1) search' },
  ],
  key: { answerIndex: 0 },
};

describe('lesson review marking (learner-centric wave)', () => {
  it('passes only when every bank question was answered correctly, and sets the tick', async () => {
    h = await makeHarness();
    const id = await createSubject('R1');
    const lesson = lessonsRepo.upsertLesson(h.ctx.db, id, 'lessons/0001-heaps.html', 'Heaps', []);
    questionsRepo.insertQuestion(h.ctx.db, {
      subjectId: id,
      lessonId: lesson.id,
      topic: 'heaps',
      type: 'mcq',
      payload: mcq,
      key: { answerIndex: 0 },
      source: 'on_demand',
    });
    // unanswered → retry
    const before = await h.app.inject({ method: 'POST', url: `/api/lessons/${lesson.id}/review` });
    expect(before.statusCode).toBe(200);
    expect(before.json().verdict).toBe('retry');
    // wrong answer → retry, tick stays off
    await answerMcq(q0Id(h), 'b');
    const wrong = await h.app.inject({ method: 'POST', url: `/api/lessons/${lesson.id}/review` });
    expect(wrong.json().verdict).toBe('retry');
    expect(wrong.json().reviewedAt).toBeNull();
    // correct answer → pass + tick
    await answerMcq(q0Id(h), 'a');
    const pass = await h.app.inject({ method: 'POST', url: `/api/lessons/${lesson.id}/review` });
    expect(pass.json().verdict).toBe('pass');
    expect(pass.json().reviewedAt).not.toBeNull();
    const dto = lessonsRepo.lessonToDto(
      lessonsRepo.getLesson(h.ctx.db, lesson.id) as lessonsRepo.LessonRow,
    );
    expect(dto.reviewedAt).not.toBeNull();
  });

  it('rejects marking a lesson with an empty bank', async () => {
    h = await makeHarness();
    const id = await createSubject('R2');
    const lesson = lessonsRepo.upsertLesson(h.ctx.db, id, 'lessons/0002-empty.html', 'Empty', []);
    const res = await h.app.inject({ method: 'POST', url: `/api/lessons/${lesson.id}/review` });
    expect(res.statusCode).toBe(400);
  });
});

function createSubject(name: string): Promise<string> {
  return (async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/subjects', payload: { name } });
    return (res.json() as { id: string }).id;
  })();
}

function q0Id(h2: NonNullable<typeof h>): string {
  const row = h2.ctx.db.prepare('SELECT id FROM questions LIMIT 1').get() as { id: string };
  return row.id;
}

function answerMcq(questionId: string, option: string): Promise<unknown> {
  return h.app.inject({
    method: 'POST',
    url: `/api/questions/${questionId}/answer`,
    payload: { answer: option },
  });
}
