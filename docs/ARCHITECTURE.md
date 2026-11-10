# studi0 — ARCHITECTURE

**Inputs:** `docs/PLAN.md` (settled decisions), `docs/PRD.md` (26 stories / 23 ACs), `docs/TASKS.md` (this is T-ARCH).
This document is the build contract for T01–T11. The full REST/SSE surface lives in `docs/API_CONTRACT.md`.
PROJECT_TYPE = fullstack (localhost). No auth, 127.0.0.1 only, single user.

## Overview

studi0 is a chat-first learning platform: a Fastify/SQLite backend owns subject folders on disk, runs the graphify pipeline through headless `opencode run`, and talks to a persistent opencode "teacher" over the SDK; a React/Vite frontend provides chat, lesson viewer, graph view, file browser, and practice.

## Tech stack (pinned)

| Layer | Choice | Note |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite (exact majors/minors pinned by T01 at scaffold time) | No router, no state library (see State). |
| Backend | Node 24 + TypeScript + **Fastify 5** | Fastify: mature TS + zod type-provider, battle-tested multipart for batch PDF uploads, and SSE via `reply.raw`; Hono's edge-first design buys nothing on a localhost Node box. |
| Metadata DB | SQLite via **`node:sqlite`** (`DatabaseSync`) | Ships with the pinned Node 24 — zero native compiles on Windows; synchronous access is fine for one user. Escape hatch: `better-sqlite3` only if a needed feature is missing. |
| Packages | **pnpm 12.15** workspace: `apps/web`, `apps/server`, `packages/shared` | `packageManager: pnpm@12.15.0` in root package.json. Never npm/yarn/npx. |
| Graph pipeline | **graphifyy 0.9.95** (Python 3.14.5) via headless **opencode 2.2.1** `opencode run` | Pinned per PLAN. |
| Chat runtime | opencode 2.2.1 `opencode serve` + `@opencode-ai/sdk` (SDK version matching 2.2.1) | Backend owns the server process. |
| Validation | **zod** — single source of truth in `packages/shared` | Every trust boundary (HTTP body/query/param, pipeline stdout parsing, quiz blocks). |
| Tests | vitest (server integration via `fastify.inject`, web unit tests co-located) | e2e smoke is T12/QA territory (agent-browser), not scaffolded here. |

Dev topology: web `127.0.0.1:5173` (vite, proxies `/api` → server), server `127.0.0.1:3001`, opencode server `127.0.0.1:44096` (backend-managed, localhost-bound).

## Directory tree

