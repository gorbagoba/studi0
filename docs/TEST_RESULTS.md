# studi0 — QA Test Results (T12)

**Date:** 2026-10-31 · **Runner:** QA subagent · **Mode:** real-integration E2E (live UI at 127.0.0.1:5173, real headless `opencode run` / SoCLaaS calls, real graphify pipeline) + gates.

**Environment:** Windows, pnpm workspace, `pnpm dev` (web :5173 + server :3001 + managed `opencode serve` :44096). QA subject `QA Heaps 101` registered by path from `C:\Users\user\AppData\Local\Temp\opencode\studi0-qa\subject1` (3 md files: 2 seed + 1 uploaded). Second subject `QA Cancel Test` for the cancel-path test. cs2040C and all pre-existing folders untouched (read-only on app code throughout).

---

## Verdict: **NOT-READY**

The app-shell, chat, practice, upload, and guard flows genuinely work against live model calls, but **every graph pipeline run kills the whole server process** (3/3 reproducible, independent of how the child exits). Cancel via the UI is also broken (malformed request → 500 → job never cancels), and chat streams never emit `done` (composer locks). These are MVP-blocking.

**Blockers (must fix before ship):**
1. **Server crash on any pipeline child close** — `apps/server/src/util/proc.ts:75` (+ root enabler `apps/server/src/pipeline/runner.ts:64`). Unhandled `ERR_INVALID_ARG_TYPE` in `Buffer.concat`; the Node process exits. AC3, AC4, AC5–AC10 all fail or are blocked by this.
2. **UI cancel never cancels** — `apps/web/src/api/client.ts:109-110` + `:77` (POST with `content-type: application/json` and empty body → Fastify `FST_ERR_CTP_EMPTY_JSON_BODY` → app error handler returns 500). AC4 fails even without blocker 1.
3. **Chat turn never terminates with `done`** — turn completes server-side (history proves it) but the `session.idle` match in `apps/server/src/teacher/chatStream.ts:80-101` never fires; stream stays open ≥11 min; UI composer locks in "Streaming…". 
4. **On-demand question keys never verified** — `apps/server/src/http/routes/practice.ts:35-49` / `apps/server/src/practice/generate.ts` never schedule the verification pass (contract: "verification runs right after… a `questions` SSE event fires when done"). Auto-deposit path does verify (`teacher/practiceFeed.ts`).

---

## Per-AC status

