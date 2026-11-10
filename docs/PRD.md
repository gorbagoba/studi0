# studi0 — PRD

**Product:** a chat-first, locally-hosted learning platform that turns a folder of university course material into a knowledge graph and a live AI teacher — comprehensive lessons, cited answers, and a daily verified-practice loop.

**Plan:** see `docs/PLAN.md` for settled decisions and stage plan.

## Goals

- G1: A subject's course material (slide PDFs + textbook MDs) becomes a queryable knowledge graph within one pipeline run, with incremental updates as material is added.
- G2: The user can study any topic through the teacher chat and receive answers that cite the course material (`source_location`), with course notation taking precedence over model knowledge.
- G3: Lessons are comprehensive, sectioned single pages, ordered by the lecturer's pacing, tagged with graph node IDs, with a checkpoint question per section.
- G4: The due-practice queue pulls the user in daily; every practice answer key is machine-verified before it can be revealed.
- G5 (MVP bar): after Phase 2 MVP, the user dogfoods cs2040C daily for one week using **only** the app.

## Users

- **The student (single user, the owner):** a university student who runs everything locally, wants grounded answers over generic ones, and studies in daily sessions. No other users exist in v1; there is no auth.

## User Stories

*Subjects & material*
- US1: As the student, I want to create a subject that points at an existing folder (reference in place), so my current workspaces (e.g. cs2040C) become subjects without duplication.
- US2: As the student, I want to batch-upload files (PDFs, MDs) into a subject's `material/`, so adding a week's lectures is one action.
- US3: As the student, I want a file browser per subject, so I can see and open what's in `material/`, `lessons/`, `reference/`, and `graphify-out/`.

