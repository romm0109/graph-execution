If testing the browser use agent browser.
U must test and see the ui by yourself if its ui changess

# How to see the app

Always test the code in this worktree, not a global `graph-execution`:

```bash
npm run build
CLI="$PWD/dist/cli.js"
FIX="$PWD/src/__fixtures__"
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

Other attempt fields (`throw`, `report`, `summary`, `write`, `commit`) are documented in `src/providers/fake.ts`.

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

Start `graph-execution suite --web --human-review` on `demo/suite` (see `demo/suite/run.sh --human-review`) and open the printed URL. The review is in the right panel (at least 60vw wide, drag its edge to resize; the width is kept in `localStorage['ge.panel']`) with a sticky Apply / Request changes / Drop bar. Repeat steps 1–6 on the suite page: the diff rows have old and new line numbers, `curl http://127.0.0.1:<port>/api/review/files?round=1` lists the round's files, and `<suiteDir>/human/round1.json` holds the comments with the same fields as a run's.

## Web UI checklist

Run it on BOTH pages: a run (start it as in "Web view" above, with `task:4` set to `hang` so one node keeps running) and a suite (`demo/suite/run.sh --human-review`, same two environment variables). Use `agent-browser set viewport 1280 800` unless a step says otherwise. Each step names its evidence.

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