```
studi0/
├─ package.json                  # root scripts: dev / build / test / typecheck / lint (pnpm -r)
├─ pnpm-workspace.yaml           # apps/*, packages/*
├─ tsconfig.base.json
├─ eslint.config.js
├─ docs/                         # PLAN, PRD, TASKS, ARCHITECTURE, API_CONTRACT, BUILD (T15)
├─ data/                         # gitignored: studi0.db + subjects created here by default
├─ packages/
│  └─ shared/                    # zod schemas + inferred API/SSE types, shared by both apps
│     └─ src/
│        ├─ index.ts
│        ├─ api.ts               # endpoint req/res schemas
│        ├─ events.ts            # SSE event payload schemas (subject + chat streams)
│        ├─ quiz.ts              # QuizSpec schema (```studi0-quiz``` blocks + oneshot output)
│        └─ errors.ts            # ErrorCode union + ApiError schema
└─ apps/
   ├─ web/                       # React + TS + Vite
   │  ├─ package.json / tsconfig.json / vite.config.ts / index.html
   │  └─ src/
   │     ├─ main.tsx
   │     ├─ App.tsx              # shell: subjects sidebar + {subjectId, tab, lessonPath} state (no router)
   │     ├─ api/
   │     │  ├─ client.ts         # typed fetch wrapper, unwraps ApiError
   │     │  ├─ sse.ts            # EventSource helper (GET) + fetch-stream SSE reader (POST, for chat)
   │     │  └─ hooks.ts          # useSubjects / useSubject / useJobs / useLessons / useDue / useStats
   │     ├─ state/app.tsx        # AppContext: current subject, tab, open lesson
   │     ├─ components/          # Badge, ProgressBar, ErrorBanner, EmptyState, ContextMenu(portal, keyboard)
   │     ├─ subjects/            # Sidebar(groups + menus), SubjectPage(tabs), AddSubjectDialog, FileBrowser(file menus), UploadZone
   │     ├─ graph/               # GraphView(iframe), JobPanel(progress/cancel/partial/stale), WikiEditor, ReportView
   │     ├─ lesson/              # LessonViewer(hot-reload), LessonsList, LessonChatPanel, Citation text renderer
   │     ├─ chat/                # ChatPanel(streaming log), SessionList, Composer
   │     ├─ practice/            # PracticePage, DueQueue, QuizRunner(mcq/text/code), KeyGate, StatsCards
   │     └─ styles.css
   └─ server/
      ├─ package.json / tsconfig.json / vitest.config.ts
      ├─ agents/
      │  └─ studi0-teacher.md    # canonical teacher agent file (see Teacher agent below)
      ├─ tests/                  # integration tests (fastify.inject + temp subject dirs)
      └─ src/
         ├─ index.ts             # bootstrap: fastify app, static web/dist in prod
         ├─ config.ts            # ports, DATA_DIR, MAX_CONCURRENT_JOBS=2, ROTATE_THRESHOLD, LADDER=[1,3,7], ALLOWED_EXT, limits
         ├─ http/
         │  ├─ app.ts            # plugins, zod type-provider, error handler, /api router
         │  ├─ routes/           # subjects.ts files.ts jobs.ts graph.ts lessons.ts chat.ts practice.ts health.ts
         │  └─ sse.ts            # reply-sse helper + per-subject event bus
         ├─ db/
         │  ├─ index.ts          # node:sqlite open + migration runner (PRAGMA user_version)
         │  ├─ migrations/       # 0001_init.sql, ...
         │  └─ repos/            # subjects.ts files.ts jobs.ts lessons.ts chat.ts questions.ts attempts.ts schedule.ts
         ├─ fs/
         │  ├─ paths.ts          # subject-root resolution + traversal guard — THE choke point for all disk paths
         │  ├─ layout.ts         # ensure/inspect teach-workspace layout, wiki dir, corrections.md, syllabus.md
         │  └─ safeWrite.ts      # write-temp-then-rename (OneDrive/AV lock safety)
         ├─ subjects/
         │  ├─ service.ts        # CRUD + register-by-path + staleness computation
         │  └─ files.ts          # tree listing (allowlisted roots) + batch upload intake
         ├─ pipeline/
         │  ├─ queue.ts          # 1 job/subject, max 2 concurrent, cancel ≤5s, event emit
         │  ├─ runner.ts         # spawns headless `opencode run` (cwd=subject dir), streams stdout
         │  └─ parse.ts          # studi0-progress lines + partial-failure parsing
         ├─ graph/
         │  ├─ prompts.ts        # ontology extraction + verification prompt templates
         │  ├─ verify.ts         # verification run dispatch + VERIFY_REPORT.md write
         │  └─ wiki.ts           # wiki page + corrections.md read/write services
         ├─ teacher/
         │  ├─ opencode.ts       # server lifecycle manager (start/stop/health/zombie cleanup)
         │  ├─ sdk.ts            # SDK client factory (points at 127.0.0.1:44096)
         │  ├─ sessions.ts       # per-subject sessions, lesson context, rotation
         │  ├─ chatStream.ts     # SDK message stream → SSE pump (token/lesson/quiz/rotated/done/error)
         │  ├─ lessons.ts        # lesson-file detection during turns, node-tag parse, index upsert
         │  ├─ quizScan.ts       # scan assistant text for ```studi0-quiz``` blocks → bank
         │  └─ practiceFeed.ts   # auto-deposit after lesson writes (oneshot generation + key verify)
         ├─ practice/
         │  ├─ generate.ts       # oneshot question+key generation (on-demand + auto-deposit share this)
         │  ├─ verifyKey.ts      # second-pass key verification (gate for reveal)
         │  ├─ grade.ts          # MCQ exact-match; short/code LLM-graded vs key+rubric (oneshot)
         │  ├─ scheduler.ts      # 1/3/7 ladder
         │  └─ stats.ts          # per-topic accuracy, due count, streak (computed from attempts)
         └─ util/
            ├─ errors.ts         # HttpError
            ├─ oneshot.ts        # one-shot `opencode run` helper (pipeline verify, practice gen/verify/grade)
            └─ proc.ts           # spawn with arg arrays (shell:false), kill-tree (Windows), pid bookkeeping
```

