# UI/UX Improvement Pass — studi0 apps/web

Lean pass: frontend-only, no API changes → no PRD / ARCHITECTURE / API_CONTRACT.
One frontend-agent dispatch (T01–T06), gates at the end, user reviews once.

## Goal
Make studi0 look designed and flow better, without changing its identity or adding features.

## Settled decisions (user, 2026-11-02)
- **Scope**: all of apps/web. Flagged pain: graph explorer, dashboard/home, overall feel.
- **Looks + UX both.**
- **Identity stays**: VT323 display + JetBrains Mono body, dark default, existing CSS custom-property tokens. No Tailwind/CSS-modules migration, no router.
- **Flows may change**; every behavior change is listed in the final summary.
- **Dialogs**: replace every `window.prompt`/`window.confirm` with styled in-app dialogs (AddSubjectDialog pattern).
- **Dashboard**: new home overview (due-today, per-subject progress, recent lessons, quick actions) replacing the EmptyState home.
- **Graph explorer**: keep the sandboxed iframe of graph.html; add chrome (legend, fullscreen, loading state, zoom hints); restyle the export **via the graphify pipeline only** — `graphify export html` is the safe regen path (cluster guard refuses destructive re-clusters); never hand-edit graph.html.
- **QA fold-ins** (docs/TEST_RESULTS.md): #2 cancel→500 empty body, #7 job status regress to "Queued…", #8 opencode step markers leaking into chat DOM.
- **Review**: one autonomous pass (taste's real-browser look-and-fix loop), user reviews the result at the end.
- **Skills wired**: frontend agent loads `design-taste-frontend` (art direction, anti-slop) and `impeccable` (critique/polish/audit).

## Stage plan
| # | Task | What |
|---|------|------|
| T01 | Flow + a11y + dialogs | prompt/confirm → in-app dialogs; Sidebar group-header keyboard access; EmojiPickerModal focus trap; kebab focus-visible reveal; theme-toggle overlap hack removed; chat height consistent with lesson viewer |
| T02 | QA fold-ins | #2, #7, #8 fixed with tests |
| T03 | Dashboard home | overview screen: due-today, per-subject progress, recent lessons, quick actions; empty path still handled |
| T04 | Graph chrome | legend, fullscreen, loading state around iframe; export restyle via pipeline |
| T05 | Art direction + debt | taste-directed pass (type scale, spacing, hierarchy, color, motion) across shell/tabs/chat/lessons/practice/settings; dedupe CSS (`.kebab`, `.lesson-frame`, `.setup-form fieldset`, pills, row styles), delete dead CSS (`.shutdown-btn`, dup hover), dedupe inline SVGs |
| T06 | Impeccable polish + gates | critique/polish audit; typecheck+lint+test+build green at root; behavior changes listed |

Order: T02 → T01 → T03 → T04 → T05 → T06 (single agent, sequential).

## Key risks
- **14 UI test files** assert DOM structure/labels/aria — tests updated only where structure intentionally changed; gates enforce green.
- **graph.html is generated** — all graph restyling flows through the graphify export path.
- **Taste/impeccable overlap** on polish — acceptable: taste deals direction first, impeccable audits the result.
- **Concurrent sessions** (see CONSTRAINTS #42): verify clean tree / no other session mid-write before dispatching.
- **Behavior changes pre-approved** (dashboard, dialogs): still enumerated in the final report.

## Gates
`pnpm typecheck && pnpm lint && pnpm test && pnpm build` at repo root, after T06 and before handing to the user.
