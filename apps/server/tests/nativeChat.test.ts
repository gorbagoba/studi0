import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeHarness } from './helpers';
import * as chatRepo from '../src/db/repos/chat.js';
import * as lessonsRepo from '../src/db/repos/lessons.js';
import { chatCompletion, streamCompletion, type StreamDelta } from '../src/teacher/llm.js';
import { makeConfig, type Config } from '../src/config.js';
import type { OcClient } from '../src/teacher/sdk.js';

vi.mock('../src/retrieval/embed.js', () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384))),
}));

const { renderLessonPngMock } = vi.hoisted(() => ({ renderLessonPngMock: vi.fn() }));
vi.mock('../src/teacher/render.js', () => ({ renderLessonPng: renderLessonPngMock }));

const NATIVE_ENV = {
  CHAT_ENGINE: 'native',
  CHAT_BASE_URL: 'http://mock-gw',
  CHAT_API_KEY: 'sk-test',
  CHAT_MODEL: 'test-model',
};

let h: Awaited<ReturnType<typeof makeHarness>> | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  renderLessonPngMock.mockReset();
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

  it('sends thinking-off chat_template_kwargs by default, omits them when disabled', async () => {
    const prev = process.env.CHAT_DISABLE_THINKING;
    const body = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };
    const drain = async (cfg: Config) => {
      for await (const _ of streamCompletion(cfg, body, new AbortController().signal)) void _;
    };
    try {
      delete process.env.CHAT_DISABLE_THINKING;
      const on = captureFetch([sseResponse(chunk({ content: 'ok' }), chunk({}, 'stop'), DONE)]);
      await drain(makeConfig());
      expect(JSON.parse(String(on[0].init.body)).chat_template_kwargs).toEqual({ enable_thinking: false });

      process.env.CHAT_DISABLE_THINKING = 'false';
      const off = captureFetch([sseResponse(chunk({ content: 'ok' }), chunk({}, 'stop'), DONE)]);
      await drain(makeConfig());
      expect(JSON.parse(String(off[0].init.body))).not.toHaveProperty('chat_template_kwargs');
    } finally {
      if (prev === undefined) delete process.env.CHAT_DISABLE_THINKING;
      else process.env.CHAT_DISABLE_THINKING = prev;
    }
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

  it('caps the transcript at 40 messages and starts it with a user message', async () => {    h = await makeHarness({ env: NATIVE_ENV });
    const id = await createSubject('ChatWindow');
    patchOc(h);
    h.ctx.feedQuestions = () => undefined;
    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json() as { id: string };
    // 60 prior messages, alternating; the turn adds a 61st user message
    for (let i = 0; i < 60; i++) {
      chatRepo.insertMessage(h.ctx.db, session.id, i % 2 === 0 ? 'user' : 'assistant', `m${i}`);
    }
    const calls = captureFetch([sseResponse(chunk({ content: 'ok' }), chunk({}, 'stop'), DONE)]);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      payload: { content: 'now' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(String(calls[0].init.body)) as { messages: { role: string }[] };
    expect(body.messages[0].role).toBe('system');
    expect(body.messages.length).toBeLessThanOrEqual(41); // 40 history + system
    expect(body.messages[1].role).toBe('user');
  });
});