## Data model

SQLite stores **metadata only** — all content (lessons, wiki, graph, corpus) stays as plain files on disk; SQLite indexes it. Never copy subject files into the DB.

### SQLite schema (migration `0001_init.sql`)

```sql
CREATE TABLE subjects (
  id            TEXT PRIMARY KEY,          -- uuid
  name          TEXT NOT NULL UNIQUE,      -- display name (renameable)
  path          TEXT NOT NULL UNIQUE,      -- absolute canonicalized subject root (reference-in-place or data/subjects/<name>)
  created_at    TEXT NOT NULL,             -- ISO
  last_built_at TEXT                       -- set when a build/update job completes (complete or partial)
);
CREATE TABLE files (                       -- mirror of material/ inventory (upload provenance + staleness fast path)
  id         TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  rel_path   TEXT NOT NULL,                -- relative to subject root, e.g. material/week3/heaps.pdf
  bytes      INTEGER NOT NULL,
  mtime      TEXT NOT NULL,
  origin     TEXT NOT NULL,                -- 'upload' | 'seed'
  UNIQUE (subject_id, rel_path)
);
CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,
  subject_id     TEXT NOT NULL REFERENCES subjects(id),
  kind           TEXT NOT NULL,            -- 'build' | 'update' | 'recluster' | 'rebuild'
  status         TEXT NOT NULL,            -- queued|running|cancelling|complete|partial|failed|cancelled
  progress_done  INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  current_file   TEXT,
  partial_json   TEXT,                     -- [{file, reason}] — honest partial-failure report
  error          TEXT,
  pid            TEXT,                     -- OS pid while running (cancel + boot-time zombie cleanup)
  created_at     TEXT NOT NULL,
  started_at     TEXT, finished_at TEXT
);
CREATE TABLE lessons (                     -- index over lessons/*.html written by the teacher
  id             TEXT PRIMARY KEY,
  subject_id     TEXT NOT NULL REFERENCES subjects(id),
  rel_path       TEXT NOT NULL,            -- lessons/0007-dijkstra.html
  title          TEXT NOT NULL,
  node_tags_json TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (subject_id, rel_path)
);
CREATE TABLE chat_sessions (               -- index over opencode sessions (opencode owns the messages)
  id            TEXT PRIMARY KEY,
  subject_id    TEXT NOT NULL REFERENCES subjects(id),
  lesson_id     TEXT REFERENCES lessons(id),   -- lesson-scoped session
  oc_session_id TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  msg_count     INTEGER NOT NULL DEFAULT 0,
  summary_path  TEXT,                      -- learning-records file this session was rotated into
  created_at    TEXT NOT NULL, rotated_at TEXT
);
CREATE TABLE questions (
  id           TEXT PRIMARY KEY,
  subject_id   TEXT NOT NULL REFERENCES subjects(id),
  lesson_id    TEXT REFERENCES lessons(id),
  topic        TEXT NOT NULL,
  type         TEXT NOT NULL,              -- 'mcq' | 'short' | 'code'
  payload_json TEXT NOT NULL,              -- {prompt, options?[], rubric?}  (shared QuizSpec)
  key_json     TEXT NOT NULL,              -- never leaves the server except via reveal-key
  key_status   TEXT NOT NULL,              -- 'unverified' | 'verified' | 'failed'
  source       TEXT NOT NULL,              -- 'auto' | 'on_demand'
  created_at   TEXT NOT NULL
);
CREATE TABLE attempts (
  id          TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id),
  subject_id  TEXT NOT NULL,
  answer      TEXT NOT NULL,
  grade_json  TEXT NOT NULL,               -- {verdict, feedback}
  created_at  TEXT NOT NULL
);
CREATE TABLE schedule (
  question_id    TEXT PRIMARY KEY REFERENCES questions(id),
  subject_id     TEXT NOT NULL,
  due_at         TEXT NOT NULL,
  interval_index INTEGER NOT NULL DEFAULT 0,  -- index into config.LADDER = [1, 3, 7] (days)
  correct_streak INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_jobs_sub    ON jobs(subject_id, status);
CREATE INDEX idx_sched_due   ON schedule(subject_id, due_at);
CREATE INDEX idx_attempts_q  ON attempts(question_id);
CREATE INDEX idx_questions_s ON questions(subject_id, topic);
```

