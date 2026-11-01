# studi0 — API CONTRACT

Backend surface for `apps/server`. Frontend (`apps/web`) is the only client. All schemas are zod schemas in `packages/shared/src` (`api.ts`, `events.ts`, `quiz.ts`, `errors.ts`) — the TypeScript below is their inferred shape. No auth, no CORS (vite proxy, same-origin), 127.0.0.1 only.

## Conventions

- Base path: `/api`. Content type: `application/json` (except SSE + raw graph files).
- IDs are UUID strings; timestamps are ISO-8601 strings.
- List endpoints return bare JSON arrays; single resources return bare objects.
- **Errors** (all non-2xx + SSE `error` events):
  ```ts
  interface ApiError { error: { code: ErrorCode; message: string; details?: unknown } }
  ```
- **SSE framing**: `text/event-stream`; each event is `event: <name>\ndata: <json>\n\n`; heartbeat comment `: ping` every 15s; a stream always ends with exactly one terminal event (`done` | `error` for chat, none needed for the subject stream which stays open until the client closes).
- **Origin guard**: mutating requests (POST/PUT/PATCH/DELETE) that carry an `Origin` or `Sec-Fetch-Site` header are rejected `403` unless `Origin: http://127.0.0.1:5173` or `Sec-Fetch-Site: same-origin|none` (drive-by/CSRF guard; header-absent clients like curl are unaffected).
- Never-streamed errors (headers not yet sent) are plain JSON errors with the status codes from the table at the bottom.

## Common types

```ts
type ID = string;   // uuid
type ISO = string;  // ISO-8601

type ErrorCode =
  | "VALIDATION" | "SUBJECT_NOT_FOUND" | "NAME_TAKEN" | "PATH_NOT_FOUND"
  | "FILE_NOT_FOUND" | "UNSUPPORTED_FILE_TYPE" | "PATH_TRAVERSAL"
  | "JOB_NOT_FOUND" | "JOB_CONFLICT" | "JOB_NOT_CANCELLABLE"
  | "SESSION_NOT_FOUND" | "SESSION_GONE" | "TURN_IN_PROGRESS" | "OPENCODE_DOWN"
  | "QUESTION_NOT_FOUND" | "KEY_NOT_VERIFIED" | "INTERNAL";

interface Subject {
  id: ID; name: string; path: string;      // path = absolute subject root (reference-in-place)
  createdAt: ISO; lastBuiltAt: ISO | null;
  stale: boolean;                           // computed: any material/** mtime > lastBuiltAt
}
interface SubjectDetail extends Subject {
  graphStatus: "none" | "ready" | "stale" | "building";  // derived
  activeJob: Job | null;
  counts: { lessons: number; questions: number; due: number };
}

interface FileEntry { path: string; dir: string; name: string; ext: string; bytes: number; mtime: ISO }
// path is relative to the subject root, e.g. "material/week3/heaps.pdf"

type JobKind = "build" | "update" | "recluster";
type JobStatus = "queued" | "running" | "cancelling" | "complete" | "partial" | "failed" | "cancelled";
interface Job {
  id: ID; subjectId: ID; kind: JobKind; status: JobStatus;
  progress: { done: number; total: number; currentFile: string | null };
  partial: { file: string; reason: string }[] | null;    // honest partial-failure report
  error: string | null;
  createdAt: ISO; startedAt: ISO | null; finishedAt: ISO | null;
}

interface Lesson { id: ID; subjectId: ID; path: string; title: string; nodeTags: ID[]; createdAt: ISO; updatedAt: ISO }
interface LessonContent { path: string; title: string; html: string; nodeTags: ID[]; updatedAt: ISO }

interface ChatSession {
  id: ID; subjectId: ID; lessonId: ID | null; active: boolean;
  messageCount: number; summaryPath: string | null;        // learning-records file if rotated
  createdAt: ISO; lastMessageAt: ISO | null;
}
interface ChatMessage { id: ID; role: "user" | "assistant"; text: string; createdAt: ISO }

type QuestionType = "mcq" | "short" | "code";
type KeyStatus = "unverified" | "verified" | "failed";
interface QuestionPayload { prompt: string; options?: { id: string; text: string }[]; rubric?: string }
interface Question {                       // key NEVER included here — only via reveal-key
  id: ID; subjectId: ID; lessonId: ID | null; topic: string;
  type: QuestionType; payload: QuestionPayload;
  keyStatus: KeyStatus; source: "auto" | "on_demand"; createdAt: ISO;
}
interface QuestionKey { answerIndex?: number; answer?: string; rubric?: string }
interface Grade { verdict: "correct" | "partial" | "incorrect"; feedback: string }
interface Stats {
  perTopic: { topic: string; attempts: number; correct: number; accuracy: number }[];
  dueCount: number; streakDays: number; totalQuestions: number;
}
```

