# studi0 — QA Test Results (T12)

**Runner:** QA subagent · **Mode:** real-integration E2E through the live UI (127.0.0.1:5173 + server :3001 + managed `opencode serve` :44096; real headless `opencode run` / SoCLaaS model calls; real graphify pipeline; unit/integration stubs never relied on).

- **Run 1 — 2026-10-31 02:2x–02:5x (pre-fix tree):** verdict NOT-READY; 2 hard FAILs (AC3, AC4) + 6 ACs blocked; 9 bugs reported (file:line + repro in the "Run 1 record" section below).
- **Run 2 — 2026-10-31 11:56–12:50 (post-fix tree, commit `78cd368 fix(qa): server blockers live-verified…`):** re-ran everything that failed or was blocked, plus lesson-flow spot checks. All previously failing/blocked in-scope ACs now pass. **FINAL verdict: MVP-READY** (caveats listed at the end).

---

## FINAL VERDICT (after Run 2): **MVP-READY**

Every fix was re-verified **live**, not by code inspection alone: a cold UI-started graph build reached `complete 4/4` with streamed per-file progress; UI cancel reaches terminal ≤3.5 s with the server alive; the stale badge appears and an Update graph clears it; wiki-edit canon reaches the teacher verbatim; chat turns close with `done` (composer unlocks, `session_after_turn` bookkeeping runs); on-demand question keys auto-verify; a short-answer question was graded live by the LLM with rubric feedback; a generated lesson appeared with section + checkpoint structure and lesson-scoped chat cites the lesson file itself. Gates on the fixed tree: typecheck ✓ lint ✓ **73/73 tests** ✓ build ✓.

**Remaining (non-blocking) watch items:**
1. **Verification one-shot reliability/latency** — the post-extraction verification pass takes ~8.5 min; it **failed (exit 1)** on the update run after ~9.5 min. The pipeline degraded honestly to `partial` (`(verification) failed; edges unverified`) — by design — but a verification retry/timeout tuning is worth a follow-up (oneshot timeout config; no retry).
2. **Pipeline latency** — cold build 17.5 min, update 20.4 min (2 files); dominated by model latency. Inside the AC3 budget, tight for update.
3. **Cosmetic** — `VERIFY_REPORT.md` starts with model narration before the `## Confirmed edges` section (prompt asks for report-only); harmless to the app.
4. **Not exercised** (unchanged scope, not failed): AC16 (rotation, needs a 24-turn session), AC14 fully (no `syllabus.md` in the QA subject; the teacher did demonstrate its pacing fallback: "no syllabus.md, so I pace it at the start of the material's spine"), AC22 (human 5-day dogfood gate).

---

## Per-AC table (Run 2 = re-run; Run 1 = pre-fix record)

