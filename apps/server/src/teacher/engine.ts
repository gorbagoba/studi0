import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { quizSpecSchema } from '@studi0/shared';
import * as chatRepo from '../db/repos/chat.js';
import * as lessonsRepo from '../db/repos/lessons.js';
import { detectAndIndexLessons } from './lessons.js';
import { depositQuiz } from './quizScan.js';
import { safeResolve } from '../fs/paths.js';
import { safeWriteFile } from '../fs/safeWrite.js';
import { hybridSearch } from '../retrieval/search.js';
import { ensureIndex } from '../retrieval/index.js';
import { HttpError } from '../util/errors.js';
import { streamCompletion, chatCompletion, type LlmMessage, type ToolCallAccum } from './llm.js';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import type { EventBus, Send } from '../http/sse.js';
import type { FeedQuestionsFn } from './practiceFeed.js';
import type { SubjectRow } from '../db/repos/subjects.js';
import type { ChatSessionRow } from '../db/repos/chat.js';
import type { LessonRow } from '../db/repos/lessons.js';

const execFileP = promisify(execFile);

/** Parity with the opencode path: one turn may run 15 minutes. */
export const TURN_TIMEOUT_MS = 15 * 60_000;

/** Tool rounds per turn — bounds a runaway tool loop. */
const MAX_TOOL_ROUNDS = 8;
/** Transcript messages sent per turn — prompt tokens otherwise grow every turn. */
const HISTORY_MAX_MESSAGES = 40;
const TOOL_RESULT_CAP = 4096;
const GREP_MAX_HITS = 40;
const READ_MAX_BYTES = 20_000_000;
// shortcut: 200k-char read cap truncates big material files; upgrade to ranged reads if the teacher needs more
const READ_MAX_CHARS = 200_000;
const GRAPHIFY_TIMEOUT_MS = 30_000;
const LESSON_EVIDENCE_MAX_CHARS = 8_000;
const LESSON_MISSION_MAX_CHARS = 2_000;
/** the lesson writer is slow (one ~60s completion on big lessons) but bounded */
const LESSON_WRITER_TIMEOUT_MS = 10 * 60_000;

export interface NativeTurnDeps {
  db: Db;
  cfg: Config;
  events: EventBus;
  feedQuestions: FeedQuestionsFn;
}

/** Same context preamble the opencode path builds — both engines speak it. */
export function buildPreamble(
  graphBuilding: boolean,
  lessonPath: string | null,
  summaryPath: string | null,
): string {
  const parts: string[] = [];
  if (graphBuilding) {
    parts.push('The knowledge graph is currently being rebuilt; treat graph data as read-only until it finishes.');
  }
  if (lessonPath) {
    parts.push(`The student is currently reading lesson ${lessonPath}; scope answers to it when relevant.`);
  }
  if (summaryPath) {
    parts.push(
      `Before answering, read ${summaryPath} — it summarizes your previous sessions with this student. Also re-read corrections.md.`,
    );
  }
  return parts.length ? `[Context] ${parts.join(' ')}` : '';
}

const NATIVE_TOOLS_SECTION = `## Native tools (this server runs you natively)

You are not running inside opencode here: there is no shell, no bash and no file-edit tool. Use exactly these tools (OpenAI function calling). Reasoning traces and tool plumbing are invisible to the student — never mention tools, JSON or internal steps in your visible reply text.

- write_lesson { "path", "html" } — write/overwrite a lesson file. path MUST match lessons/NNNN-slug.html (4-digit number, slug, .html). All lesson rules above apply unchanged (first-line marker, template, MathJax when math is present).
- generate_lesson { "path", "topic" } — delegate writing a full lesson to the lesson writer (slow, highest quality); use it instead of authoring big HTML yourself; give it a precise topic and evidence-worthy scope.
- read_material { "path" } — read a file under the course root. Allowed: material/**, graphify-out/**, syllabus.md, MISSION.md, corrections.md, NOTES.md.
- search_material { "query" } — PRIMARY evidence tool: hybrid semantic+keyword search over the whole course (extracted PDF knowledge included). Use it FIRST for topical questions; fall back to read_material for full files and grep_material only for exact strings (codes, identifiers).
- grep_material { "query" } — literal case-insensitive search over material/ and graphify-out/wiki/; returns file:line hits (max ${GREP_MAX_HITS}).
- graphify_query { "query" } — one knowledge-graph query (BFS over graph.json). Skip while the server says the graph is rebuilding.
- save_quiz { "spec" } — deposit a quiz directly; spec is the same JSON as a \`\`\`studi0-quiz\`\`\` block (topic + questions[]). Prefer this over the fenced block.
- update_corrections { "entry" } — append one correction bullet to corrections.md.

Quizzes appended as \`\`\`studi0-quiz\`\`\` text blocks still work. Reply text remains the student-facing channel: after any tool rounds, write the final answer as normal text.`;

