# BUILD

## Prerequisites (this machine — all verified present)

- **Node ≥ 24** and **pnpm 12** (canonical package manager — never npm/yarn/npx)
- **Python 3.14** with **graphifyy pinned at 0.9.95** (`python -m pip install graphifyy==0.9.95`) — required only for graph builds
- **opencode CLI** (≥ 2.2.1) on `PATH` — the server manages `opencode serve` itself; graph pipeline and one-shots run headless `opencode run` (SoCLaaS model access configured in opencode itself)
- No external services; everything binds to 127.0.0.1

## Commands

```sh
pnpm install          # workspace: apps/web + apps/server + packages/shared
pnpm dev              # web 127.0.0.1:5173 (proxies /api) + server 127.0.0.1:3001
```

| Gate      | Command          |
| --------- | ---------------- |
| Typecheck | `pnpm typecheck` |
| Lint      | `pnpm lint`      |
| Tests     | `pnpm test`      |
| Build     | `pnpm build`     |

`pnpm build` produces production bundles for both apps (`pnpm preview` serves them).

## Runtime data

- `data/` (gitignored) — SQLite database + registered subject paths
- Subjects are folders registered **in place** (nothing is copied); each holds `material/`, `graphify-out/`, teach-workspace files, `corrections.md`
- `graphify-out/` per subject (graph.json, graph.html, wiki/, GRAPH_REPORT.md) is gitignored
