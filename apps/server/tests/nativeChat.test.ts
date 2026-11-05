import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeHarness } from './helpers';
import { chatCompletion, streamCompletion, type StreamDelta } from '../src/teacher/llm.js';
import { makeConfig, type Config } from '../src/config.js';
import type { OcClient } from '../src/teacher/sdk.js';

vi.mock('../src/retrieval/embed.js', () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384))),
}));

const NATIVE_ENV = {
  CHAT_ENGINE: 'native',
  CHAT_BASE_URL: 'http://mock-gw',
  CHAT_API_KEY: 'sk-test',
  CHAT_MODEL: 'test-model',
};

let h: Awaited<ReturnType<typeof makeHarness>> | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (h) await h.close();
  h = undefined;
});

const enc = new TextEncoder();
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
const DONE = 'data: [DONE]\n\n';

function sseResponse(...frames: string[]): Response {
  return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(frames.join(''))); c.close(); } }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const llmCfg = { chatBaseUrl: 'http://gw', chatApiKey: 'sk-secret', chatModel: 'm' } as unknown as Config;

function captureFetch(responses: Response[]): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      const res = responses.shift();
      if (!res) throw new Error('unexpected extra LLM call');
      return res;
    }),
  );
  return calls;
}

function patchOc(harness: NonNullable<typeof h>, ocId = 'oc-native') {
  harness.ctx.oc.ensureUp = () => undefined;
  harness.ctx.oc.client = () =>
    ({ session: { create: async () => ({ id: ocId }) } }) as unknown as OcClient;
}

async function createSubject(name: string): Promise<string> {
  const res = await h!.app.inject({ method: 'POST', url: '/api/subjects', payload: { name } });
  return (res.json() as { id: string }).id;
}

const eventsOf = (body: string) => [...body.matchAll(/event: (\w+)/g)].map((m) => m[1]);
const dataOf = (body: string, event: string) =>
  [...body.matchAll(new RegExp(`event: ${event}\\ndata: (.+)`, 'g'))].map((m) => JSON.parse(m[1]) as Record<string, unknown>);

