# Weekly repo hygiene — studi0

One pass, ~15 minutes, every week. Run from the repo root. Never npm/yarn/npx — pnpm only.

## 1. Dead code + unused deps + duplicate exports

```sh
pnpm dlx knip
```

- Exit 0 with no output = clean. Any findings: verify each with `git grep -n "\b<symbol>\b"`, then
  either delete the symbol outright (only its declaration references it) or drop the `export`
  keyword (used internally, never imported). Remove orphaned type imports the same commit.
- Accepted exception (in `knip.json`): `netstat` is a Windows system binary, not a dependency.

## 2. Full gates (must all stay green)

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected baseline: **241 tests** (server 156 + web 85) — re-baseline this line after test-adding waves. Knip deletions that break a test mean the
"dead" symbol was used by the test — restore the export, not the test.

## 3. Junk scan

```sh
git status --short          # no stray untracked files
git clean -Xdn              # preview ignored junk (dist/, data/, qa-tmp/) — delete if stale
```

- `.cortexkit/` is Magic Context's internal storage — leave it alone.
- `data/` holds the live SQLite DB — never delete unless resetting the app.

## 4. Debt markers + secrets

```sh
git grep -nE "TODO|FIXME|HACK|XXX" -- apps packages
pnpm dlx knip --include dependencies   # duplicate/unused deps (covered by step 1 too)
```

- Every TODO must name its condition: `shortcut: <limit>, <when to upgrade>`. Fix orphans.
- Secrets/dep-audit breadth pass: `codedev find_secrets` + `dep_vuln_scan` + `find_empty_catches`
  (all zero as of 2026-11-01). Do NOT use codedev `security_scan` as a finding source — it flags
  every template literal as "SQL injection" (~100 false positives; verified against real code:
  React setters, path checks, PRAGMA constants) and every bundled `dist/` asset. Treat its output
  as unverified leads at best. Real assurance = the security-review passes on changed surfaces
  (see the reviews folded into git history + docs/TEST_RESULTS.md).

## 5. Commit

One commit: `chore: weekly sweep - <n> findings removed` — include the knip exit status in the
body. If everything was already clean, no commit.

## History

| Date | Findings removed |
|---|---|
| 2026-11-02 (sweep 3, post UI/UX pass) | knip ignoreBinaries taskkill+lsof (now resolved from code literals), TODO→`shortcut:` in web client.ts, stale qa-tmp/job.json; breadth: secrets 0, dep vulns 0, empty catches 0 |
| 2026-11-01 (sweep 2) | stale TODO(server) in FileBrowser (row ids landed), SubjectLogEvent export keyword, knip ignores for .d.mts decls + POSIX binaries; security breadth audit: 0 real findings |
| 2026-11-01 | 15 (4 dead symbols, 10 export keywords, 1 duplicate schema alias) — knip baseline created |