Derived values (never stored): `stale` = any `material/**` mtime > `subjects.last_built_at` (computed on read; `files` mirrors it); `graphStatus` = building (active graph job) / none (no `graph.json`) / stale / ready; `streak` = consecutive days ending today-or-yesterday with ≥1 attempt (computed in stats.ts).

### On-disk subject layout

Subject root is either an existing folder referenced in place (e.g. `../cs2040C` — never copied) or `data/subjects/<name>`. On registration the server ensures missing pieces exist (idempotent) and syncs the teacher agent file:

```
<subject-root>/
├─ material/              # course corpus: slide PDFs + textbook MDs (uploads land here)
├─ syllabus.md            # optional pacing spine; folder structure is the fallback
├─ corrections.md         # user's feedback memory — teacher reads before answering
├─ MISSION.md             # teach-skill: what this course is, exam angle
├─ lessons/               # NNNN-slug.html — single-page sectioned lessons (teacher writes)
├─ reference/             # teach-skill reference notes
├─ learning-records/      # session summaries from auto-rotation
├─ NOTES.md  RESOURCES.md  assets/     # teach-skill conventions
├─ .opencode/agent/studi0-teacher.md   # synced byte-identical from apps/server/agents/ at register + boot
└─ graphify-out/          # pipeline artifacts
   ├─ graph.json          # the knowledge graph (ontology-typed)
   ├─ graph.html          # interactive graph → iframed in the UI
   ├─ wiki/               # generated per-topic pages — user edits are CANON
   ├─ GRAPH_REPORT.md     # graphify's own report
   └─ VERIFY_REPORT.md    # our verification agent's flagged/confirmed edge report (studi0 artifact, not graphify's)
```

**Who writes what:** user → `material/` (via upload), wiki pages, `corrections.md`, optional `syllabus.md`; teacher agent → `lessons/`, `reference/`, `learning-records/`, `NOTES.md`; pipeline → `graphify-out/**`; server → `.opencode/agent/` sync, `VERIFY_REPORT.md`, SQLite index. The server never deletes subject files (DELETE subject = unregister only).

## Key flows

**(a) Batch upload → stale badge**
1. UI `POST /api/subjects/:id/files` (multipart, N files) → server streams each to `material/<basename>` (sanitized, collision-suffixed), rejects unsupported extensions per-file, upserts `files` rows.
2. Response: `{accepted[], rejected[{name, reason}]}` — partial success is per-file (AC2).
3. Staleness is **computed, not watched**: next `GET /subjects` sees `max(material mtime) > last_built_at` → `stale: true` → badge. No file watcher.
4. Badge clears only when an Update job completes (`last_built_at` advances).