describe('llm client', () => {
  it('streamCompletion parses content deltas and merges fragmented tool_calls by index', async () => {
    const calls = captureFetch([
      sseResponse(
        chunk({ content: 'Hello ' }),
        chunk({ reasoning: 'hidden', content: 'world' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_9', function: { name: 'write_lesson', arguments: '{"a"' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
        chunk({}, 'tool_calls'),
        DONE,
      ),
    ]);
    const deltas: StreamDelta[] = [];
    for await (const d of streamCompletion(
      llmCfg,
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    )) {
      deltas.push(d);
    }
    expect(calls[0]?.url).toBe('http://gw/chat/completions');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret');
    expect(deltas.filter((d) => d.content).map((d) => d.content)).toEqual(['Hello ', 'world']);
    expect(deltas.at(-1)?.toolCalls).toEqual([
      { index: 0, id: 'call_9', name: 'write_lesson', arguments: '{"a":1}' },
    ]);
    // reasoning is parsed away, never yielded
    expect(JSON.stringify(deltas)).not.toContain('hidden');
  });

  it('chatCompletion posts non-streaming and returns the full JSON', async () => {
    captureFetch([new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })]);
    const out = (await chatCompletion(
      llmCfg,
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    )) as { choices: { message: { content: string } }[] };
    expect(out.choices[0].message.content).toBe('ok');
  });

  it('errors carry the status, never the key', async () => {
    captureFetch([new Response('unauthorized', { status: 401 })]);
    await expect(
      chatCompletion(llmCfg, { model: 'm', messages: [] }, new AbortController().signal),
    ).rejects.toSatisfy((e: unknown) => {
      const msg = (e as Error).message;
      return (e as Error).name === 'HttpError' && msg.includes('401') && !msg.includes('sk-secret');
    });
  });
});

describe('native config', () => {
  it('falls back to opencode when native lacks gateway config', () => {
    const keys = ['CHAT_ENGINE', 'CHAT_BASE_URL', 'CHAT_API_KEY', 'CHAT_MODEL'];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      process.env.CHAT_ENGINE = 'native';
      delete process.env.CHAT_API_KEY;
      expect(makeConfig().chatEngine).toBe('opencode');
      process.env.CHAT_API_KEY = 'k';
      process.env.CHAT_BASE_URL = 'http://x';
      process.env.CHAT_MODEL = 'm';
      expect(makeConfig().chatEngine).toBe('native');
    } finally {
      for (const k of keys) {
        const v = prev[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('native chat engine', () => {
  it('runs the tool loop: write_lesson → save_quiz → final text; reasoning never surfaces', async () => {
    h = await makeHarness({ env: NATIVE_ENV });
    const id = await createSubject('ChatNative');
    patchOc(h);
    let fed = 0;
    h.ctx.feedQuestions = () => {
      fed++;
    };
    const quizSpec = {
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
          key: { answerIndex: 0 },
        },
      ],
    };
    const calls = captureFetch([
      sseResponse(
        chunk({ reasoning: 'secret-1', content: 'Writing the lesson now. ' }),
        chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_lesson', arguments: '{"path":"lessons/0001-he' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'aps.html","html":"<h1>Heaps</h1>"' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }),
        chunk({}, 'tool_calls'),
        DONE,
      ),
      sseResponse(
        chunk({ tool_calls: [{ index: 0, id: 'c2', function: { name: 'save_quiz', arguments: JSON.stringify({ spec: quizSpec }) } }] }),
        chunk({}, 'tool_calls'),
        DONE,
      ),
      sseResponse(
        chunk({ reasoning: 'secret-2', content: 'All done. ' }),
        chunk({ content: 'Lesson written.' }),
        chunk({}, 'stop'),
        DONE,
      ),
    ]);

    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json() as { id: string };
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'teach me heaps' },
    });
    expect(res.statusCode).toBe(200);

    const names = eventsOf(res.body);
    expect(names.filter((n) => n === 'token')).toHaveLength(3);
    expect(dataOf(res.body, 'tool')).toEqual([
      { name: 'write_lesson', ok: true },
      { name: 'save_quiz', ok: true },
    ]);
    expect(names).toContain('lesson');
    expect(names).toContain('quiz');
    expect(names[names.length - 1]).toBe('done');
    expect(res.body).not.toContain('secret-1');
    expect(res.body).not.toContain('secret-2');

    // lesson file written and indexed exactly once (safety net must not re-emit)
    const subjectDir = path.join(h.dataDir, 'subjects', 'ChatNative');
    await expect(readFile(path.join(subjectDir, 'lessons', '0001-heaps.html'), 'utf8')).resolves.toBe(
      '<h1>Heaps</h1>',
    );
    expect(fed).toBe(1);

    // quiz deposited via save_quiz
    const bank = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/questions` })).json();
    expect(bank).toHaveLength(1);
    expect(bank[0].source).toBe('auto');

    // local transcript: user + assistant, no reasoning, no tool JSON
    const rows = h.ctx.db.prepare('SELECT role, text FROM chat_messages ORDER BY rowid').all() as {
      role: string;
      text: string;
    }[];
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(rows[0].text).toBe('teach me heaps');
    expect(rows[1].text).toBe('Writing the lesson now. \n\nAll done. Lesson written.');

    // protocol: system message first, tool results appended after each tool round
    expect(calls).toHaveLength(3);
    const firstBody = JSON.parse(calls[0].init.body as string) as { messages: { role: string }[] };
    expect(firstBody.messages[0].role).toBe('system');
    const secondBody = JSON.parse(calls[1].init.body as string) as { messages: { role: string }[] };
    expect(secondBody.messages.at(-1)?.role).toBe('tool');

    // history endpoint serves the local transcript
    const history = (
      await h.app.inject({ method: 'GET', url: `/api/chat/sessions/${session.id}/messages` })
    ).json();
    expect(history).toHaveLength(2);
  });

  it('survives truncated "{}" tool arguments: tool fails, turn completes', async () => {
    h = await makeHarness({ env: NATIVE_ENV });
    const id = await createSubject('ChatNative2');
    patchOc(h);
    h.ctx.feedQuestions = () => undefined;
    captureFetch([
      sseResponse(
        chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_lesson', arguments: '{}' } }] }),
        chunk({}, 'tool_calls'),
        DONE,
      ),
      sseResponse(chunk({ content: 'Could not write that — the arguments arrived empty.' }), chunk({}, 'stop'), DONE),
    ]);
    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json() as { id: string };
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'write a lesson' },
    });
    expect(dataOf(res.body, 'tool')).toEqual([{ name: 'write_lesson', ok: false }]);
    expect(eventsOf(res.body).at(-1)).toBe('done');
  });

  it('rejects lesson paths that escape lessons/NNNN-slug.html', async () => {
    h = await makeHarness({ env: NATIVE_ENV });
    const id = await createSubject('ChatNative3');
    patchOc(h);
    h.ctx.feedQuestions = () => undefined;
    captureFetch([
      sseResponse(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'c1',
              function: { name: 'write_lesson', arguments: JSON.stringify({ path: 'lessons/../../escape.html', html: 'x' }) },
            },
          ],
        }),
        chunk({}, 'tool_calls'),
        DONE,
      ),
      sseResponse(chunk({ content: 'ok' }), chunk({}, 'stop'), DONE),
    ]);
    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json() as { id: string };
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'write' },
    });
    const tools = dataOf(res.body, 'tool') as { name: string; ok: boolean }[];
    expect(tools[0].ok).toBe(false);
    await expect(stat(path.join(h.dataDir, 'escape.html'))).rejects.toThrow();
  });

  it('rotates native sessions using the local transcript', async () => {
    h = await makeHarness({ env: NATIVE_ENV });
    const id = await createSubject('ChatNative4');
    let ocIds = 0;
    h.ctx.oc.ensureUp = () => undefined;
    h.ctx.oc.client = () =>
      ({ session: { create: async () => ({ id: `oc-${++ocIds}` }) } }) as unknown as OcClient;
    const summaries: string[] = [];
    h.ctx.oneshot = async (_cwd: string, prompt: string) => {
      summaries.push(prompt);
      return '## Summary';
    };
    captureFetch([
      sseResponse(chunk({ content: 'first answer' }), chunk({}, 'stop'), DONE),
      sseResponse(chunk({ content: 'second answer' }), chunk({}, 'stop'), DONE),
    ]);
    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json() as { id: string };
    await h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'first question' },
    });
    h.ctx.db.prepare('UPDATE chat_sessions SET msg_count = 24 WHERE id = ?').run(session.id);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'second question' },
    });
    expect(res.statusCode).toBe(200);
    expect(eventsOf(res.body)).toContain('rotated');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('first answer');
    // the fresh session has its own local transcript going forward
    const rotated = dataOf(res.body, 'rotated')[0] as { newSessionId: string };
    const rows = h.ctx.db
      .prepare('SELECT role FROM chat_messages WHERE session_id = ? ORDER BY rowid')
      .all(rotated.newSessionId) as { role: string }[];
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
  });

  it('search_material tool round feeds hybrid hits back to the model', async () => {
    h = await makeHarness({ env: NATIVE_ENV });
    const id = await createSubject('ChatSearch');
    patchOc(h);
    const root = (h.ctx.db.prepare('SELECT path FROM subjects WHERE id = ?').get(id) as { path: string })
      .path;
    await mkdir(path.join(root, 'material'), { recursive: true });
    await writeFile(
      path.join(root, 'material', 'notes.md'),
      '# Heap sort\n\nHeap sort builds a heap then repeatedly extracts the max element.\n',
    );
    const calls = captureFetch([
      sseResponse(
        chunk({
          tool_calls: [
            { index: 0, id: 's1', function: { name: 'search_material', arguments: '{"query":"heap sort"}' } },
          ],
        }),
        chunk({}, 'tool_calls'),
        DONE,
      ),
      sseResponse(chunk({ content: 'Found it in your notes.' }), chunk({}, 'stop'), DONE),
    ]);

    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json() as { id: string };
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'what is heap sort?' },
    });
    expect(res.statusCode).toBe(200);
    expect(eventsOf(res.body)).toContain('done');
    expect(calls).toHaveLength(2);
    // the hybrid hit for the fixture file was fed back as the tool result
    const second = JSON.parse(String(calls[1].init.body)) as {
      messages: { role: string; content: string }[];
    };
    const toolMsg = second.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('material/notes.md');
  });
});
