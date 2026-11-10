# BUILD — setup, run, verify

## Setup (one-time)

### 1. The easy path: `pnpm setup`

```sh
corepack enable   # only if pnpm is missing
pnpm setup
```

`scripts/setup.mjs` (single cross-platform node script — no bash/ps1 twins) checks and reports:

- **runtimes**: node ≥20, pnpm (via corepack), python ≥3.12
- **pinned pip packages**: `graphifyy==0.9.95`, `pypdf>=6,<7` — installed only if missing/wrong version, never re-installed when satisfied
- **AI harnesses**: `opencode` / `claude` / `codex` are *detected* (`--version`), never auto-installed; opencode's login state is probed (`opencode auth list`), the others report "login state unknown"
- **optional skills install** (opt-in: `pnpm setup --with-skills`, or an interactive yes in a terminal): installs the graphify skill for direct opencode use via `pnpm dlx skills add … -g -y` (registry-name fallback; any failure is a printed warning, never a setup failure)
- **ports**: `PORT` (3001), `OC_PORT` (44096), `VITE_PORT` (5173), `PREVIEW_PORT` (4173) are probed by binding; a busy port gets the next free one, and every deviation from the defaults is written to a repo-root `.env` (an existing `.env` is never touched without `--force`)
- then runs `pnpm install` + `pnpm build` and prints next steps.

### 2. Manual

1. node ≥20 + `corepack enable` (pnpm) + python ≥3.12
2. `python -m pip install 'graphifyy==0.9.95' 'pypdf>=6,<7'`
3. install an AI harness yourself, e.g. opencode → `opencode auth login`
4. if any default port is taken, write the overrides yourself:
   ```sh
   echo 'PORT=3001'  > .env   # API      (default 3001)
   echo 'OC_PORT=44096' >> .env # managed opencode serve (default 44096)
   echo 'VITE_PORT=5173' >> .env # web dev server       (default 5173)
   echo 'PREVIEW_PORT=4173' >> .env # vite preview     (default 4173)
   ```
   The server derives its security Host-allowlist from these, so whatever you pick here is what the UI is trusted on.
5. `pnpm install && pnpm build`

### Platform honesty

The POSIX branches of the process code (process-group spawn/kill via `detached`, `lsof` port lookup, `python3` resolution) are **unit-tested but not yet live-booted on Linux/macOS** — there is no Linux CI in this repo. The first real Linux run is the moment of truth; Windows paths are QA-verified.

### Calibrate your provider

`pnpm calibrate` was retired: graph extraction now runs graphify directly (its own 4-way parallel chunk pool), so the `STUDI0_MAX_CHUNK_CONCURRENCY` knob it tuned no longer exists.

## Run

```sh
pnpm dev      # API + web + managed opencode serve (parallel, streamed)
pnpm stop     # graceful stop of all three (add --force for stubborn pids)
pnpm preview  # serve the built web app
```

## Verify

```sh
pnpm typecheck            # all 3 packages
pnpm lint
pnpm -C apps/server test  # vitest
pnpm -C apps/web test     # vitest
pnpm build                # tsc --noEmit (server/shared) + vite build (web)
```