Citation markers (`【file.pdf · p12】`) are **inline in `ChatMessage.text`** — the frontend parses them with a shared regex for display; the server does not structure them.

---

## Endpoints

### Health

`GET /api/health`
→ `200 { ok: true; opencode: { running: boolean; pid: ID | null; port: number; healthy: boolean } }`

### Subjects

`GET /api/subjects`
→ `200 Subject[]`

`POST /api/subjects` — create empty subject under `data/subjects/<name>`, **or register an existing folder in place** (same endpoint; `path` presence is the switch). Ensures missing layout pieces, syncs the teacher agent file.
`{ name: string; path?: string }`
→ `201 SubjectDetail` · `400 VALIDATION | PATH_NOT_FOUND` · `409 NAME_TAKEN`
No files are copied or moved (AC1).

`GET /api/subjects/:id`
→ `200 SubjectDetail` · `404 SUBJECT_NOT_FOUND`

`PATCH /api/subjects/:id` — rename display name only (folder untouched).
`{ name: string }`
→ `200 Subject` · `404 SUBJECT_NOT_FOUND` · `409 NAME_TAKEN`

`DELETE /api/subjects/:id` — **unregister only; never touches disk.**
→ `204` · `404 SUBJECT_NOT_FOUND`

### Files (browser + batch upload)

`GET /api/subjects/:id/tree?dir=<rel>` — `dir` must be `material` | `lessons` | `reference` | `graphify-out` (allowlisted roots; omit for the root listing of those four).
→ `200 { dir: string; entries: FileEntry[] }` · `404 SUBJECT_NOT_FOUND | FILE_NOT_FOUND` · `400 PATH_TRAVERSAL`

`POST /api/subjects/:id/files` — multipart, field `files` (repeatable), cap 200 MB/file, extensions `.pdf`/`.md` only. Per-file accept/reject; accepted files stream into `material/` (name sanitized, collisions suffixed `-1`, `-2`, …).
→ `200 { accepted: FileEntry[]; rejected: { name: string; reason: string }[] }` · `404 SUBJECT_NOT_FOUND` · `415 UNSUPPORTED_FILE_TYPE` envelope with `details.rejected` (only when nothing at all was acceptable)

`POST /api/subjects/:id/split-pdf` — **PDF-split assistant**: splits a big material PDF into parts next to the original (python + `pypdf`, `apps/server/scripts/split_pdf.py`). `{ file: string }` is a path relative to the subject root and **must resolve inside `material/`** (traversal is a hard gate). Heuristic: parts of ~10–20 MB — `ceil(fileBytes / 15 MB)` parts, pages distributed evenly (target tunable via `STUDI0_SPLIT_TARGET_BYTES`); files at or below the target are returned unsplit as `[file]`. Parts are named `<stem>_pNN.pdf`; the original is never written; new parts are synced into the files table like uploads and are picked up by the next build.
→ `200 { parts: string[] }` (paths relative to the subject root) · `404 SUBJECT_NOT_FOUND | FILE_NOT_FOUND` · `400 PATH_TRAVERSAL` · `415 UNSUPPORTED_FILE_TYPE` (not a `.pdf`) · `500 INTERNAL` (python/pypdf failure)

### Jobs (graph pipeline)

`POST /api/subjects/:id/jobs`
`{ kind: JobKind }`
→ `202 Job` (status `queued`) · `404 SUBJECT_NOT_FOUND` · `409 JOB_CONFLICT` (subject already has an active job)

`GET /api/jobs?subjectId=<id>&active=<true>`
→ `200 Job[]`