describe('save_mission_answers tool', () => {
  async function start(name: string): Promise<{ sessionId: string; root: string }> {
    h = await makeHarness({ env: NATIVE_ENV });
    const id = await createSubject(name);
    patchOc(h);
    h.ctx.feedQuestions = () => undefined;
    const root = (h.ctx.db.prepare('SELECT path FROM subjects WHERE id = ?').get(id) as { path: string }).path;
    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json() as { id: string };
    return { sessionId: session.id, root };
  }

  const toolCall = (answers: string) =>
    sseResponse(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'a1',
            function: { name: 'save_mission_answers', arguments: JSON.stringify({ answers }) },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
      DONE,
    );
  const finalText = () => sseResponse(chunk({ content: 'Saved.' }), chunk({}, 'stop'), DONE);
  const ask = (sessionId: string) =>
    h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'Answers to your questions: 1. … — …' },
    });

  it('creates MISSION.md with the heading, then appends each call as another bullet', async () => {
    const { sessionId, root } = await start('ChatMissionAnswers');
    const calls = captureFetch([toolCall('Pace: exam in under a week'), finalText()]);
    const res = await ask(sessionId);
    expect(dataOf(res.body, 'tool')).toEqual([{ name: 'save_mission_answers', ok: true }]);

    // the teacher prompt carries the form instruction and the tool line
    const system = (JSON.parse(String(calls[0].init.body)) as { messages: { role: string; content: string }[] })
      .messages[0].content;
    expect(system).toContain('studi0-questions');
    expect(system).toContain('save_mission_answers { "answers" }');

    const file = path.join(root, 'MISSION.md');
    await expect(readFile(file, 'utf8')).resolves.toBe(
      '## Student answers (from chat)\n- Pace: exam in under a week\n',
    );

    captureFetch([toolCall('Style: examples first'), finalText()]);
    await ask(sessionId);
    const after = await readFile(file, 'utf8');
    expect(after).toBe(
      '## Student answers (from chat)\n- Pace: exam in under a week\n- Style: examples first\n',
    );
    expect(after.split('## Student answers (from chat)')).toHaveLength(2); // heading written once
  });

  it('creates MISSION.md when it is absent', async () => {
    const { sessionId, root } = await start('ChatMissionMissing');
    const file = path.join(root, 'MISSION.md');
    await rm(file, { force: true });
    captureFetch([toolCall('Pace: 1-4 weeks'), finalText()]);
    const res = await ask(sessionId);
    expect(dataOf(res.body, 'tool')).toEqual([{ name: 'save_mission_answers', ok: true }]);
    await expect(readFile(file, 'utf8')).resolves.toBe(
      '## Student answers (from chat)\n- Pace: 1-4 weeks\n',
    );
  });

  it('caps oversized answers without crashing', async () => {
    const { sessionId, root } = await start('ChatMissionHuge');
    captureFetch([toolCall('x'.repeat(20_000)), finalText()]);
    const res = await ask(sessionId);
    expect(dataOf(res.body, 'tool')).toEqual([{ name: 'save_mission_answers', ok: true }]);
    const size = (await stat(path.join(root, 'MISSION.md'))).size;
    expect(size).toBeLessThan(5_000);
  });
});

