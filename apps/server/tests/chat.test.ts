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
  const events: V2Event[] = [
    ...(opts.tokens ?? []).map(
      (t) =>
        ({
          type: 'session.text.delta',
          data: { sessionID: ocSessionId, assistantMessageID: 'a1', ordinal: 0, delta: t },
        }) as unknown as V2Event,
    ),
    { type: 'session.idle', data: { sessionID: ocSessionId } } as unknown as V2Event,
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