`GET /api/jobs/:id`
→ `200 Job` · `404 JOB_NOT_FOUND`

`POST /api/jobs/:id/cancel` — requests cancel; the job must reach a terminal state within 5s (AC4). Response is the job with status `cancelling`; final state arrives via SSE/GET.
→ `200 Job` · `404 JOB_NOT_FOUND` · `409 JOB_NOT_CANCELLABLE` (already terminal)

`GET /api/subjects/:id/events` — **SSE, subject-scoped** (job progress, lesson index changes, question bank changes):
- `event: job` → `Job` (full snapshot on every transition)
- `event: log` → `{ line: string; at: ISO }` (one pipeline build-log line, same text as written to `graphify-out/build.log`; `at` is the server timestamp)
- `event: lesson` → `Lesson` (written during chat / auto-indexed)
- `event: questions` → `{ subjectId: ID; questions: Question[] }` (auto-deposit / quiz block landed)
- heartbeat comments only otherwise

### Graph / report / wiki / corrections

`GET /api/subjects/:id/graph`
→ `200 { graphStatus: "none"|"ready"|"stale"|"building"; stale: boolean; lastBuiltAt: ISO | null; hasGraph: boolean; hasReport: boolean; hasVerifyReport: boolean }`

`GET /api/subjects/:id/graph/report`
→ `200 { graphReport: string | null; verifyReport: string | null }` (contents of GRAPH_REPORT.md / VERIFY_REPORT.md)

`GET /api/subjects/:id/graph/raw/{*path}` — raw file passthrough confined to `graphify-out/` (serves `graph.html` + its assets to the iframe). Scriptable responses (`text/html`, `text/javascript`, `image/svg+xml`) carry `content-security-policy: sandbox allow-scripts` — the document runs in an opaque origin (direct opens / cross-site embeds cannot script the API origin) while the app's sandboxed iframe renders it.
→ `200 <raw file, content-type by extension>` · `404 FILE_NOT_FOUND` · `400 PATH_TRAVERSAL`

`GET /api/subjects/:id/graph/log` — tail (last 300 lines) of the pipeline build log (`graphify-out/build.log`), written by the runner with relative timestamps for every protocol/raw output line.
→ `200 { log: string | null }`

`POST /api/subjects/:id/setup` — course setup form answers, written verbatim into the delimited `## Student setup (from form)` block of `MISSION.md` (idempotent: retakes replace the block, teacher-written content is preserved; blank fields omitted; all fields optional).
→ `200 { ok: true }` · `400 VALIDATION`

`POST /api/shutdown` — clean shutdown: drains running jobs, stops the managed opencode server, closes the DB, exits. The response is sent before the process exits.
→ `200 { ok: true }`

`GET /api/subjects/:id/wiki` — list pages (graphify-generated, in `graphify-out/wiki/`).
→ `200 { pages: { name: string; updatedAt: ISO }[] }`

`GET /api/subjects/:id/wiki/:page`
→ `200 { name: string; markdown: string; updatedAt: ISO }` · `404 FILE_NOT_FOUND`

`PUT /api/subjects/:id/wiki/:page` — edit existing page only (user edits are canon; no page creation — free-form knowledge goes in `corrections.md`).
`{ markdown: string }`
→ `200 { name: string; updatedAt: ISO }` · `404 FILE_NOT_FOUND`

