---
name: run-graph
description: Start a graph-execution run of a task folder in the background and open its live view in the browser. Use when the user wants to run, start or execute the tasks created by to-tasks, or asks to "run the graph".
---

# Run the graph

Start a `graph-execution` run in the background, hand the live view to the user, and stop.

## 1. Work out the arguments

- **Tasks folder:** the one `to-tasks` just wrote in this conversation; otherwise `.agents/tasks` if it exists; otherwise ask.
- **Spec:** the PRD used to make the tasks in this conversation; otherwise ask. Never guess between several files.
- **Provider:** what the user said. Otherwise default to your own CLI and say so: Claude Code → `claude`, Codex → `codex`, OpenCode → `opencode`, Qwen Code → `qwen`. Any other agent: ask.
- Pass `--concurrency`, `--model` and `--no-merge` only if the user asked for them.

## 2. Warn, don't block, about uncommitted code

Run `git status --porcelain`. If it shows changes outside the tasks folder and the spec, tell the user that agents only see committed code and ask whether to continue or commit first. The task folder and the spec do not need to be committed.

## 3. Launch

From the repo root (use `graph-execution` directly if it is installed globally):

```bash
npx graph-execution <tasks> --spec <spec> --provider <p> --web
```

## 4. Report and stop, by exit code

Decide by the exit code, never by matching the output.

- **0**: give the user the URL the CLI printed and tell them:
  - the run is in their browser and can be aborted there;
  - a failed node can be retried from its page: click the node, read the AI summary, press Retry;
  - when the review is clean, the result lands as uncommitted changes on the current branch, on top of whatever they edit meanwhile, with overlaps as conflicts;
  - `graph-execution open` brings the page back;
  - `graph-execution --resume --web` continues an interrupted run.

  Then end the turn. Do not sleep, poll, fetch the URL, read `.graph-execution/`, or tail logs.
- **3** (hand-off blocked): give the user the command the CLI printed to run in their own terminal, then stop. Do not work around the sandbox.
- **2**: show the error. Fix what is fixable within this skill's scope (for example an invalid task file, by re-running the `to-tasks` validation) or ask the user, then try again. Never retry the same failing command unchanged.

## 5. Never

- Never run `graph-execution` without `--web` from your shell.
- Never start a second run while one is live (check with `graph-execution open`) unless the user asks.
