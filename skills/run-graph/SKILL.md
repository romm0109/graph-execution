---
name: run-graph
description: Start a graph-execution run of a task folder, or a suite of several task folders, in the background and open its live view in the browser. Use when the user wants to run, start or execute the tasks created by to-tasks, asks to "run the graph", or wants several features (PRDs) built in parallel and integrated.
---

# Run the graph

Start a `graph-execution` run or suite in the background, hand the live view to the user, and stop.

## 1. Run or suite

- **Run:** one task folder and one PRD.
- **Suite:** several features, each a task folder with its own PRD. Use it when `to-tasks` wrote several feature folders in this conversation (`.agents/tasks/<feature>/`), when `.agents/tasks/` has subfolders of task files instead of task files, or when the user asks to build several PRDs together. A suite needs at least two features.

## 2. Work out the arguments

- **Tasks folder(s):** the ones `to-tasks` just wrote in this conversation; otherwise `.agents/tasks` (or its feature subfolders) if it exists; otherwise ask.
- **Spec(s):** the PRD used to make each task folder in this conversation; otherwise ask. Never guess between several files, and never pair a folder with a PRD you are unsure of.
- **Provider:** what the user said. Otherwise default to your own CLI and say so: Claude Code → `claude`, Codex → `codex`, OpenCode → `opencode`, Qwen Code → `qwen`. Any other agent: ask.
- **Several repos:** the features of a suite may be in different git repos (a backend and a frontend, for example). Each feature belongs to the repo of its tasks folder. Then pass `--feature` with absolute paths. The suite runs from the current folder, which need not be a repo. Later `graph-execution open`, `list`, `clean` and `suite --resume` must run from that same folder.
- Pass these only if the user asked for them:
  - `--concurrency <n>`: tasks running at once. In a suite it is the cap for the whole suite, split across the features.
  - `--model <m>`
  - `--no-merge`: keep the result on its branch instead of applying it.
  - `--human-review` / `--no-human-review`: pause before applying so the user can review the diff and ask for changes, or apply without that pause.

## 3. Warn, don't block, about uncommitted code

Run `git status --porcelain`. If it shows changes outside the task folders and the specs, tell the user that agents only see committed code and ask whether to continue or commit first. The task folders and the specs do not need to be committed. For a suite over several repos, check every repo (`git -C <repo> status --porcelain`).

## 4. Check nothing is already running

Run `graph-execution list`. A run or suite with a live process shows its pid. Do not start a second one unless the user asks.

## 5. Launch

From the repo root (use `graph-execution` directly if it is installed globally).

Run:

```bash
npx graph-execution <tasks> --spec <spec> --provider <p> --web
```

Suite, one `--feature <task-folder>:<prd>` per feature:

```bash
npx graph-execution suite --feature <tasks-a>:<prd-a> --feature <tasks-b>:<prd-b> --provider <p> --web
```

## 6. Report and stop, by exit code

Decide by the exit code, never by matching the output.

- **0**: give the user the URL the CLI printed. For a **run**, tell them:
  - the run is in their browser and can be aborted there; closing the tab does not stop it;
  - the page is a graph they can drag, scroll and zoom; clicking a node shows its changed files and diffs;
  - a failed node can be retried from its page: click the node, read the AI summary, press Retry;
  - when the review is clean, the result lands as uncommitted changes on the current branch, on top of whatever they edit meanwhile, with overlaps as conflicts;
  - `graph-execution open` brings the page back;
  - `graph-execution --resume --web` continues an interrupted run.

  For a **suite**, tell them:
  - each feature runs as its own run and shows as a box with its whole graph (tasks, validation, code reviewer, live tester, fixer); a failed feature gets a Retry button while the others keep going, and **Start integration** integrates the others without the failed ones;
  - once every feature is done, the features are merged one by one in the order they finished; a merge that conflicts goes to the **integration agent** node, which resolves it with the PRDs involved, or waits with **Retry integration** if it gives up;
  - then an end-to-end phase checks the combined result (validation, cross-feature reviewer, e2e tester, fixer), and the result lands once, as uncommitted changes on the current branch;
  - the suite is in their browser and can be aborted there; closing the tab does not stop it, and `graph-execution open` brings the page back;
  - `graph-execution suite --resume --web` continues an interrupted suite.
  - if the features are in several repos: each repo gets its own `suite/<id>` branch with only its features merged, then one combined e2e phase runs on all repos side by side, and the result is applied to every repo or to none (if any repo cannot take it, the log names the repo). `open`, `list`, `clean` and `--resume` must run from the folder the suite was launched in.

  Also mention that `graph-execution list` and `graph-execution clean` show and remove old runs and suites.

  Then end the turn. Do not sleep, poll, fetch the URL, read `.graph-execution/`, or tail logs.
- **3** (hand-off blocked): give the user the command the CLI printed to run in their own terminal, then stop. Do not work around the sandbox.
- **2**: show the error. Fix what is fixable within this skill's scope (for example an invalid task file, by re-running the `to-tasks` validation, or a `--feature` value that is not `<task-folder>:<prd>`) or ask the user, then try again. Never retry the same failing command unchanged.

## 7. Never

- Never run `graph-execution` without `--web` from your shell.
- Never start a second run or suite while one is live (step 4) unless the user asks.
