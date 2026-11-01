# Wave plan — portability (Linux/macOS) + setup script + configurable ports (2026-11-01)

## Settled decisions
- Ports become **env-configurable** (`PORT` API, `VITE_PORT` frontend, `OC_PORT` teacher serve) with **derived security allowlist** and auto-pick on collision (setup script writes `.env`)
- Full POSIX port of process management; setup script wires runtimes + AI harnesses (detect, never auto-install CLIs)

## Tasks
- **T-X1 POSIX process port** (`util/proc.ts`, `teacher/opencode.ts`, `subjects/files.ts`):
  - `spawnArgs`: spawn children with `detached: true` on non-Windows (Node docs: child becomes process-group leader) → `killTree` POSIX branch kills the **group** (`process.kill(-pid, 'SIGKILL')`) — fixes the orphaned-grandchild class on Linux/macOS. Windows path unchanged (QA-verified).
  - `resolveOpencodeBin`: POSIX uses `which opencode` (bare name is spawn-safe there).
  - `pidListeningOn`: POSIX branch via `lsof -ti :port` (pattern proven in stop.mjs).
  - `runPython`: POSIX tries `python3` then `python` (the `py -3` launcher is Windows-only).
- **T-X2 Configurable ports**: `config.ts` reads `PORT`/`OC_PORT` (+ defaults 3001/44096); `apps/web/vite.config.ts` reads `VITE_PORT` (default 5173) and proxies to the API port env; `app.ts` Host allowlist derives **all** entries from config (api + vite + preview ports — no hardcoded 5173/4173); zombie cleanup already keys on `cfg.ocPort` ✓. Tests that inject Host headers get the values from a test config (port 80 default already allowlisted).
- **T-X3 `scripts/setup.mjs`** + root `pnpm setup`: runtime checks (node ≥20, corepack/pnpm, python3 ≥3.12) → pinned pip installs (`graphifyy==0.9.95`, `pypdf>=6,<7`) → AI-harness detection (`opencode/claude/codex --version` + auth probe; report ready/login-needed/not-installed; **never auto-install**) → port probe with **auto-pick** of free ports → writes `.env` → `pnpm install` + `pnpm build` → next-steps printout. BUILD.md gains a setup section.
- **T-X4 Platform-honest tests**: pure-function tests for lsof/netstat parsing + plan parsing stays platform-free; live-Linux verification is **explicitly out of scope locally** (no Linux machine/CI in this repo) — tracked as the one remaining risk, plus `proc.test.ts` reaper test as the future CI tripwire.
- **T-P6' Security re-check** on the allowlist-derivation diff (security-reviewer, focused).
- **Gates**: typecheck/lint/tests/build green; commits sliced per task.

## Risks
- No Linux/macOS machine available: POSIX branches are unit-tested + docs-verified but not live-booted — first real Linux run is the moment of truth (flag in BUILD.md).
- Vite port override changes the proxy target — must read the same env, or the UI 403s itself.
- Friends' setup UX depends on their distro python naming (python3 vs python) — handled by try-order.