const NATIVE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_lesson',
      description: 'Write or overwrite a lesson file under lessons/.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'lessons/NNNN-slug.html — 4-digit number, slug, .html' },
          html: { type: 'string', description: 'the complete self-contained HTML page' },
        },
        required: ['path', 'html'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_lesson',
      description:
        'Delegate writing a complete lesson to the lesson writer model (slow, highest quality). Use instead of authoring big HTML yourself.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'lessons/NNNN-slug.html — 4-digit number, slug, .html' },
          topic: { type: 'string', description: 'precise topic and evidence-worthy scope of the lesson' },
        },
        required: ['path', 'topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_material',
      description:
        'Read a course file (material/**, graphify-out/**, syllabus.md, MISSION.md, corrections.md, NOTES.md).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_material',
      description:
        'Hybrid semantic+keyword search over the whole course (material, wiki, lessons, extracted graph knowledge). Primary evidence tool.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_material',
      description: 'Literal case-insensitive search over material/ and graphify-out/wiki/; returns file:line hits.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graphify_query',
      description: 'One knowledge-graph query (BFS traversal of graphify-out/graph.json).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_quiz',
      description: 'Deposit a practice quiz into the question bank.',
      parameters: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description:
              'Quiz spec: { topic, questions: [{ topic, type: "mcq"|"short"|"code", prompt, options?, key, rubric? }] }',
          },
        },
        required: ['spec'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_corrections',
      description: 'Append one correction bullet to corrections.md.',
      parameters: {
        type: 'object',
        properties: { entry: { type: 'string' } },
        required: ['entry'],
      },
    },
  },
] as const;

const LESSON_PATH_RE = /^lessons\/\d{4}-.+\.html$/;
const READ_ALLOW_RE = /^(?:material|graphify-out)\/.+/;
const READ_ALLOW_FILES = new Set(['syllabus.md', 'MISSION.md', 'corrections.md', 'NOTES.md']);
const GREP_EXT = new Set(['.md', '.txt', '.html', '.json', '.csv', '.tex']);

const AGENT_FILE = path.resolve(import.meta.dirname, '..', '..', 'agents', 'studi0-teacher.md');

// compiled system prompt cached per process — the agent file only changes on server restart
let cachedSystem: string | null = null;

function systemPrompt(): string {
  if (cachedSystem) return cachedSystem;
  const raw = readFileSync(AGENT_FILE, 'utf8');
  // strip the opencode YAML frontmatter (permissions do not apply to the native loop)
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimEnd();
  cachedSystem = `${body}\n\n${NATIVE_TOOLS_SECTION}`;
  return cachedSystem;
}

type ToolResult = { ok: boolean } & Record<string, unknown>;

/**
 * The server-native chat turn: persist the user message, then loop
 * LLM call → tool execution (≤8 rounds) over the local chat_messages transcript.
 * Returns the final assistant text (all rounds joined) for the caller's quiz scan.
 */