**(b) Build/update graph → headless opencode → graphify → verification → SSE**
1. UI `POST /api/subjects/:id/jobs {kind: build|update|recluster|rebuild}` → queued (409 if the subject already has an active job; queue holds it otherwise, max 2 running globally).
2. Queue dequeues when a slot frees → `runner.ts` spawns `opencode run "<extraction prompt>"` with `cwd = subject root` (arg-array spawn, no shell). The prompt (from `graph/prompts.ts`) carries the fixed ontology (entities: Concept, Algorithm, DataStructure, Proof, Pitfall, ExamNote; relations: prerequisite_of, uses, confused_with, contradicts, related_to) and instructs the agent to run graphify 0.9.95 (`--update` for update jobs; re-cluster instructions for recluster; clean backup + cache clear + full re-extract for rebuild) and to emit protocol lines on stdout: `studi0-progress {"done":n,"total":m,"file":"..."}`.
3. `parse.ts` tails stdout → progress events → job row update + `job` event on the subject SSE stream.
4. On extraction completion, a **second headless run** (verification prompt) source-checks sampled edges and writes `graphify-out/VERIFY_REPORT.md` (flagged/confirmed edges). Flagged edges are treated as non-facts by the teacher.
5. Outcome: `complete` (all chunks OK) / `partial` (per-file failures listed in `partial_json`, graph still usable — AC6) / `failed`. Verification failure → `partial` with reason "verification failed; edges unverified".
6. Cancel: `POST /api/jobs/:id/cancel` → status `cancelling` → `proc.ts` kills the process tree (Windows `taskkill /T /F`; SIGTERM→SIGKILL elsewhere) with a 5s force timer → `cancelled`, progress + partial report preserved (AC4).
7. Job `complete`/`partial` sets `last_built_at` (clears stale) → frontend reloads the graph iframe and report view.

**(c) Teacher chat → SDK session → hybrid retrieval → cited SSE answer → lesson → rotation**
1. UI `POST /api/subjects/:id/chat/sessions {lessonId?}` → backend (via SDK, opencode at 44096) creates a session with `cwd = subject root`, agent `studi0-teacher`; lesson-scoped sessions record `lesson_id`. 503 `OPENCODE_DOWN` if the managed server isn't healthy.
2. UI `POST /api/chat/sessions/:id/messages {content, lessonId?}` → response is an SSE stream.
3. **Rotation check first**: if `msg_count ≥ 24` (or session bytes > 60k) → summarize the session via one-shot run → `learning-records/<date>-<slug>.md` → mark old session inactive, create a fresh one → emit `rotated` → continue in the new session (AC16).
4. Server appends a short context preamble (graph building? lesson path? latest rotation summary?) and streams the turn via SDK `session.chat`; deltas are pumped as SSE `token` events.
5. The teacher agent performs **hybrid retrieval** itself (budget-capped: ≤2 graphify queries, top-5, then dense text search with grep over `material/` + `graphify-out/wiki/`; wiki edits are canon; `corrections.md` pre-read) and answers with inline citations `【file.pdf · p12】` — every factual claim cites a `source_location`; beyond-material claims are prefixed "Beyond the material:" (AC11/AC13).
6. Lesson request → agent writes `lessons/NNNN-slug.html` (single page, ≥3 sections, checkpoint question per section, first line `<!-- studi0:lesson {"nodes":[...],"topic":"..."} -->`, ordered by the syllabus spine). Server detects the new file during the turn, parses node tags, upserts the `lessons` index, emits SSE `lesson`; quiz blocks in the same reply are parsed into the bank (SSE `quiz`).
7. `done` closes the stream. History after refresh: `GET /api/chat/sessions/:id/messages` (proxied from opencode; 410 if opencode lost the session).

