# studi0 — PLAN

**Vision:** a chat-first, locally-hosted learning platform. One folder per university subject; batch-upload course material; a graphify knowledge graph built per subject; a live opencode "teacher" that teaches in comprehensive lessons, answers questions with citations from the graph + corpus, and generates verified practice — so studying becomes a daily loop.

**Status:** spec settled via double-grill (2026-10-31). This document is the build plan. PRD: `docs/PRD.md`.

## Settled decisions

| Area | Decision |
|---|---|
| Name | **studi0** (repo/folder: `studi0`) |
| Product shape | Chat-first: teacher chat is the primary interface; lessons + graph are artifacts it produces |
| Access | Browser, localhost only, single user, no auth |
| Scope | Multi-course capable at launch; dogfood with ONE course: cs2040C referenced **in place** (`../cs2040C`), not copied |
| Corpus | Slide PDFs + textbook MDs (no lecture recordings exist; Whisper excluded) |
| Extraction | SoCLaaS-only (subagents) — university material never leaves the machine; no Gemini key |
| Graph correctness | Ontology-constrained extraction (typed entities/relations) + verification agent on edges + editable wiki as canon + `corrections.md` feedback memory |
| Deferred (v1.5) | Deep-build extraction voting (behind a "deep build" flag); node→lesson click-through UI (node tags recorded in v1) |
| Re-cluster | Manual button (node-explosion maintenance), not automatic |
| Teacher | opencode session per subject; teach-skill conventions (MISSION.md, lessons/, reference/, learning-records/, NOTES.md, assets/); auto-rotating sessions with state in learning-records; `corrections.md` read before answering |
| Pedagogy | **Overrides teach's short-lesson philosophy**: one comprehensive, sectioned single-page lesson per topic, checkpoint question per section. Notation-drift rule: course slides are canon; model knowledge fills gaps only when flagged. Pacing: lecturer's sequence (folder structure / `syllabus.md`) is the lesson-ordering spine; graph informs cross-links only |
| Practice | Dedicated engine: auto-deposited + on-demand ("quiz me on X"); MCQ + short answer + code questions; LLM-graded against keys; answer key verified by a second pass before reveal |
| Scheduling | Light spaced-review scheduler (due-today queue from wrong/untouched items); minimal stats (per-topic accuracy, due counts, streak) |
| Retrieval | Hybrid: graph query (budget-capped) + dense text over raw corpus; every claim cites `source_location` |
| UI | Lesson viewer (hot-reload `lessons/*.html`), lesson-scoped chat when opened from a lesson, subject-scoped chat otherwise; graph = iframe of graphify's `graph.html`; subjects sidebar + file browser with batch upload; job progress UI |
| v1 exclusions | Recordings/Whisper · LAN/phone · cross-subject graph merge · code-execution sandbox · multi-user/auth |
| MVP acceptance bar | The due-practice queue pulls the user in daily AND chat answers cite the material — both must work at launch |

## Architecture approach

- **Local web app:** React/Vite frontend + Node backend (Fastify or Hono), SQLite for metadata (subjects, jobs, attempts, chat index). Course files stay as plain files on disk — portable, inspectable, teach-skill compatible.
- **Subject layout** (`subjects/<name>/` or referenced path): `material/` (uploads) · `graphify-out/` (graph.json, graph.html, wiki/, GRAPH_REPORT.md) · teach workspace files (`MISSION.md`, `lessons/`, `reference/`, `learning-records/`, `assets/`, `NOTES.md`, `RESOURCES.md`) · `corrections.md` · optional `syllabus.md`.
- **Pipeline worker:** backend spawns headless `opencode run` in the subject directory for graph builds/updates; in-process job queue with progress events (SSE), cancellation, and honest partial-failure reporting; one pipeline job per subject at a time (teacher sees "graph rebuilding" state during a build).
- **Teacher chat:** backend talks to the opencode server (SDK); one session per subject with cwd = subject directory; custom `studi0-teacher` agent (opencode agent file) combining the teach skill, graphify query, hybrid retrieval, lesson writing, and the correction/notation rules; SSE streaming to UI; auto-rotation summarizes into learning-records.
- **Practice engine:** questions stored per subject (SQLite + JSON payloads); teacher generates + a verification pass grades the key before reveal; attempts and due-times in SQLite drive the scheduler.
- **Pinning:** graphifyy pinned at **0.9.95** (verified installed; Python 3.14.5, opencode 2.2.1, node 24, pnpm 12.15 on this machine — all prerequisites already present).

## Key risks → mitigations

1. **Extraction quality / notation drift** → ontology-constrained prompt, verification agent, human skim of GRAPH_REPORT + editable wiki, corrections.md, slides-are-canon rule, `--update` re-extraction of partial reads.
2. **Long-running jobs UX** → job queue with progress/cancel/partial-failure honesty; builds are never silent.
3. **Session lifecycle (opencode server)** → backend owns start/stop/health; documented ports + service auth; zombie cleanup on boot.
4. **Context bloat in chat** → budget-capped graph queries; retrieval over recall; auto-rotation.
5. **Answer-key correctness** → generate → verify → reveal gate.
6. **Scope creep** → phases below are the contract; v1 exclusions are binding.
7. **Windows friction** → pinned toolchain, paths handled centrally, PowerShell-safe pipeline scripts.

## Stage plan

- **Phase 0 — shell:** scaffold app (pnpm), subjects CRUD incl. reference-in-place, batch upload, file browser, lesson viewer. *Gate: typecheck+lint+tests+build.*
- **Phase 1 — graph pipeline:** build/update buttons → headless opencode run → progress/cancel/stale badges → iframe graph + report view. Ontology-constrained prompt + verification agent land here.
- **Phase 2 — teacher chat:** opencode SDK wiring, studi0-teacher agent, SSE chat with citations, session rotation, corrections.md.
- **Phase 3 — lessons + practice:** in-chat lesson generation (sectioned template, node tags, pacing), practice engine (generation, verification, attempts, scheduler, stats).
- **Phase 4 — polish:** cross-subject niceties, tuning, dogfood feedback loop.

**Execution:** team pipeline per AGENTS.md (frontend + backend in parallel after architecture; security-reviewer dispatches when input handling/sessions/data storage land — file upload and chat qualify; qa gates every phase). Phases 0–2 = first shippable MVP.

## Deferred / open

- v1.5: deep-build voting flag · node→lesson click-through UI · (candidate) LightRAG swap only if graphify's update story stumbles.
- No open spec questions; build starts on user's explicit go per stage.
