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

1. Open a file in the diff and add a line comment (tick *needs live check*), then a general comment.
2. Press **Request changes**. The phase line reads `fix pass 1/3 (human round 1)`, and the run pauses again.
3. Check that each comment shows a fixer note and a reviewer verdict, then **Resolve** them and press **Apply**.
4. `curl http://127.0.0.1:<port>/state` shows `review.waiting`. `$REPO/.graph-execution/<run-id>/human/round1.json` holds the comments.

## What to check

- If the change touches the run view, check it in BOTH the terminal UI and the web view. They show the same graph.
- Check a run in progress (`hang`), a clean run (no script) and a failed run (`exitCode: 1`) if the change can affect them.
- Put the screenshot path or the captured screen text in your report as evidence.