| AC | Requirement (short) | Status | Evidence / note |
|----|---------------------|--------|-----------------|
| AC1 | Register folder by path, in place, nothing copied | **PASS** | UI register-by-path → sidebar lists subject, file browser shows both seed files; `data/subjects` never created; original files untouched (server only ensured missing teach-workspace layout in place, per ARCHITECTURE) |
| AC2 | Batch upload into `material/`, per-file accept/reject | **PASS** | Uploaded 3rd .md via upload zone → appeared in browser listing. Mixed upload (1 md + 1 txt) → 200 `{accepted:[01-heaps-1.md], rejected:[qa-reject-notes.txt, "unsupported type"]}` incl. collision-suffix `-1`. txt-only → 415. 5-PDF scale not exercised (no PDFs at hand). Minor: 415 body is not the ApiError envelope (bug 6) |
| AC3 | Build streams progress → complete, `graph.json` exists | **FAIL** | 3 build attempts (02:26:53, 02:33:33, 02:37:41). Attempt 3 ran **15.7 min at 0/0 with zero progress events** (child alive, ~3.7 s CPU — stuck on model calls); every attempt ended with the server process crashing (bug 1) before/instead of completion. `graphify-out/` only ever contains the empty `wiki/` scaffold; `graph.json` never produced. Job rows post-restart: `failed "server restarted"` |
| AC4 | Cancel within 5 s, honest report | **FAIL** | UI Cancel click → `POST /api/jobs/:id/cancel` 500 INTERNAL (`FST_ERR_CTP_EMPTY_JSON_BODY`), job stays `running`, error banner "INTERNAL: internal server error" (bug 2). curl cancel (no content-type) → 200 `cancelling`, child tree killed within ~1 s, **then the server crashed on the child's stdout flush (bug 1)** — no clean terminal state survives |
| AC5 | Stale badge after material change | **BLOCKED** | Requires a completed build (`last_built_at`); no build ever completed |
| AC6 | Partial-failure reporting | **BLOCKED** | Requires extraction reaching the end; no run got past model recon before the crash |
| AC7 | Ontology-typed nodes/edges | **BLOCKED** | No `graph.json` produced |
| AC8 | Verification agent + report | **BLOCKED** | Verification (second headless run) never reachable; `VERIFY_REPORT.md` never written |
| AC9 | Wiki edit is canon | **BLOCKED** | No wiki pages exist (no build); corrections.md PUT/GET works (200 round-trip) as the adjacent path |
| AC10 | `graph.html` iframes in-app | **BLOCKED** | No graph.html; the empty state renders ("No graph yet") and GraphView wiring is present (`GraphView.tsx` iframes raw passthrough with `sandbox="allow-scripts"`) |
| AC11 | Chat answer cites `source_location` | **PASS** | 2 questions answered via real teacher stream with rendered citation chips (DOM `[class*=citation]` count = 3), e.g. `【02-heaps-to-priority-queues.md · Priority queues, L24–25】`, `【01-heaps.md · §5 table, L98–100】`; preamble correctly notes "graph is mid-rebuild". Caveat: stream never closes (`done` missing — bug 3) |
| AC12 | Lesson-scoped chat | **NOT EXERCISED** | No lesson exists to scope to (depends on builds/lesson generation) |
| AC13 | Beyond-material flagged | **PASS** | Asked about Shellsort (absent from corpus): answer states "Is it covered? No" and marks the complexity section "*Beyond the material:* (from general knowledge, not course fact)" — exact PRD phrasing |
| AC14 | Syllabus-driven lesson order | **NOT EXERCISED** | QA subject has no `syllabus.md`; teacher lesson proposal not observed (see AC15) |
| AC15 | Generated lesson structure | **NOT EXERCISED** | Lesson generation not driven in this run (chat turns already hang at close; adding a lesson-writing turn would add another orphan stream without changing the verdict) |
| AC16 | Auto-rotation at threshold | **NOT EXERCISED** | Requires a 24-message session; out of scope for a smoke run |
| AC17 | corrections.md honored | **PARTIAL** | `PUT/GET /corrections` round-trips (200). The teacher's step narration shows protocol adherence ("Checking learning-records as required…"); a dedicated notation-honored answer was not isolated |
| AC18 | Practice bank, on-demand gen, grading | **PASS (partial)** | On-demand generation of 1 MCQ on "binary heaps" (~40 s) → bank + due immediately; answering graded instantly with feedback + ladder update. MCQ grading is offline exact-match; live LLM grading (short/code) not exercised. Auto-deposit path unexercised (needs lessons) |
| AC19 | Key verified before reveal | **PARTIAL** | Reveal with verified key → 200 `{key:{answerIndex:1}}`. Manual `POST /verify-key` runs the real second-pass (16 s, source-checked justification citing `material/01-heaps.md`). **But on-demand keys are never auto-verified** (bug 4) → out of the box the gate is stuck at 409; unverified-409 path itself covered by unit tests, not re-driven live |
| AC20 | Due queue / 1-3-7 ladder | **PASS** | Correct answer → `next review in 1 day(s)` (+1 d step 1), due count 1→0, streak 0→1 |
| AC21 | Stats | **PASS** | `GET /practice/stats` → `{perTopic:[{topic:"binary heaps",attempts:1,correct:1,accuracy:1}], dueCount:0, streakDays:1, totalQuestions:1}`; UI Progress cards match |
| AC22 | Human dogfood (5 days) | **N/A-machine** | Human-only gate |
| AC23 | Gates + pnpm dev, no external services | **PASS** | `pnpm -r typecheck` ✓ · `pnpm lint` exit 0 ✓ · `pnpm -r test` 60/60 (server 52 + web 8) ✓ · `pnpm -r build` ✓ · `pnpm dev` serves both ports ✓ · localhost + local opencode/SoCLaaS only |