export async function runNativeTurn(
  deps: NativeTurnDeps,
  subject: SubjectRow,
  session: ChatSessionRow,
  content: string,
  preamble: string,
  lesson: LessonRow | null,
  before: Map<string, string>,
  send: Send,
): Promise<string> {
  const { db, cfg } = deps;
  chatRepo.insertMessage(db, session.id, 'user', preamble ? `${preamble}\n\n${content}` : content);

  // history already ends with the just-persisted user message (preamble included).
  // cap the window, then start at its first user message: an orphan assistant/tool
  // head is rejected by OpenAI-compatible servers.
  const recent = chatRepo.listMessages(db, session.id).slice(-HISTORY_MAX_MESSAGES);
  const firstUser = recent.findIndex((m) => m.role === 'user');
  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt() },
    ...recent.slice(Math.max(0, firstUser)).map((m) => ({ role: m.role, content: m.text })),
  ];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURN_TIMEOUT_MS);
  timer.unref();
  const texts: string[] = [];
  try {
    // cap: if the model still wants tools after 8 rounds the turn ends with the
    // text accumulated so far (last tool results are delivered but never answered)
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let text = '';
      let calls: ToolCallAccum[] = [];
      for await (const delta of streamCompletion(
        cfg,
        { model: cfg.chatModel, messages, tools: [...NATIVE_TOOLS] },
        ac.signal,
      )) {
        if (delta.content) {
          text += delta.content;
          send('token', { text: delta.content });
        }
        if (delta.toolCalls) calls = delta.toolCalls; // full accumulated state — replace
      }
      texts.push(text);
      if (calls.length === 0) break;
      messages.push({
        role: 'assistant',
        content: text,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });
      for (const call of calls) {
        let result: ToolResult;
        try {
          result = await executeTool(deps, subject, lesson, before, send, call, ac.signal);
        } catch (e) {
          result = { ok: false, error: e instanceof HttpError ? e.message : String(e) };
        }
        send('tool', { name: call.name, ok: result.ok });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, TOOL_RESULT_CAP),
        });
      }
    }
  } catch (e) {
    if (ac.signal.aborted) throw new HttpError('INTERNAL', 'teacher turn timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }

  // reasoning and tool plumbing never reach persistence: only streamed content
  const finalText = texts.filter(Boolean).join('\n\n');
  if (finalText) chatRepo.insertMessage(db, session.id, 'assistant', finalText);
  return finalText;
}

async function executeTool(
  deps: NativeTurnDeps,
  subject: SubjectRow,
  lesson: LessonRow | null,
  before: Map<string, string>,
  send: Send,
  call: ToolCallAccum,
  signal: AbortSignal,
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
  } catch {
    // gateway truncation edge: arguments can arrive as "{}" or half-cut JSON
    return { ok: false, error: 'tool arguments were truncated or not valid JSON' };
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'tool arguments must be a JSON object' };
  }
  switch (call.name) {
    case 'write_lesson':
      return writeLesson(deps, subject, before, send, args);
    case 'generate_lesson':
      return generateLesson(deps, subject, before, send, signal, args);
    case 'read_material':
      return readMaterial(subject, args);
    case 'search_material':
      return searchMaterial(deps, subject, args);
    case 'grep_material':
      return grepMaterial(subject, args);
    case 'graphify_query':
      return graphifyQuery(subject, args);
    case 'save_quiz':
      return saveQuiz(deps, subject, lesson, send, args);
    case 'update_corrections':
      return updateCorrections(subject, args);
    default:
      return { ok: false, error: `unknown tool: ${call.name}` };
  }
}

/** Both lesson-writing tools share this path rule (traversal rejected before any write). */
function assertLessonPath(rel: string, tool: string): void {
  if (!LESSON_PATH_RE.test(rel)) {
    throw new HttpError('VALIDATION', `${tool} path must match lessons/NNNN-slug.html, got: ${rel}`);
  }
}

async function writeLesson(
  deps: NativeTurnDeps,
  subject: SubjectRow,
  before: Map<string, string>,
  send: Send,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const rel = typeof args.path === 'string' ? args.path : '';
  const html = typeof args.html === 'string' ? args.html : '';
  assertLessonPath(rel, 'write_lesson');
  return writeLessonFile(deps, subject, before, send, rel, html);
}