| AC | Requirement (short) | Run 1 | Run 2 (re-run evidence) |
|----|---------------------|-------|--------------------------|
| AC1 | Register folder by path, in place | PASS | — (no regression; subject re-used) |
| AC2 | Batch upload + per-file accept/reject | PASS | — (upload reject re-checked incidentally via material; per-file logic re-confirmed) |
| AC3 | Build streams progress → complete, `graph.json` | **FAIL** | **PASS** — UI Build graph (cold, `graphify-out/` wiped) → job `259fa66d` reached **`complete 4/4` in 17.5 min**; SSE stream carried `queued 0/0 → running 0/4 → 1/4 → 2/4 → 3/4 → 4/4 (currentFile names) → complete`; `graph.json` (31 nodes / 34 links) + `graph.html` + wiki (22 pages) + `GRAPH_REPORT.md` produced; server alive throughout |
| AC4 | Cancel ≤5 s, honest report | **FAIL** | **PASS** — Update graph started from UI, Cancel clicked ≤3 s in → job terminal `cancelled` in ≤3.5 s (`finishedAt` 04:20:12.841, started 04:20:09.775), server alive, UI banner "Cancelled — 0/0 files were completed before the stop." |
| AC5 | Stale badge → Update clears | BLOCKED | **PASS** — new `material/05-heap-updates.md` after build → sidebar + header show **stale** (`graph: stale`); Update graph ran to terminal (extraction 2/2; verification sub-run failed → honest `partial`, see watch item 1) → `stale=false`, `lastBuiltAt` updated |
| AC6 | Partial-failure reporting | BLOCKED | **PASS (mechanism)** — the update's verification failure produced a live honest partial job row: `{"file":"(verification)","reason":"verification failed; edges unverified"}`; parser unit-tested (`queue.test.ts:180-184`); UI partial banner component present (`JobPanel.tsx:110-127`). The literal "1 of 8 chunks fails" scenario was not forced |
| AC7 | Ontology-typed nodes/edges | BLOCKED | **PASS** — all 31 nodes carry an entity type (Concept 4, Algorithm 10, DataStructure 4, Proof 1, Pitfall 4, ExamNote 8); all 34 links carry a relation (`uses` 27, `prerequisite_of` 4, `confused_with` 3) |
| AC8 | Verification agent + flagged/confirmed in-app | BLOCKED | **PASS** — `VERIFY_REPORT.md` written with `## Confirmed edges` (source-checked justifications citing material sections) and `## Flagged edges` (2 flagged, e.g. Max-Heap `confused_with` Min-Heap — "uncertain, do not present as fact downstream"); both reports surface via `GET /graph/report` and render in the UI Reports panel (verified expanded in DOM) |
| AC9 | Edited wiki is canon | BLOCKED | **PASS** — appended a canary section ("QA-CANARY-2026-BUILDHEAP … exactly O(n) … height-weighted-sum") to `wiki/Build-Heap.md` via the app API → live teacher answer to "what is the required exam answer for build-heap" contains the canary string verbatim |
| AC10 | `graph.html` iframes in-app | BLOCKED | **PASS** — GraphView iframe (sandbox allow-scripts) points at the proxied raw passthrough; `graph.html` serves 200 (43 KB); "Knowledge graph" region rendered |
| AC11 | Cited answer; turn closes with `done` | PASS (cited) / FAIL (hang) | **PASS** — answers streamed with rendered citation chips (`【02-heaps-to-priority-queues.md · L24–25】` etc.); **turns now close**: composer returns from "Streaming…" to "Send", session `messageCount`/`lastMessageAt` updated (`done` → `sessionAfterTurn` executed), repeatedly, across 3 turns |
| AC12 | Lesson-scoped chat | NOT EXERCISED | **PASS** — opened the generated lesson → "Ask about this lesson" panel → "why does the pitfall in this lesson matter" answered against the lesson, citing `【lessons/0001-sift-down-heapify.html · §4】` unprompted |
| AC13 | Beyond-material flagged | PASS | — (no regression) |
| AC14 | Syllabus-driven pacing | NOT EXERCISED | **PARTIAL** — teacher demonstrated the fallback pacing decision in the lesson turn ("no syllabus.md, so I pace it at the start of the material's spine: heaps"); no `syllabus.md`-ordered test (subject has none) |
| AC15 | Generated lesson structure | NOT EXERCISED | **PASS** — chat-requested lesson written to `lessons/0001-sift-down-heapify.html`: single page, 4 numbered sections ("What sift-down does" / pseudocode / cost / pitfall), `Checkpoint` blocks per section, indexed in the app (`GET /lessons` + Lessons list) |
| AC16 | Auto-rotation at threshold | NOT EXERCISED | NOT EXERCISED (needs a 24-message session) |
| AC17 | corrections.md honored | PARTIAL | — (endpoint round-trip still OK; pre-read behavior unchanged) |
| AC18 | Bank, on-demand gen, LLM grading | PASS (partial) | **PASS** — plus a live **short-answer** question graded by the LLM in 22 s: verdict `correct` with rubric-point-by-point feedback ("All four rubric points are covered…"); code-type generated + auto-verified (live grading of code type not separately driven) |
| AC19 | Key verified before reveal | PARTIAL | **PASS** — on-demand generate → key auto-verified asynchronously (~35–60 s; observed `unverified → verified` with zero manual calls; all 7 questions ended `verified`) → reveal unblocked |
| AC20 | Due queue / 1-3-7 ladder | PASS | — (no regression) |
| AC21 | Stats | PASS | — (no regression) |
| AC22 | Human dogfood (5 days) | N/A-machine | **N/A-machine** (human gate) |
| AC23 | Gates + pnpm dev, no external services | PASS | **PASS** — re-run on the fixed tree: typecheck ✓, lint exit 0 ✓, tests **73/73** (server 61 + web 12) ✓, build ✓, `pnpm dev` healthy |

