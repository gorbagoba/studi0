# studi0

A chat-first, localhost learning platform. Drop in your university course material, build a verified knowledge graph from it, and study with a teacher that answers **from your material** — lessons, cited answers, and practice generated as you talk.

Single user, runs entirely on your machine. Your material never leaves it.

## What it does

- **Subjects** — each subject is a folder on disk (your existing course folders work; they're referenced in place, never copied)
- **Knowledge graph** — batch-upload PDFs/MDs; a pipeline chunks, extracts, and builds an ontology-typed graph (interactive view + editable wiki + verification report), with per-chunk progress, resumable caching, and honest partial-failure reporting
- **Teacher chat** — an AI teacher grounded in the graph + raw files: answers cite pages, flags anything beyond the material, runs lesson plans interactively (diagnose → plan → section-by-section with checkpoint questions), and writes comprehensive lessons into the subject folder
- **Practice engine** — auto-generated + on-demand questions (MCQ / short / code), LLM-graded against auto-verified answer keys, with a spaced due-today queue and stats
- **Diagnostics** — probe every service, restart a wedged teacher, cancel stuck builds, shut the whole stack down from the UI

## Requirements

- Node.js ≥ 20 + pnpm (`corepack enable`)
- Python ≥ 3.12 + pip
- An [opencode](https://opencode.ai) install, logged in to a provider (this is the AI harness the teacher runs on)

## Setup

```sh
pnpm setup      # checks runtimes, installs pinned Python deps (graphifyy, pypdf),
                # detects AI harnesses, probes ports (auto-picks free ones, writes .env),
                # then pnpm install + build
```

Optional flags: `--with-skills` also installs the graphify skill for driving opencode manually. Re-check your provider's safe concurrency anytime with:

```sh
pnpm calibrate  # ramps 2→4→6→8 concurrent test requests, writes the safe cap to .env
```

Then start everything:

```sh
pnpm dev        # web 127.0.0.1:5173 (proxies /api) + server 127.0.0.1:3001 + managed teacher
pnpm stop       # cleanly stops all three (graceful API drain first)
```

Ports are configurable via `.env` (`PORT`, `VITE_PORT`, `OC_PORT`) — the security allowlist derives from the same values.

## Using it

1. **Add a subject** — point studi0 at a folder (e.g. your `CS2107` course folder). Existing teach-style workspaces are adopted as-is.
2. **Upload material** — Material tab, batch upload. Big semester PDF (>15 MB)? Use **Split into parts** on the file row first — chunks extract better and builds stay resumable.
3. **Build the graph** — Graph tab → Build. Watch the live build log (streams per chunk). Cancel anytime; re-runs resume from cache. Status lands `complete` / `partial` (failed chunks named) / `failed` (reason + log).
4. **Course setup** — Setup tab: exam targets, weak topics, study hours, anything urgent. Written verbatim into the subject's `MISSION.md`; the teacher treats it as canonical.
5. **Learn** — Chat tab. Ask anything (answers cite your files); say *teach me X* for the full interactive lesson flow; click **Course setup** to redo onboarding in chat. Lessons appear in the Lessons tab as they're written.
6. **Practice** — Practice tab: due-today queue, generate on demand, reveal keys after auto-verification.
7. **Maintain** — Settings tab (sidebar): probe services, restart the teacher, cancel stuck jobs. Edit wiki pages as canon; drop corrections into `corrections.md`.

### Each subject folder

| Path | Contents |
|---|---|
| `material/` | your uploads — the graph's source of truth |
| `graphify-out/` | `graph.json`, interactive `graph.html`, editable `wiki/`, `GRAPH_REPORT.md`, `VERIFY_REPORT.md`, `build.log` |
| `lessons/` `reference/` `assets/` | teacher-written lessons & material |
| `learning-records/` | progress notes — how the teacher remembers you across sessions |
| `MISSION.md` | course mission + your setup answers; read before every session |
| `corrections.md` | your feedback memory; read before each answer |

## Platform notes

- **Windows**: fully verified.
- **Linux/macOS**: supported by the same codebase (POSIX process groups, `python3`/`lsof` paths, setup script is cross-platform Node) — unit-tested, not yet live-booted on those OSes. `pnpm calibrate` is the first thing to run there.
- **Providers**: concurrency is provider-dependent — that's what `pnpm calibrate` is for. The default cap is 4.

## Development

| Gate | Command |
|---|---|
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Tests | `pnpm test` |
| Build | `pnpm build` |

Repo hygiene: `pnpm dlx knip` (dead code) per `docs/MAINTENANCE.md`. Architecture, PRD, API contract, and wave plans live in `docs/`. The API is contract-tested; the security model (CSRF/Host allowlist, path containment, agent permission confinement) is documented in the reviews appended to `docs/TEST_RESULTS.md`.