/** Shared tail: write the file, then index + emit + feed questions immediately. */
async function writeLessonFile(
  deps: NativeTurnDeps,
  subject: SubjectRow,
  before: Map<string, string>,
  send: Send,
  rel: string,
  html: string,
): Promise<ToolResult> {
  await safeWriteFile(safeResolve(subject.path, rel), html);
  // index + emit immediately; the end-of-turn safety net skips these (before is synced)
  const rows = await detectAndIndexLessons(deps.db, subject, before, deps.events);
  for (const row of rows) {
    send('lesson', lessonsRepo.lessonToDto(row));
    deps.feedQuestions(subject, row);
  }
  return { ok: true, path: rel };
}

const LESSON_WRITER_SYSTEM =
  'You are the lesson writer. Output ONLY a complete self-contained HTML lesson document starting with <!DOCTYPE html> and ending with </html>. No markdown fences, no commentary.';

/**
 * Delegate lesson authoring to the stronger quality-first model as plain content
 * (tool-call arguments truncate big HTML on our gateways), then save it here.
 */
async function generateLesson(
  deps: NativeTurnDeps,
  subject: SubjectRow,
  before: Map<string, string>,
  send: Send,
  signal: AbortSignal,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const rel = typeof args.path === 'string' ? args.path : '';
  const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
  assertLessonPath(rel, 'generate_lesson');
  if (!topic) return { ok: false, error: 'topic is required' };

  const { db, cfg } = deps;
  await ensureIndex(db, subject, { log: (m) => console.log(`[generate_lesson] ${m}`) });
  let evidence = '';
  try {
    const hits = await hybridSearch(db, subject.id, topic, { k: 10, subjectPath: subject.path });
    if (hits.length === 0) console.log('[generate_lesson] no material hits — writing from general knowledge');
    evidence = hits
      .map((h) => `- [${h.relPath} — ${h.title}]\n  ${h.snippet}`)
      .join('\n')
      .slice(0, LESSON_EVIDENCE_MAX_CHARS);
  } catch (e) {
    console.log(`[generate_lesson] material search failed: ${String(e)}`);
  }
  const mission = (await readFile(safeResolve(subject.path, 'MISSION.md'), 'utf8').catch(() => '')).slice(
    0,
    LESSON_MISSION_MAX_CHARS,
  );

  const prompt = `Course: ${subject.name}
Topic: ${topic}

Write the lesson. Rules:
- Open with a pretest: two guess-first questions before any explanation.
- Teach a worked example before practice.
- End with a teach-back checkpoint.
- Use MathJax only if the lesson contains math.
- Cite sources inline where the material evidence below supports a claim.
${mission ? `\nStudent mission (pace, style, level):\n${mission}\n` : ''}
Material evidence:
${evidence || '(none found — teach from general knowledge)'}`;

  const writerCfg: Config = { ...cfg, chatModel: cfg.chatModelLesson, chatDisableThinking: false };
  const res = (await chatCompletion(
    writerCfg,
    {
      model: cfg.chatModelLesson,
      messages: [
        { role: 'system', content: LESSON_WRITER_SYSTEM },
        { role: 'user', content: prompt },
      ],
      max_tokens: 16000,
      chat_template_kwargs: cfg.chatLessonTemplateKwargs,
    },
    AbortSignal.any([signal, AbortSignal.timeout(LESSON_WRITER_TIMEOUT_MS)]),
  )) as { choices?: { message?: { content?: string } }[] };

  const html = (res.choices?.[0]?.message?.content ?? '')
    .trim()
    .replace(/^```html\s*/i, '')
    .replace(/```$/, '')
    .trim();
  if (!/<!doctype html>/i.test(html) || !/<\/html>/i.test(html)) {
    return { ok: false, error: 'lesson HTML incomplete — retry with a narrower topic' };
  }
  return writeLessonFile(deps, subject, before, send, rel, html);
}