**(d) Practice: deposit/generate → verify gate → attempts → 1/3/7 ladder → stats**
1. **Auto-deposit**: after a `lesson` event, `practiceFeed.ts` runs a one-shot generation for the lesson topic → questions + keys inserted (`source: auto`, `key_status: unverified`) → key-verification pass → `verified` | `failed` (flag for regeneration). Completion emits a subject-level `questions` SSE event.
2. **On-demand**: Practice UI `POST /api/subjects/:id/questions/generate {topic}` (same generator, `source: on_demand`) **and** in-chat "quiz me on X" — the teacher replies with a fenced ```studi0-quiz``` JSON block which `quizScan.ts` parses into the same bank (AC18). One schema (`packages/shared/quiz.ts`), two entry points.
3. **Due queue**: new questions are due immediately; `GET /api/subjects/:id/practice/due` returns `schedule.due_at ≤ now`. No background timers — the queue moves only when answers arrive.
4. **Answer**: `POST /api/questions/:id/answer` → MCQ exact-match, short/code LLM-graded against key + rubric (one-shot) → attempt row + feedback; scheduler: correct → next ladder step (1d → 3d → 7d → stays 7d), wrong → reset to 1d (AC20).
5. **Reveal gate**: `POST /api/questions/:id/reveal-key` → 409 unless `key_status = verified` (AC19). Grading may proceed on an unverified key (only reveal is gated, per AC19).
6. **Stats**: `GET /api/subjects/:id/practice/stats` → per-topic accuracy, due count, streak — all computed from `attempts`/`schedule`, nothing pre-aggregated.

## Components & responsibilities

### Pipeline job queue (`pipeline/`)
- Enforces **1 active job per subject** (409 otherwise) and **max 2 concurrent** across subjects; overflow queues FIFO.
- Owns the full job lifecycle row (queued → running → complete/partial/failed/cancelled) and emits every transition to the subject SSE stream.
- Cancellation is cooperative-then-forced with a 5s deadline; completed-so-far is reported honestly (`partial_json`), never faked (US7).
- Persists the child `pid`; on boot, any job row left `running/cancelling` is closed as `failed` ("server restarted") and orphan processes are cleaned (see lifecycle manager).

### Opencode server lifecycle manager (`teacher/opencode.ts`)
- Single owner of one `opencode serve --port 44096 --hostname 127.0.0.1` process for the whole app.
- **Boot**: check port 44096 — if something healthy answers and we have no record of it, treat as zombie: resolve the PID via `netstat -ano` + kill tree (Windows) before starting ours; then close stale `running` job rows.
- **Health**: periodic lightweight probe; `GET /api/health` exposes `{running, pid, port, healthy}` so the UI can show a banner instead of failing chat mysteriously. Chat/practice/oneshot calls return 503 `OPENCODE_DOWN` while unhealthy.
- **Stop**: graceful shutdown on app exit; kill-tree on timeout. The manager is the only code that spawns or kills opencode serve (job runners spawn separate short-lived `opencode run` processes).

### studi0-teacher agent definition (`apps/server/agents/studi0-teacher.md`)
An opencode agent file (markdown + frontmatter). Canonical copy lives in the repo; the server syncs it byte-identical to `<subject-root>/.opencode/agent/studi0-teacher.md` at registration and on every boot (sessions run with `cwd = subject dir`, so project-level agent discovery requires the file there; overwrite-on-sync is intentional — the single source of truth is the repo).

Required content, section by section:
1. **Frontmatter**: `description`, `mode: all`, moderate `temperature`, tool allowlist (`read, grep, glob, write, edit` — no bash), permission block: allow edits only under `lessons/**`, `reference/**`, `learning-records/**`, `NOTES.md`; everything else `ask` (effectively denied headless). Exact permission keys verified against opencode 2.2.1 docs in T06.
2. **Mission pre-read**: read `MISSION.md` first; this folder is the course.
3. **Corrections pre-read**: read `corrections.md` (and the latest `learning-records/*`) before answering any topical question (AC17).
4. **Hybrid retrieval protocol**: ≤2 graphify queries (top-5) → dense grep over `material/` + `graphify-out/wiki/`; never load `graph.json` wholesale; wiki pages are canon over extracted graph content (AC9).
5. **Citation rule**: every factual claim carries an inline `【source · page】` from `source_location`; no source → say so (AC11).
6. **Slides-are-canon**: course notation wins; model-knowledge-only content must be prefixed "Beyond the material:" (AC13). Flagged edges from `VERIFY_REPORT.md` are never presented as fact (AC8).
7. **Ontology**: when discussing the graph, only the six entity types and four relation types.
8. **Lesson template**: on request, write `lessons/NNNN-<slug>.html` — single page, ≥3 sections, each ending in one checkpoint question, ordered by the syllabus spine; first line `<!-- studi0:lesson {"nodes":[...],"topic":"..."} -->` (node tags recorded for v1; click-through UI is v1.5) (AC14/AC15).
9. **Comprehensive style**: this overrides teach-skill short-lesson philosophy in lessons; chat replies stay structured, not walls of text.
10. **Quiz format**: when asked to quiz, append exactly one fenced ```studi0-quiz``` JSON block matching `packages/shared/quiz.ts` (AC18).
11. **Rotation**: when the server preamble names a learning-record summary, treat it as memory of prior sessions.

