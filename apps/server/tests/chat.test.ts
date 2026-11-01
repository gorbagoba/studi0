import { describe, expect, it, afterEach } from 'vitest';
import { makeHarness } from './helpers';
import type { OcClient } from '../src/teacher/sdk.js';
import type { V2Event } from '@opencode/client';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

function fakeClient(ocSessionId: string, opts: { tokens?: string[]; history?: { role: string; text: string }[] } = {}): OcClient {
  const history = opts.history ?? [];
  // terminal event replayed from a live opencode 2.2.1 probe: the turn ends
  // with session.execution.succeeded — session.idle does not exist in 2.2.1
  const events: V2Event[] = [
    ...(opts.tokens ?? []).map(
      (t) =>
        ({
          type: 'session.text.delta',
          data: { sessionID: ocSessionId, assistantMessageID: 'a1', ordinal: 0, delta: t },
        }) as unknown as V2Event,
    ),
    { type: 'session.execution.succeeded', data: { sessionID: ocSessionId } } as unknown as V2Event,
  ];
  return {
    session: {
      create: async () => ({ id: ocSessionId }),
      prompt: async () => ({}),
      interrupt: async () => ({}),
    },
    message: {
      list: async () => ({
        data: history.map((m, i) =>
          m.role === 'user'
            ? { id: `u${i}`, type: 'user', time: { created: i }, text: m.text }
            : {
                id: `a${i}`,
                type: 'assistant',
                time: { created: i },
                content: [{ type: 'text', text: m.text }],
              },
        ),
        cursor: {},
      }),
    },
    event: {
      subscribe: async function* () {
        for (const e of events) yield e;
      },
    },
    permission: { reply: async () => undefined },
  } as unknown as OcClient;
}

function patchOc(harness: Awaited<ReturnType<typeof makeHarness>>, client: OcClient) {
  harness.ctx.oc.ensureUp = () => undefined;
  harness.ctx.oc.client = () => client;
}

async function createSubject(name: string): Promise<string> {
  const res = await h.app.inject({ method: 'POST', url: '/api/subjects', payload: { name } });
  return (res.json() as { id: string }).id;
}

