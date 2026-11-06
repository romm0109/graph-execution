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

graph-manager (`apps/graph-manager`) is a web service around graph-execution. Build both, then start it with temp dirs and log in:

```bash
npm run build -w graph-execution && npm run build -w graph-manager
GM_DIR=$(mktemp -d)
GM_PASSWORD=pw GM_PORT=7420 GM_DATA_DIR=$GM_DIR/data GM_WORKSPACES_DIR=$GM_DIR/ws node apps/graph-manager/dist/server/main.js &
curl -s -c $GM_DIR/c -X POST -H 'content-type: application/json' -d '{"password":"pw"}' http://127.0.0.1:7420/api/auth/login
curl -s -b $GM_DIR/c http://127.0.0.1:7420/api/health      # {"ok":true}
```

- Without a cookie, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7420/api/health` prints `401`, and so does `/runs/x/y/view`.
- Without `GM_PASSWORD` the server exits 1 and prints `GM_PASSWORD is required`.
- Open http://127.0.0.1:7420/ with agent-browser, log in with `pw`, and look at each page: Workspaces, Terminals, Runs and Settings in the left nav, and **Log out**. A wrong password shows "Wrong password.". Reload on `/settings`: the page still shows (SPA fallback).
- Stop the server by its PID (`kill $!`), never by name.

### Terminals

- Terminals page → **New terminal**, type `echo hi`, reload the page, and the output is still there. Type `graph-execution --version`: it prints the engine version. The sidebar shows `working` while output flows and `exited 0` after `exit`.
- In a terminal, `echo $GRAPH_EXECUTION_HANDOFF-${GM_PASSWORD:-none}` prints `detached-none`.
- `/terminals?workspace=<id>` opens a terminal in that workspace. `POST /api/terminals` with `{"cwd":"/etc"}` answers 400.

Later sections cover forges (with a fake forge), terminals and runs.

### Forges (fake forge)

`apps/graph-manager/scripts/fake-forge.mjs` serves a fake GitHub API at `<url>/github` and a fake GitLab API at `<url>/gitlab/api/v4`, with bare git repos (cloned over `file://`) under the given dir. It starts with GitHub repo `octo/hello` and GitLab project `grp/sub/proj`. No real tokens are needed, and none may be used in tests.

```bash
node apps/graph-manager/scripts/fake-forge.mjs 7421 $GM_DIR/forge &
# start graph-manager with GM_GITHUB_API_URL=http://127.0.0.1:7421/github
# Settings → GitHub token: gh-good (login octo). GitLab: token gl-good, base URL http://127.0.0.1:7421/gitlab
```

- Any other token gets 401 `Bad credentials`: Connect shows `GitHub 401: Bad credentials` under the card and nothing is saved.
- `curl -s -b $GM_DIR/c http://127.0.0.1:7420/api/forges` shows `connected` and the login, never the token. `/api/forges/github/repos` lists `octo/hello`.
- Pull requests opened against the fake are listed at `http://127.0.0.1:7421/__fake/pulls`. A PR whose head branch is missing from the bare repo gets 422.
- Stop the fake forge by its PID.

### Runs dashboard

In a terminal in a cloned workspace, copy the engine's diamond fixture in, commit it, and run `graph-execution diamond --spec spec.md --provider fake --web`. The Runs page shows the run within a few seconds; its detail page shows the live graph in the iframe. After the run, press Close in the iframe: the detail page switches to the static graph. Also try **Start run** with provider `fake (testing)`.

Without the UI (with the server and cookie from above, and a workspace under `$GM_DIR/ws/github/octo/hello` holding the committed `diamond/` and `spec.md`):

```bash
curl -s -b $GM_DIR/c -X POST -H 'content-type: application/json' \
  -d '{"tasksDir":"diamond","spec":"spec.md","provider":"fake"}' http://127.0.0.1:7420/api/runs/github~octo~hello   # 201 {runId, viewUrl}
curl -s -b $GM_DIR/c http://127.0.0.1:7420/api/runs                                                             # the run, live:true
curl -s -b $GM_DIR/c http://127.0.0.1:7420/runs/github~octo~hello/<runId>/view/state                             # the run page's state, through the proxy
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7420/runs/github~octo~hello/<runId>/view/                # 401 without the cookie
```

A path outside the workspace answers 400, an unknown run 404, and the view URL of a run whose page is closed 404.

### Workspaces

With the fake forge connected: Workspaces → **Clone repository**, pick GitHub, search `hello`, **Clone** `octo/hello`. The row shows branch `main`, `clean`. **Open terminal** opens a terminal in that folder (`pwd` shows `.../github/octo/hello`).

- `git -C $GM_DIR/ws/github/octo/hello config --get-regexp extraheader` prints nothing (the token is not saved), and `.git/info/exclude` ends with `.graph-execution/`.
- Cloning `octo/hello` again gives `already cloned`. Writing a file in the clone turns the badge `dirty` after a reload; files under `.graph-execution/` do not.
- **Delete** asks for confirmation, closes the workspace's terminals and removes the folder. While a run is live in it (`.graph-execution/<run>/lock` holds a live PID) it answers `a run is live in this workspace`.

### Create PR/MR

After a fake-provider run reaches `applied` in a cloned workspace, the run page shows **Create PR**. Submit it and a link appears. `curl http://127.0.0.1:7421/__fake/pulls` lists the PR with `head: gm/<runId>`.

- The form is prefilled: branch `gm/<runId>`, base `main`, the spec's first `# ` heading as title, and the task list as body. A GitLab workspace (`grp/sub/proj`) shows **Create MR**.
- `git -C $GM_DIR/forge/octo/hello.git ls-tree -r --name-only gm/<runId>` lists the run's files and nothing under `.graph-execution/`; the clone's `config --get-regexp extraheader` still prints nothing.
- Before the run lands, with no changes, or with the forge disconnected, the section shows the reason instead of the button. A second `POST /api/runs/<ws>/<runId>/pr` answers 409; a bad branch name 400; a failed step 502 `{error: "<step> failed: …", step}`.