**Tally:** PASS 9 · PARTIAL 3 · FAIL 2 · BLOCKED 6 · NOT EXERCISED 3 · N/A 1 — verdict **NOT-READY** (2 hard FAILs + 6 ACs blocked by the same root cause).

---

## E2E transcript summary (live UI loop)

| Step | Time (local) | Result |
|---|---|---|
| Health | 02:25 | `{"ok":true, opencode:{running:true,pid:48920,port:44096,healthy:true}}`, web 200 |
| Register subject by path (UI dialog) | 02:25:56 | 201; sidebar + file browser show 2 files; teach-workspace layout ensured in place; nothing copied |
| Upload 3rd .md (upload zone) | 02:26:40 | 200; `material/qa-upload-03-exercises.md` appears |
| Reject path | 02:38:3x | txt-only → 415; mixed → 200 per-file (see AC2) |
| Build #1 (UI Build graph) | 02:26:53 | `running` 0/0; killed at 4.8 min by server crash triggered from the *other* subject's cancel test |
| Origin guard (curl) | 02:27 | `Origin: https://evil.example` → **403**; no Origin → 400 `PATH_NOT_FOUND` (past guard, no side effect) |
| Cancel test subject + build (UI) | 02:30:42 | queued→running (SSE frames captured on a raw curl listener: `queued`, `running`, `cancelling` all emitted correctly by the server) |
| UI Cancel click | 02:31:00 | **500 INTERNAL**; job stays running; UI banner "INTERNAL: internal server error" (bug 2) |
| curl Cancel (no content-type) | 02:31:00+ | 200 `cancelling`; child tree killed; **server crashed ~1 s later on child stdout close** (bug 1, instance 1) |
| Restart + boot cleanup | 02:32:51 | both stale rows closed `failed "server restarted"` (works as specified) |
| Build #2 (UI) | 02:33:33 | `running` 0/0; **server crashed at T+106 s** when the child flushed output and closed (bug 1, instance 2) |
| Chat #1 (AC11 question) | 02:33:59 → 02:35:32 | full cited answer streamed with 3 citation chips; stream cut by the crash before `done` |
| Restart | 02:36 | healthy |
| Build #3 (UI) | 02:37:41 | `running` 0/0 for 15.7 min, zero progress events (child alive, ~3.7 s CPU — model-call latency, no `studi0-progress` lines emitted); **15-min budget exceeded → FAIL**; manual child kill at 02:55 → **server crash (bug 1, instance 3)** |
| Corrections PUT/GET | 02:38–02:39 | 200 round-trip |
| Practice generate (UI) | 02:40:01 → 02:40:41 | 1 MCQ generated (~40 s), due immediately, `on_demand`, key unverified |
| Manual verify-key | ~02:44 | 200 `verified` in 16 s with source-checked reason |
| Answer MCQ (UI review) | 02:43:34 | verdict correct, feedback shown, due 1→0, streak→1, next due +1 d (ladder step 1) |
| Reveal key | 02:44 | 200 `{key:{answerIndex:1}}` |
| Chat #2 (heapsort in-place) | 02:44:12 | cited answer streamed (3 chips); **`done` never arrived (≥11.5 min; answer complete at ~1 min — opencode history shows the turn finished); composer locked in "Streaming…"** (bug 3) |
| Chat #3 (Shellsort / AC13) | 02:50:39 | "Beyond the material:" flag present with general-knowledge complexity; same non-terminating stream behavior |
| Gates | 02:52 | typecheck ✓ lint ✓ 60/60 tests ✓ build ✓ |

