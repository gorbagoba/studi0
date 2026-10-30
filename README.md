# studi0

Chat-first learning platform (localhost, single user). See `docs/` for PLAN, PRD, ARCHITECTURE, TASKS and API_CONTRACT.

## Quickstart (pnpm only — never npm/yarn/npx)

```sh
pnpm install
pnpm dev        # web 127.0.0.1:5173 (proxies /api) + server 127.0.0.1:3001
```

| Gate      | Command          |
| --------- | ---------------- |
| Typecheck | `pnpm typecheck` |
| Lint      | `pnpm lint`      |
| Tests     | `pnpm test`      |
| Build     | `pnpm build`     |