async function readMaterial(subject: SubjectRow, args: Record<string, unknown>): Promise<ToolResult> {
  const rel = typeof args.path === 'string' ? args.path.replaceAll('\\', '/').replace(/^\.\//, '') : '';
  const abs = safeResolve(subject.path, rel); // traversal → PATH_TRAVERSAL
  if (!READ_ALLOW_RE.test(rel) && !READ_ALLOW_FILES.has(rel)) {
    throw new HttpError('PATH_TRAVERSAL', `read_material path not allowed: ${rel}`);
  }
  const st = await stat(abs).catch(() => null);
  if (!st?.isFile()) return { ok: false, error: `not a file: ${rel}` };
  if (st.size > READ_MAX_BYTES) {
    return { ok: false, error: 'file too large for read_material — use grep_material' };
  }
  let content = await readFile(abs, 'utf8');
  if (content.length > READ_MAX_CHARS) content = `${content.slice(0, READ_MAX_CHARS)}\n[truncated]`;
  return { ok: true, path: rel, content };
}

/** Hybrid semantic+keyword retrieval over the whole course — the primary evidence tool. */
async function searchMaterial(
  deps: NativeTurnDeps,
  subject: SubjectRow,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { ok: false, error: 'query is required' };
  // index build (first run on a subject) can take ~14s cold; still far cheaper
  // than grep thrash across every turn
  await ensureIndex(deps.db, subject, { log: (m) => console.log(`[search_material] ${m}`) });
  const hits = await hybridSearch(deps.db, subject.id, query, { k: 8, subjectPath: subject.path });
  return {
    ok: true,
    hits: hits.map((h) => ({ file: h.relPath, section: h.title, snippet: h.snippet })),
  };
}

async function grepMaterial(subject: SubjectRow, args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { ok: false, error: 'query is required' };
  const needle = query.toLowerCase();
  const hits: string[] = [];
  outer: for (const dir of ['material', 'graphify-out/wiki']) {
    const root = safeResolve(subject.path, dir);
    let entries: string[] = [];
    try {
      entries = await readdir(root, { recursive: true });
    } catch {
      continue; // dir missing (e.g. no wiki yet)
    }
    for (const entry of entries) {
      if (hits.length >= GREP_MAX_HITS) break outer;
      if (!GREP_EXT.has(path.extname(entry))) continue;
      const abs = path.join(root, entry);
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile() || st.size > READ_MAX_BYTES) continue;
      const text = await readFile(abs, 'utf8').catch(() => '');
      if (!text || text.includes('\0')) continue; // binary
      const relDisplay = `${dir}/${entry.replaceAll('\\', '/')}`;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < GREP_MAX_HITS; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push(`${relDisplay}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
  }
  return { ok: true, hits };
}

async function graphifyQuery(subject: SubjectRow, args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { ok: false, error: 'query is required' };
  try {
    const { stdout } = await execFileP('graphify', ['query', query], {
      cwd: subject.path,
      timeout: GRAPHIFY_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, output: stdout.slice(0, TOOL_RESULT_CAP) };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string };
    // exit 3 = ambiguous name (candidates listed), 4 = no match — output is still useful
    if (typeof err.stdout === 'string' && err.stdout.trim()) {
      return { ok: true, output: err.stdout.slice(0, TOOL_RESULT_CAP) };
    }
    return {
      ok: false,
      error: err.code === 'ENOENT' ? 'graphify CLI not installed' : `graphify query failed (${String(err.code ?? 'error')})`,
    };
  }
}

async function saveQuiz(
  deps: NativeTurnDeps,
  subject: SubjectRow,
  lesson: LessonRow | null,
  send: Send,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = quizSpecSchema.safeParse(args.spec);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'invalid quiz spec',
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const questions = depositQuiz(deps.db, subject.id, parsed.data, lesson?.id ?? null);
  send('quiz', { questions });
  deps.events.emit(subject.id, 'questions', { subjectId: subject.id, questions });
  return { ok: true, deposited: questions.length };
}

async function updateCorrections(subject: SubjectRow, args: Record<string, unknown>): Promise<ToolResult> {
  const entry = typeof args.entry === 'string' ? args.entry.trim() : '';
  if (!entry) return { ok: false, error: 'entry is required' };
  const abs = safeResolve(subject.path, 'corrections.md');
  const prev = await readFile(abs, 'utf8').catch(() => '');
  const sep = prev && !prev.endsWith('\n') ? '\n' : '';
  await safeWriteFile(abs, `${prev}${sep}- ${entry}\n`);
  return { ok: true };
}