**Graph pipeline reality check (AC3):** the headless `opencode run` child never emitted a single `studi0-progress` line in any attempt (0/0 forever, `currentFile` null). Whether that is prompt adherence or model latency cannot be judged from the app side — but it is moot while bug 1 crashes the server on child close: **no graph build can ever complete on this code**.

---

## Bugs found (report-only; no app code touched)

1. **[CRITICAL] Whole-server crash on pipeline child close — kills builds and cancels.**
   `apps/server/src/util/proc.ts:67-68` types stdout/stderr collectors as `Buffer[]` and `proc.ts:75-76` does `Buffer.concat`, but `apps/server/src/pipeline/runner.ts:64` calls `child.stdout.setEncoding('utf8')` after spawn → every chunk is a **string** → `TypeError [ERR_INVALID_ARG_TYPE]` synchronously inside the child `close`/`data` handler → uncaught → **process exits**.
   *Repro (3/3):* enqueue a build; when the `opencode run` child produces any stdout and then closes (own exit, cancel-kill, or manual kill) → server dies (`pnpm dev` log: `ERR_INVALID_ARG_TYPE … at proc.ts:75:26`), all SSE streams ECONNRESET, all job rows become `failed "server restarted"` after reboot. Crash also fires when a build *finishes normally*, so AC3/AC10 and everything downstream is unreachable. `util/oneshot.ts` does **not** setEncoding, which is why practice/verify one-shots survive — the fix is to keep chunks as Buffers in `spawnArgs` (or drop the `setEncoding` in the runner).
2. **[BLOCKER] UI cancel request is malformed → 500 → job never cancels.**
   `apps/web/src/api/client.ts:109-110` (`cancelJob` → `send('POST', path)` with no body) + `apps/web/src/api/client.ts:77` (unconditional `content-type: application/json`). Fastify 5 rejects an empty JSON body (`FST_ERR_CTP_EMPTY_JSON_BODY`, 400) and the app error handler maps it to **500 INTERNAL**; `killJob` never runs. *Repro:* start any job → click Cancel in the UI → banner "INTERNAL: internal server error", job stays `running`, child keeps running. Fix: omit the header/body for bodyless POSTs (curl without content-type works: 200 `cancelling`).
3. **[BLOCKER] Chat turn completes but never emits `done` → composer locks.**
   `apps/server/src/teacher/chatStream.ts:80-101` waits for `session.idle` matching `session.oc_session_id`; the SDK/opencode turn demonstrably finishes (proxied history shows the full assistant reply) but no matching terminal event arrives — the stream stays open until the 15-min `TURN_TIMEOUT_MS` (chatStream.ts:17,109) resolves it as failed. *Repro:* any chat question; answer streams fully, "Streaming…" persists (observed ≥11.5 min), Send button disabled → no further messages can be sent in the panel. (Client impact: `apps/web/src/chat/ChatPanel` has no stream timeout.)
4. **[MAJOR] On-demand questions never run key verification.**
   Contract: generate → keys unverified → "verification runs right after and completes asynchronously (a `questions` SSE event fires when done)". `apps/server/src/http/routes/practice.ts:35-49` and `apps/server/src/practice/generate.ts` never call `verifyQuestionKey` (only the auto-deposit path, `apps/server/src/teacher/practiceFeed.ts:25-28`, does). *Repro:* `POST /api/subjects/:id/questions/generate {topic:"binary heaps",count:1}` → key stuck `unverified` (>2.5 min, no `questions` SSE event, no verify oneshot in server logs) → `reveal-key` is permanently 409 until the user manually hits `POST /verify-key` (that endpoint works: verified in 16 s).
5. **[MINOR] 415 upload response is not the ApiError envelope.**
   `apps/server/src/http/routes/files.ts:41` returns `{accepted:[],rejected:[…]}` with status 415; contract says non-2xx use `{"error":{code,message,…}}`. The web client's `toApiError` can't parse it → UI shows "INTERNAL: Request failed (415)" instead of the real reason. Server logic itself is correct (per-file accept/reject + 415-only-when-nothing-acceptable).
