# graph-manager design v1 (GMD-01 … GMD-14)

## Summary

The graph-manager UI is rebuilt from the design file the user handed over on 2026-11-06. The spec is `docs/prd/done/graph-manager-design.md`, and the 21 boards are in `docs/design/graph-manager/`. Changes:

- **Shell:** Runs is the home page, a global status block shows in the nav, and the nav collapses to a 56 px rail.
- **Look:** light and dark themes from one token file, with Geist fonts served by the app itself.
- **Keyboard:** a Ctrl K palette, `g` shortcuts, j/k list navigation and a Ctrl Space prefix inside terminals.
- **Runs:** a dashboard sorted by attention, with a Start run drawer.
- **Run detail:** phase cards, a layered task graph and a task table.
- **Terminals:** a split of up to 4 panes that hold terminals or run views.
- **Background jobs:** cloning and Create PR run in the background with live progress.
- **Settings:** forge cards show the token's last 4 characters.

The work was done by a graph-execution run (`.agents/tasks/graph-manager-design/`, 10 tasks). Its live tester checked every screen with agent-browser. The change is client-only: nothing under `packages/graph-execution/` changed.

**GMD-15 (2026-11-07):** terminal statuses are gone from the UI (spec `docs/prd/done/graph-manager-no-terminal-status.md`). Terminals show their title, workspace and foreground process; there are no working / idle / other chips, NEEDS YOU section, status badges, nav terminal rows, "Terminals idle" card or `Ctrl Space a`.

## Decisions

| Decision | Why | Id |
|---|---|---|
| Tokens in `apps/graph-manager/src/web/ui/tokens.css`, light on `:root`, dark on `[data-theme=dark]`. The theme is set before first paint from `localStorage["gm.theme"]` or `prefers-color-scheme`. | Follows the design's React notes. Components read only `var(--…)`, so one file themes everything. | GMD-01 |
| Geist and Geist Mono come from `@fontsource-variable/*` and Vite bundles them. | Works offline on a VM, with no request to a font CDN. | GMD-01 |
| One `OverviewProvider` polls runs, terminals, workspaces and forges every 2 s, pauses while the tab is hidden, keeps the last data, and marks it stale after 3 failed polls. | The nav, cards, badges and palette all read the same data, which means one poller instead of one per page. | GMD-02, GMD-04 |
| Keyboard: app shortcuts outside terminals, a Ctrl Space prefix inside them, and `g` chords handled in the capture phase. | xterm takes every key, and the reviewer found that `g s` on Runs also triggered the page's `s` (Start run). | GMD-03 |
| The run view cache: while a run's page is live, the server saves its `/state` to `<GM_DATA_DIR>/views/<ws>/<runId>.json`. | Finished runs keep their task times, line counts and review results without changing the engine (the user asked for client-only changes). | GMD-14 |
| Without a cache, run detail falls back to `state.json` and git: line counts from each task's merge commit, and no times. | Runs that finished while graph-manager was down still show their graph and table. | GMD-09 |
| `POST /api/workspaces` and `POST /api/runs/:ws/:runId/pr` answer 202 with a job. The UI polls the clone list or the PR status for progress. | The design shows clone and push progress and the Create PR steps. | GMD-10, GMD-12 |
| The clone destination is reserved before the first `await`, and a failed clone only removes a folder it created. | The reviewer found that two clones racing could delete each other's folder. | GMD-12 |
| The PR job registry is kept per app (a WeakMap keyed by `AppContext`). | Several app instances in tests must not share jobs. | GMD-10 |
| `GET /api/forges` shows `tokenEnd` (the last 4 characters) only for tokens longer than 4 characters. | The design shows "token ends ••••a91f". The first cut hid it below 8 characters, which hid it for the fake forge's tokens too. | GMD-13 |
| The login note names `GM_PASSWORD`. | The board says `GM_ADMIN_PASSWORD`, which is not a real variable. | GMD-05 |
| The empty Runs state shows `graph-execution <tasks> --spec <spec> --web`. | The board's `graph-execution run --spec …` is not the CLI's syntax. | GMD-06 |
| The delete dialog says the workspace's runs go with it. | Runs live in the workspace's `.graph-execution/`, so the board's "runs history is kept" would be false. | GMD-11 |
| Terminal statuses removed from the UI | The user doesn't want working/idle/other labels; the 3 s output heuristic was a guess anyway | GMD-15 |
| Closing a terminal asks first only while its foreground process is not a plain shell (`bash sh zsh fish dash ash tcsh csh ksh pwsh`). | Without a working status, the process is what says whether something would be lost. | GMD-15 |
| The exited bar (Restart / Close) and the reconnecting bar stay; the server still returns `status`. | Restart is only reachable from the exited bar; the change is client-only. | GMD-15 |

## Known follow-ups

- The engine's run page (the iframe) keeps its own dark theme. `?theme=` is passed, but the engine ignores it, and the change was client-only.
- While a fake run waits with a failed task, its page still shows Close, and `state.json` says `running`. So the Failed card and the failure toast only fire after the page is closed. This comes from the engine's state.
- Runs started from Start run get ids like `gm-20261107-…`, so their PR branch is `gm/gm-20261107-…`.
- Terminal ids restart at `t1` after a server restart, so tabs restored from `localStorage` can point at new terminals that reuse an id.
- Create PR on a local fake forge finishes in under a second, so the step-by-step progress is only visible on a real forge.

## Code references

- `apps/graph-manager/src/web/ui/`: tokens, base CSS, theme, status tones, and components (StatusBadge, Icon, Drawer, ConfirmDialog, Segmented, toasts, …).
- `apps/graph-manager/src/web/Shell.tsx`, `overview.tsx`, `keys.ts`, `CommandPalette.tsx`: the shell, polling and keyboard.
- `apps/graph-manager/src/web/pages/Runs.tsx`, `StartRunDrawer.tsx`: the dashboard. `src/server/routes/inspect.ts`: `GET /api/workspaces/:id/inspect`.
- `apps/graph-manager/src/web/pages/RunDetail.tsx`, `PhaseCards.tsx`, `TaskGraph.tsx`, `PrPanel.tsx`; `src/server/runs.ts`, `src/server/pr.ts`.
- `apps/graph-manager/src/server/viewcache.ts`: the run view cache.
- `apps/graph-manager/src/web/pages/Terminals.tsx` (`isShell`, `needsCloseConfirm`), `TerminalSidebar.tsx`, `TerminalPane.tsx`, `layout.ts`, `components/TerminalView.tsx`; `src/server/terminals.ts` (process name, restart, rename).
- `apps/graph-manager/src/web/pages/Workspaces.tsx`, `CloneDrawer.tsx`; `src/server/routes/workspaces.ts` (clone jobs).
- `apps/graph-manager/src/web/pages/Settings.tsx`; `src/server/routes/forges.ts` (`tokenEnd`, `apiUrl`).
- `apps/graph-manager/scripts/ui-smoke.sh`: the end-to-end smoke test (agent-browser + curl). It is not part of `npm test`.

## Related

- [graph-manager: web service and Docker image](graph-manager.md)
- [graph-manager README](../../../apps/graph-manager/README.md)
- [Project wiki index](../index.md)

## Last updated

2026-11-07