`GET /api/subjects/:id/corrections`
→ `200 { markdown: string }` (empty string if the file doesn't exist yet)

`PUT /api/subjects/:id/corrections` — creates the file if missing.
`{ markdown: string }`
→ `200 { markdown: string }`

### Lessons

`GET /api/subjects/:id/lessons` — ordered by the pacing spine (syllabus.md position, then filename prefix).
→ `200 Lesson[]`

`GET /api/subjects/:id/lessons/content?path=lessons/0007-dijkstra.html` — hot-reload: poll this while the viewer is open; skip re-render while `updatedAt` is unchanged.
→ `200 LessonContent` · `404 FILE_NOT_FOUND` · `400 PATH_TRAVERSAL`

### Chat

`GET /api/subjects/:id/chat/sessions`
→ `200 ChatSession[]` (newest first)

`POST /api/subjects/:id/chat/sessions` — creates the opencode session eagerly (cwd = subject root, agent `studi0-teacher`), so opencode-down fails here, not mid-message. `lessonId` scopes the session to a lesson (AC12).
`{ lessonId?: ID }`
→ `201 ChatSession` · `404 SUBJECT_NOT_FOUND | FILE_NOT_FOUND` · `503 OPENCODE_DOWN`

`GET /api/chat/sessions/:id/messages` — history (proxied from the opencode server, which owns message storage).
→ `200 ChatMessage[]` · `404 SESSION_NOT_FOUND` · `410 SESSION_GONE` (opencode lost it — client should start a new session)

`POST /api/chat/sessions/:id/messages` — **SSE response stream.** `lessonId` here is a per-turn context override (wins over the session's scope).
`{ content: string; lessonId?: ID }`

Stream events:
- `event: token` → `{ text: string }` (answer deltas, citations inline)
- `event: lesson` → `Lesson` (teacher wrote/updated a lesson this turn)
- `event: quiz` → `{ questions: Question[] }` (parsed ```studi0-quiz``` block joined the bank)
- `event: rotated` → `{ newSessionId: ID; summaryPath: string }` (session auto-rotated; this stream continues in the new session transparently)
- `event: done` → `{ messageCount: number }` (terminal)
- `event: error` → `ApiError` (terminal)

Pre-stream JSON errors (before any SSE byte): `400 VALIDATION` · `404 SESSION_NOT_FOUND` · `409 TURN_IN_PROGRESS` (a turn is already running on this session — second tab) · `410 SESSION_GONE` · `503 OPENCODE_DOWN`.

### Practice

`GET /api/subjects/:id/questions?topic=<t>&type=<mcq|short|code>` — bank listing; keys always omitted.
→ `200 Question[]`

`POST /api/subjects/:id/questions/generate` — on-demand generation (synchronous; may take ~1 min — UI shows a spinner). Returns `unverified` keys; verification runs right after and completes asynchronously (a `questions` SSE event fires when done).
`{ topic: string; count?: number /* default 5, cap 10 */; lessonId?: ID }`
→ `201 Question[]` · `404 SUBJECT_NOT_FOUND` · `503 OPENCODE_DOWN`

`POST /api/questions/:id/answer` — grades and advances the 1/3/7 ladder (correct → next step, wrong → 1d).
`{ answer: string }`
→ `200 { attemptId: ID; grade: Grade; nextDueAt: ISO; intervalDays: number }` · `404 QUESTION_NOT_FOUND` · `503 OPENCODE_DOWN` (short/code grading needs opencode; MCQ grades offline)

`POST /api/questions/:id/verify-key` — (re-)run the key verification pass.
→ `200 { keyStatus: "verified" | "failed"; reason?: string }` · `404 QUESTION_NOT_FOUND` · `503 OPENCODE_DOWN`

`POST /api/questions/:id/reveal-key` — **the gate**: only a verified key is revealed (AC19).
→ `200 { key: QuestionKey }` · `404 QUESTION_NOT_FOUND` · `409 KEY_NOT_VERIFIED { details: { keyStatus: KeyStatus } }`

`GET /api/subjects/:id/practice/due` — due-today queue (new questions are due immediately; no background scheduler).
→ `200 { date: ISO; questions: Question[] }`

`GET /api/subjects/:id/practice/stats`
→ `200 Stats`

---

## Error code → HTTP status

| Code | Status |
|---|---|
| VALIDATION, PATH_NOT_FOUND, PATH_TRAVERSAL | 400 |
| SUBJECT_NOT_FOUND, FILE_NOT_FOUND, JOB_NOT_FOUND, SESSION_NOT_FOUND, QUESTION_NOT_FOUND | 404 |
| NAME_TAKEN, JOB_CONFLICT, JOB_NOT_CANCELLABLE, KEY_NOT_VERIFIED, TURN_IN_PROGRESS | 409 |
| SESSION_GONE | 410 |
| UNSUPPORTED_FILE_TYPE | 415 |
| OPENCODE_DOWN | 503 |
| INTERNAL | 500 |