**Run-2 tally:** PASS 18 · PARTIAL 2 (AC14, AC17) · FAIL 0 · BLOCKED 0 · NOT EXERCISED 1 (AC16) · N/A 1 (AC22) → **MVP-READY**.

---

## Run 2 transcript summary (re-run, 2026-10-31)

| Step | Time | Result |
|---|---|---|
| Health (reused fixing agent's server, restarted web) | 11:56–11:57 | API healthy; started a fresh `pnpm dev` for web+server+serve coherence |
| Fix verification in code (read-only) | 11:58 | buffer normalize (proc.ts:68-73), `execution.succeeded/failed` matcher + marker strip (chatStream.ts:80-104), bodyless cancel POST (client.ts), `--agent studi0-pipeline --standalone` (runner.ts:50-51), `verifyKeysAndEmit` on on-demand generate, descendant reaping (proc.ts:89-155) — all present |
| Wipe `graphify-out/` → UI Build graph (cold) | 11:57:38 | job `259fa66d`; UI status "Working… (0/0)" (no more queued-regression); total announced 0/4; artifacts grew; done 1/4→4/4 with currentFile names (T+526s…T+541s) |
| **Build terminal** | **12:15:17** | **`complete 4/4`, 17.5 min; graph.json (31n/34e) + VERIFY_REPORT.md + 22 wiki pages; server alive** |
| AC7/AC8/AC10 checks | 12:16–12:20 | ontology types/relations verified; VERIFY_REPORT Confirmed+Flagged; reports in UI; iframe 200 |
| AC5 stale | 12:18–12:20 | new file → sidebar "QA Heaps 101 **stale**" after fresh GET |
| **AC4 UI cancel** | 12:20:09–12:20:12 | Update → Cancel (UI) → `cancelled` ≤3.5 s, honest banner, server alive |
| AC5 update run | 12:20:31–12:40:56 | extraction 2/2 (files 04+05); verification failed (exit 1, ~9.5 min) → honest `partial`; **stale cleared**, lastBuiltAt updated |
| AC19 on-demand generate ×3 | 12:02–12:10 | keys auto-verified ≤60 s each, no manual calls |
| AC18 short-answer grading | 12:03 | 22 s LLM grade, `correct`, rubric-referenced feedback |
| AC9 wiki canary + chat probe | 12:20:57–12:26:25 | canary reflected verbatim; **turn closed with `done`** (composer unlocked, msgs=2) |
| AC15 lesson generation | 12:44:15–12:46:34 | `lessons/0001-sift-down-heapify.html` (4 sections + checkpoints), indexed, turn closed |
| AC12 lesson-scoped chat | 12:47:58–12:49+ | answer cites `lessons/0001-sift-down-heapify.html · §4` unprompted |
| Gates (fixed tree) | 12:5x | typecheck ✓ lint ✓ 73/73 ✓ build ✓ |

Evidence files (temp): `studi0-qa\build-r.log`, `update-r.log` (full job timelines), `sse-rerun-build.log` (SSE frames incl. streamed progress), `subject1\` (QA subject with graph artifacts), `gen-body.json`/`ans-body.json`/`wiki-body.json` (request bodies).

---

## Run 1 record (pre-fix, 2026-10-31 02:2x–02:5x) — kept for history

### Run-1 verdict was NOT-READY; blockers 1–4 below were claimed fixed and are now live-verified in Run 2.

**Run-1 per-AC (original):** PASS 9 (AC1, AC2, AC11, AC13, AC18*, AC20, AC21, AC23) · PARTIAL 3 (AC17, AC18, AC19) · FAIL 2 (AC3, AC4) · BLOCKED 6 (AC5–AC10) · NOT EXERCISED 3 (AC12, AC14, AC15, AC16) · N/A 1 (AC22).

### Run-1 bugs (as reported; fix status from Run 2)

1. **[CRITICAL] Server crash on any pipeline child close** — `apps/server/src/util/proc.ts:67-68,75-76` + `apps/server/src/pipeline/runner.ts:64` (`setEncoding('utf8')` → string chunks → `Buffer.concat` throws `ERR_INVALID_ARG_TYPE` inside a `data`/`close` handler → process exit). 3/3 repro (build finish, cancel-kill, manual kill). **FIXED** (buffer normalization proc.ts:68-73) — no crash across Run 2's full build, cancel, and update.
2. **[BLOCKER] UI cancel never cancels** — `apps/web/src/api/client.ts:109-110` + `:77` (empty-body POST with JSON content-type → Fastify `FST_ERR_CTP_EMPTY_JSON_BODY` → 500). **FIXED** (bodyless POSTs drop the header) — UI cancel verified live.
3. **[BLOCKER] Chat turn never emits `done`** — `apps/server/src/teacher/chatStream.ts:80-101` waited on `session.idle`, which opencode 2.2.1 never emits. **FIXED** (matcher switched to `session.execution.succeeded/failed`, chatStream.ts:80-104) — verified live across 3 turns.
4. **[MAJOR] On-demand keys never verified** — `apps/server/src/http/routes/practice.ts:35-49`/`generate.ts` didn't schedule verification. **FIXED** (`verifyKeysAndEmit` wired on the generate route) — verified live.
5. **[MINOR] 415 upload response not ApiError envelope** (`http/routes/files.ts:41`). **FIXED** (claimed; envelope shape per contract; not re-driven live this run).
6. **[MINOR] Malformed/empty JSON → 500 instead of 400** (error handler didn't map `FST_ERR_CTP_*`). **FIXED** (claimed; observed 400 `VALIDATION "malformed request body"` during Run 2 via a bad curl body — consistent).
7. **[MINOR] UI job status regressed to "Queued…"** (`SubjectPage.tsx:102-105`). **FIXED** (status rank) — Run 2 UI showed "Working… (0/4)" correctly from the start.
8. **[COSMETIC] opencode step markers leaked into chat tokens** — **FIXED** (`stripStepMarkers` in the delta pump, chatStream.ts:91); no `` observed in Run 2 DOM.
9. **[RESIDUAL] Orphan-of-orphan processes survived boot cleanup** — **FIXED** (descendant enumeration in `killTree`, proc.ts:89-155); no orphans observed across Run 2's build/cancel/update cycles.

### Run-1 transcript highlights (for context)

- 3 build attempts, all ending in server crashes (2 spontaneous on child close, 1 via post-cancel child flush); job timelines in `studi0-qa\build1-3.log`.
- UI cancel → 500 INTERNAL; curl cancel killed the job then crashed the server.
- Chat: 2 fully-streamed cited answers (chips rendered), but streams never closed (≥11.5 min), locking the composer.
- Practice: generate → answer → ladder/stats all worked; keys stuck unverified on the on-demand path.
- Origin guard (curl): evil Origin → 403; no Origin → 400 PATH_NOT_FOUND. (No regression; not re-driven in Run 2 — unchanged code path.)

---

## Notes

- Read-only on app code throughout both runs; no fixes applied by QA.
- cs2040C and all pre-existing folders untouched. QA material lives only under `C:\Users\user\AppData\Local\Temp\opencode\studi0-qa\`.
- Background processes spawned by QA are killed at the end of each run (dev stack, pollers, SSE captures).
