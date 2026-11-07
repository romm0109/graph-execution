If testing the browser use agent browser.
U must test and see the ui by yourself if its ui changess

# How to see the app

Always test the code in this worktree, not a global `graph-execution`:

```bash
npm run build -w graph-execution
CLI="$PWD/packages/graph-execution/dist/cli.js"
FIX="$PWD/packages/graph-execution/src/__fixtures__"
```

Run in a fresh temp git repo, never in this worktree (a run writes `.graph-execution/` and applies changes to the branch):

```bash
REPO=$(mktemp -d) && git -C "$REPO" init -q -b main && git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
```

Use `--provider fake`. It needs no login and costs nothing. Every agent commits `<id>.txt` and succeeds, unless a script says otherwise.

## Fake provider scripts

To get a specific state, write a JSON script and pass it in `GRAPH_EXECUTION_FAKE_SCRIPT`. Keys are `<role>:<label>` (for example `task:3`). Attempts are used in order.

```bash
# task 3 stays "running" until aborted: use it to look at a run in progress
echo '{"task:3":{"attempts":[{"hang":true}]}}' > "$REPO/.git/fake.json"

# task 3 fails all 3 attempts: use it to look at the failure panel, Retry and "Merge as it is"
echo '{"task:3":{"attempts":[{"exitCode":1},{"exitCode":1},{"exitCode":1}]}}' > "$REPO/.git/fake.json"
```

Other attempt fields (`throw`, `report`, `summary`, `write`, `commit`) are documented in `packages/graph-execution/src/providers/fake.ts`.

## Terminal UI (Ink)

The terminal UI needs a real TTY, so run it in tmux and read the screen with `capture-pane`:

```bash
tmux new-session -d -s ge -x 160 -y 50 -c "$REPO" \
  "GRAPH_EXECUTION_FAKE_SCRIPT=$REPO/.git/fake.json node $CLI $FIX/diamond --spec $FIX/spec.md --provider fake; echo EXIT=\$?; sleep 600"
sleep 5
tmux capture-pane -p -t ge          # read the screen (repeat to see it change)
tmux send-keys -t ge C-c            # send keys, e.g. Ctrl+C to abort
tmux kill-session -t ge             # always clean up
```

- `sleep 600` keeps the pane open after the run, so you can read the final summary and `EXIT=<code>`.
- Make the window big enough (`-x 160 -y 50`), or the graph gets cut off.

## Web view (agent-browser)

```bash
cd "$REPO" && GRAPH_EXECUTION_HANDOFF=detached SSH_CONNECTION=1 \
  GRAPH_EXECUTION_FAKE_SCRIPT=$REPO/.git/fake.json \
  node $CLI $FIX/diamond --spec $FIX/spec.md --provider fake --web
# prints: Started run <id> in the background: http://127.0.0.1:<port>/
```

- `GRAPH_EXECUTION_HANDOFF=detached` starts a plain detached process, not a launchctl/systemd job.
- `SSH_CONNECTION=1` stops it from opening the user's browser. It only prints the URL.

Then look at the page:

```bash
agent-browser open http://127.0.0.1:<port>/
agent-browser snapshot -i              # buttons and their refs (Abort, Retry, Close...)
agent-browser screenshot page.png      # then read page.png and LOOK at it
agent-browser click @e1                # click by ref from the snapshot
agent-browser close
```

- `curl http://127.0.0.1:<port>/state` returns the raw JSON state. Use it to check what the page should show.
- Clean up: press **Close** on the page after the run ends, or kill the pid in `$REPO/.graph-execution/<run-id>/web.json`.

## Human review

Start with `--human-review --web` (same environment as above) and open the printed URL:

```bash
agent-browser open http://127.0.0.1:<port>/
agent-browser snapshot -i              # "Waiting for your review", diff files, Apply, Drop
```

1. Select a range (drag from +2 to +3) and comment.
2. Comment on a deleted line.
3. Add a suggestion on one new line.
4. Check `human/round1.json` has `side`/`startLine`/`endLine`.
5. Press **Request changes**. The phase line reads `fix pass 1/3 (human round 1)`, and the run pauses again.
6. Check that each comment shows a fixer note and a reviewer verdict, switch to Round 1 and the Comments tab, then **Resolve** the comments and press **Apply**.
7. `curl http://127.0.0.1:<port>/state` shows `review.waiting`. `$REPO/.graph-execution/<run-id>/human/round1.json` holds the comments.