describe('generate_lesson (lesson writer delegation)', () => {
  const VALID_HTML =
    '<!DOCTYPE html><html><head><title>Heaps</title></head><body><h1>Heaps</h1></body></html>';

  async function startSession(name: string): Promise<{ id: string; sessionId: string; root: string }> {
    h = await makeHarness({ env: NATIVE_ENV });
    const id = await createSubject(name);
    patchOc(h);
    const root = (h.ctx.db.prepare('SELECT path FROM subjects WHERE id = ?').get(id) as { path: string }).path;
    const session = (
      await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/chat/sessions`, payload: {} })
    ).json() as { id: string };
    return { id, sessionId: session.id, root };
  }

  /** Seed one already-indexed lesson so the subject counts as "has lessons". */
  async function seedLesson(id: string, root: string, rel = 'lessons/0001-heaps.html') {
    await mkdir(path.join(root, 'lessons'), { recursive: true });
    await writeFile(path.join(root, rel), '<h1>existing</h1>');
    lessonsRepo.upsertLesson(h!.ctx.db, id, rel, 'Heaps', []);
  }

  const toolCall = (name: string, args: object) =>
    sseResponse(
      chunk({ tool_calls: [{ index: 0, id: 'g1', function: { name, arguments: JSON.stringify(args) } }] }),
      chunk({}, 'tool_calls'),
      DONE,
    );
  const writerResponse = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  const finalText = () => sseResponse(chunk({ content: 'Lesson ready.' }), chunk({}, 'stop'), DONE);

  it('writes the writer HTML, emits the lesson event and reports ok to the model', async () => {
    const { sessionId, root } = await startSession('ChatGenLesson');
    let fed = 0;
    h!.ctx.feedQuestions = () => {
      fed++;
    };
    await mkdir(path.join(root, 'material'), { recursive: true });
    await writeFile(path.join(root, 'material', 'notes.md'), '# Heap sort\n\nHeap sort builds a heap then extracts the max.\n');

    const calls = captureFetch([
      toolCall('generate_lesson', { path: 'lessons/0002-heaps.html', topic: 'heap sort' }),
      writerResponse(VALID_HTML),
      finalText(),
    ]);
    const res = await h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'write me a lesson on heaps' },
    });

    expect(res.statusCode).toBe(200);
    expect(dataOf(res.body, 'tool')).toEqual([{ name: 'generate_lesson', ok: true }]);
    expect(eventsOf(res.body)).toContain('lesson');
    expect(fed).toBe(1);
    await expect(readFile(path.join(root, 'lessons', '0002-heaps.html'), 'utf8')).resolves.toBe(VALID_HTML);

    // writer request: lesson model, its own kwargs, big token budget, evidence + rules in the prompt
    const writer = JSON.parse(String(calls[1].init.body)) as {
      model: string;
      max_tokens: number;
      chat_template_kwargs: Record<string, unknown>;
      messages: { role: string; content: string }[];
    };
    expect(writer.model).toBe('x-test-2');
    expect(writer.max_tokens).toBe(16000);
    expect(writer.chat_template_kwargs).toEqual({ thinking: false });
    expect(writer.messages[1].content).toContain('material/notes.md');
    expect(writer.messages[1].content).toContain('teach-back');
    expect(writer.messages[0].content).toContain('VISUAL RULES');
    expect(writer.messages[0].content).toContain('inline SVG');

    // the tool result fed back to the chat model
    const next = JSON.parse(String(calls[2].init.body)) as { messages: { role: string; content: string }[] };
    const toolMsg = next.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMsg?.content ?? '{}')).toMatchObject({ ok: true, path: 'lessons/0002-heaps.html' });
  });

  const ROUND1_HTML =
    '<!DOCTYPE html><html><head><title>Heaps</title></head><body><h1>Heaps</h1><svg><text>root</text></svg></body></html>';
  const REVISED_HTML =
    '<!DOCTYPE html><html><head><title>Heaps</title></head><body><h1>Heaps</h1><svg><text>root (labeled)</text></svg></body></html>';

  it('renders, reviews the screenshot, rewrites once and emits one lesson event', async () => {
    const { sessionId, root } = await startSession('ChatGenReview');
    renderLessonPngMock.mockResolvedValue(Buffer.from('png-bytes'));
    let fed = 0;
    h!.ctx.feedQuestions = () => {
      fed++;
    };
    const calls = captureFetch([
      toolCall('generate_lesson', { path: 'lessons/0001-heaps.html', topic: 'heaps' }),
      writerResponse(ROUND1_HTML),
      writerResponse(REVISED_HTML),
      writerResponse('OK'),
      finalText(),
    ]);
    const res = await h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'write me a lesson on heaps' },
    });
    expect(dataOf(res.body, 'tool')).toEqual([{ name: 'generate_lesson', ok: true }]);
    expect(eventsOf(res.body).filter((n) => n === 'lesson')).toHaveLength(1);
    expect(fed).toBe(1);
    await expect(readFile(path.join(root, 'lessons', '0001-heaps.html'), 'utf8')).resolves.toBe(REVISED_HTML);

    // review request: reviewer system prompt + the rendered PNG as an image part
    const review = JSON.parse(String(calls[2].init.body)) as {
      messages: { role: string; content: unknown }[];
    };
    expect(review.messages[0].content).toContain('reviewing the rendered lesson');
    const parts = review.messages[1].content as { type: string; image_url?: { url: string } }[];
    expect(parts[0].type).toBe('text');
    expect(parts[1].image_url?.url).toBe(
      `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
    );

    // rounds/revisions reported back to the chat model
    const next = JSON.parse(String(calls[4].init.body)) as { messages: { role: string; content: string }[] };
    expect(JSON.parse(next.messages.find((m) => m.role === 'tool')?.content ?? '{}')).toMatchObject({
      ok: true,
      rounds: 2,
      revisions: 1,
    });
  });

  it('stops without rewriting when the review replies OK', async () => {
    const { sessionId, root } = await startSession('ChatGenReviewOk');
    renderLessonPngMock.mockResolvedValue(Buffer.from('png'));
    h!.ctx.feedQuestions = () => undefined;
    const calls = captureFetch([
      toolCall('generate_lesson', { path: 'lessons/0001-heaps.html', topic: 'heaps' }),
      writerResponse(ROUND1_HTML),
      writerResponse('OK'),
      finalText(),
    ]);
    const res = await h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'write it' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(4); // writer + one review, no rewrite call
    await expect(readFile(path.join(root, 'lessons', '0001-heaps.html'), 'utf8')).resolves.toBe(ROUND1_HTML);
    const next = JSON.parse(String(calls[3].init.body)) as { messages: { role: string; content: string }[] };
    expect(JSON.parse(next.messages.find((m) => m.role === 'tool')?.content ?? '{}')).toMatchObject({
      ok: true,
      rounds: 1,
      revisions: 0,
    });
  });

  it('writes once and skips review when no browser can render', async () => {
    const { sessionId, root } = await startSession('ChatGenNoRender');
    renderLessonPngMock.mockResolvedValue(null);
    h!.ctx.feedQuestions = () => undefined;
    const calls = captureFetch([
      toolCall('generate_lesson', { path: 'lessons/0001-heaps.html', topic: 'heaps' }),
      writerResponse(ROUND1_HTML),
      finalText(),
    ]);
    const res = await h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'write it' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(3); // no review call
    await expect(readFile(path.join(root, 'lessons', '0001-heaps.html'), 'utf8')).resolves.toBe(ROUND1_HTML);
    const next = JSON.parse(String(calls[2].init.body)) as { messages: { role: string; content: string }[] };
    expect(JSON.parse(next.messages.find((m) => m.role === 'tool')?.content ?? '{}')).toMatchObject({
      ok: true,
      rounds: 0,
      revisions: 0,
    });
  });

  it('caps visual review at two revisions', async () => {
    const { sessionId, root } = await startSession('ChatGenReviewCap');
    renderLessonPngMock.mockResolvedValue(Buffer.from('png'));
    h!.ctx.feedQuestions = () => undefined;
    const calls = captureFetch([
      toolCall('generate_lesson', { path: 'lessons/0001-heaps.html', topic: 'heaps' }),
      writerResponse(ROUND1_HTML),
      writerResponse(REVISED_HTML),
      writerResponse(REVISED_HTML.replace('root (labeled)', 'root (final)')),
      finalText(),
    ]);
    const res = await h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'write it' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(5); // exactly two review cycles
    const finalHtml = REVISED_HTML.replace('root (labeled)', 'root (final)');
    await expect(readFile(path.join(root, 'lessons', '0001-heaps.html'), 'utf8')).resolves.toBe(finalHtml);
    const next = JSON.parse(String(calls[4].init.body)) as { messages: { role: string; content: string }[] };
    expect(JSON.parse(next.messages.find((m) => m.role === 'tool')?.content ?? '{}')).toMatchObject({
      ok: true,
      rounds: 2,
      revisions: 2,
    });
  });

  it('rejects incomplete HTML without writing a file', async () => {
    const { sessionId, root } = await startSession('ChatGenIncomplete');
    h!.ctx.feedQuestions = () => undefined;
    const calls = captureFetch([
      toolCall('generate_lesson', { path: 'lessons/0003-cut.html', topic: 'heaps' }),
      writerResponse('<!DOCTYPE html><html><body><h1>Heaps'),
      finalText(),
    ]);
    const res = await h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'write it' },
    });
    expect(dataOf(res.body, 'tool')).toEqual([{ name: 'generate_lesson', ok: false }]);
    await expect(stat(path.join(root, 'lessons', '0003-cut.html'))).rejects.toThrow();
    const next = JSON.parse(String(calls[2].init.body)) as { messages: { role: string; content: string }[] };
    expect(next.messages.find((m) => m.role === 'tool')?.content).toContain('incomplete');
  });

  it('rejects paths outside lessons/NNNN-slug.html before calling the writer', async () => {
    const { sessionId, root } = await startSession('ChatGenTraversal');
    h!.ctx.feedQuestions = () => undefined;
    const calls = captureFetch([
      toolCall('generate_lesson', { path: 'lessons/../../x.html', topic: 'heaps' }),
      finalText(),
    ]);
    const res = await h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'write it' },
    });
    expect(dataOf(res.body, 'tool')).toEqual([{ name: 'generate_lesson', ok: false }]);
    expect(calls).toHaveLength(2); // no writer call happened
    await expect(stat(path.join(root, 'x.html'))).rejects.toThrow();
    await expect(stat(path.join(h!.dataDir, 'x.html'))).rejects.toThrow();
  });

  it('with lessons present: write_lesson rejects a new path and allows an existing one', async () => {
    const { id, sessionId, root } = await startSession('ChatPolicyWrite');
    h!.ctx.feedQuestions = () => undefined;
    await seedLesson(id, root);

    const calls = captureFetch([
      toolCall('write_lesson', { path: 'lessons/0002-new.html', html: '<h1>New</h1>' }),
      finalText(),
    ]);
    await h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'add another lesson' },
    });
    // the error reaches the model via the tool result, and nothing was written
    const next = JSON.parse(String(calls[1].init.body)) as { messages: { role: string; content: string }[] };
    expect(next.messages.find((m) => m.role === 'tool')?.content).toContain('lessons already exist');
    await expect(stat(path.join(root, 'lessons', '0002-new.html'))).rejects.toThrow();
    await expect(readFile(path.join(root, 'lessons', '0001-heaps.html'), 'utf8')).resolves.toBe(
      '<h1>existing</h1>',
    );

    captureFetch([
      toolCall('write_lesson', { path: 'lessons/0001-heaps.html', html: '<h1>Better heaps</h1>' }),
      finalText(),
    ]);
    const res = await h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'improve that lesson' },
    });
    expect(dataOf(res.body, 'tool')).toEqual([{ name: 'write_lesson', ok: true }]);
    await expect(readFile(path.join(root, 'lessons', '0001-heaps.html'), 'utf8')).resolves.toBe(
      '<h1>Better heaps</h1>',
    );
  });

  it('with lessons present: generate_lesson rejects a new path before calling the writer', async () => {
    const { id, sessionId, root } = await startSession('ChatPolicyGen');
    h!.ctx.feedQuestions = () => undefined;
    await seedLesson(id, root);
    // only two responses: chat stream + final text. A writer call would need a third.
    const calls = captureFetch([
      toolCall('generate_lesson', { path: 'lessons/0002-new.html', topic: 'heaps' }),
      finalText(),
    ]);
    const res = await h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'write another lesson' },
    });
    expect(dataOf(res.body, 'tool')).toEqual([{ name: 'generate_lesson', ok: false }]);
    expect(calls).toHaveLength(2);
    const next = JSON.parse(String(calls[1].init.body)) as { messages: { role: string; content: string }[] };
    expect(next.messages.find((m) => m.role === 'tool')?.content).toContain('lessons already exist');
    await expect(stat(path.join(root, 'lessons', '0002-new.html'))).rejects.toThrow();
  });

  it('with lessons present: generate_lesson on an existing path regenerates it', async () => {
    const { id, sessionId, root } = await startSession('ChatPolicyGenEdit');
    h!.ctx.feedQuestions = () => undefined;
    await seedLesson(id, root);
    const calls = captureFetch([
      toolCall('generate_lesson', { path: 'lessons/0001-heaps.html', topic: 'heap sort' }),
      writerResponse(VALID_HTML),
      finalText(),
    ]);
    const res = await h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'regenerate that lesson' },
    });
    expect(dataOf(res.body, 'tool')).toEqual([{ name: 'generate_lesson', ok: true }]);
    expect(calls).toHaveLength(3);
    await expect(readFile(path.join(root, 'lessons', '0001-heaps.html'), 'utf8')).resolves.toBe(VALID_HTML);
  });

  it('with no lessons yet: write_lesson may create the first lesson file', async () => {
    const { sessionId, root } = await startSession('ChatPolicyFirst');
    h!.ctx.feedQuestions = () => undefined;
    captureFetch([
      toolCall('write_lesson', { path: 'lessons/0001-first.html', html: '<h1>First</h1>' }),
      finalText(),
    ]);
    const res = await h!.app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      payload: { content: 'start the course' },
    });
    expect(dataOf(res.body, 'tool')).toEqual([{ name: 'write_lesson', ok: true }]);
    await expect(readFile(path.join(root, 'lessons', '0001-first.html'), 'utf8')).resolves.toBe(
      '<h1>First</h1>',
    );
  });
});

describe('lesson writer config', () => {
  it('parses CHAT_MODEL_LESSON_TEMPLATE_KWARGS and falls back on bad JSON', () => {
    const key = 'CHAT_MODEL_LESSON_TEMPLATE_KWARGS';
    const prev = process.env[key];
    try {
      process.env[key] = '{"thinking":true}';
      expect(makeConfig().chatLessonTemplateKwargs).toEqual({ thinking: true });

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      process.env[key] = '{oops';
      expect(makeConfig().chatLessonTemplateKwargs).toEqual({ thinking: false });
      expect(warn.mock.calls.flat().join(' ')).toContain(key);
      warn.mockRestore();
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });
});
