# PRD: graph-manager design v1

No Jira tickets: the user handed over a design file (`graph-manager.html`, 21 boards) in conversation on 2026-11-06 and asked for all of it to work. Ids below are `GMD-xx`. The boards are saved in `docs/design/graph-manager/`: for each board there is a screenshot (`NN-name.png`), its text (`NN-name.txt`) and its HTML and CSS without the embedded fonts (`NN-name.html`). **Read the matching board before building a screen, and match it.**

| Board | Files |
|---|---|
| IA proposal + React notes | `00-ia-proposal-react-notes.*` |
| Design system (tokens, status tones, type, components) | `01-design-system.*` |
| Nav rail component | `02-component-nav-rail.*` |
| Login light / dark | `03-login-light.*`, `04-login-dark.*` |
| Runs dashboard (Start run open) light / dark | `05-runs-dashboard-light-start-run-open.*`, `06-runs-dashboard-dark.*` |
| Terminals 2×2 light / dark, 800 px | `07-terminals-light-2-2-split.*`, `08-terminals-dark.*`, `09-terminals-800-px.*` |
| Run detail live light / dark, finished 800 px | `10-run-detail-live-light.*`, `11-run-detail-live-dark.*`, `12-run-detail-finished-800-px.*` |
| Run detail landed + Create PR light / dark | `13-run-detail-landed-create-pr-light.*`, `14-…-dark.*` |
| Workspaces + Clone light / dark | `15-workspaces-clone-light.*`, `16-workspaces-clone-dark.*` |
| Settings · forges light / dark | `17-settings-forges-light.*`, `18-settings-forges-dark.*` |
| Empty, loading, error, dialogs light / dark | `19-empty-loading-error-dialogs-light.*`, `20-…-dark.*` |

## 1. Problem

graph-manager (`apps/graph-manager`, spec `docs/prd/done/graph-manager.md`) works, but its UI is a plain first cut: four pages with minimal styling, Workspaces first in the nav, no status overview, no dark theme toggle, no keyboard model, one terminal at a time, and the finished-run page shows only a bare graph. The design reorganises it around the four questions the user arrives with (what is running, what is blocked, what failed, what is ready to ship) and adds features the current code doesn't have.

## 2. Goals

Make every screen, state and interaction in the design work against the real server, in light and dark:

