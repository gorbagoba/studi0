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

const short = {
  topic: 'heaps',
  type: 'short',
  prompt: 'Why does Dijkstra use a priority queue?',
  key: { answer: 'to get the next closest vertex in O(log n)' },
};

type ResultRow = {
  questionId: string;
  verdict: string;
  answered: boolean;
  feedback?: string;
};

async function createSubject(name: string): Promise<string> {
  const res = await h.app.inject({ method: 'POST', url: '/api/subjects', payload: { name } });
  return (res.json() as { id: string }).id;
}

function stubOneshot(reply: string) {
  return async () => reply;
}

/** stubbed oneshot implies a healthy opencode for the route gates */
function patchOc(harness: Awaited<ReturnType<typeof makeHarness>>) {
  harness.ctx.oc.ensureUp = () => undefined;
}

function review(lessonId: string, answers: unknown) {
  return h.app.inject({
    method: 'POST',
    url: `/api/lessons/${lessonId}/review`,
    payload: { answers },
  });
}

function insertMcq(subjectId: string, lessonId: string, topic = 'heaps'): string {
  return questionsRepo.insertQuestion(h.ctx.db, {
    subjectId,
    lessonId,
    topic,
    type: 'mcq',
    payload: mcq,
    key: mcq.key,
    source: 'on_demand',
  }).id;
}

function resultById(body: { results: ResultRow[] }, questionId: string): ResultRow {
  return body.results.find((r) => r.questionId === questionId) as ResultRow;
}

function reviewedAtOf(lessonId: string): string | null {
  return lessonsRepo.lessonToDto(
    lessonsRepo.getLesson(h.ctx.db, lessonId) as lessonsRepo.LessonRow,
  ).reviewedAt;
}

describe('lesson review one-shot submit (learner-centric wave)', () => {
  it('grades a full submission in one shot and passes the lesson when all are correct', async () => {
    h = await makeHarness();
    const id = await createSubject('R1');
    const lesson = lessonsRepo.upsertLesson(h.ctx.db, id, 'lessons/0001-heaps.html', 'Heaps', []);
    const qId = insertMcq(id, lesson.id);
    const res = await review(lesson.id, [{ questionId: qId, answer: 'a' }]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verdict).toBe('pass');
    expect(body.reviewedAt).not.toBeNull();
    expect(body.results).toHaveLength(1);
    // mcq grading is local and always carries feedback
    expect(resultById(body, qId).verdict).toBe('correct');
    expect(resultById(body, qId).answered).toBe(true);
    expect(resultById(body, qId).feedback).toBeDefined();
    expect(reviewedAtOf(lesson.id)).not.toBeNull();
  });

  it('retries a wrong answer with feedback, then passes on correct resubmission', async () => {
    h = await makeHarness();
    const id = await createSubject('R2');
    const lesson = lessonsRepo.upsertLesson(h.ctx.db, id, 'lessons/0002-loop.html', 'Loop', []);
    const qId = insertMcq(id, lesson.id);
    const wrong = await review(lesson.id, [{ questionId: qId, answer: 'b' }]);
    expect(wrong.json().verdict).toBe('retry');
    expect(wrong.json().reviewedAt).toBeNull();
    expect(resultById(wrong.json(), qId).verdict).toBe('incorrect');
    expect(resultById(wrong.json(), qId).feedback).toContain('Correct answer');
    expect(reviewedAtOf(lesson.id)).toBeNull();
    // weak-area loop: same lesson, correct resubmission turns it to pass
    const pass = await review(lesson.id, [{ questionId: qId, answer: 'a' }]);
    expect(pass.json().verdict).toBe('pass');
    expect(pass.json().reviewedAt).not.toBeNull();
  });

  it('reports bank questions missing from the submission as unanswered and retries', async () => {
    h = await makeHarness();
    const id = await createSubject('R3');
    const lesson = lessonsRepo.upsertLesson(h.ctx.db, id, 'lessons/0003-pair.html', 'Pair', []);
    const q0 = insertMcq(id, lesson.id, 'heaps');
    const q1 = insertMcq(id, lesson.id, 'graphs');
    const res = await review(lesson.id, [{ questionId: q0, answer: 'a' }]);
    const body = res.json();
    expect(body.verdict).toBe('retry');
    expect(body.results).toHaveLength(2);
    expect(resultById(body, q0)).toEqual({
      questionId: q0,
      verdict: 'correct',
      answered: true,
      feedback: expect.any(String),
    });
    expect(resultById(body, q1)).toEqual({
      questionId: q1,
      verdict: 'unanswered',
      answered: false,
    });
  });

  it('rejects reviewing a lesson with an empty bank', async () => {
    h = await makeHarness();
    const id = await createSubject('R4');
    const lesson = lessonsRepo.upsertLesson(h.ctx.db, id, 'lessons/0004-empty.html', 'Empty', []);
    const res = await review(lesson.id, []);
    expect(res.statusCode).toBe(400);
  });

  it('ignores unknown questionIds in the submission (results sized to the bank)', async () => {
    h = await makeHarness();
    const id = await createSubject('R5');
    const lesson = lessonsRepo.upsertLesson(h.ctx.db, id, 'lessons/0005-unknown.html', 'Unknown', []);
    const qId = insertMcq(id, lesson.id);
    const res = await review(lesson.id, [
      { questionId: qId, answer: 'a' },
      { questionId: 'f0000000-0000-4000-8000-000000000000', answer: 'whatever' },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict).toBe('pass');
    expect(res.json().results).toHaveLength(1);
  });

  it('grades short answers through the LLM gate (stubbed oneshot)', async () => {
    h = await makeHarness();
    patchOc(h);
    const id = await createSubject('R6');
    const lesson = lessonsRepo.upsertLesson(h.ctx.db, id, 'lessons/0006-short.html', 'Short', []);
    const qId = questionsRepo.insertQuestion(h.ctx.db, {
      subjectId: id,
      lessonId: lesson.id,
      topic: 'heaps',
      type: 'short',
      payload: short,
      key: short.key,
      source: 'on_demand',
    }).id;
    h.ctx.oneshot = stubOneshot(
      '```json\n{"verdict":"partial","feedback":"missing the O(log n) bound"}\n```',
    );
    const res = await review(lesson.id, [{ questionId: qId, answer: 'it is fast' }]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(resultById(body, qId)).toEqual({
      questionId: qId,
      verdict: 'partial',
      answered: true,
      feedback: 'missing the O(log n) bound',
    });
    // partial is not all-correct → retry
    expect(body.verdict).toBe('retry');
    expect(body.reviewedAt).toBeNull();
  });
});
