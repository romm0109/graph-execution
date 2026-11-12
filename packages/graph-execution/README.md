# graph-execution

[![npm](https://img.shields.io/npm/v/graph-execution)](https://www.npmjs.com/package/graph-execution)

For developers who already use a coding agent (Claude Code, Codex, OpenCode, Qwen Code, pi, oh-my-pi or GitHub Copilot) and want it to build a whole feature: you split the work into tasks with dependencies, and graph-execution runs them in parallel, reviews the result against your spec and hands it back as uncommitted changes.

- Independent tasks run in parallel, each in its own git worktree.
- Each finished task is merged into an integration branch `graph/<run-id>`, which unlocks the tasks that depend on it.
- When every task is merged, a review loop runs. Your validation commands come first, then a code reviewer and a live tester run in parallel and judge the result against your PRD. A fixer handles blockers and majors, for up to 3 fix passes.
- Once the review is clean, the result lands on the branch you started the run from as **uncommitted changes**: review them in `git diff` or your editor, then commit them yourself (`--no-merge` keeps it on its own branch only).
- The run is resumable.

**Works without graph-manager.** Everything above is in this CLI: runs, reviewers files, test plans, human review in the terminal's web view, resume, suites, `list`, `clean`, `open`, the sandbox and the skills. Each of these features is covered by an end-to-end test of the built CLI (`src/standalone-e2e.test.ts`). graph-manager adds a desktop dashboard on top: the web dashboard of every run, agent terminals, Create PR, and the reviewers page.

## Quick start

You need Node.js 20+, git with a commit identity, and one provider CLI on your `PATH` that is already logged in (`claude`, `codex`, `opencode`, `qwen`, `pi`, `omp` or `copilot`).

In the git repository you want to change, write a spec and one task:

```bash
mkdir -p tasks
printf '# Hello\n\nThe repo has a hello.txt file that says "Hello, world".\n' > PRD.md
cat > tasks/1.json <<'JSON'
{ "id": "1", "content": "Create hello.txt containing exactly: Hello, world" }
JSON
```

Then run it:

```bash
npx graph-execution ./tasks --spec PRD.md --provider claude
```

> **Safety:** agents run in full-auto mode with your user's permissions. This is not a sandbox, so only run tasks and specs you trust, or add `--sandbox` to run the whole run in a Docker container that sees only your repository. See [Safety](#safety) and [Sandbox](#sandbox-docker).

When it finishes, `git diff` shows the result. For real work, let your agent write the tasks for you: see [Skills](#skills-graph-execution-install-skills).

## Contents

- [Requirements](#requirements) · [Installation](#installation) · [Usage](#usage) · [Task file format](#task-file-format) · [Configuration](#configuration-graph-executionconfigjson)
- [The review loop](#the-review-loop) · [Reviewers file](#reviewers-file-optional) · [Human review](#human-review-optional) · [When a node fails](#when-a-node-fails-summary-and-retry) · [Resume](#resume) · [Exit codes](#exit-codes)
- [Suites](#suites) · [Cleaning up runs](#cleaning-up-runs) · [Skills](#skills-graph-execution-install-skills) · [Safety](#safety) · [Sandbox](#sandbox-docker) · [Development](#development)
- [graph-manager](#graph-manager): the web app, started with `graph-execution manager`

## Requirements

- Node.js 20 or later, and git with a commit identity (`git config --global user.name "…"` and `user.email`, or the `GIT_AUTHOR_*` / `GIT_COMMITTER_*` variables). Every agent commits, so a run without one stops at startup with exit code 2 and the commands to set it.
- The CLI of the provider you choose must be on the `PATH` and already logged in: `claude` (Claude Code), `codex`, `opencode`, `qwen` (Qwen Code 0.6 or later), `pi`, `omp` (oh-my-pi, which also needs [Bun](https://bun.sh) on the `PATH`) or `copilot` (GitHub Copilot CLI). graph-execution stores no credentials. For `qwen`, log in with `qwen` interactively once, or set the API key in Qwen Code's `settings.json`; don't put `--openai-api-key` in `GRAPH_EXECUTION_QWEN_ARGS`, because run logs aren't redacted. For `copilot`, log in with `copilot login` once, or set `COPILOT_GITHUB_TOKEN` to a fine-grained personal access token with the Copilot Requests permission. Copilot keeps every session on disk; graph-execution gives each agent its own session id and deletes that session's folder (`$COPILOT_HOME/session-state/<id>`, default `~/.copilot`) when the agent exits.
- Extra flags for the provider CLI go in `GRAPH_EXECUTION_CLAUDE_ARGS`, `GRAPH_EXECUTION_CODEX_ARGS`, `GRAPH_EXECUTION_OPENCODE_ARGS`, `GRAPH_EXECUTION_QWEN_ARGS`, `GRAPH_EXECUTION_PI_ARGS`, `GRAPH_EXECUTION_OMP_ARGS` or `GRAPH_EXECUTION_COPILOT_ARGS`. They are split like a shell does: `"two words"`, `'two words'` and `two\ words` stay one argument; nothing is expanded. An unterminated quote stops the run at startup.
- macOS, Linux or Windows.
- The package depends on [`node-pty`](https://www.npmjs.com/package/node-pty), which the terminals of [graph-manager](#graph-manager) use. On macOS and Windows (x64 and arm64) it installs a prebuilt binary. It has no prebuilt binary for Linux: there `npm install` compiles it, which needs Python 3, make and a C++ compiler (for example `sudo apt-get install -y python3 make g++`, or `build-essential`, on Debian and Ubuntu).

### Supported agents

| Agent | `--provider` | CLI | npm package |
|---|---|---|---|
| Claude Code | `claude` | `claude` | `@anthropic-ai/claude-code` |
| Codex | `codex` | `codex` | `@openai/codex` |
| OpenCode | `opencode` | `opencode` | `@opencode/cli` |
| Qwen Code | `qwen` | `qwen` | `@qwen-code/qwen-code` |
| pi | `pi` | `pi` | `@mariozechner/pi-coding-agent` |
| oh-my-pi | `omp` | `omp` (runs on Bun) | `@oh-my-pi/pi-coding-agent` |
| GitHub Copilot | `copilot` | `copilot` | `@github/copilot` |

The list comes from the provider catalog (`src/providers/catalog.ts`, exported from `graph-execution/api` as `PROVIDER_CATALOG`).

<details>
<summary><strong>Windows notes</strong></summary>

graph-execution runs on Windows in Windows Terminal, PowerShell or cmd. A few things behave differently there:

- **Provider CLIs** installed through npm (`claude.cmd` and similar) are found through `PATH` and `PATHEXT`, like any other command.
- **Prompts go to the agent's stdin**, not its command line, on every platform. On Windows, npm's `.cmd` shims run through `cmd.exe`, which caps a command line at 8,191 characters. Reviewer prompts (spec plus the whole diff) are far longer than that and used to fail with "The command line is too long".
- **`validate` and `setup` commands** run through a POSIX `sh`, as on macOS and Linux, so `export`, `rm -rf`, `$VAR` and `&&` work. graph-execution uses `sh` from your PATH, or else the `sh.exe` of the Git for Windows install that `git` comes from. If neither is found, the commands run through `cmd.exe`. Set `GRAPH_EXECUTION_SHELL=cmd` to always use `cmd.exe`, or to the path of another `sh` to use that one.
- **Aborting a run** (Ctrl+C) kills each running agent and its child processes with `taskkill /T`. Processes an agent leaves running after it exits (for example an app the live tester started) are killed too: Windows keeps an orphan's parent PID, so they are found in the process table (through PowerShell) and killed, with creation times checked so a reused PID is never touched. Processes left by a CLI that was itself killed (`--resume`, `clean`) are still best effort on Windows.
- **Non-ASCII paths and arguments** (for example `C:\Users\Zoë`) reach a `--web` run unchanged: its launch script switches cmd.exe to UTF-8 (`chcp 65001`).
- **`--resume` after a crash** checks that the PID in the run's lock is still the process that took it. Windows reuses PIDs right away, so a live PID alone does not mean the run is still going.
- **The "drop them" command** in the end-of-run summary quotes paths with double quotes. It works in cmd and PowerShell 7. Windows PowerShell 5.1 doesn't support `&&`, so run its two parts one after the other there.

</details>

## Installation

The package is published on npm as [`graph-execution`](https://www.npmjs.com/package/graph-execution). Run it without installing:

```bash
npx graph-execution --help
```

Or install it globally to get the `graph-execution` command:

```bash
npm install -g graph-execution
```

## Usage

```bash
npx graph-execution ./tasks --spec PRD.md --provider claude
```

```
graph-execution <tasks-dir> --spec <prd-file> --provider claude|codex|opencode|qwen|pi|omp|copilot [--concurrency 3] [--model <m>] [--no-merge] [--human-review|--no-human-review] [--attempts <n>] [--fix-passes <n>] [--validation-rounds <n>] [--validate-at task|end] [--validate-parallel|--no-validate-parallel] [--idle-timeout <min>] [--reviewers <file>] [--review-provider <name>] [--review-model <m>] [--web] [--sandbox [--sandbox-image <image> | --sandbox-base <image>] [--sandbox-line <line>]... [--no-sandbox-config-lines] [--sandbox-cpus <n>] [--sandbox-memory <MB>] [--sandbox-pids <n>]]
graph-execution --resume [--run <id>] [--no-merge] [--web] [--sandbox]
graph-execution open [--run <id>]
graph-execution suite --feature <tasks-dir>:<prd> --feature <tasks-dir>:<prd> ... --provider <name> [--concurrency 3] [--model <m>] [--no-merge] [--human-review|--no-human-review] [--web]
graph-execution suite --resume [--run <suite-id>] [--web]
graph-execution list
graph-execution clean [<run-id>] [--done] [--force] [--yes]
graph-execution install skills [--target agents|claude|both|codex|opencode|qwen|pi|omp|copilot|all] [--force]
graph-execution readme [--print]
```

| Option | Meaning |
|---|---|
| `<tasks-dir>` | Folder of `*.json` task files (see below). |
| `--spec <file>` | **Required.** The PRD that the reviewers and the fixer judge the result against. The run refuses to start if the file is missing, unreadable or empty. |
| `--provider <name>` | **Required.** One provider is used for every agent in the run: `claude`, `codex`, `opencode`, `qwen`, `pi`, `omp` or `copilot`. |
| `--concurrency <n>` | Maximum number of tasks running at once. Overrides `concurrency` in the config file. Default: 3. |
| `--model <m>` | Model name passed to the provider CLI. |
| `--resume [--run <id>]` | Resume an interrupted or aborted run. Without `--run` it resumes the latest run. |
| `--no-merge` | Keep the result on `graph/<run-id>` only, instead of applying it to your branch at the end. |
| `--human-review` / `--no-human-review` | Pause before applying so you can review the result and ask for changes, or apply without that pause. Overrides `humanReview` in the config for this run. Not allowed with `--resume`. See [human review](#human-review-optional). |
| `--attempts <n>` | Attempts for every agent invocation. Overrides `attempts` in the config for this run. Saved with the run: `--resume` keeps it and refuses the flag. Not allowed with `--resume`. |
| `--fix-passes <n>` | Fix passes in the review loop (0 or more). Overrides `fixPasses` in the config for this run. Saved with the run: `--resume` keeps it and refuses the flag. Not allowed with `--resume`. |
| `--validation-rounds <n>` | Fix rounds when validation fails (0 or more). Overrides `validationRounds` in the config for this run. Saved with the run: `--resume` keeps it and refuses the flag. Not allowed with `--resume`. |
| `--validate-at task\|end` | When the gate runs. Overrides `validateAt` in the config for this run. Saved with the run: `--resume` keeps it and refuses the flag. Not allowed with `--resume`. |
| `--validate-parallel` / `--no-validate-parallel` | Run the `validate` commands all at once, or one after another. Overrides `validateParallel` in the config for this run. Saved with the run: `--resume` keeps it and refuses the flag. Not allowed with `--resume`. |
| `--idle-timeout <minutes>` | Stop an agent silent for this long; fractions allowed, `0` never stops it. Overrides `idleTimeoutMinutes` in the config for this run. Saved with the run: `--resume` keeps it and refuses the flag. Not allowed with `--resume`. |
| `--reviewers <file>` | Reviewers file (JSON). Default: `$GRAPH_EXECUTION_REVIEWERS`, else the built-in code reviewer and live tester. Copied into the run dir at start; not allowed with `--resume`. See [Reviewers file](#reviewers-file-optional). |
| `--review-provider <name>` | Provider of every reviewer (code reviewer, live tester, reviewers from a reviewers file) that has no `provider` of its own: `claude`, `codex`, `opencode`, `qwen`, `pi`, `omp` or `copilot`. Default: `reviewProvider` in the config, else `--provider`. Its CLI is checked at startup. The fixer always uses the run's provider and model. Saved with the run; not allowed with `--resume`. |
| `--review-model <m>` | Model of every reviewer that has no `provider` of its own and no `model`. Default: `reviewModel` in the config, else `--model`. Saved with the run; not allowed with `--resume`. |
| `--web` | Start the run as a background process owned by the operating system (not by your shell or your agent), open its live page in the browser and exit. Works with `--resume`. Over SSH it prints the URL and an `ssh -L` hint instead. See [the web view](#the-web-view). |
| `--sandbox` | Run the whole run in a Docker container that sees only your repository, then open its page like `--web` (implied). Linux and macOS only. Works with `--resume`. See [Sandbox](#sandbox-docker). |
| `--sandbox-image <image>` | With `--sandbox`: a ready-made image instead of the generated one. Not with `--sandbox-base` or `--sandbox-line`. |
| `--sandbox-base <image>` | With `--sandbox`: the `FROM` of the generated image. Default: `sandbox.base` in the config, else `node:24.22.1-bookworm`. |
| `--sandbox-line <line>` | With `--sandbox`: an extra Dockerfile line after the config's lines (repeat). No `FROM`. |
| `--no-sandbox-config-lines` | With `--sandbox`: leave out the config's `sandbox.dockerfile` lines for this run. |
| `--sandbox-cpus <n>`, `--sandbox-memory <MB>`, `--sandbox-pids <n>` | With `--sandbox`: the container's CPU, memory and process limits. Default: `sandbox.cpus`, `sandbox.memoryMb`, `sandbox.pids` in the config, else 2, 4096 and 2048. The image flags and limits are saved with the run and refused with `--resume`. |
| `open [--run <id>]` | Reopen the page of a run or suite started with `--web`, while its process is alive. `--run` takes a run id or a suite id (`suite-…`). Without it, it opens the latest run or suite. |
| `suite ...` | Run several features in parallel and integrate them. See [suites](#suites). |
| `list`, `clean` | Show and delete old runs, suites and leftover branches. See [cleaning up runs](#cleaning-up-runs). |
| `--version`, `-v` | Print the installed version and exit. |

`graph-execution readme` opens this README, rendered, in your browser. If no browser can be opened (over SSH, in CI), it prints the path of the HTML file instead. `--print` writes the markdown to stdout, for example to pipe it into `less`.

Run it from inside the git repository you want to change. Worktrees are cut from **committed** state, so uncommitted changes are not visible to the agents. The tool prints a warning about them and continues.

The spec and the task folder are the exception: they **don't need to be committed**. The tool copies both into `.graph-execution/<run-id>/context/` and tells every task agent where they are, so a task can say "see `PRD.md` section 7" even if `PRD.md` was never committed. They don't trigger the warning either.

### The live view

The run shows as one top-down graph: the tasks with arrows to the tasks that depend on them, then validate → code reviewer and live tester → fixer → apply. Running nodes have a heavy border and a spinner.

When the graph is taller than the terminal, it shows in a scrollable window: use the **mouse wheel**, `↑`/`↓` (or `j`/`k`), `PgUp`/`PgDn`, and `g`/`G` for top and bottom. The window follows the running tasks until you scroll; press `f` to follow again. While the window is scrollable, the terminal's own text selection needs a modifier (Shift-drag in most terminals, Option-drag in iTerm2). When the run ends, the whole graph and the summary are printed in full, so you can scroll back through them in the terminal as usual.

### The web view

`--web` shows the same graph as the terminal, in a browser page, with the final summary on the page when the run ends. The page has one button: **Abort** (with a confirm dialog) while the run is going, **Close** after it ends.

- The run lives in its own background process, so **closing the tab does not stop the run**. `graph-execution open` brings the page back.
- The page is served on `127.0.0.1` only, and requests with a foreign `Host` or `Origin` header are refused.
- After the run ends, the process stays up so you can read the summary, until you press **Close**.
![The run page: the graph on the left, a split diff in the resizable panel](docs/img/run-split-diff.png)

- **Full-viewport page.** The graph fills the window; the page itself never scrolls. Each node card shows its status, provider, elapsed time and `+`/`−` counts, and a running node pulses. The events list is a drawer at the bottom.
- **The graph is a canvas.** Drag it (or scroll) to move around, ctrl+scroll or pinch to zoom, or use the **−**, **+**, **fit** and **1:1** buttons in its corner. Double-click the background to fit it again. Dragging from a node doesn't select it.
- **Click a node** to open the right panel with the tabs **Overview** (its failure with **Retry** and **Merge**, its test plan), **Changes**, **Logs**, and **Review** while a human review waits.
- **Resizable panel.** Drag its left edge (up to 85% of the window); the width is kept across reloads. Below 900px wide it becomes a full-screen sheet.
- **Changes.** A file tree, then one section per file with highlighted code (highlight.js, loaded lazily as files scroll into view). Switch **Unified** and **Split** (split needs a panel at least 900px wide), collapse files, and expand the context around a hunk 20 lines at a time. Diffs load on demand and refresh while the agent works; lockfiles and files with more than 1000 changed lines start collapsed and carry a `large` hint, and files over 2000 diff lines are shown as plain text.
- **Live logs.** The Logs tab streams the node's agent logs as they are written. It stops following when you scroll up (a chip shows how many new lines came in), and it has a filter box.
- **Keyboard shortcuts.** `F` fits the graph, `+`/`-` zoom, `0` goes to actual size, `E` toggles the events drawer, and `Esc` closes the panel (or the summary).
- **Works offline.** The page, its styles, scripts and the highlighter are bundled with the package and served from `/assets/`: no CDN, no network access needed. Animations pause while the tab is hidden.
- Finished nodes keep their final changes. A node without changes shows `No changes yet`.

The original design left a web dashboard out of scope; the web view is the run view added later, and the terminal view is unchanged.

### Starting a run from your agent

After the `to-tasks` skill has written the task folder, your agent asks whether to start the run. The bundled `run-graph` skill then runs `graph-execution … --web` and **stops**: it never monitors the run, because the page does that. The launcher exits with:

| Code | Meaning |
|---|---|
| `0` | Started. The page is open (or its URL is printed). |
| `2` | Error. Nothing was started, or the run process died before its page was up; the tail of its log is printed. |
| `3` | The hand-off was blocked (for example by a strict sandbox). Nothing was started. The exact foreground command is printed, to run in your own terminal. |

To outlive your shell and your agent, the run is handed to the operating system with `launchctl` (macOS), `systemd-run --user` (Linux) or `schtasks` (Windows), and falls back to a detached process.

### What a run produces

```
graph/<run-id>                        # integration branch with all merged tasks and fixes
.graph-execution/<run-id>/
  state.json  lock                    # run state (used by --resume) and PID lock
  logs/<agent>.log                    # full output of every agent
  reports/round<N>/{code,tester}.json # review reports for each round
  reports/round<N>/fixer-comments.json # human review: the fixer's note per comment
  human/round<H>.json                 # human review: your comments for pause H
  worktrees/                          # task, integration and reviewer worktrees (removed on success)
  pids/                               # agent processes still running (removed as they exit)
```

In `logs/<agent>.log`, an output line longer than 1 Mi characters is truncated and ends with a `[truncated N characters]` marker, so an agent that prints without newlines cannot exhaust memory.

`.graph-execution/` is added to `.git/info/exclude`, which is local and never committed. The run state therefore never makes your working tree look dirty.

### The final step: your branch gets the changes, uncommitted

When the review ends clean (exit code 0), the tool applies `graph/<run-id>` to the branch that was checked out when the run started, **as uncommitted changes**. Nothing is committed or staged: changed files show as modified, and new files as plain untracked files, just like files you create yourself. Your editor's source control view shows all of them, and discarding one there restores or deletes it as you'd expect. It is a real three-way merge (`git merge --squash`), so it works even if you committed on your branch while the run was going.

The final summary lists every changed file with its line counts (new files marked `(new)`) and the run's commits, and tells you what to do next:

- **Review:** your editor's source control view, or `git status` and `git diff` (plain `git diff` does not list untracked new files).
- **Keep:** commit as usual, new files included. Git has a commit message ready that lists the run's commits.
- **Drop:** the summary prints the exact command, for example `git restore . && git clean -f -- src/new.ts test/new.test.ts`. It deletes only the files the run created, never your own untracked files.

**Your own uncommitted changes don't block it.** If tracked files had uncommitted changes, the tool saves them first (they also stay in `git stash list` as `graph-execution: your changes before applying graph/<run-id>`), applies the result, and puts your changes back on top. You end up with both in the same diff, and the summary lists only the run's files. In that case the drop command resets the checkout and applies your changes back from that backup, so you get back exactly what you had.

**Overlaps become merge conflicts, not failures.** A file changed by both the run and your uncommitted edits, or by the run and a commit made on your branch during the run, is left as a regular merge conflict: conflict markers in the file, and the file shows as conflicted in your editor. The summary lists these files. Resolve them as usual, then `git add` them. With your own edits, the markers say `Updated upstream` (the run's version) and `Stashed changes` (yours).

It does not apply the changes, and tells you why, when:

- the review loop is exhausted (exit 1) or the run aborts (exit 2);
- the code reviewer gave up (see below), so the result was never reviewed;
- you switched to another branch while the run was going;
- git refuses the merge, for example because a new file of the run would overwrite an untracked file of yours. It is rolled back, so your checkout is left exactly as it was;
- the run conflicts with commits made on your branch during the run **and** you have uncommitted changes. Two sets of conflicts can't be stacked, so your changes are put back exactly as they were (staging included);
- you passed `--no-merge`, or the run started on a detached HEAD.

When the apply itself failed (the branch switch, git's refusal or the stacked conflicts above), the run ends as an abort: exit code 2, and `graph-execution --resume --run <run-id>` retries only the apply once the obstacle is gone. In any of those cases you can also bring it in yourself once you are ready:

```bash
git log --oneline main..graph/<run-id>
git merge --squash --no-commit graph/<run-id>
```

## graph-manager

graph-manager is a web app around the engine, in the same npm package. From one browser tab you connect GitHub or GitLab, clone repositories into workspaces, open terminals to run `claude` and `graph-execution`, follow every run on a dashboard and open a pull request from an applied run.

```bash
npm install -g graph-execution
graph-execution manager
```

It prints its address and the password for the login page, then opens the browser:

```text
graph-manager listening on http://127.0.0.1:7420
Password: kq3ZJ0cXo1b9mVd2wTn5Hs8yLr4uAe7P (saved in /home/ada/.graph-manager/password)
```

It stays in the foreground; Ctrl+C stops it (exit code 0). A port in use exits 1 with `port <n> is already in use: pass --port or set GM_PORT`.

| Flag | Variable | Default | Meaning |
| --- | --- | --- | --- |
| `--port <n>` | `GM_PORT` | `7420` | The port to listen on (`0` picks a free one) |
| `--host <host>` | `GM_HOST` | `127.0.0.1` | The address to listen on |
| `--data-dir <dir>` | `GM_DATA_DIR` | `~/.graph-manager` | Where graph-manager keeps its data: the password, the tokens, the session secret |
| `--workspaces-dir <dir>` | `GM_WORKSPACES_DIR` | `~/graph-manager-workspaces` | Where repositories are cloned |
| `--no-open` | `GRAPH_EXECUTION_NO_OPEN=1` | | Do not open the browser. It is not opened either over SSH or when the output is not a terminal. |

A flag overrides its variable. Every other setting is a `GM_*` variable only.

- **Password:** the first start generates a password and saves it in `<data dir>/password` (mode 600); later starts read it from there, so it stays the same. Delete the file to get a new one. When `GM_PASSWORD` is set, that password is used instead: it is never written to the file, and the second line is `Password: from GM_PASSWORD`.
- **Skills:** at startup graph-manager installs the bundled skills (`to-spec`, `to-tasks`, `run-graph`) into `~/.claude/skills` and `~/.agents/skills`, so the agents in its terminals use the skills that match this version, and prints one `Installed the <name> skill into <folder>` line for each. A skill folder you made yourself is not replaced.
- **Other commands** (`graph-execution <tasks-dir>`, `list`, `clean`…) do not load graph-manager.

Sandboxed runs, Docker, every `GM_*` variable and the security notes are in [graph-manager's README](https://github.com/romm0109/graph-execution/tree/main/apps/graph-manager).

## Task file format

Each task is one JSON file in the tasks folder:

```json
{
  "id": "4",
  "content": "## Export endpoint\n\nImplement `GET /export` ...\n\n## Acceptance criteria\n- ...",
  "dependencies": ["2", "3"],
  "validate": null
}
```

| Field | Meaning |
|---|---|
| `id` | Unique non-empty string. |
| `content` | Markdown. **It is the main thing the task agent sees**, so make it self-sufficient: what to build, which files to read, acceptance criteria. The agent is also told where copies of the spec and the task files are, and may read them when the content refers to them. It does not get the content of the dependency tasks, but their code is already in its worktree. |
| `dependencies` | Ids of the tasks that must be merged before this one starts. Optional, defaults to `[]`. |
| `validate` | Optional per-task override: a list of commands, `false` to skip validation for this task, or `null`/absent to use `validate` from the config. Ignored with `validateAt: "end"`. |

The graph is validated before any agent runs. Invalid JSON, duplicate ids, unknown dependencies, self-dependencies and cycles are all reported at once, and the run exits with code 2.

Example (a diamond): `1` has no dependencies, `2` and `3` depend on `1`, and `4` depends on `2` and `3`. Tasks 2 and 3 run in parallel after 1 is merged, and 4 starts from a worktree that already contains 1, 2 and 3.

A task succeeds only when its agent exits cleanly **and** makes a new commit. The task agent is told to commit when it is done.

Agents are asked to commit their work. If one finishes cleanly but leaves changes uncommitted (it forgot, or committed only part), the tool commits the rest for it (`Task <id>: changes the agent left uncommitted`) instead of failing the attempt. The same goes for the fixer. Files that were already uncommitted when the agent started, such as output of `setup` or of a validation command, are left out of that commit. Only an agent that changed nothing at all counts as a failed attempt ("made no commit") and is retried.

A task whose work already exists (for example because an earlier task delivered it) is not a failure. The agent is told to record that with an empty commit (`git commit --allow-empty`), which goes through validation and merges like any other. A retry is also told why the previous attempt failed.

## Configuration: `graph-execution.config.json`

This file is optional and lives at the repository root. Unknown keys are rejected, so typos are caught at startup.

```json
{
  "setup": ["npm ci"],
  "validate": ["npx tsc --noEmit", "npx eslint .", "npm run build"],
  "concurrency": 3,
  "attempts": 3,
  "validationRounds": 3,
  "fixPasses": 3,
  "humanReview": false,
  "keepRuns": 5,
  "idleTimeoutMinutes": 20
}
```

| Key | Default | Meaning |
|---|---|---|
| `setup` | `[]` | Commands run once in every new worktree (tasks and reviewers) before the agent starts, for example `npm ci`. |
| `validate` | `[]` | Gate commands, run directly without AI after each task, once all tasks are merged, and after each fix pass. Failing output (its tail) goes back to the agent. |
| `validateAt` | `"task"` | When the gate runs during the task phase. `"task"`: after each task, then once more on the merged result. `"end"`: only on the merged result, once every task is merged. Tasks are not validated on their own, and a task file's own `validate` list is ignored. Either way, a failure on the merged result goes to the fixer. |
| `validateParallel` | `false` | Run the `validate` commands all at once instead of one after another. Every command runs to the end, so the agent gets all failures in one round instead of one at a time. Only use it when the commands don't interfere with each other (for example two of them writing the same build output). `setup` always runs first and in order. |
| `concurrency` | `3` | Maximum number of parallel tasks. `--concurrency` overrides it. |
| `attempts` | `3` | Attempts for every agent invocation: task, merge resolver, reviewer, tester and fixer. |
| `validationRounds` | `3` | Fix rounds when validation fails: after a task, on the merged result before the review, or after a fix pass. They do not consume fix passes. |
| `fixPasses` | `3` | Fix passes in the review loop. Every [human review](#human-review-optional) round gets a fresh budget of this size. |
| `humanReview` | `false` | Pause after the review loop and wait for you before applying. `--human-review` / `--no-human-review` override it. See [human review](#human-review-optional). |
| `loopDetection` | `{ "repeats": 5 }` | Stops an agent stuck in a loop and retries it: the same tool call `repeats` times in a row, or the same cycle of 2–3 calls `repeats` times. Identical means same tool and same input (a call's `description` is ignored). The stopped run counts as a failed attempt, and the next attempt starts in a fresh worktree and is told why. Works for every provider and every agent (task, resolver, reviewer, tester, fixer). `false` turns it off. |
| `idleTimeoutMinutes` | `20` | Stops and retries an agent that produces no output for this many minutes, for example a provider that hangs. The stop kills the agent and everything it started, and counts as a failed attempt; the next attempt starts fresh and is told why. Silence is what counts, not total time: Claude Code prints nothing while one long tool call (a slow test suite) runs, so keep it above your slowest command. Applies to every agent, including the failure summarizer, which is also always stopped after 5 minutes. Fractions are allowed; `0` turns it off. |
| `reviewProvider` | — | Provider of the reviewers without their own `provider` (see [Reviewers file](#reviewers-file-optional)). `--review-provider` overrides it. Unset: the run's `--provider`. The fixer always uses the run's provider and model. |
| `reviewModel` | — | Model of the reviewers without their own `provider` or `model`. `--review-model` overrides it. Unset: the run's `--model`. |
| `keepRuns` | `5` | Applied runs kept by the automatic cleanup at run start; `0` disables it. Only applied runs count and are deleted (folder, worktrees and `graph/<run-id>` branch); unfinished, `done` and live runs are never deleted automatically. When unfinished runs exist, the start prints a hint such as `3 unfinished runs use 650 MB, run graph-execution clean`. `--resume` does not clean up. `graph-execution clean` also uses it. |

`attempts`, `fixPasses`, `validationRounds`, `validateAt`, `validateParallel` and `idleTimeoutMinutes` can be overridden for one run with `--attempts`, `--fix-passes`, `--validation-rounds`, `--validate-at`, `--validate-parallel` / `--no-validate-parallel` and `--idle-timeout`; the file is not changed, the values are saved in the run's `state.json`, and `--resume` uses them again.

The hashes of the config, the tasks folder and the spec are recorded when the run starts. `--resume` refuses to continue if any of them changed.

## `REVIEW.md` and `TESTING.md` (optional)

Both files are read from the repository root at startup and passed to the reviewers in their prompts. They therefore work even when they are not committed. Neither file is required. A missing file never causes an error.

- **`REVIEW.md`**: your conventions for the **code reviewer**. Without it, the reviewer applies general rules for bugs, security and correctness.
- **`TESTING.md`**: tells the **live tester** how to boot the app, which endpoints or URLs to hit, which credentials to use and what to check. Without it, the tester tries its best using the README and the package scripts. If the tester cannot run the app, it records a "live test not performed" note that appears in the final summary, and the run does not fail.

## Reviewers file (optional)

By default a run has two reviewers: the built-in **code reviewer** (`code`, reads `REVIEW.md`) and the **live tester** (`tester`, reads `TESTING.md`). A reviewers file replaces that list, so you can add reviewers of your own, change their instructions, or turn one off. Pass it with `--reviewers <file>` or set `GRAPH_EXECUTION_REVIEWERS`; the flag wins. At start the file is copied to `.graph-execution/<run-id>/reviewers.json`, and resume, retries and human-review rounds read that copy (so `--resume` takes no `--reviewers`). A missing or invalid file makes the run exit 2 at startup.

```json
{
  "reviewers": [
    { "id": "code", "type": "diff", "name": "Code review", "enabled": true, "instructions": "…", "repoFile": "REVIEW.md", "blockAt": "major" },
    { "id": "tester", "type": "tester", "name": "Live test", "enabled": true, "instructions": "…", "repoFile": "TESTING.md" },
    { "id": "security", "type": "diff", "name": "Security", "enabled": true, "instructions": "…", "repoFile": "SECURITY_REVIEW.md",
      "provider": "claude", "model": "opus", "files": ["src/**", "!**/*.test.ts"], "blockAt": "blocker" }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | Kebab-case, 1-32 characters, unique. Names the worktree (`review-<id>-r<N>`), the log label (`<id>-r<N>`) and the report (`reports/round<N>/<id>.json`). |
| `type` | `diff` (reviews the diff, like the code reviewer) or `tester` (runs the app). At most one `tester`, and only with id `tester`. |
| `name` | 1-60 characters, shown in the views, logs and fixer prompt. |
| `enabled` | `false` skips the reviewer. With no enabled reviewer the run logs `no reviewers enabled; the result is not reviewed` and goes on to apply. |
| `instructions` | The reviewer's role text (up to 20 000 characters). The engine keeps the fixed parts of the prompt: report path, JSON shape, finding rules, previous-round verification and comment verdicts. |
| `repoFile` | A `.md` file name at the repo root, unique across reviewers. Each reviewer gets only its own file, read at startup (it need not be committed); a missing file is fine. |
| `provider`, `model` | Optional. Provider: the reviewer's own, else `--review-provider`, else `reviewProvider` in the config, else `--provider`. Model: the reviewer's own; for a reviewer without its own `provider`, else `--review-model`, else `reviewModel` in the config, else `--model`; a reviewer with its own `provider` but no `model` uses `--model`. The fixer always uses the run's provider and model. Every distinct provider is checked at startup (and on `--resume`), so a reviewer whose CLI is not on the `PATH` makes the run exit 2 before it starts. |
| `files` | Optional globs (`*`, `**`, `?`; `!` to exclude) matched against the changed files. The reviewer sees only the matching part of the diff; when nothing matches it writes a "not needed" report without running. |
| `blockAt` | `major` (default): blockers and majors start a fix pass. `blocker`: only blockers do. `never`: every finding of the reviewer is reported as minor, so it shows in the summary but never starts a fix pass. |

Each reviewer's prompt has two layers: the general `instructions` and its own repo file. Findings of reviewers other than `code` and `tester` get the reviewer id as a prefix (`security-F1`), so two reviewers never share an id; `plan-*` and `human-*` ids stay as they are. [Human review](#human-review-optional) comments, and their verdicts, go to the `code` reviewer when it is enabled, else to the first enabled `diff` reviewer; exactly one reviewer answers each comment. With no diff reviewer, comments get no verdict and count as not addressed. Suites keep the built-in reviewers. graph-manager sets `GRAPH_EXECUTION_REVIEWERS` for the runs it starts, from its reviewers page.

## Test plans (optional)

A test plan is a list of cases the live tester must check. It lives in `<tasks-dir>/test-plan.json`. The `to-tasks` skill drafts it from the PRD and shows it to you in the quiz step, where you can edit it or say "no plan".

```json
{ "cases": [ { "id": "P1", "title": "Create an item", "steps": ["POST /items with {\"name\":\"a\"}"], "expected": "201, and GET /items lists it", "priority": "must" } ] }
```

Ids match `^[A-Za-z0-9_-]+$` and are unique. `steps` and `cases` are non-empty. `priority` is `must` or `should`. Don't put credentials in the plan; the tester finds them in `TESTING.md`.

The tester reports a verdict for every case, every review round:

| Result | Finding |
|---|---|
| `must` case fails | blocker |
| `should` case fails | major |
| any case is `blocked` | major |

If a `must` failure is still open after the last fix pass, the result is not applied to your branch.

A malformed plan fails `graph-execution` at startup. Edits to the file are picked up on `--resume`. The final summary shows a line such as `Test plan: 7/8 passed (1 blocked)`, and the web view's live tester panel shows the checklist. Without the file, nothing changes.

## Human review (optional)

Turn on `"humanReview": true` in `graph-execution.config.json` (or pass `--human-review`) to review the result before it lands on your branch. When the review loop ends, the run does not apply anything. It pauses and the web view shows **Waiting for your review**, with the final diff (the run's starting commit against the integration branch). The pause comes whether the loop ended clean or with open blockers or majors.

The page's graph has a **human review** node between the fixer and the apply. It reads `waiting for you` during a pause, `changes, round N` while the agents work on your comments, then `approved` or `dropped`. Click it to jump to the review.

The review is the panel's **Review** tab, with a sticky bar of **Apply**, **Request changes** and **Drop** at the bottom, so the decision is always in reach while you scroll the diff.

![The Review tab: a general comment, the final diff and the decision bar](docs/img/review.png)

Your changes go through the same checks as the agents' changes: you don't edit the result yourself, you comment, and the fixer, validation, code reviewer and live tester handle the comments.

1. The run pauses. Read the diff and add comments.
2. Press **Request changes**. Your open comments become blocker findings, and the fixer works on them first.
3. Validation, the code reviewer and the live tester run again, with a fresh `fixPasses` budget. The phase line reads `fix pass 1/3 (human round 1)`.
4. The run pauses again. Each comment shows how it was handled. Resolve or reopen comments, comment more and go again, or apply.

| Action | What happens |
|---|---|
| Apply | Applies `graph/<run-id>` to your branch as uncommitted changes, like the [final step](#the-final-step-your-branch-gets-the-changes-uncommitted). Exit code 0. With `--no-merge` the button reads **Finish** and only ends the run. |
| Apply anyway | The same, offered instead of **Apply** while blockers or majors are open. A confirm dialog lists the count; the summary records that it was applied with open findings. |
| Request changes | Needs at least one open comment. Starts a fix pass with a fresh `fixPasses` budget. There is no limit on human rounds. |
| Drop | Applies nothing, after a confirm dialog. The worktrees are removed and `graph/<run-id>` is kept. Exit code 0 if the last review had no open blockers or majors, otherwise 1. |

### Comments

- A **line comment** is anchored to a file and a line of the diff, and keeps a short snippet of the code. A **file comment** has a file only. A **general comment** has neither.
- **Select lines like on GitHub.** Hover a line and press the `+` in the gutter, or click it. Drag the `+` to comment on a range, or shift-click a second `+`. The keyboard works too: focus a `+` with Tab and press Enter, then Shift+Up or Shift+Down to extend. A range stays inside one hunk of one file. You can comment on **deleted lines**: they are anchored to the old side of the file (`side: "old"`), added and unchanged lines to the new side.
- The composer is **markdown** with Write and Preview tabs and a small toolbar. A comment has a text and a **needs live check** box. The box also sends the comment to the live tester as an extra `must` case, so a failure is a blocker. It stays in the plan every round until you resolve the comment.
- **Suggested changes.** On new-side lines, **Suggestion** puts the selected lines into a ` ```suggestion ` block. Edit them: the fixer applies a suggestion exactly as written, replacing the commented lines, and the reviewer checks that it did. Deleted lines cannot take a suggestion.
- Comments show as **threads** under their line, with edit, delete, resolve and reopen. The **Comments** tab lists every comment grouped by round and file, with open, resolved and all filters; click one to jump to its lines. Files with open comments show a 💬 count.
- The **round switcher** shows an earlier round on its own diff, with its own threads, so a comment is never shown on a diff it was not written on. The suite page (`graph-execution suite --web --human-review`) has the same review in its right-hand panel.
- Comments get ids like `H1-2` (human round 1, comment 2). They stay pinned to the round they were written on: they are not moved onto the next diff, and are listed under previous comments with their snippet.
- Comments are saved as you type them. You can edit and delete comments of the current round.

### How each comment was handled

After a human round, the next pause shows for every comment:

- the **fixer's note** (the fixer writes one per comment; a missing note shows as "no note");
- the **code reviewer's verdict**, `addressed` or `not_addressed`, with its evidence. Every open comment needs a verdict with evidence, or the report is retried like any malformed report;
- for a live-check comment, the live tester's result.

You decide, not the reviewer: **Resolve** closes a comment even if the reviewer said `not_addressed`, and **Reopen** (with an optional follow-up text) opens it again even if it was addressed. Only open comments go into the next **Request changes**.

### Files

```
.graph-execution/<run-id>/
  human/round<H>.json                  # the comments of pause H, written as you edit them
  reports/round<N>/fixer-comments.json # [{ "id": "H1-1", "note": "..." }]
```

Rounds keep counting up across human rounds, so `reports/round<N>/` folders never collide.

### Without `--web`, and resume

Human review happens in the web view. If you did not pass `--web`, the web server still starts in the same process, next to the terminal view. The terminal view only shows the URL: `waiting for your review: http://127.0.0.1:<port>/`.

Waiting is saved state. Ctrl+C while waiting exits with code 2 and applies nothing; `graph-execution --resume` brings back the same pause with your comments, and `graph-execution open` does the same for a run started with `--web`. The effective setting is saved in the run, so `--resume` takes neither `--human-review` nor `--no-human-review`. A run with `humanReview` off behaves as before.

## The review loop

After every task is merged:

1. **Validation gate.** `validate` runs on `graph/<run-id>`. Tasks that pass on their own can still break once merged together. If the gate fails, the fixer gets the failing output, commits a fix, and the gate runs again, for up to `validationRounds` rounds. These rounds don't use up a fix pass. If it still fails after that, the run aborts (exit code 2, resumable). The live view then shows a **validation fixer** node between `validate` and the reviewers.
2. **Review.** The code reviewer and the live tester run in parallel. Each gets its own throwaway worktree, detached at the head of the integration branch, so they never touch it. Both receive the full `--spec` and the path of the tasks folder. The code reviewer also gets the diff against the starting commit and `REVIEW.md`. The tester also gets `TESTING.md`, the list of changed files and, when there is one, the [test plan](#test-plans-optional). Each one writes a JSON report with findings of severity `blocker`, `major` or `minor`. A finding without a concrete failure scenario is downgraded to minor.
3. **Fix.** If any blocker or major is still open, the fixer receives both reports and the spec, commits fixes on the integration branch, and validation runs again. Then the reviewers re-review: they verify the previous findings and may only add new blockers or majors.
4. The loop ends **clean** as soon as a review has no open blockers or majors. The result is then applied to your branch as uncommitted changes (see [the final step](#the-final-step-your-branch-gets-the-changes-uncommitted)). Otherwise it stops after **3 fix passes**, which means at most 4 reviews. Minor findings are listed in the final summary and never trigger a fix pass.

### Reports that don't parse

Agents don't always write the JSON exactly right. The tool handles that in three steps:

1. **Repair.** Before the strict schema check, unambiguous slips are fixed silently: JSON inside a Markdown code fence, a bare findings array, a missing `round` or `reviewer`, severity or status in another case or a common alias (`Critical` → `blocker`, `high` → `major`, `not fixed` → `not_fixed`), a missing `status` (`open`) or `id` (`F1`, `F2`, ...), and `"line": "42"`.
2. **Retry with feedback.** A report that still fails gets up to 3 attempts. Each retry is told exactly what was wrong (for example `findings.2.severity: invalid option`) and is shown the file it wrote, so it can reuse its findings and only fix the format.
3. **Give up without stopping the run.** After 3 failed attempts, the report records a note (`code review not performed: ...` or `live test not performed: ...`) that appears in the final summary. The previous round's unresolved findings stay open, so they still count. If it was the **code reviewer** that gave up, the result is not applied to your branch automatically.

## When a node fails: summary and retry

A node is **failed** when it errored or used all its attempts: a task, the validation gate, the validation fixer, the fixer, the code reviewer, the live tester, or the apply step.

The tool asks the same provider and model for a short plain-language explanation and a verdict (`likely to work`, `unlikely to help`, `unclear`) on retrying, and shows both on the node. It is advice only. It costs one extra agent call per failure, and is never made for Ctrl+C or Abort.

**Retry** re-runs that node:

- **Web:** click the failed node, then press **Retry**.
- **Terminal:** the view stays open after a failure. Arrows pick the failed node, `r` retries it and `q` quits (Ctrl+C also quits).

Retry resets the node's attempts to 0 and re-enters the run like `--resume` does, in the same process, so tasks the failure had interrupted restart as well.

**Merge as it is** is offered next to Retry whenever the result can still go to your branch (not with `--no-merge`, and not after it was applied):

- **Web:** the **Merge into `<branch>` as it is** button in the failure panel, with a confirm dialog.
- **Terminal:** the `m` key.

It applies `graph/<run-id>` to your branch as uncommitted changes, exactly like the last step of a clean run (the same stash, conflict and refusal rules, see [the final step](#the-final-step-your-branch-gets-the-changes-uncommitted)), and ends the run with the usual summary. What lands is only what was merged so far, plus any fixes: the failed node's own work is not included, tasks that depend on it never ran, and the code was not reviewed. The exit code stays that of the failure, and the worktrees are kept. A later `--resume` that finishes cleanly would apply the result a second time, so drop or commit what you merged first.

Retry is not offered:

- after Ctrl+C or Abort (use `--resume`);
- after Close or `q`;
- for a reviewer or tester once the result was applied to your branch;
- without a TTY (terminal view).

## Cleaning up runs

`graph-execution list` shows every run (status, age, size, branches) and the leftover `graph/*` and `graph-task/*` branches that have no run folder.

`graph-execution clean` deletes leftovers. It prints what it would delete and the space it frees, then asks `Delete these? [y/N]`.

| Command | Deletes |
|---|---|
| `clean` | Unfinished runs, applied runs beyond the newest `keepRuns`, and orphan branches. |
| `clean <run-id>` | Only that run. |
| `clean --done` | Also runs that finished without apply (`--no-merge` results). |
| `clean --force` | Also branches with commits that are not merged anywhere else. |
| `clean --yes` | Skips the question. Required when stdin is not a terminal (otherwise exit code 2). |

Never deleted: runs that are still running, branches that are checked out in a worktree, and (without `--force`) branches of unfinished or finished-without-apply runs that hold commits not on any other branch. The run folder is still deleted in that case, and the kept branches are named. Exit code 1 means a deletion failed.

`clean` also stops agents left running by a run whose process was killed (`kill -9`, the OOM killer), before deleting their worktrees (see [Resume](#resume)).

A run also refuses to start while its own `graph-task/<run-id>/*` or `graph/<run-id>` branch is still checked out in a leftover worktree outside its run folder: it prints each path and the `git worktree remove --force` / `git branch -D` commands, and exits 2. It never removes them itself, because that worktree may hold your uncommitted work. Registrations whose directory is already gone are pruned automatically. `--resume` is not affected by the run's own worktrees.

## Suites

```bash
graph-execution suite --feature tasks/auth:PRD-auth.md --feature tasks/export:PRD-export.md --provider claude
```

A suite runs several features at once, each with its own task folder and PRD, and integrates them at the end. At least two `--feature <tasks-dir>:<prd>` are required.

- **One child run per feature.** Each feature is a normal run with its own graph, review loop and logs under `.graph-execution/suite-<id>/features/<run-id>/`. Nothing is applied to your branch while the features run.
- **Split concurrency and queue.** `--concurrency` (or the config value) is the cap for the whole suite, split across the features. Features beyond the cap wait in a queue and start when a slot frees up.
- **Integration at the end.** The finished features are merged one by one into `suite/<id>`. When a merge conflicts, an integration agent resolves it.
- **E2E phase.** On `suite/<id>` a cross-feature reviewer and an e2e tester run, and a fixer handles their findings, like the review loop of a run. `"e2eReview": false` in `graph-execution.config.json` keeps only the validation.
- **One apply.** A clean result is applied once to the branch you started on, as uncommitted changes. `--no-merge`, a detached HEAD or a code review that was not performed leave the result on `suite/<id>`.
- **Human review.** With `--human-review` (or `humanReview` in the config), the suite pauses before its one apply so you can review the combined diff, comment and request changes, as for a [run](#human-review-optional). It needs `--web`.
- **`--web`.** `graph-execution suite ... --web` starts the suite in the background and opens one page, styled like a run's page (dark, with the same nodes, colors and diffs), that draws the whole suite as one graph of graphs:
  - **A box per feature** with that feature's whole run: its tasks, then validate → code reviewer and live tester → fixer (and the validation fixer once it has run). A review round shows the reviewer and the tester running until each one's report is written.
  - **A merge node per feature**, in the order the features finished (`merged #1`, `#2`). The first merge lands on an empty suite branch, so a conflict always shows on a later merge: the files it shares with the features merged before it. A merge that conflicted carries `⚠ N conflicts`.
  - **An integration agent node** under each merge that conflicted. It shows the agent working (`resolving 2 files`, `try 2/3`), `resolved` with its `+`/`−` counts, or `gave up after 3` with a **retry** badge.
  - **The e2e phase** on the combined result (e2e validate → cross-feature review and e2e tester → e2e fixer), then, with human review on, a **human review** node (`waiting for you`, `changes, round N`, `approved`, `dropped`; click it to jump to the review), then the apply.
  - **Click any node or feature box** for a side panel: what it does, its changed files with diffs (a merge or the integration agent marks the conflicted files), its agent logs, and its buttons. A failed feature has **Retry** while the others keep running. The integration agent that gave up has **Retry integration**. **Start integration** appears in the header when the other features are done and some keep failing: it excludes the failed ones and integrates the rest.
  - The graph, the panel, the shortcuts and the offline assets are the same as on a run's page.

    ![The suite page: a box per feature, merge nodes, the e2e phase and the human review node](docs/img/suite.png)

  - **Abort** stops the suite; once it has ended, **Close** ends the process. A feature that fails never ends a web suite by itself.
  - Closing the tab does not stop the suite. `graph-execution open` brings the page back (`--run suite-<id>` for a specific suite).
- **`--resume`.** `graph-execution suite --resume [--run <suite-id>]` restarts the features that are not done (a feature with a run is resumed) and continues with the integration. Without `--run` it takes the latest suite. Add `--web` to continue it in the background with its page.

What a suite produces:

```
suite/<id>                                 # the suite branch: each feature merged in turn, then the e2e fixes
.graph-execution/suite-<id>/
  suite.json  lock  run.log                # suite state (used by --resume), PID lock, suite log
  web.json                                 # the page's URL, while the --web process is alive
  logs/<feature>.log                       # output of each feature's process
  logs/integration-<feature>.log           # the integration agent, for a merge that conflicted
  logs/code-r<N>.log, tester-r<N>.log, ... # the e2e phase's agents
  worktrees/integration/                   # the suite branch's worktree
  features/<run-id>/                       # each feature's run folder, like a normal run's
```

`suite.json` records, per conflicted merge, the integration agent's conflicted files, which try it is on, and whether it is running, resolved or gave up. `graph-execution list` shows a suite as one line, and `graph-execution clean <suite-id>` deletes it with its feature runs.

## Exit codes

| Code | Meaning | What is kept |
|---|---|---|
| `0` | Success: every task is merged and the last review has no open blockers or majors (or you chose Apply anyway or Drop in a [human review](#human-review-optional)). The result is applied to your branch as uncommitted changes, unless `--no-merge`, a human Drop, or a code review that was not performed kept it on its branch (see [the final step](#the-final-step-your-branch-gets-the-changes-uncommitted)). | The branch `graph/<run-id>` and `.graph-execution/<run-id>/` (state, logs, reports). **All worktrees are removed.** |
| `1` | Review loop exhausted: blockers or majors are still open after the last fix pass. | Everything: branch, worktrees, reports. |
| `2` | Abort: retries exhausted, merge resolver failed, validation exhausted, Ctrl+C (also while waiting for a human review), the final apply to your branch failed (`--resume` retries only the apply), or a startup failure (bad arguments, invalid graph, invalid config, missing spec, provider not on the `PATH`, not a git repo). | Everything, ready for `--resume`. |
| `3` | Launcher only (`--web`): the hand-off to the operating system was blocked and nothing was started. The foreground command to run yourself is printed. See [starting a run from your agent](#starting-a-run-from-your-agent). | Nothing. |

## Resume

```bash
graph-execution --resume            # latest run
graph-execution --resume --run <id> # a specific run
```

An aborted run prints the exact resume command. On resume:

- git is the source of truth. Tasks recorded as `merged` must still have their merge commit on the branch, otherwise they run again.
- Tasks interrupted while running get a fresh worktree, and their attempt counter is kept. A task that failed gets 3 new attempts.
- The review loop continues from the saved round and step. Valid existing reports are not generated again.
- A run that was waiting for your [human review](#human-review-optional) pauses again, with your comments. `--resume` takes no `--human-review` flag: the saved setting is used.
- A PID lock file prevents two concurrent resumes of the same run. Within one process (when graph-execution is used as a library) the lock can't be taken twice either, and releasing it only removes the lock file if it still belongs to that holder.
- If the run's process was killed without a chance to clean up (`kill -9`, the OOM killer), the agents it left running are stopped first: each agent's pid, process group and start time are recorded in `pids/` while it runs, and a recorded agent whose owner is gone is killed with its whole process group. A pid that now belongs to another process is never touched. Windows: best effort.
- A run that already finished (status `applied` or `done`) is refused: `cannot resume run <id>: it already finished`, exit code 2.

`graph-execution --resume --web` continues the run in the background. While the run's process is alive, **Retry** (see [when a node fails](#when-a-node-fails-summary-and-retry)) is the in-process equivalent.

## Skills: `graph-execution install skills`

```bash
graph-execution install skills                 # → .agents/skills/to-spec/, to-tasks/ and run-graph/
graph-execution install skills --target claude # → .claude/skills/ (Claude Code project skills)
graph-execution install skills --target both
graph-execution install skills --target pi     # → .pi/skills/
graph-execution install skills --target all    # → every agent's folder below, each once
graph-execution install skills --force         # overwrite existing installs
```

This copies three bundled skills into the current directory. `--target` picks the folder:

| Target | Folder |
|---|---|
| `agents` (default) | `.agents/skills` |
| `claude` | `.claude/skills` |
| `both` | `.agents/skills` and `.claude/skills` |
| `codex` | `.agents/skills` |
| `opencode` | `.opencode/skills` |
| `qwen` | `.qwen/skills` |
| `pi` | `.pi/skills` |
| `omp` | `.omp/skills` |
| `copilot` | `.github/skills` |
| `all` | `.agents/skills` and every agent's folder above, each once |

A provider id installs into that agent's project skill folder (`projectSkillDir` in the provider catalog).

**`to-spec`** writes the spec (PRD) a run starts from:

- It reads the tickets or the conversation, explores the code, and asks you now every question that would otherwise need a human during the run.
- It writes `docs/prd/<name>.md` (never inside `docs/prd/done/`) with a fixed layout: problem, goals with ticket keys, a ```` ```mermaid ```` diagram of the workflow, a decision table, non-goals, user stories, requirements and acceptance criteria. It saves the file early and in steps, so graph-manager can show it live next to the terminal.
- When it is done it gives you the path and asks you, in the chat, to read it and approve it or ask for changes. It applies the changes and asks again, and goes no further until you approve. Then it offers `to-tasks` and `run-graph`.
- When the result becomes a PR through graph-manager's **Create PR**, the spec moves to `docs/prd/done/<name>.md` in that commit. Without graph-manager, move it there yourself in the PR.

**`to-tasks`** turns a PRD into a task folder:

- Without a spec yet, it starts with `to-spec`. It explores the codebase, drafts vertical (tracer-bullet) slices and a [test plan](#test-plans-optional), and asks you about granularity, dependencies and test cases until you approve them.
- It writes one task file per slice to `.agents/tasks/<id>.json` in the format above, plus `test-plan.json`. Each `content` is a full, self-sufficient issue.
- **Several PRDs** become the features of a [suite](#suites): one task folder per feature, `.agents/tasks/<feature>/`, each with its own test plan. It keeps features independent of each other (they run in parallel and never see each other's code) and prefers additive edits to files that several features touch, which the integration agent merges at the end.
- At the end it runs the bundled `validate-tasks.mjs` on every task folder, a standalone Node script with no dependencies that applies the same rules as graph-execution. It keeps fixing the files until the script passes.

**`run-graph`** starts a run or a suite from your agent:

- One task folder: it runs `graph-execution <tasks-dir> --spec <prd> --provider <name> --web`. Several feature folders: `graph-execution suite --feature <dir>:<prd> ... --provider <name> --web`. Either goes to the background and its page opens in your browser.
- It passes `--concurrency`, `--model`, `--no-merge` and `--human-review` only when you ask for them, and checks with `graph-execution list` that nothing else is running first.
- It then stops. It never monitors the run. On exit code 3 it gives you the foreground command to run yourself.

Refusal is per skill folder: an existing skill folder is not overwritten unless you pass `--force`. Skipped ones are listed, and the command exits with code 2 only when nothing was installed.

Then run:

```bash
npx graph-execution .agents/tasks --spec PRD.md --provider claude --web
npx graph-execution suite --feature .agents/tasks/auth:PRD-auth.md --feature .agents/tasks/export:PRD-export.md --provider claude --web
```

## Safety

- **Agents run in full-auto mode** in their worktree: `claude --dangerously-skip-permissions`, `codex exec --dangerously-bypass-approvals-and-sandbox`, `opencode run --auto`, `qwen --yolo`, `omp --auto-approve`, `copilot --allow-all` (without it Copilot silently denies every tool in headless mode); `pi` never asks for approval, so it needs no flag. **This is not a sandbox.** Agents can run arbitrary commands with your user's permissions, so only run tasks and specs you trust, or add `--sandbox` to run them in a Docker container that sees only your repository (see [Sandbox](#sandbox-docker)).
- **omp needs Bun**: its CLI runs only on [Bun](https://bun.sh), so `--provider omp` stops at startup when `bun` is not on the `PATH`.
- **pi exits 0 when the model request fails** in json mode; graph-execution reads the last assistant message's `stopReason` and counts an `error` or `aborted` stop as a failed attempt (exit code 1).
- **Ctrl+C stops everything it started**: agents, and `setup` / `validate` commands with all their child processes (each runs in its own process group on macOS and Linux). The run exits 2 and prints the resume command.
- The tool itself **never pushes**. It never commits on your current branch. At the very end of a clean run it leaves the result there as uncommitted changes, rolled back if git refuses the merge (`--no-merge` to skip it). Otherwise it writes only to `.graph-execution/` and to git worktree and branch metadata.
- Logs are not redacted. Don't put secrets in task files, `TESTING.md` or the spec unless you accept that they appear in `.graph-execution/<run-id>/logs/`.

## Sandbox (Docker)

graph-execution can run a whole run inside a Docker container that sees only your repository. Start a run in the sandbox with `--sandbox`:

```bash
graph-execution ./tasks --spec PRD.md --provider claude --sandbox
```

`--sandbox` implies `--web` (passing both is fine). No graph-manager is needed. In a graph-manager terminal, graph-manager's own `graph-execution` shim takes `--sandbox` instead and starts the run in its sandbox.

### How a sandboxed run starts

1. The host checks everything a normal run checks (tasks, spec, reviewers, config, provider names), except that the agent CLIs need not be installed on the host: the image has them.
2. The image is built when its tag does not exist yet (the build streams to the terminal). A ready-made image (`--sandbox-image` or `sandbox.image`) is checked instead: each provider's CLI must be on its `PATH`, else it exits 2 with `image <image> has no <bin> on its PATH`.
3. A container `ge-sbx-<run-id>` is created with `--init`, your user and group id, `no-new-privileges`, the CPU, memory and process limits, and a random hostname. **Only the repository is mounted** (read-write, at the same path), plus the engine copy read-only at `/opt/graph-execution`. The tasks folder, spec and reviewers file must therefore be inside the repository. The run page is published on a free port of `127.0.0.1` only.
4. **Logins are copied in**: the login files of every provider in the run (for example `~/.claude/.credentials.json` and `~/.claude.json`, `~/.codex/auth.json`) are staged in a private temporary folder, copied into the container's home with `docker cp` and the temporary folder is deleted. The provider login keys set in your environment (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `COPILOT_GITHUB_TOKEN`, …) are passed too, with your git identity, `TZ`, `LANG`, the names in `sandbox.env` and the public `GRAPH_EXECUTION_*` variables. A provider with neither a login file nor a login key stops the start: `no <p> login to copy into the sandbox: log in once, or set <key>`. **A macOS Keychain login is not a file**: on macOS set `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) for Claude, or `COPILOT_GITHUB_TOKEN` for Copilot.
5. The container starts and runs the normal run with its web view. Once the page is up, graph-execution writes `.graph-execution/<run-id>/sandbox.json`, prints `Run <id> started in a sandbox: http://127.0.0.1:<port>/?token=<token>`, opens it (over SSH it prints an `ssh -L` hint instead) and exits 0. If the container exits or the page is not up within 60 s, it prints the container's log, removes the container and exits 2.

**The URL carries a token.** The page requires it; opening the `?token=` URL once sets a cookie for that browser. `graph-execution open` prints or opens the URL with its token while the container runs.

### Open, list, clean and resume

- `graph-execution open [--run <id>]` opens the page of a sandboxed run while its container is running; otherwise the run "has no live page".
- `graph-execution list` shows a running sandboxed run as `running` with `(sandbox ge-sbx-<id>)`. Liveness comes from `docker inspect` of the container (the run's lock was written inside it); when docker cannot tell, the run is treated as running.
- `graph-execution clean` skips a running sandboxed run and removes the stopped container of every run it deletes.
- `graph-execution --resume --run <id> --sandbox` resumes an interrupted sandboxed run in a new container, with the image settings and limits it started with (the image flags are refused). It exits 2 with `the run's sandbox is still running` while the old container runs; otherwise it removes the old container, lets the new one take over the old one's run lock, and prints a new URL and token. A plain `--resume` of a sandboxed run exits 2 and names this command.

### Limits

- Linux and macOS only. On Windows, use WSL: `--sandbox` exits 2 there.
- Suites cannot run in a sandbox yet (`suite … --sandbox` exits 2).
- There is **no network filtering**: agents in the container can reach the internet and your local network like any container on Docker's default bridge.
- `--sandbox` cannot be started from inside a sandbox.

It uses the local `docker` command (Docker Engine or Docker Desktop on Linux or macOS). The image is generated from a bundled Dockerfile and tagged `graph-execution-sandbox:<12 hex of the Dockerfile's sha256>`, so identical settings share one image:

```dockerfile
FROM <base>
RUN node --version && npm --version && git --version
RUN npm install -g --no-audit --no-fund <the CLIs of the run's providers>
RUN mkdir -p /home/sandbox && chmod 1777 /home/sandbox
<your extra lines>
```

The image installs only the agent CLIs the run needs (plus `bun` for `omp`); `sandbox build` and `sandbox dockerfile` without `--provider` install every supported CLI. The engine itself is not installed in the image: the running graph-execution is copied once per version into `~/.cache/graph-execution/sandbox-engine/` (`$XDG_CACHE_HOME/graph-execution` when set) and mounted into the container.

**Base image requirements:** a glibc-based Linux image (Debian or Ubuntu, not Alpine) with `node` >= 20, `npm` and `git`. The first build step checks them. The default is `node:24.22.1-bookworm`. Add toolchains with extra lines, for example `RUN apt-get update && apt-get install -y python3` or `COPY --from=golang:1-bookworm /usr/local/go /usr/local/go`. `FROM` lines are refused; use `COPY --from=<image>` instead.

### Commands

```bash
graph-execution sandbox dockerfile [--provider <p>]... [--base <image>] [--line <line>]...   # print the Dockerfile and its tag; runs no docker command
graph-execution sandbox build [--provider <p>]... [--no-cache] [--image <image> | --base <image> --line <line>...]
graph-execution sandbox config [--image <i> | --base <b>] [--line <l>]... [--clear-lines] [--cpus n] [--memory MB] [--pids n] [--unset-image]
```

- `sandbox build` builds the image with `docker build -t <tag> -` (the Dockerfile on stdin, no build context) and prints `Sandbox image: <tag>`. When the tag already exists it is reused; `--no-cache` rebuilds from scratch and pulls the base again. With a ready-made `--image`, it only checks that the image exists locally or pulls it. Without Docker it exits 2: `--sandbox needs Docker: the docker command was not found or cannot reach a daemon`.
- `sandbox dockerfile` prints the generated Dockerfile followed by `# tag: <tag>`.
- `sandbox config` edits the `sandbox` section of `graph-execution.config.json` at the repository root, creating the file or the section when missing and keeping every other key. `--line` appends a line, `--clear-lines` removes the saved ones first, `--unset-image` removes the ready-made image. The result is validated before it is written: an invalid value or a `FROM` line exits 2 and leaves the file unchanged. Without options it prints the current section merged with the defaults. A run started before the change refuses `--resume` with the changed config file, like any config change.

`--image`, `--base` and `--line` also accept the run flags' names `--sandbox-image`, `--sandbox-base` and `--sandbox-line`.

### The `sandbox` config section

```json
{
  "sandbox": {
    "base": "node:24.22.1-bookworm",
    "dockerfile": ["RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*"],
    "cpus": 2,
    "memoryMb": 4096,
    "pids": 2048,
    "env": ["MY_API_KEY"]
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `image` | none | A ready-made image to use instead of the generated one; skips the build. `base` and `dockerfile` are then unused (`sandbox config` warns). It must meet the base image requirements and have the agent CLIs installed. |
| `base` | `"node:24.22.1-bookworm"` | The `FROM` of the generated Dockerfile. |
| `dockerfile` | `[]` | Extra Dockerfile lines after the CLI install, kept verbatim. No `FROM`. |
| `cpus` | `2` | CPU limit of the container. |
| `memoryMb` | `4096` | Memory limit in MB, at least 256. |
| `pids` | `2048` | Process limit, at least 64. |
| `env` | `[]` | Names of extra environment variables passed into the container. |

**Precedence:** the run flags (`--sandbox-image`, `--sandbox-base`, `--sandbox-line`, `--no-sandbox-config-lines`, `--sandbox-cpus`, `--sandbox-memory`, `--sandbox-pids`) for one run, then the config's `sandbox` section, then the defaults. `--sandbox-line` lines are added after the config's lines; `--no-sandbox-config-lines` drops the config's lines for that run. `--sandbox-image` cannot be combined with `--sandbox-base` or `--sandbox-line`.

## Manual smoke test with real providers

The automated tests use a fake provider. Before a release, run this checklist once per provider (`claude`, `codex`, `opencode`, `qwen`, `pi`, `omp`, `copilot`):

1. **Prepare a scratch repo.**
   ```bash
   mkdir /tmp/ge-smoke && cd /tmp/ge-smoke && git init -b main && npm init -y
   mkdir tasks
   echo '{ "id": "1", "content": "Create src/sum.js (CommonJS) exporting sum(a, b).", "dependencies": [] }' > tasks/1.json
   echo '{ "id": "2", "content": "Create src/mul.js (CommonJS) exporting mul(a, b).", "dependencies": ["1"] }' > tasks/2.json
   echo '{ "id": "3", "content": "Create src/sub.js (CommonJS) exporting sub(a, b).", "dependencies": ["1"] }' > tasks/3.json
   echo '{ "id": "4", "content": "Create src/index.js (CommonJS) re-exporting sum, mul and sub.", "dependencies": ["2", "3"] }' > tasks/4.json
   printf '# Tiny math lib\nsrc/index.js exports sum, mul and sub (CommonJS).\n' > PRD.md
   echo '{ "validate": ["node src/sum.js"] }' > graph-execution.config.json
   git add -A && git commit -m "smoke inputs"
   ```
   Task 1 creates `src/sum.js`, so every task after it passes the validation gate.
2. **Check startup.** Make sure the provider CLI is installed and logged in (`claude --version`, `codex --version`, `opencode --version`, `qwen --version`, `pi --version`, `omp --version`, `copilot --version`).
3. **Run it.** `npx graph-execution ./tasks --spec PRD.md --provider <name>`
   - [ ] The startup warning about full-auto agents is printed.
   - [ ] The TUI shows the diamond. Tasks 2 and 3 run at the same time. The footer shows where the agent logs are, and the summary appears under the graph at the end.
   - [ ] The phase bar goes through tasks → validate → review (→ fix pass N/3 if anything was found).
   - [ ] The final summary shows the branch `graph/<run-id>`, any minor findings and the next steps.
4. **Check the result.**
   - [ ] `echo $?` prints `0`.
   - [ ] `git worktree list` shows only the main checkout.
   - [ ] `git branch --list 'graph/*'` shows the run branch, and `git log graph/<run-id>` shows 4 task merges.
   - [ ] `git status` is clean and you are still on `main` at the same commit.
   - [ ] `.graph-execution/<run-id>/` contains `state.json`, `logs/` and `reports/round0/{code,tester}.json`.
5. **Abort and resume.** Start a new run and press Ctrl+C while a task is running.
   - [ ] Exit code `2`. The message names the step and prints `graph-execution --resume --run <id>`.
   - [ ] `graph-execution --resume` continues without redoing merged tasks and ends with exit code `0`.
6. **Missing spec.** `npx graph-execution ./tasks --provider <name>` exits with code `2` before any agent runs.
7. **Skills.** In an empty folder, `npx graph-execution install skills` creates `.agents/skills/to-tasks/` and `.agents/skills/run-graph/`. Running it a second time skips both. `--force` overwrites.

### Web view and retry

Run these once each on Windows, macOS and a Linux desktop, started by hand and from Claude Code and Codex:

- [ ] `--web` opens the page and shows the live graph.
- [ ] The run survives closing the agent or the shell.
- [ ] **Abort** works (after the confirm dialog).
- [ ] `--resume --web` continues the run.
- [ ] **Close** ends the process.
- [ ] `graph-execution open` reopens a live page, and fails cleanly after Close.
- [ ] Over SSH, the URL and the `ssh -L` hint are printed.
- [ ] A strict sandbox gives exit code 3 with a usable foreground command.
- [ ] With `--human-review --web`, the run pauses at "Waiting for your review". A line comment (with *needs live check*) and a general comment survive closing the page. **Request changes** shows the fixer note and reviewer verdict per comment at the next pause; **Resolve**, then **Apply** ends the run with exit code `0`. Ctrl+C while waiting exits with `2`, and `--resume` shows the same pause.
- [ ] A task made to fail shows the AI summary and verdict. **Retry** (web) and `r` (terminal) re-run it, and the run completes.

## Development

```bash
npm install
npm run typecheck && npm run lint && npm test
npm run build && npm pack --dry-run   # the tarball contains only dist/, skills/, README.md and LICENSE
```

The tests drive the CLI with a hidden `--provider fake`, scripted through the `GRAPH_EXECUTION_FAKE_SCRIPT` env var.

### Releasing

1. Move the `(unreleased)` section of [`CHANGELOG.md`](CHANGELOG.md) to the new version and date; `version` in `package.json` must match.
2. On a clean `main`, in `packages/graph-execution`: `npm publish`. Its `prepublishOnly` runs typecheck, lint and the tests, then the build at the repository root: the engine, graph-manager (`apps/graph-manager`), and the bundle step that copies graph-manager into `dist/manager`. So publish from a full checkout of the monorepo with `npm ci` done at its root, not from a copy of this folder alone.
3. Tag the published commit and create the GitHub Release from the changelog: `git tag v<version> && git push origin v<version>`, then `gh release create v<version> --notes-file <notes>`.

## License

MIT
