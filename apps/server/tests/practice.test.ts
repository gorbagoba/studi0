import { describe, expect, it, afterEach } from 'vitest';
import { makeHarness } from './helpers';
import { quizSpecSchema } from '@studi0/shared';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

const goodQuiz = {
  topic: 'heaps',
  questions: [
    {
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
    },
    {
      topic: 'heaps',
      type: 'short',
      prompt: 'Why does Dijkstra use a priority queue?',
      key: {
        answer: 'to get the next closest vertex in O(log n)',
        rubric: 'mentions extracting the minimum efficiently',
      },
    },
  ],
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

describe('practice engine (T07)', () => {
  it('generates unverified questions due immediately (stubbed oneshot)', async () => {
    h = await makeHarness();
    patchOc(h);
    const id = await createSubject('P1');
    h.ctx.oneshot = stubOneshot('```studi0-quiz\n' + JSON.stringify(goodQuiz) + '\n```');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${id}/questions/generate`,
      payload: { topic: 'heaps', count: 2 },
    });
    expect(res.statusCode).toBe(201);
    const questions = res.json();
    expect(questions).toHaveLength(2);
    expect(questions[0].keyStatus).toBe('unverified');
    expect(questions[0].payload.key).toBeUndefined(); // key never leaks in listing
    const due = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/practice/due` })).json();
    expect(due.questions).toHaveLength(2);
    // malformed generation output â†’ honest 500
    h.ctx.oneshot = stubOneshot('the model babbled, no json');
    const bad = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${id}/questions/generate`,
      payload: { topic: 'heaps' },
    });
    expect(bad.statusCode).toBe(500);
  });

  it('verification gate: reveal 409s until a second pass passes (AC19)', async () => {
    h = await makeHarness();
    patchOc(h);
    const id = await createSubject('P2');
    h.ctx.oneshot = stubOneshot('```json\n' + JSON.stringify(goodQuiz) + '\n```');
    const questions = (
      await h.app.inject({
        method: 'POST',
        url: `/api/subjects/${id}/questions/generate`,
        payload: { topic: 'heaps' },
      })
    ).json();
    const q = questions[0];

    const revealBefore = await h.app.inject({
      method: 'POST',
      url: `/api/questions/${q.id}/reveal-key`,
    });
    expect(revealBefore.statusCode).toBe(409);
    expect(revealBefore.json().error.code).toBe('KEY_NOT_VERIFIED');
    expect(revealBefore.json().error.details.keyStatus).toBe('unverified');

    // failing verification keeps the gate closed
    h.ctx.oneshot = stubOneshot('```json\n{"ok":false,"reason":"key contradicts the slides"}\n```');
    const failed = await h.app.inject({ method: 'POST', url: `/api/questions/${q.id}/verify-key` });
    expect(failed.json().keyStatus).toBe('failed');
    expect(
      (await h.app.inject({ method: 'POST', url: `/api/questions/${q.id}/reveal-key` })).statusCode,
    ).toBe(409);

    // passing verification opens the gate
    h.ctx.oneshot = stubOneshot('```json\n{"ok":true,"reason":"matches material"}\n```');
    const ok = await h.app.inject({ method: 'POST', url: `/api/questions/${q.id}/verify-key` });
    expect(ok.json().keyStatus).toBe('verified');
    const reveal = await h.app.inject({ method: 'POST', url: `/api/questions/${q.id}/reveal-key` });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json().key).toEqual({ answerIndex: 0 });
  });

  it('grades MCQ offline (exact match) and advances the ladder', async () => {
    h = await makeHarness();
    patchOc(h);
    const id = await createSubject('P3');
    h.ctx.oneshot = stubOneshot('```json\n' + JSON.stringify(goodQuiz) + '\n```');
    const [q] = (
      await h.app.inject({
        method: 'POST',
        url: `/api/subjects/${id}/questions/generate`,
        payload: { topic: 'heaps' },
      })
    ).json();
    const right = await h.app.inject({
      method: 'POST',
      url: `/api/questions/${q.id}/answer`,
      payload: { answer: 'a' },
    });
    expect(right.statusCode).toBe(200);
    const body = right.json();
    expect(body.grade.verdict).toBe('correct');
    expect(body.intervalDays).toBe(1);
    const wrong = await h.app.inject({
      method: 'POST',
      url: `/api/questions/${q.id}/answer`,
      payload: { answer: 'b' },
    });
    expect(wrong.json().grade.verdict).toBe('incorrect');
    expect(wrong.json().intervalDays).toBe(1);
    expect(wrong.json().grade.feedback).toContain('Correct answer');
  });

  it('grades short answers via LLM vs key + rubric (stubbed oneshot)', async () => {
    h = await makeHarness();
    patchOc(h);
    const id = await createSubject('P4');
    h.ctx.oneshot = stubOneshot('```json\n' + JSON.stringify(goodQuiz) + '\n```');
    const [, q] = (
      await h.app.inject({
        method: 'POST',
        url: `/api/subjects/${id}/questions/generate`,
        payload: { topic: 'heaps' },
      })
    ).json();
    h.ctx.oneshot = stubOneshot(
      '```json\n{"verdict":"partial","feedback":"missing the O(log n) bound"}\n```',
    );
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/questions/${q.id}/answer`,
      payload: { answer: 'it is fast' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().grade).toEqual({
      verdict: 'partial',
      feedback: 'missing the O(log n) bound',
    });
  });

  it('computes per-topic accuracy, due count, and streak from attempts', async () => {
    h = await makeHarness();
    patchOc(h);
    const id = await createSubject('P5');
    h.ctx.oneshot = stubOneshot('```json\n' + JSON.stringify(goodQuiz) + '\n```');
    const questions = (
      await h.app.inject({
        method: 'POST',
        url: `/api/subjects/${id}/questions/generate`,
        payload: { topic: 'heaps' },
      })
    ).json();
    await h.app.inject({
      method: 'POST',
      url: `/api/questions/${questions[0].id}/answer`,
      payload: { answer: 'a' },
    });
    h.ctx.oneshot = stubOneshot(
      '```json\n{"verdict":"incorrect","feedback":"not what the rubric asks for"}\n```',
    );
    await h.app.inject({
      method: 'POST',
      url: `/api/questions/${questions[1].id}/answer`,
      payload: { answer: 'wrong on purpose' },
    });
    const stats = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/practice/stats` })).json();
    expect(stats.totalQuestions).toBe(2);
    expect(stats.dueCount).toBe(0); // both answered → next due tomorrow (correct 1d, wrong reset 1d)
    expect(stats.perTopic[0].topic).toBe('heaps');
    expect(stats.perTopic[0].attempts).toBe(2);
    expect(stats.perTopic[0].correct).toBe(1);
    expect(stats.streakDays).toBe(1);
  });

  it('quizSpecSchema rejects blocks with missing keys', () => {
    expect(quizSpecSchema.safeParse({ topic: 'x', questions: [{ prompt: 'p' }] }).success).toBe(false);
    expect(quizSpecSchema.safeParse(goodQuiz).success).toBe(true);
  });
});
