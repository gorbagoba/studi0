# studi0 — TASKS

One line per task: `id · stage · owner · depends-on · files · done-criteria`.
Every dispatch references a task id; every gate checks against its done-criteria.

- T-ARCH · architecture · architect · PLAN.md+PRD.md · docs/ARCHITECTURE.md, docs/API_CONTRACT.md · stack + tree + data model + all REST/SSE endpoints contracted; honors reference-in-place, job queue (1/subject, cap 2), graphifyy@0.9.95, headless `opencode run`, SDK sessions, SQLite, hybrid retrieval, scheduler ladder (1/3/7 default)
- T01 · phase-0 · devops · T-ARCH · apps/web, apps/server, package.json, pnpm-workspace.yaml, tsconfig, eslint, vitest · `pnpm install && pnpm dev` serves web+server; typecheck/lint/test/build all green on scaffold
- T02 · phase-0 · backend · T01 · apps/server/src/db · SQLite schema + migrations (subjects, files, jobs, lessons, questions, attempts, schedule, chat sessions) + data layer; migration tests pass
- T03 · phase-0 · backend · T02 · apps/server/src/subjects · subjects CRUD (incl. reference-in-place registration), file browser, batch upload into `material/`; upload rejects unsupported types with clear errors; path-traversal safe
- T04 · phase-1 · backend · T03 · apps/server/src/pipeline · job queue spawning headless `opencode run` for graphify build/update/re-cluster; SSE progress; cancel ≤5s; partial-failure parsing; stale detection; 1 job/subject, cap 2 concurrent
- T05 · phase-1 · backend · T04 · apps/server/src/graph · ontology extraction prompt template (typed entities/relations), verification-agent dispatch + edge report storage, wiki + corrections.md file services
- T06 · phase-2 · backend · T02 · apps/server/src/teacher · opencode SDK session manager: server lifecycle/health, per-subject teacher session (cwd = subject dir), SSE streaming, lesson-context injection, auto-rotation into learning-records, corrections.md pre-read
- T07 · phase-3 · backend · T06 · apps/server/src/practice · question store + generation (auto-deposit + on-demand via teacher), LLM grading vs key, key verification gate before reveal, attempts, 1/3/7 scheduler ladder, stats endpoints
- T08 · phase-0 · frontend · T01 · apps/web/src · app shell: subjects sidebar, subject page, file browser, batch-upload zone
- T09 · phase-2 · frontend · T08+T06 · apps/web/src/lesson · lesson viewer (renders lessons/*.html, hot-reload) + lesson-scoped chat panel with citation display
- T10 · phase-1 · frontend · T08+T04 · apps/web/src/graph · graph view (iframe graph.html) + build/update/cancel/stale/partial-failure job UI
- T11 · phase-3 · frontend · T08+T07 · apps/web/src/practice · practice UI: bank, quiz runner (MCQ/text/code), key-reveal gate, due-today queue, stats cards
- T12 · test · qa · T03–T11 · apps/*/tests, e2e · server integration tests (subjects, jobs incl. cancel/partial, practice scheduler) + web e2e smoke (add subject → upload → build → lesson → chat → practice); gates green
- T13 · review · security-reviewer · T03+T04+T06 · changed server files · upload handling, path traversal, chat/session wiring audited; findings triaged to owning specialist
- T14 · review · orchestrator · T01–T11 · changed files · one code-review pass; real findings fed back to owners before QA
- T15 · build · devops · T12 · configs, README, BUILD.md · `pnpm build` + preview runs; BUILD.md documents prereqs (graphifyy@0.9.95, opencode server) and pnpm-only workflow

MVP slice = T-ARCH, T01–T06, T08–T10, T12–T15 (practice engine T07/T11 follows immediately; dogfood gate per PRD AC22).