The server injects per-turn context as a preamble part (graph rebuilding? lesson path? rotation summary path?) — the agent file stays static.

### Server modules (one-liners)
`http/routes/*` — thin: validate (zod) → service → serialize. `db/repos/*` — prepared statements only, no SQL in services. `fs/paths.ts` — every disk path in the app passes through it (traversal guard, space-safe joining). `graph/prompts.ts` + `util/oneshot.ts` — all headless `opencode run` invocations (build, verify, practice gen/verify/grade) go through one helper with the same spawn/parse/kill semantics as the pipeline.

### Web modules (one-liners)
`api/client.ts` typed against `packages/shared` inferred types; `api/sse.ts` two helpers (EventSource for GET subject events; fetch-stream reader for POST chat streams — EventSource can't POST). `chat/` renders streamed tokens and parses `【citation】` markers client-side (regex from shared). `graph/GraphView` lazy-iframes `graph.html` via the raw passthrough route. `lesson/LessonViewer` polls lesson content (2.5s while visible) for hot-reload. `practice/KeyGate` renders reveal only after a successful reveal-key call — the 409 is the gate, not UI state.

## State strategy (web)

- No router, no state library. `AppContext` holds `{subjectId, tab, lessonPath}`; everything else is per-page local state + fetch hooks.
- Server state via small handwritten hooks (`api/hooks.ts`) with manual invalidation driven by SSE events (job update → refetch subject; lesson event → refetch lessons; questions event → refetch due/stats). React Query was considered and skipped — SSE-driven invalidation is the whole story and hand-rolled is smaller.
- Chat is append-only local state fed by the SSE stream; history fetch only on mount/refresh.
- URL state deliberately absent: single user, five tabs, nothing to share.

## Data / storage layer (server)

- One SQLite file: `data/studi0.db`, opened once, `DatabaseSync`, WAL mode; migrations = ordered `.sql` files applied by `PRAGMA user_version` at boot.
- Repos are the only SQL; services compose repos + fs + pipeline/teacher; routes compose services. No ORM.
- File I/O: every path resolved through `fs/paths.ts`; all server-authored writes go through `safeWrite.ts` (temp + rename) to survive OneDrive/antivirus locks (the repo lives under `Documents\Y2 stuff` — possibly synced).
- Disk is truth for content; SQLite is truth for jobs/schedule/bank/session index. Deleting a subject row never touches disk.

## Error handling

- `HttpError(code, message, details?)` thrown anywhere; one fastify `setErrorHandler` maps it to `{"error": {code, message, details?}}` with the HTTP status from a code→status table (see API_CONTRACT). Unknown errors → 500 `INTERNAL` (logged, no internals leaked).
- Zod validation failures → 400 `VALIDATION` with flattened issues.
- SSE surfaces: pre-stream errors are normal JSON errors (headers not yet sent); post-stream failures are `error` events carrying the same `ApiError` payload. Every stream terminates with exactly one of `done` | `error`.
- Pipeline failures are job states (`partial`/`failed` + `partial_json`), not HTTP errors — honesty lives in the job row (AC6).

## Accessibility

- Chat is a `<form>` + log with `aria-live="polite"` on the streaming region; job progress and due-count badges are announced via `aria-live` too.
- Quiz runner uses real inputs (`radio` for MCQ, `textarea` for short/code); key-reveal confirm dialog returns focus to the trigger.
- Keyboard-only flows: Enter sends / Shift+Enter newlines in composer; all tabs and panels reachable by tab order; no focus traps outside the one dialog.
- Semantic landmarks (`nav`, `main`, headings per panel), AA contrast, `prefers-reduced-motion` respected on progress animations. No a11y scope beyond standard semantic HTML — this is a localhost single-user tool, not a public site.

## Performance

- SQLite sync in-process: correct choice at single-user scale; repos use prepared statements; WAL for concurrent readers during job writes.
- Uploads stream to disk per-file (never buffered whole); 200 MB/file cap.
- `graph.json` is never loaded into server memory for chat — retrieval is the agent's budget-capped queries + grep; the UI gets the graph only as an iframe of `graph.html`.
- Subject SSE streams are per-subject and closed on tab switch; heartbeat every 15s keeps proxies idle-tolerant.
- Lesson hot-reload polls only while the viewer is open and the tab is visible (2.5s, `document.visibilityState`-gated).
- Staleness check stats one directory tree per subjects fetch — hundreds of files, sub-millisecond; no watcher process.

## Data flow (summary)

```
web (5173) ──fetch / POST-SSE──▶ server (3001) ──SQL──▶ data/studi0.db
                                  server ──fs──▶ subject roots (material/, graphify-out/, lessons/, ...)
                                  server ──spawn──▶ opencode run (pipeline jobs, cwd = subject dir)
                                  server ──SDK/HTTP──▶ opencode serve (44096) ──▶ teacher sessions (cwd = subject dir)
subject SSE ◀── job | lesson | questions | ping      chat SSE ◀── token | lesson | quiz | rotated | done | error
```

## Windows / pnpm constraints (where they bite)

- **Paths with spaces** (`Documents\Y2 stuff`): every spawn uses arg arrays with `shell: false` — never string-concatenated commands; `fs/paths.ts` is the only place paths are joined. PowerShell is never invoked by the server; glue logic is Node.
- **Zombie opencode processes**: opencode doesn't always die with its parent on Windows. Mitigations: backend-owned serve process with recorded pid, boot-time port probe + `netstat -ano` PID resolution + `taskkill /PID <pid> /T /F` (tree kill is mandatory — opencode spawns children), and job runners kill-tree with a 5s force timer (AC4).
- **pnpm on Windows**: run everything through `pnpm` scripts (`pnpm exec`, never `npx`); `packageManager` field pins 12.15.0; spawned CLIs are resolved from absolute paths or `process.execPath`, not `.cmd` shims (shims break under `spawn` without a shell).
- **OneDrive/AV locks** on `Documents\Y2 stuff`: server writes use temp-file + rename; a failed rename retries once before surfacing an error. Graphify's own writes can't be wrapped — noted as residual risk in PLAN.
- **Long paths / CRLF**: subject folders may nest deep — Windows Long Paths must be enabled on the machine (BUILD.md prerequisite, T15); lesson HTML is written with `\n` and read back text-mode-agnostic.

## Open questions & interpretations (none contradict PLAN/PRD)

1. **Verification "agent"** = the second headless `opencode run` with a verification prompt (PLAN's wording); not a second persisted agent file. Only `studi0-teacher` is a persisted agent file.
2. **`packages/shared`** is a third workspace package not named in T01 ("apps/web, apps/server") — added because the API contract requires one zod source for both ends. Fold into T01.
3. **On-demand question generation is a synchronous POST** (can take ~1 min; spinner in UI) rather than a pipeline job — keeps the 1-job-per-subject rule clean for graph builds. Auto-deposit is fire-and-forget server-side.
4. **Scheduler ladder** `[1, 3, 7]` is a code constant (TASKS says "default"); no user-facing setting (nothing requested).
5. **Streak** is computed from `attempts`, not stored — T02's "schedule" table stays minimal.
6. **Wiki PUT does not create pages** — pages are graphify-generated; free-form user knowledge belongs in `corrections.md` (US10 is edit-only).
7. **Lesson content endpoint** added (viewer needs HTML; T02/T09 imply it) — not in the T-ARCH endpoint list explicitly, required by US3/AC15.