### Suite review

Start `graph-execution suite --web --human-review` on `packages/graph-execution/demo/suite` (see `packages/graph-execution/demo/suite/run.sh --human-review`) and open the printed URL. The review is in the right panel (at least 60vw wide, drag its edge to resize; the width is kept in `localStorage['ge.panel']`) with a sticky Apply / Request changes / Drop bar. Repeat steps 1–6 on the suite page: the diff rows have old and new line numbers, `curl http://127.0.0.1:<port>/api/review/files?round=1` lists the round's files, and `<suiteDir>/human/round1.json` holds the comments with the same fields as a run's.

## Web UI checklist

Run it on BOTH pages: a run (start it as in "Web view" above, with `task:4` set to `hang` so one node keeps running) and a suite (`packages/graph-execution/demo/suite/run.sh --human-review`, same two environment variables). Use `agent-browser set viewport 1280 800` unless a step says otherwise. Each step names its evidence.

1. **No page scroll.** Run `agent-browser eval 'document.documentElement.scrollHeight - innerHeight'` and the same for `scrollWidth - innerWidth`. Expected: `0` and `0`. Evidence: the `eval` output.
2. **Node cards.** Take a screenshot. Expected: each card shows status, provider, elapsed time and `+N −N` (a card with no changes has no counts), and the running node pulses. Evidence: the screenshot, and `eval 'getComputedStyle(document.querySelector(".node.s-running")).animationName'` returns `pulse`.
3. **Fit and zoom.** Move the graph with a drag, press `F`, then press **+**, **−** and **1:1** in the zoom bar. Expected: `F` brings the whole graph back into view; the buttons zoom around the center. Evidence: a screenshot after `F`.
4. **Panel and width.** Click a node. Expected: the right panel opens with its tabs. Drag its left edge to about 75% of the width (`agent-browser mouse down`/`move`/`up`), then reload and click the node again. Expected: the panel has the same width (`eval 'document.querySelector("#panel").offsetWidth'` returns `960` at 1280 wide, give or take a few pixels). Evidence: the `eval` output.
5. **Changes tab.** Open **Changes** on a node with a file. Expected: a file tree, a highlighted diff (`eval 'document.querySelectorAll(".hljs-keyword").length'` is above 0), and a **Split** button that is enabled once the panel is 900px wide or more; pressing it shows two columns (`eval '!!document.querySelector(".srow")'` returns `true`). Evidence: a screenshot of the split diff.
6. **Expand context.** On a modified file press **↑** or **↓** on a "hidden lines" bar. Expected: up to 20 more lines appear (count `.dv-files .dl` before and after). Evidence: both counts.
7. **Logs.** Open **Logs** on a running node, then append text from the shell to the log file under `$REPO/.graph-execution/<run-id>/logs/` (or, in a suite, the feature run's). Expected: the new text shows up without a reload; after you scroll up in the log, it stops following and shows a chip with the number of new lines; typing in the filter box hides the lines that do not match. Evidence: the `eval` text of `#panel` before and after.
8. **Events drawer.** Press `E`, then `E` again. Expected: `eval 'document.querySelector("#drawer").className'` contains `open` after the first press, and not after the second. Evidence: both outputs.
9. **Review (with `--human-review`).** Wait for **Waiting for your review**. In the Review tab save a general comment, press **Request changes**, wait for the page to say `round 2`, then press **Apply** (or **Apply anyway**, and accept the confirm). Expected: round 2 lists the comment as open; after Apply the run ends and **Close** shows. Evidence: a screenshot of round 2, and `curl .../state` (the run) or the page text (the suite).
10. **Small screens.** `agent-browser set viewport 800 700`, then click a node. Expected: the panel covers the whole window (`offsetWidth` equals `innerWidth`). Evidence: the `eval` output.
11. **Assets are fenced.** `curl -s -o /dev/null -w '%{http_code}' --path-as-is http://127.0.0.1:<port>/assets/../package.json`. Expected: `404`. Evidence: the status code.

Also, with `document.hidden` forced to `true` (`Object.defineProperty(document, "hidden", {get: () => true})` then dispatch `visibilitychange`), `<html>` gets the class `paused` and the animations stop.

For a large diff, script a task that writes 5000 lines (`"write": {"big.js": "..."}`), open its **Changes** tab and time the file opening with `performance.mark("a")`, a click on the file row, two `requestAnimationFrame`s and `performance.measure("open", "a")`. Expected: under 1000 ms.

## What to check

- If the change touches the run view, check it in BOTH the terminal UI and the web view. They show the same graph.
- Check a run in progress (`hang`), a clean run (no script) and a failed run (`exitCode: 1`) if the change can affect them.
- Put the screenshot path or the captured screen text in your report as evidence.

## graph-manager

graph-manager (`apps/graph-manager`) is a web service around graph-execution. Build both, start the fake forge (see "Forges" below) and the server with temp dirs, and log in:

```bash
npm run build -w graph-execution && npm run build -w graph-manager
GM_DIR=$(mktemp -d)
node apps/graph-manager/scripts/fake-forge.mjs 7421 $GM_DIR/forge &        # fake GitHub/GitLab; tokens gh-good / gl-good
GM_PASSWORD=pw GM_PORT=7420 GM_DATA_DIR=$GM_DIR/data GM_WORKSPACES_DIR=$GM_DIR/ws \
  GM_GITHUB_API_URL=http://127.0.0.1:7421/github node apps/graph-manager/dist/server/main.js &
curl -s -c $GM_DIR/c -X POST -H 'content-type: application/json' -d '{"password":"pw"}' http://127.0.0.1:7420/api/auth/login
curl -s -b $GM_DIR/c http://127.0.0.1:7420/api/health      # {"ok":true}
```

Use other ports if 7420/7421 are taken; other agents may be using them.

- Without a cookie, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7420/api/health` prints `401`, and so does `/runs/x/y/view`. `/healthz`, the login and `/api/auth/info` (`{"host":"<hostname>"}`, shown under the brand and on the login card) are public.
- Without `GM_PASSWORD` the server exits 1 and prints `GM_PASSWORD is required`.
- Log in with `pw` at http://127.0.0.1:7420/: it lands on **Runs**. The left nav has the status block (runs live, runs failed; each count links to Runs pre-filtered; no terminal rows), then Runs, Terminals, Workspaces and Settings, then **Jump to… Ctrl K**, the theme button (system → light → dark) and **Log out**. Below 1100 px, and on the detail page of a live run, the nav is a 56 px icon rail with dots instead of counts. A wrong password shows "Wrong password.". Reload on `/settings`: the page still shows (SPA fallback).
- The server indexes the static files at startup: after `npm run build -w graph-manager`, restart it, or the new bundle 404s and the page is blank.
- If `npm ci` leaves out the test libraries (tests fail with "Invalid hook call" or cannot find vitest), check for `NODE_ENV=production` in the shell and use `npm ci --include=dev`.
- Stop the servers by their PID (`kill <pid>`), never by name.

`bash apps/graph-manager/scripts/ui-smoke.sh` runs the main loop end to end (fake forge and server on free ports, log in, connect GitHub, clone, a fake run, Create PR, `/__fake/pulls`) with agent-browser and curl, and prints `OK: PR <url>`. It is not part of `npm test`. `SKIP_BUILD=1` skips the builds; `KEEP=1` keeps its temp dir.

### Forges (fake forge)

`apps/graph-manager/scripts/fake-forge.mjs` serves a fake GitHub API at `<url>/github` and a fake GitLab API at `<url>/gitlab/api/v4`, with bare git repos (cloned over `file://`) under the given dir. It starts with GitHub repo `octo/hello` and GitLab project `grp/sub/proj`. No real tokens are needed, and none may be used in tests.

- Settings → GitHub token `gh-good` (login `octo`). GitLab: Base URL `http://127.0.0.1:7421/gitlab`, token `gl-good`. Any other token gets 401 `Bad credentials`: the card shows `GitHub 401: Bad credentials` in a red box and nothing is saved.
- API: `PUT /api/forges/github` `{"token"}` and `PUT /api/forges/gitlab` `{"token","baseUrl"}`; `DELETE` disconnects. `curl -s -b $GM_DIR/c http://127.0.0.1:7420/api/forges` shows `connected`, `login` and `apiUrl` (plus `baseUrl` for GitLab), and `tokenEnd` (the last 4 characters) for tokens of 8 characters or more; never the token. The fake's tokens are shorter, so the card shows no "token ends ••••" there. `/api/forges/github/repos` lists `octo/hello`.
- **Disconnect** asks "Disconnect GitHub?" first. With no forge connected, Settings has a dot in the nav.
- Pull requests opened against the fake are listed at `http://127.0.0.1:7421/__fake/pulls`. A PR whose head branch is missing from the bare repo gets 422.

### Workspaces

With the fake forge connected: Workspaces → **Clone repository** (or open `/workspaces?clone=1`). The drawer shows the GitHub card selected (`as octo`) and GitLab as `not connected` until you connect it; with no forge it says "No forge connected. Connect one in Settings to search repositories." Search `hello` and press **Clone** on `octo/hello`. The row shows `N%`, a progress bar and git's `Receiving objects: …` line while it runs (a tiny repo may finish before the first poll), then the toast "Cloned octo/hello · Open terminal" appears and the row reads `already cloned`. The table row shows branch `main` and `clean`. **Open terminal** opens a terminal in that folder (`pwd` shows `.../github/octo/hello`).

- `POST /api/workspaces` `{"forge","fullPath"}` answers 202 `{ job }`; poll `curl -b cookie :7420/api/workspaces/clones` for `{ jobs }` (`status` running/done/failed, `progress` 0..1, `phase`, `error`, and `workspace` once done). `GET /api/workspaces` returns `{ root, workspaces }`, each entry with `branch`, `dirty` and `changes`.
- `git -C $GM_DIR/ws/github/octo/hello config --get-regexp extraheader` prints nothing (the token is not saved), and `.git/info/exclude` ends with `.graph-execution/`.
- Cloning `octo/hello` again gives 409 `already cloned` (`already cloning` while the first clone runs). A repo whose bare dir is gone ends `failed` with `clone failed: …` under its row, and the Clone button comes back.
- Writing a file in the clone turns the row `dirty` within 2 s; files under `.graph-execution/` do not count. **Delete** (the trash button) asks "Delete workspace octo/hello?" and says "its 1 uncommitted file"; confirming closes the workspace's terminals, removes the folder and toasts "Deleted octo/hello".
- While a run is live in it (a fake run with `task:4` set to hang), the Runs column shows `1 · 1 live`, Delete is disabled with the tooltip "A run is live in this workspace. Abort it or wait for it to finish.", and clicking it opens "Can't delete octo/hello yet" with **OK** and **Open run**.
- Under 900px the rows become two-line cards and the drawer is full width. Drawers do not dim the page; a click outside or Esc closes them.

### Terminals

- Terminals page → **New** (or `Ctrl Space n`, then Enter), type `echo hi`, reload the page, and the output is still there. Type `graph-execution --version`: it prints the engine version. The sidebar has one section per workspace, then WORKSPACES ROOT, and no filter chips or NEEDS YOU; an item shows its title and the foreground process (`bash`, `node` while it runs), never a working / idle / exited status. The Terminals nav badge is the number of terminals.
- In a terminal, `echo $GRAPH_EXECUTION_HANDOFF-${GM_PASSWORD:-none}` prints `detached-none`.
- `/terminals?workspace=<id>` opens a terminal in that workspace; `?focus=<id>` focuses one; `?run=<ws>/<runId>` opens the run's live page in a pane. `POST /api/terminals` with `{"cwd":"/etc"}` answers 400. `PATCH /api/terminals/:id` `{"title"}` renames (also a double-click on the tab title); `POST /api/terminals/:id/restart` restarts an exited one.
- Split and prefix: press `Ctrl+Space` then `n` four times (the dialog creates a terminal in the focused pane), pick the 2×2 layout button, then `Ctrl+Space` `1`…`4` and `echo pane-N` in each: every pane runs on its own and no `n`/digit reaches a shell. `Ctrl+Space |` cycles 1 → 2 → 4 panes; `Ctrl+Space a` does nothing. Reload and the layout, tabs and panes are back (`localStorage["gm.terminals.layout"]`).
- `exit 1` shows "Process exited with code 1"; **Restart** gives a new prompt in the same folder with the old output above it. `node -e 'setInterval(()=>{},1000)'` turns the sidebar line into `node`; `Ctrl+Space x` on it asks "Close “…”?" with "node is running. Closing the tab ends it and its scrollback." (Keep running / Close terminal), and Esc puts the focus back in the terminal; a terminal at its shell prompt (`bash`, `zsh`, …) or exited closes at once.
- Reconnect without a server restart: before the panes mount, wrap `WebSocket` with `agent-browser eval` so the page keeps its sockets in `window.__ws`, switch to 1 pane and back to 4, then `window.__ws.forEach(w => w.close())`. The amber bar "Reconnecting to the container…" shows, and within a second the panes come back with their scrollback.
- A live run in a terminal's workspace shows its last 4 chars as a chip on the sidebar item and `run xxxx ↗` in the pane header. The chip opens the run's live page in the next free pane, or in pane 2.
- At 800 px wide the sidebar is a drawer (the **Terminals N** button) and one pane fills the page.
- Terminals are PTYs of the server: a server restart ends them.

### Runs dashboard

In a terminal in a cloned workspace, copy the engine's diamond fixture in, commit it, and run `graph-execution diamond --spec spec.md --provider fake --web`. The Runs page shows the run within a few seconds, `live` while its page is open; its detail page shows the live graph in the iframe. After the run, press **Close** in the iframe: the detail page switches to the static graph. Also try **Start run** (or `s`) with provider `fake (testing)`; Ctrl+Enter submits and the toast "Started run …" links to it.

Without the UI (with the server and cookie from above, and a workspace under `$GM_DIR/ws/github/octo/hello` holding the committed `diamond/` and `spec.md`):

```bash
curl -s -b $GM_DIR/c -X POST -H 'content-type: application/json' \
  -d '{"tasksDir":"diamond","spec":"spec.md","provider":"fake"}' http://127.0.0.1:7420/api/runs/github~octo~hello   # 201 {runId, viewUrl}
curl -s -b $GM_DIR/c http://127.0.0.1:7420/api/runs                                                             # the run, live:true
curl -s -b $GM_DIR/c http://127.0.0.1:7420/runs/github~octo~hello/<runId>/view/state                             # the run page's state, through the proxy
curl -s -b $GM_DIR/c -X POST http://127.0.0.1:7420/runs/github~octo~hello/<runId>/view/close                     # Close, as the iframe's button
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7420/runs/github~octo~hello/<runId>/view/                # 401 without the cookie
```

A path outside the workspace, a tasks folder or spec that is not there, answers 400 with `error`; when the CLI itself exits non-zero, the 400 also carries `exitCode` and `output` (its last 20 lines), which the drawer shows as "graph-execution exited with code N". An unknown run answers 404, and the view URL of a run whose page is closed 404.

### Run detail

Start runs from a terminal in the workspace (as in "Web view" above) while graph-manager is running, so its view cache (`$GM_DATA_DIR/views/<workspace>/<runId>.json`, a snapshot of the page's `/state` every 3 s) records them: one plain, one with `task:3` failing 3 times (press Close in its page, or `POST …/view/close`, to end it `failed`), one with `task:4` set to `hang`.

- **Live** (the hanging run): the nav is a rail, the engine page fills the area under the header and the page does not scroll (`eval 'document.documentElement.scrollHeight - innerHeight'` is `0`). `kill -9` the run's PID from `web.json` (a plain `kill` only aborts the run and its page stays up): within 10 s the page shows "The run page stopped responding. Showing the static graph." with **Retry**. A run that ends normally (Close in the iframe) shows the static view without that banner.
- **Applied** (press **Close** in the iframe first): 4 phase cards (Validation, Review + live test, Fixer, Landed with `N files uncommitted`), the layered graph with curved edges, and the task table with elapsed times and `+N −N` lines. Clicking a node highlights its row.
- **Failed** at 800px (`set viewport 800 1500`): the Pull request panel comes first ("Not available: the run has not landed (status failed)."), then a Tasks card `3 failed after 3 attempts`, "not reached" on Validation, Review and Fixer, node 3 red, node 4 `pending`, and the task table without a horizontal scrollbar.
- **Open terminal here** opens `/terminals?focus=<id>` with a terminal in the workspace.

### Create PR/MR

After a fake-provider run reaches `applied` in a cloned workspace, the run page's Pull request card shows the Create PR form (`#pr` in the URL, from the Runs page's Create PR button or `p`, scrolls to it and focuses Title; `#pr` shows the static view even while the run's page is still open, and ↗ opens that page). Submit it: the fields turn read-only, the button reads "Creating…", and the step list shows checkout → commit → push → create turning green, then "Pull request #1 ↗" and a toast "Opened PR #1". `curl http://127.0.0.1:7421/__fake/pulls` lists the PR with `head: gm/<runId>`.

- The form is prefilled: branch `gm/<runId>`, base `main` (the select lists the remote's branches), the spec's first `# ` heading as title, and the task list as body text. A GitLab workspace (`grp/sub/proj`) shows **Create MR** (also on the Runs row), then "Merge request !1 ↗".
- `git -C $GM_DIR/forge/octo/hello.git ls-tree -r --name-only gm/<runId>` lists the run's files and nothing under `.graph-execution/`; the clone is back on its original branch and its `config --get-regexp extraheader` still prints nothing.
- Before the run lands, with no changes, or with the forge disconnected, the card reads "Not available: <reason>." instead of the form (plus a "Fix it from a terminal in …" line for a run that has not landed).
- API: `POST /api/runs/<ws>/<runId>/pr` `{branch, base, title, body}` validates, then answers 202 `{job}`; `GET` the same URL returns `eligible`, `reason`, `suggested` (branch, title, body, base and `bases`, the remote's branches), `pr` once it exists, and `job` (steps with `state`/`detail`/`progress`). A second POST while the job runs answers 409 "a pull request is already being created"; a bad branch name 400; an existing PR or branch 409. A failed step ends the job with `status: "failed"`, `failedStep` and `error: "<step> failed: …"` (no token).

## graph-manager UI checklist (agent-browser)

Bring the stack up as at the top of "graph-manager" (fake forge, `GM_GITHUB_API_URL`), then `agent-browser open http://127.0.0.1:7420/`. Use `agent-browser set viewport 1440 900` unless a step says otherwise. Compare each screenshot with its board in `docs/design/graph-manager/NN-*.png` (open both). For dark, pick Settings → Appearance → Dark (or `eval 'localStorage.setItem("gm.theme","dark")'` and reload); `eval 'document.documentElement.dataset.theme'` returns the resolved theme. Each step names its evidence.

1. **Log in** (boards 03/04). A wrong password first. Expected: "Wrong password." under a red field; then `pw` lands on `/runs`. Evidence: screenshots in light and dark, and `get url`.
2. **Connect forges** (17/18). Settings: GitHub `gh-good`, GitLab `gl-good` + `http://127.0.0.1:7421/gitlab`; first a bad token. Expected: the red `GitHub 401: Bad credentials` box, then both cards `connected` with "Connected as octo" / "gitlab-user" and the API URL. Evidence: screenshots, `curl -b … /api/forges`.
3. **Clone** (15/16). Workspaces → Clone repository, search `hello`, Clone `octo/hello`. Expected: the toast "Cloned octo/hello · Open terminal", the row `github · octo/hello · main · clean`, and no dimming behind the drawer. Evidence: screenshot with the drawer open in light and dark.
4. **Terminal and run.** Open terminal on the row; copy `packages/graph-execution/src/__fixtures__/diamond` and a `spec.md` into the clone and commit them; type `graph-execution diamond --spec spec.md --provider fake --web`. Expected: the run's URL prints; the sidebar item shows the run chip. Evidence: screenshot of the terminal.
5. **Runs** (05/06). Expected: the run shows `live` (with a hanging `task:4`, `running`), then `applied`, with the Ready for PR card counting it and a **Create PR** button; `s` opens the Start run drawer. Evidence: screenshots in light (drawer open) and dark, `curl … /api/runs`.
6. **Run detail live** (10/11) on a hanging run. Expected: the nav is a rail, the run page fills the area, `scrollHeight - innerHeight` is `0`. Evidence: screenshots in light and dark.
7. **Run detail finished.** Close the run page (iframe **Close**). Expected: the static view without the "stopped responding" banner: phase cards (Validation `passed`), the graph and the task table. A failed run (`task:3` failing 3 times) at `800 1500` (12): the Pull request panel first, `3 failed after 3 attempts`, "not reached", no horizontal scrollbar on the task table. Evidence: screenshots.
8. **Create PR** (13/14). On the applied run press **Create PR**. Expected: the steps checkout → commit → push → create, then "Pull request #1 ↗" and the toast "Opened PR #1"; `curl http://127.0.0.1:7421/__fake/pulls` lists `head: gm/<runId>`. A GitLab run reads Create MR / "Merge request !1". Evidence: screenshots in light and dark and the curl output.
9. **Terminals** (07/08, 09). Four panes with `?run=<ws>/<runId>` in one of them; then `set viewport 800 1000`. Expected: 2×2 with a run pane, titles readable (the path truncates first), no status badge or amber border on any pane; at 800 the sidebar is the **Terminals N** drawer and one pane fills the page. Evidence: screenshots in light and dark.
10. **States** (19/20). Expected, each with a screenshot: kill the server → within ~6 s the amber "Can't reach the server. Showing data from Ns ago. Retrying…" and an amber "updated Ns ago" (restart it after); no terminals and no tabs → "No terminals open" with the workspaces root path and **New terminal Ctrl Space n**; `exit 1` → "Process exited with code 1" with Restart / Close; the failed run's PR card "Not available: …"; both forges disconnected → the clone drawer's "No forge connected" box; toasts "Cloned …", "Opened PR #1" and, when a run fails while the app is open, "Run xxxx failed in <repo>" with **Open**; the dialogs "Close “…”?" (a terminal running `node`, `Ctrl Space x`), "Can't delete octo/hello yet" (OK / Open run, click Delete while a run is live) and "Disconnect GitHub?".
11. **Keyboard.** Expected: `Ctrl K`, type part of a run id, Enter → its detail page; `g r`, `g t`, `g w`, `g s` → `/runs`, `/terminals`, `/workspaces`, `/settings`; on Runs and Workspaces `j`/`k` move the focused row and Enter opens it (Workspaces: a terminal); `/` focuses the filter (`eval 'document.activeElement.hasAttribute("data-filter")'` is `true`); `s` opens Start run and Ctrl+Enter submits; `p` on a ready row opens `/runs/<ws>/<id>#pr` with the form; in a terminal `Ctrl Space` then `n` (Enter creates), `x`, `1`–`4`, `|` act and never reach the shell (`a` does nothing); Esc closes drawers and dialogs and the focus returns to the opener. Evidence: `get url` and `eval 'document.activeElement…'` after each.
12. **No horizontal scroll.** On `/`, `/runs`, `/terminals`, `/workspaces`, `/workspaces?clone=1`, `/settings` and a live, an applied and a failed run detail, at widths 1440, 1100, 1000, 900 and 800: `eval 'document.documentElement.scrollWidth - innerWidth'`. Expected: `0` everywhere. Evidence: the list of outputs.
13. **Fonts stay on the origin.** `eval 'performance.getEntriesByType("resource").map(e => e.name)'`. Expected: the Geist and Geist Mono woff2 files under `http://127.0.0.1:7420/assets/` and nothing from fonts.googleapis.com or fonts.gstatic.com; `eval '[...document.fonts].filter(f => f.status === "loaded").map(f => f.family)'` lists `Geist Variable` and `Geist Mono Variable`. Evidence: both outputs.