describe('teacher chat (T06)', () => {
  it('renames a chat session (PATCH title) and 404s unknown sessions', async () => {
    h = await makeHarness();
    const id = await createSubject('ChatRename');
    patchOc(h, fakeClient('oc-rename'));
    const s = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json();
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${s.id}`,
      payload: { title: '  Heaps deep-dive  ' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Heaps deep-dive');
    const list = await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/chat/sessions` });
    expect(list.json()[0].title).toBe('Heaps deep-dive');
    const bad = await h.app.inject({ method: 'PATCH', url: '/api/chat/sessions/nope', payload: { title: 'x' } });
    expect(bad.statusCode).toBe(404);
    const empty = await h.app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${s.id}`,
      payload: { title: '' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('creates an opencode session eagerly; 503 when opencode is down', async () => {
    h = await makeHarness();
    const id = await createSubject('Chat1');
    const down = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${id}/chat/sessions`,
      payload: {},
    });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe('OPENCODE_DOWN');

    patchOc(h, fakeClient('oc-1'));
    const ok = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${id}/chat/sessions`,
      payload: {},
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().active).toBe(true);
    expect(ok.json().messageCount).toBe(0);
  });

  it('streams tokens and terminates with done; quiz blocks join the bank', async () => {
    h = await makeHarness();
    const id = await createSubject('Chat2');
    patchOc(h, fakeClient('oc-2', { tokens: ['Hello ', 'world'] }));
    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json();

    // simulate the teacher having answered with a quiz block
    h.ctx.oc.client = () =>
      fakeClient('oc-2', {
        tokens: ['tok'],
        history: [
          { role: 'user', text: 'quiz me on heaps' },
          {
            role: 'assistant',
            text:
              'Here we go:\n```studi0-quiz\n' +
              JSON.stringify({
                topic: 'heaps',
                questions: [
                  {
                    topic: 'heaps',
                    type: 'mcq',
                    prompt: 'p?',
                    options: [
                      { id: 'a', text: 'x' },
                      { id: 'b', text: 'y' },
                    ],
                    key: { answerIndex: 1 },
                  },
                ],
              }) +
              '\n```',
          },
        ],
      });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'quiz me on heaps' },
    });
    expect(res.statusCode).toBe(200);
    const names = [...res.body.matchAll(/event: (\w+)/g)].map((m) => m[1]);
    expect(names).toContain('token');
    expect(names).toContain('quiz');
    expect(names[names.length - 1]).toBe('done');
    const bank = (
      await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/questions` })
    ).json();
    expect(bank).toHaveLength(1);
    expect(bank[0].source).toBe('auto');
    const sessions = (
      await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/chat/sessions` })
    ).json();
    expect(sessions[0].messageCount).toBe(2);
  });

  it('scans only the latest assistant message for quiz blocks (no re-deposit of older turns)', async () => {
    h = await makeHarness();
    const id = await createSubject('Chat5');
    patchOc(h, fakeClient('oc-5'));
    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json();
    const quizBlock = (topic: string) =>
      '```studi0-quiz\n' +
      JSON.stringify({
        topic,
        questions: [
          {
            topic,
            type: 'mcq',
            prompt: `${topic}?`,
            options: [
              { id: 'a', text: 'x' },
              { id: 'b', text: 'y' },
            ],
            key: { answerIndex: 0 },
          },
        ],
      }) +
      '\n```';
    h.ctx.oc.client = () =>
      fakeClient('oc-5', {
        tokens: ['tok'],
        history: [
          { role: 'user', text: 'earlier question' },
          { role: 'assistant', text: `Old answer:\n${quizBlock('old-topic')}` },
          { role: 'user', text: 'quiz me again' },
          { role: 'assistant', text: `New answer:\n${quizBlock('new-topic')}` },
        ],
      });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'quiz me again' },
    });
    expect(res.statusCode).toBe(200);
    const bank = (
      await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/questions` })
    ).json();
    // only the latest assistant reply is scanned — the older block must not re-deposit
    expect(bank).toHaveLength(1);
    expect(bank[0].payload.prompt).toBe('new-topic?');
  });

  it('rejects a second concurrent turn on the same session with 409 TURN_IN_PROGRESS', async () => {
    h = await makeHarness();
    const id = await createSubject('Chat6');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = {
      session: {
        create: async () => ({ id: 'oc-6' }),
        prompt: async () => {
          await gate;
        },
        interrupt: async () => ({}),
      },
      message: { list: async () => ({ data: [], cursor: {} }) },
      event: {
        subscribe: async function* () {
          await gate;
          yield { type: 'session.execution.succeeded', data: { sessionID: 'oc-6' } };
        },
      },
      permission: { reply: async () => undefined },
    } as unknown as OcClient;
    patchOc(h, client);
    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json();

    const first = h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'one' },
    });
    await new Promise((r) => setTimeout(r, 50)); // let the first turn get in flight
    const second = await h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'two' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('TURN_IN_PROGRESS');
    release();
    expect((await first).statusCode).toBe(200);
  });

  it('strips opencode step markers from tokens (§N§ never reaches the client)', async () => {
    h = await makeHarness();
    const id = await createSubject('Chat7');
    patchOc(h, fakeClient('oc-7', { tokens: ['§3§ ', 'Binary heaps §12§ are ', 'heaps.'] }));
    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'hi' },
    });
    expect(res.statusCode).toBe(200);
    const text = [...res.body.matchAll(/event: token\ndata: (.+)/g)]
      .map((m) => (JSON.parse(m[1]) as { text: string }).text)
      .join('');
    expect(text).toBe('Binary heaps are heaps.');
    expect(text).not.toContain('\u00A7');
  });

  it('history: 404 unknown session, 410 when opencode lost it', async () => {
    h = await makeHarness();
    const id = await createSubject('Chat3');
    const missing = await h.app.inject({
      method: 'GET',
      url: '/api/chat/sessions/00000000-0000-0000-0000-000000000000/messages',
    });
    expect(missing.statusCode).toBe(404);
    patchOc(h, fakeClient('oc-3'));
    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json();
    h.ctx.oc.client = (() => ({
      message: {
        list: async () => {
          const e = new Error('not found') as Error & { _tag: string };
          e._tag = 'SessionNotFoundError';
          throw e;
        },
      },
    })) as unknown as () => OcClient;
    const gone = await h.app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages`,
    });
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error.code).toBe('SESSION_GONE');
  });

  it('rotates long sessions: summary written, fresh session, rotated event (AC16)', async () => {
    h = await makeHarness();
    const id = await createSubject('Chat4');
    patchOc(h, fakeClient('oc-4'));
    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json();
    // force the rotation threshold
    h.ctx.db.prepare('UPDATE chat_sessions SET msg_count = 24 WHERE id = ?').run(session.id);
    const summaries: string[] = [];
    h.ctx.oneshot = async (_cwd, prompt) => {
      summaries.push(prompt);
      return '## Topics\n- heaps';
    };
    h.ctx.oc.client = () =>
      fakeClient('oc-4-NEW', {
        tokens: ['continuing'],
        history: Array.from({ length: 24 }, (_, i) => ({ role: 'user', text: `msg ${i}` })),
      });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'continue' },
    });
    expect(res.statusCode).toBe(200);
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain('msg 23');
    const body = res.body;
    expect(body).toContain('event: rotated');
    const rotated = JSON.parse(body.split('event: rotated\ndata: ')[1].split('\n\n')[0]);
    expect(rotated.newSessionId).not.toBe(session.id);
    expect(rotated.summaryPath).toMatch(/^learning-records\/\d{4}-\d{2}-\d{2}-chat4-.*\.md$/);
    const sessions = (
      await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/chat/sessions` })
    ).json();
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s: { id: string }) => s.id === session.id).active).toBe(false);
    expect(
      sessions.find((s: { id: string }) => s.id === rotated.newSessionId).summaryPath,
    ).toBeNull();
  });
});