- **GMD-01 Tokens, theme and components.** One `tokens.css` with the design's surface/text/status tokens for light (`:root`) and dark (`[data-theme=dark]` on `<html>`). The theme defaults to `prefers-color-scheme`; the user's override (System / Light / Dark) is saved in `localStorage`. Geist and Geist Mono are self-hosted as woff2 files, so the page works offline. Shared components: `StatusBadge` (six tones with distinct glyphs), buttons, inputs, segmented control, tabs, cards, table rows, drawer, confirm dialog, toasts, skeletons, `Kbd`, forge chip.
- **GMD-02 App shell.** Left nav in the order Runs (home), Terminals, Workspaces, Settings. Brand with the host name. Global status block (terminals working, idle · waiting on you, runs live, run failed); each count is a link that opens its screen pre-filtered. Nav badges: `3 live · 1 failed`, `4 · 2`, a workspace count, and a dot on Settings when no forge is connected. Footer with **Jump to… Ctrl K**, a theme toggle and **Log out**. Below 1100 px the nav collapses to a 56 px icon rail, and the counts become dots.
- **GMD-03 Keyboard model.** Ctrl K command palette (runs, terminals, workspaces, pages). `g r` / `g t` / `g w` / `g s` go to a screen. `j` / `k` / Enter move through table rows and sidebar items. `/` focuses the screen's filter. Esc closes a drawer or dialog and puts focus back. `s` opens Start run and `p` creates a PR on the focused row. Inside terminals, Ctrl Space is a prefix: `n` new, `x` close, `1`–`4` focus a pane, `|` split, `a` jump to the next idle agent. Each binding is shown on the button it triggers.
- **GMD-04 Polling and toasts.** Poll every 2 s and pause while `document.hidden`. Keep the last data on screen and never blank a table. Show "updated Ns ago", which turns amber after 3 failed polls, with the banner "Can't reach the server. Showing data from Ns ago. Retrying…". Skeleton rows on first load. Toasts for a finished clone ("Cloned octo/cli · Open terminal") and for a run that turns failed ("Run a3f0 failed in deploy-tools · Open").
- **GMD-05 Login.** The card from the design: brand, host name, "Admin password", "Wrong password.", and a note naming the password variable. That note says `GM_PASSWORD`, the real variable; the board says `GM_ADMIN_PASSWORD`, which is a typo.
- **GMD-06 Runs dashboard.**
  - Summary cards: Live (`2 runs · 1 suite`), Failed (newest one's workspace and time), Ready for PR (applied, no PR yet) and Terminals idle (links to Terminals filtered to idle).
  - Workspace filter, text filter (run id, provider) and **Group by workspace**. Group rows show the forge chip, path, branch, dirty/clean, the run count and **Open terminal**.
  - Columns: Status, Run (id and a `live` dot), Type (run/suite), Provider, Tasks merged (n/m and a progress bar in the status tone), Created, Action.
  - The Action column shows **Create PR**, a `PR #42 ↗` / `MR !17 ↗` link, or a short failure reason such as "validation failed".
  - Rows are sorted by attention: failed and live first, then ready for PR, then the rest by created time.
  - Empty state, first-load skeleton, stale-data banner.
- **GMD-07 Start run drawer.** Workspace (shows `branch · N uncommitted files`), Tasks folder ("7 task files found"), Spec path, Provider segmented control (claude, codex, opencode, qwen, plus `fake` for testing), a "Will run" command preview, **Cancel** and **Start run Ctrl ↵**. A CLI failure shows "graph-execution exited with code N" with the CLI's output.
- **GMD-08 Terminals.**
  - **Sidebar:** title with count and **New**. Filter chips: working / idle / other. Sections: NEEDS YOU (idle terminals), one per workspace, and WORKSPACES ROOT.
  - **Sidebar items:** title, then the foreground process with its state and time (`claude · working 14s`, `idle 4m`, `exited 1 · 40m ago`). A chip for each live run in the terminal's workspace, and the pane number when the terminal is shown in a pane.
  - **Tab bar:** tabs with a status dot and ×, and layout buttons: 1 pane, 2 side by side, 2×2.
  - **Panes:** each pane holds either a terminal or a run view (the live iframe, or the static graph when the page is down). The pane header shows the pane number, title, workspace, status badge, a run chip (`run 44c2 ↗`), maximise and close.
  - **Lifecycle:**
    - Closing a working terminal asks first ("Keep running" / "Close terminal").
    - An exited terminal shows "Process exited with code N" with **Restart** and **Close**.
    - A dropped WebSocket shows "Reconnecting to the container… your scrollback is kept on the server." and reconnects on its own.
    - Empty state: "No terminals open" with **New terminal Ctrl Space n**.
  - Terminals stay dark in both themes (`--term-*` tokens). Layout and open tabs are kept in `localStorage`.
  - Below 900 px the sidebar becomes a drawer and the split becomes one pane.
- **GMD-09 Run detail.**
  - **Header:** ‹ Runs, run id, status badge, workspace · provider · started ago · n/m merged (or "page not live"), **Open terminal here**, and an "open ↗" button that opens the run page in a new tab.
  - **Live:** the engine's page in a full-height iframe. A skeleton shows until it loads. If the live probe fails, the static graph replaces it with "The run page stopped responding. Showing the static graph. **Retry**".
  - **Finished:** phase cards (Validation, Review + live test, Fixer, Landed, each with a status line and a detail line; "not reached" when skipped). A task graph in dependency-layer columns with drawn edges. A task table with Status, Task (title + id), Attempt, Elapsed, Lines (+N −N) and Depends on.
- **GMD-10 Create PR panel.**
  - **States:** the form (Branch, Base as a select of remote branches, Title "from the spec's heading", Body), or the existing PR/MR link with `branch → base`. Otherwise the reason it isn't available: "Not available: the run has not landed (status failed). Fix it from a terminal in <ws> and start a new run. Create PR shows up here once a run lands." or "Not available: no uncommitted changes in the workspace."
  - **Progress:** the server runs Create PR as a background job, and the panel shows each step (checkout, commit, push with %, create) live. The button reads **Creating…** meanwhile, and a failed step shows its error.
- **GMD-11 Workspaces.**
  - Header with count, the workspaces root path, a filter and **Clone repository**.
  - Columns: Forge, Repository (path + remote URL), Branch, Tree (dirty/clean), Runs (`3 · 1 live`), Actions (**Open terminal**, **Runs**, **Delete**).
  - **Delete:** disabled while a run is live, with a tooltip. It asks for confirmation and names the number of uncommitted files. The "Can't delete octo/hello yet" dialog has **Open run**.
  - **Empty states:** "Connect GitHub or GitLab first · Go to Settings" and "No workspaces yet · Connected as <login> · Clone repository".
- **GMD-12 Clone drawer.**
  - Forge tabs (GitHub "as <login>", GitLab host) and a search box with a result count.
  - **Result rows:** "already cloned", a `private` chip, **Clone**, a live progress bar ("Receiving objects: 58% (1204/2071)"), or an error ("clone failed: repository is empty").
  - **Other states:** "No forge connected. Connect one in Settings", "No repositories match “x” for <login>.", and the footer "Repos are cloned into /workspaces/<full path>, keeping nested GitLab groups."
  - Clones run as background jobs on the server.
- **GMD-13 Settings.**
  - **Forge cards:** a connected card shows "Connected as <login>", the API URL, "token ends ••••a91f" and **Disconnect** (confirm dialog). A not-connected card has the form: GitLab Base URL ("Default https://gitlab.com; change it for self-hosted GitLab."), Personal access token ("Needs the api scope." / "repo scope" for GitHub), the inline error ("gitlab 401: 401 Unauthorized") and **Connect**.
  - **Appearance:** System / Light / Dark, "Saved in this browser only."
- **GMD-14 Run view cache.** While a run's page is live, the graph-manager server snapshots the page's `GET /state` (the engine's view model: per-task status, attempts, start/end times, line counts, phase, review results, failures) every 3 s into `<GM_DATA_DIR>/views/<workspace>/<runId>.json`. Finished runs then keep their elapsed times, line counts and phase results. Runs that finished while graph-manager was down fall back to `state.json` and git (line counts from each task's merge), with no times.

## 3. Non-goals

- Detecting that an agent "asked a question". An idle terminal (no output for 3 s) counts as "waiting on you".
- Theming the engine's own run page (`?theme=` is passed, and the engine may ignore it).
- Persisting terminals across server restarts, multiple users, OAuth, Jira (unchanged from `docs/prd/done/graph-manager.md`).
- Mobile layouts below 800 px beyond "nothing overflows".

## 4. User stories and acceptance criteria

**US-1 Look and theme (GMD-01, GMD-05).** As the owner, I see the design's look in light and dark.
- `<html>` gets `data-theme="light"` or `"dark"`. Settings → Appearance and the nav toggle switch it. The choice survives a reload (`localStorage['gm.theme']`), and "System" follows `prefers-color-scheme`.
- The body font is Geist and IDs use Geist Mono, both loaded from the app's own origin (no request to Google Fonts or a CDN).
- Every status shows the tone and glyph from the design-system board.

**US-2 Shell and status (GMD-02, GMD-04).** As the owner, I see from any screen whether anything needs me.
- Runs is the landing page. The nav order is Runs, Terminals, Workspaces, Settings.
- The status block counts working terminals, idle terminals, live runs and failed runs from the API. Clicking "run failed" opens `/runs?status=failed`, and clicking "idle · waiting on you" opens `/terminals?filter=idle`.
- At 1000 px wide the nav is a 56 px rail.
- When the API stops answering, the data stays on screen, and after 3 failed polls the amber banner shows.

**US-3 Keyboard (GMD-03).** As the owner, I drive the app from the keyboard.
- Ctrl K opens the palette. Typing part of a run id and pressing Enter opens that run.
- `g w` opens Workspaces. On Runs, `j` / `k` move the focused row and Enter opens it.
- In a terminal, Ctrl Space then `n` opens a new terminal and Ctrl Space then `x` closes the focused one (asking first if it is working).

**US-4 Runs (GMD-06, GMD-07).** As the owner, I triage and start runs.
- A fake-provider run started from a terminal or from **Start run** appears within 5 s with a `live` dot, then turns `applied` with **Create PR** in its row.
- **Start run** with a missing spec shows "graph-execution exited with code 2" or the server's 400 reason, under the Spec path field.
- The Tasks folder field shows how many task files it found.

**US-5 Terminals (GMD-08).** As the owner, I work in several terminals and watch runs next to them.
- The 2×2 layout shows four panes. A run can be opened in a pane from its chip.
- `exit 1` in a terminal shows "Process exited with code 1" with **Restart**, which starts a new shell in the same folder.
- The sidebar shows the foreground process name (for example `bash`, or `node` while graph-execution runs).

**US-6 Run detail (GMD-09, GMD-14).** As the owner, I understand a run at a glance.
- A live run shows the engine page in an iframe.
- A finished fake run shows the four phase cards, a layered graph with edges, and the task table with attempts, elapsed times and line counts from the view cache.

**US-7 Create PR (GMD-10).** As the owner, I open a PR from a landed run and watch it happen.
- The panel shows the steps checkout → commit → push → create turning green one by one, then the PR link.
- The fake forge lists the PR.
- A clean workspace shows the "no uncommitted changes" reason.

**US-8 Workspaces and clone (GMD-11, GMD-12).** As the owner, I clone and manage repositories.
- Cloning shows a progress row and then a toast "Cloned octo/hello · Open terminal". The row lists the branch and `clean`.
- **Delete** is disabled while a run is live. Otherwise it asks first and removes the clone.

**US-9 Settings (GMD-13).** As the owner, I connect and disconnect forges.
- A connected forge shows its login and the last 4 characters of the token, never more.
- **Disconnect** asks first.
- A bad token shows the forge's error inline.

## 5. Constraints

- **Client changes only: nothing under `packages/graph-execution/` changes.** graph-manager reads the engine through `graph-execution/api`, its CLI and its run page.

- Stack stays as it is: React 19, react-router 7, Vite, xterm.js, Fastify 5, zod, vitest + Testing Library (jsdom). No CSS framework: plain CSS with the design's tokens. Fonts come from `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`. Vite bundles their woff2 files into `dist/web`.
- Components read only `var(--…)`, never hex values, except in `tokens.css`.
- All existing server tests keep passing, or are updated where this PRD deliberately changes an API (async clone and PR jobs).
- The checks: `npm run typecheck && npm run lint && npm test` at the repo root.
- UI changes must be looked at in a real browser with `agent-browser` (installed globally), following the graph-manager section of `TESTING.md`, with the fake forge and `--provider fake`.
