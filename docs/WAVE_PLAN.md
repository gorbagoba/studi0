# Wave plan — performance + lifecycle (2026-11-01)

## Settled decisions (grill round complete)
- **Perf full slate**: runner-driven chunk-wave orchestration · build-log SSE · React.lazy tabs
- **PDF-split assistant**: in-app, big semester PDF → per-lecture PDFs in `material/`
- **Lifecycle pair**: root `pnpm stop` (server + vite + managed serve) + shutdown confirm lists running state + copyable restart on the post-shutdown page
- **No extras** this round (graph-links, dashboard, search, backup deferred)
- **Execution**: one wave, commits sliced per task, one gate pass at the end

## Architecture notes
- **Waves**: runner asks the pipeline agent for a chunk PLAN only (JSON list of chunk prompts), then executes waves of ≤4 chunk extractions itself via headless `opencode run --agent studi0-pipeline`, then a final agent run merges + exports. Progress/log events unchanged in shape (SSE + build.log), wave scheduling server-side. Resume semantics unchanged (graphify chunk cache).
- **SSE log**: runner emits `log` events on the subject event bus (line + timestamp); JobPanel subscribes via existing `openSubjectEvents`; the tail endpoint stays for history/pre-connection lines.
- **PDF-split**: `POST /api/subjects/:id/split-pdf {file}` → python (`pypdf`) splits into `<stem>_pNN.pdf` next to the original in `material/`; original untouched; response lists parts. File-browser action on PDFs.
- **Stop script**: `scripts/stop.mjs` — finds listeners on 3001/5173/44096 (netstat), verifies identity (command line contains `node`/`opencode`/`tsx`), `taskkill /T /F` each; POSIX branch best-effort (`kill -pid`). Root script `stop`. UI shutdown confirm fetches `/api/health` first and lists jobs/teacher; post-shutdown page shows copyable `pnpm dev`.

## Deferred (tracked)

- **L5 (security review): agent-child env allowlist** — wave children inherit the full process env (provider keys reachable by LLM-driven bash). Pre-existing, now multiplied by wave children. Fix: explicit env allowlist in `proc.ts` spawnArgs + verify opencode's edit-permission cwd scoping. Tracked ticket, not a wave blocker.

## Risks
- Wave runner must keep API-contract shapes (progress/log) stable — addendum documents the new `log` SSE event + split endpoint.
- pypdf availability in the managed python env — verify at implement time; fallback `pip install pypdf` documented in BUILD.md.
- Host allowlist: split endpoint is POST — covered by the existing guard automatically.

## Tasks
- T-P1 · backend · runner wave orchestration (+ plan one-shot) · waves ≤4 · resume unchanged
- T-P2 · backend · `log` SSE events in runner + JobPanel contract line
- T-P3 · backend · split-pdf route + python script + contract + file-browser action wiring point
- T-P4 · scripts · `pnpm stop` + shutdown confirm summary + post-shutdown copy (web + scripts)
- T-P5 · web · lazy tabs (React.lazy + Suspense on tab panels) + SSE log pane wiring
- T-P6 · review+security on changed files (new POST endpoint + python exec = security-reviewer required)
- T-P7 · gates + QA spot-check (cancel a wave mid-run, split a real PDF)