*Graph pipeline*
- US4: As the student, I want to click "Build graph" (and later "Update graph") and see live progress, so long extractions are never a black box.
- US5: As the student, I want to cancel a running pipeline job, so a wrong upload doesn't waste minutes.
- US6: As the student, I want a "stale" badge when `material/` changed after the last build, so I never study from an outdated graph.
- US7: As the student, I want partial-failure reporting (which files/extracts failed) rather than a fake-complete graph, per graphify's honesty rules.
- US8: As the student, I want the extraction to use a fixed ontology (Concept, Algorithm, DataStructure, Proof, Pitfall, ExamNote; prerequisite_of, uses, confused_with, contradicts, related_to), so the graph stays consistent across weeks.
- US9: As the student, I want a verification pass over graph edges (sampled, source-checked), so wrong edges are flagged before they reach lessons.
- US10: As the student, I want to edit the generated wiki pages to correct them, and have edited pages treated as canon by the teacher.
- US11: As the student, I want a manual "re-cluster" button, so node bloat mid-semester is my call, not a surprise job.
- US12: As the student, I want to view the interactive knowledge graph (graphify's `graph.html`), so I can explore how ideas connect.

*Teacher chat*
- US13: As the student, I want a chat per subject, so the teacher knows the course, the graph, and my history.
- US14: As the student, I want the chat scoped to the current lesson when opened from a lesson, so "why is step 3 like that?" is answered against exactly what I'm reading.
- US15: As the student, I want every factual answer to cite `source_location` (file/page), so I can trust and verify it.
- US16: As the student, I want the teacher to follow the course's notation and flag anything beyond the material, so I study what the examiner examines.
- US17: As the student, I want lessons ordered by my lecturer's sequence (folder structure / `syllabus.md`), so the course pacing drives what's next.
- US18: As the student, I want the teacher to write lessons as sectioned single pages with checkpoint questions while we talk, so depth arrives structured, not as a wall of text.
- US19: As the student, I want long chat sessions to auto-rotate (summarized into learning-records), so the teacher never degrades mid-explanation.
- US20: As the student, I want my corrections remembered (corrections.md, read before answers), so I never re-explain the same fix.
- US21: As the student, I want answers retrieved via graph query + raw-text search, so grounding doesn't depend on the graph alone.

*Practice*
- US22: As the student, I want practice questions auto-deposited from lessons AND generable on demand ("quiz me on heaps"), so the bank grows with and beyond lessons.
- US23: As the student, I want MCQ, short-answer, and code questions, LLM-graded against a key and rubric, so code practice exists without an execution sandbox.
- US24: As the student, I want every answer key verified by a second pass before I can reveal it, so a wrong key never teaches me the wrong thing.
- US25: As the student, I want a due-today review queue (spaced resurfacing of wrong/untouched items), so retention is scheduled for me.
- US26: As the student, I want minimal stats (per-topic accuracy, due counts, streak), so progress is visible at a glance without an analytics rabbit hole.

## Acceptance Criteria (Given/When/Then)

- AC1 (US1): Given a folder `../cs2040C` with teach-workspace files, when I add it as a subject by path, then the sidebar lists it, its existing `lessons/` render in the viewer, and no files are copied or moved.
- AC2 (US2): Given a subject, when I drop 5 PDFs onto the upload zone, then all 5 land in `material/` and the file browser lists them.
- AC3 (US4): Given `material/` with ≥1 supported file, when I click "Build graph", then a progress indicator streams job events until "complete" or a listed partial failure, and `graphify-out/graph.json` exists afterward.
- AC4 (US5): Given a running job, when I click cancel, then the job stops within 5s and the UI reports what was completed.
- AC5 (US6): Given a built graph, when I add a file to `material/`, then the subject shows a "stale" badge until "Update graph" completes.
- AC6 (US7): Given a build where 1 of 8 extraction chunks fails, then the UI reports "7/8 complete, 1 failed: <file>" and the graph is still usable.
- AC7 (US8): Given a graph build, then every node in `graph.json` carries one of the ontology's entity types and every edge one of its relation types.
- AC8 (US9): Given a completed build, then the verification agent ran and its report (flagged/confirmed edges) is visible in the app; flagged edges do not appear in teacher answers as fact.
- AC9 (US10): Given I edit a wiki page, when the teacher later answers a question in that topic, then the edited content takes precedence over extracted graph content.
- AC10 (US12): Given a built graph, when I open the graph view, then graphify's interactive `graph.html` renders in-app.
- AC11 (US13/15): Given a subject with material, when I ask "why does Dijkstra use a priority queue?", then the reply cites at least one `source_location` from the subject corpus and uses the course's terminology.
- AC12 (US14): Given I opened lesson `lessons/0007-dijkstra.html` and chat in it, when I ask a question, then the teacher's answer references that lesson's content without me re-stating it.
- AC13 (US16): Given a question the corpus doesn't cover, then the teacher answers with general knowledge **explicitly flagged** as "beyond the material" (not presented as course fact).
- AC14 (US17): Given a `syllabus.md` (or week-structured `material/`), then the lessons list orders topics by that sequence, and the teacher proposes new lessons in that order.
- AC15 (US18): Given the teacher generates a lesson, then the file is a single page with ≥3 sections, each section ending in one checkpoint question, and it appears in the viewer immediately.
- AC16 (US19): Given a session exceeds the rotation threshold, then a summary lands in `learning-records/`, a fresh session starts, and the teacher still recalls the summary's content in its next answer.
- AC17 (US20): Given I wrote "I use whichever notation the slides use" in `corrections.md`, when the teacher next explains that topic, then it matches the slides' notation.
- AC18 (US22/23): Given a lesson exists, when I open Practice, then its questions appear in the bank; when I type "quiz me on heaps" in chat, then generated questions join the same bank; answering a code question yields LLM-graded feedback against a key + rubric.
- AC19 (US24): Given a newly generated answer key, then a verification pass runs before reveal; a failed verification blocks reveal and flags regeneration.
- AC20 (US25): Given I answered a question wrong yesterday, then it appears in today's due queue; a correct streak pushes the next due date out.
- AC21 (US26): Given attempts exist, then the subject page shows per-topic accuracy, current due count, and streak.
- AC22 (G5, MVP bar): after Phases 0–2 (+practice slice of Phase 3), the user completes 5 consecutive days studying cs2040C solely inside studi0.
- AC23 (Global): every build/test gate (typecheck, lint, tests, build) passes on Windows with pnpm; the app runs with `pnpm dev` and no external services beyond the local opencode server + SoCLaaS endpoint.

## Scope (in)

- Subjects (create/reference-in-place/rename), batch upload, file browser.
- Graph pipeline: build/update/cancel/progress/stale badge/partial-failure reporting; ontology-constrained extraction; verification agent; manual re-cluster; iframe graph view; wiki editing.
- Teacher chat: per-subject sessions, lesson-scoped context, cited answers, auto-rotation, corrections memory, in-chat lesson generation (sectioned template, node tags, pacing spine).
- Practice engine: bank, generation (auto + on-demand), MCQ/text/code LLM grading, key verification gate, due-today scheduler, minimal stats.
- Plain-file storage on disk; SQLite for metadata; localhost web UI.

## Out of scope (v1)

- Lecture recordings / Whisper transcription · LAN or phone access · cross-subject graph merging · code-execution sandbox · multi-user or authentication · cloud deployment · extraction voting (v1.5 flag) · node→lesson click-through UI (tags recorded in v1, UI v1.5).

## Risks

- Extraction quality on slide PDFs → ontology prompt + verification agent + wiki curation + corrections loop (see PLAN §risks).
- Notation drift → slides-are-canon rule with explicit "beyond the material" flagging (AC13).
- Long jobs / zombie processes → job queue with cancel + backend-owned opencode lifecycle.
- Answer-key errors → generate-verify-reveal gate (AC19).
- Dependency churn → graphifyy pinned 0.9.95.
- Scope creep → v1 exclusions are binding; phases are the contract.

## Definition of Done

- Every AC above is testable as written; no vague requirements.
- Scope boundaries explicit (In/Out above).
- G1–G5 measurable; MVP bar (G5/AC22) is the launch gate for the Phase 0–2 + practice slice.