6. **[MINOR] Malformed/empty JSON bodies return 500 instead of 400.**
   Fastify body-parser errors (`FST_ERR_CTP_INVALID_JSON_BODY` / `FST_ERR_CTP_EMPTY_JSON_BODY`, statusCode 400 on the error object) are not special-cased by the app error handler → 500 `INTERNAL` (observed on PUT /corrections with invalid JSON and on the bug-2 cancel). Client mistakes should map to 400 VALIDATION per ARCHITECTURE.
7. **[MINOR] UI job status regresses to "Queued…" after SSE already said `running`.**
   `apps/web/src/subjects/SubjectPage.tsx:102-105`: `onStarted` sets `liveJob` from the POST 202 response (status `queued`); the queued→running SSE events were already emitted *before* the 202 was sent (queue.ts emits inside `pump()` prior to the response), and their `setLiveJob(running)` is overwritten by the later-resolving fetch → the panel shows "Queued — waiting for a pipeline slot…" while the job is `running` (observed on every build). Self-heals on the next SSE job event — but a silent pipeline (0/0 with no progress lines) leaves it wrong for the whole run, the exact "black box" US4 forbids.
8. **[COSMETIC] opencode step markers leak into chat tokens/UI/history.**
   Assistant text carries stray `§N§` markers (raw codepoints `167,56,167,32 = "§8§"` at message start; visible in the DOM and in proxied history). `chatStream.ts:81-83` pumps `session.text.delta` verbatim — the markers are opencode part/step markers that studi0 should strip (or the SDK should not include). Not harmful, but they pollute lessons/tokens and the crash dump in bug 1 shows the same artifact on pipeline stdout.
9. **[RESIDUAL] Orphan-of-an-orphan processes survive boot cleanup.** Boot cleanup closes stale job rows and kills recorded pids, but a grandchild `opencode`/Python process (no recorded pid, parent died in the crash) remained alive after two restarts (pid 36316, killed manually at cleanup). Architecture acknowledges this risk class; consider a boot-time sweep of `opencode` processes not owned by the manager.

---

## Honest status of the required deliverables

- **(2) QA subject + cross-file material:** done (2 seed files + 1 uploaded; cs2040C untouched).
- **(3a–c) Register → sidebar/browser → upload → build:** register/upload PASS; **build FAIL** (crash + 15.7 min 0/0; budget exceeded; failure detail = server crash, no job-side failure detail because the process died first).
- **(3d) Graph view / report / wiki:** empty states render; real views blocked (no artifacts).
- **(3e) Chat:** streamed cited answers PASS (2 turns, 3 chips each); AC13 flag PASS; `done` never arrives (bug 3) — SSE error event could not be captured for the hang because the server died in unrelated crashes; server logs captured in `docs/`-adjacent evidence below.
- **(3f) Practice:** generate (~40 s) → answer → grading feedback → due/streak/stats updates all PASS; key auto-verification missing (bug 4).
- **(4) Cancel path:** enqueue → cancel ≤5 s — **FAIL** via UI (bug 2) and server-crash via API (bug 1). SSE frames for queued/running/cancelling were captured and are correct server-side (`studi0-qa/sse-subject2.log`).
- **(5) Origin guard:** PASS (403 evil Origin; no-Origin passes; drive-by guard working).

**Evidence files (temp):** `C:\Users\user\AppData\Local\Temp\opencode\studi0-qa\` — `build1.log`, `build2.log`, `build3.log` (job timelines incl. budget overrun), `sse-subject2.log` (full job-event frames), `sse-subject1.log`, `sse-subject1-build3.log` (heartbeats + build3 frames), `subject1/` + `subject2/` (QA subjects). Raw dev-server logs retained in the session shell outputs (crash stacks quoted above).
