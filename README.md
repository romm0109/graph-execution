# graph-execution

[![npm](https://img.shields.io/npm/v/graph-execution)](https://www.npmjs.com/package/graph-execution)

Run a folder of tasks arranged as a dependency graph (DAG) with headless AI coding agents (Claude Code, Codex, OpenCode).

- Independent tasks run in parallel, each in its own git worktree.
- Each finished task is merged into an integration branch `graph/<run-id>`, which unlocks the tasks that depend on it.
- When every task is merged, a review loop runs. Your validation commands come first, then a code reviewer and a live tester run in parallel and judge the result against your PRD. A fixer handles blockers and majors, for up to 3 fix passes.
- Once the review is clean, the result lands on the branch you started the run from as **uncommitted changes**: review them in `git diff` or your editor, then commit them yourself (`--no-merge` keeps it on its own branch only).
- The run is resumable.

## Requirements

- Node.js 20 or later, and git.
- The CLI of the provider you choose must be on the `PATH` and already logged in: `claude` (Claude Code), `codex` or `opencode`. graph-execution stores no credentials.
- macOS, Linux or Windows.

### Windows notes

graph-execution runs on Windows in Windows Terminal, PowerShell or cmd. A few things behave differently there:

- **Provider CLIs** installed through npm (`claude.cmd` and similar) are found through `PATH` and `PATHEXT`, like any other command.
- **Prompts go to the agent's stdin**, not its command line, on every platform. On Windows, npm's `.cmd` shims run through `cmd.exe`, which caps a command line at 8,191 characters. Reviewer prompts (spec plus the whole diff) are far longer than that and used to fail with "The command line is too long".
- **`validate` and `setup` commands** run through `cmd.exe`, not a POSIX shell. `&&` chains work. `export`, `rm -rf`, `$VAR` and shell globs don't. Write commands that both shells accept, such as `npm test` or `node scripts/check.js`, or call `bash -c "…"` if Git Bash is installed.
- **Aborting a run** (Ctrl+C) kills each running agent and its child processes with `taskkill /T`. On macOS and Linux, processes an agent leaves running after it exits (for example an app the live tester started) are killed too. Windows can't trace a process back to an agent that has already exited, so such leftovers can survive there and need to be stopped by hand.
- **The "drop them" command** in the end-of-run summary quotes paths with double quotes. It works in cmd and PowerShell 7. Windows PowerShell 5.1 doesn't support `&&`, so run its two parts one after the other there.

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
graph-execution <tasks-dir> --spec <prd-file> --provider claude|codex|opencode [--concurrency 3] [--model <m>] [--no-merge]
graph-execution --resume [--run <id>] [--no-merge]
graph-execution install skills [--target agents|claude|both] [--force]
graph-execution readme [--print]
```

| Option | Meaning |
|---|---|
| `<tasks-dir>` | Folder of `*.json` task files (see below). |
| `--spec <file>` | **Required.** The PRD that the reviewers and the fixer judge the result against. The run refuses to start if the file is missing, unreadable or empty. |
| `--provider <name>` | **Required.** One provider is used for every agent in the run: `claude`, `codex` or `opencode`. |
| `--concurrency <n>` | Maximum number of tasks running at once. Overrides `concurrency` in the config file. Default: 3. |
| `--model <m>` | Model name passed to the provider CLI. |
| `--resume [--run <id>]` | Resume an interrupted or aborted run. Without `--run` it resumes the latest run. |
| `--no-merge` | Keep the result on `graph/<run-id>` only, instead of applying it to your branch at the end. |

`graph-execution readme` opens this README, rendered, in your browser. If no browser can be opened (over SSH, in CI), it prints the path of the HTML file instead. `--print` writes the markdown to stdout, for example to pipe it into `less`.

Run it from inside the git repository you want to change. Worktrees are cut from **committed** state, so uncommitted changes are not visible to the agents. The tool prints a warning about them and continues.

The spec and the task folder are the exception: they **don't need to be committed**. The tool copies both into `.graph-execution/<run-id>/context/` and tells every task agent where they are, so a task can say "see `PRD.md` section 7" even if `PRD.md` was never committed. They don't trigger the warning either.

### The live view

The run shows as one top-down graph: the tasks with arrows to the tasks that depend on them, then validate → code reviewer and live tester → fixer → apply. Running nodes have a heavy border and a spinner.

When the graph is taller than the terminal, it shows in a scrollable window: use the **mouse wheel**, `↑`/`↓` (or `j`/`k`), `PgUp`/`PgDn`, and `g`/`G` for top and bottom. The window follows the running tasks until you scroll; press `f` to follow again. While the window is scrollable, the terminal's own text selection needs a modifier (Shift-drag in most terminals, Option-drag in iTerm2). When the run ends, the whole graph and the summary are printed in full, so you can scroll back through them in the terminal as usual.

### What a run produces

```
graph/<run-id>                        # integration branch with all merged tasks and fixes
.graph-execution/<run-id>/
  state.json  lock                    # run state (used by --resume) and PID lock
  logs/<agent>.log                    # full output of every agent
  reports/round<N>/{code,tester}.json # review reports for each round
  worktrees/                          # task, integration and reviewer worktrees (removed on success)
```

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

In those cases bring it in yourself once you are ready:

```bash
git log --oneline main..graph/<run-id>
git merge --squash --no-commit graph/<run-id>
```

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
  "fixPasses": 3
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
| `fixPasses` | `3` | Fix passes in the review loop. |

The hashes of the config, the tasks folder and the spec are recorded when the run starts. `--resume` refuses to continue if any of them changed.

## `REVIEW.md` and `TESTING.md` (optional)

Both files are read from the repository root at startup and passed to the reviewers in their prompts. They therefore work even when they are not committed. Neither file is required. A missing file never causes an error.

- **`REVIEW.md`**: your conventions for the **code reviewer**. Without it, the reviewer applies general rules for bugs, security and correctness.
- **`TESTING.md`**: tells the **live tester** how to boot the app, which endpoints or URLs to hit, which credentials to use and what to check. Without it, the tester tries its best using the README and the package scripts. If the tester cannot run the app, it records a "live test not performed" note that appears in the final summary, and the run does not fail.

## The review loop

After every task is merged:

1. **Validation gate.** `validate` runs on `graph/<run-id>`. Tasks that pass on their own can still break once merged together. If the gate fails, the fixer gets the failing output, commits a fix, and the gate runs again, for up to `validationRounds` rounds. These rounds don't use up a fix pass. If it still fails after that, the run aborts (exit code 2, resumable). The live view then shows a **validation fixer** node between `validate` and the reviewers.
2. **Review.** The code reviewer and the live tester run in parallel. Each gets its own throwaway worktree, detached at the head of the integration branch, so they never touch it. Both receive the full `--spec` and the path of the tasks folder. The code reviewer also gets the diff against the starting commit and `REVIEW.md`. The tester also gets `TESTING.md` and the list of changed files. Each one writes a JSON report with findings of severity `blocker`, `major` or `minor`. A finding without a concrete failure scenario is downgraded to minor.
3. **Fix.** If any blocker or major is still open, the fixer receives both reports and the spec, commits fixes on the integration branch, and validation runs again. Then the reviewers re-review: they verify the previous findings and may only add new blockers or majors.
4. The loop ends **clean** as soon as a review has no open blockers or majors. The result is then applied to your branch as uncommitted changes (see [the final step](#the-final-step-your-branch-gets-the-changes-uncommitted)). Otherwise it stops after **3 fix passes**, which means at most 4 reviews. Minor findings are listed in the final summary and never trigger a fix pass.

### Reports that don't parse

Agents don't always write the JSON exactly right. The tool handles that in three steps:

1. **Repair.** Before the strict schema check, unambiguous slips are fixed silently: JSON inside a Markdown code fence, a bare findings array, a missing `round` or `reviewer`, severity or status in another case or a common alias (`Critical` → `blocker`, `high` → `major`, `not fixed` → `not_fixed`), a missing `status` (`open`) or `id` (`F1`, `F2`, ...), and `"line": "42"`.
2. **Retry with feedback.** A report that still fails gets up to 3 attempts. Each retry is told exactly what was wrong (for example `findings.2.severity: invalid option`) and is shown the file it wrote, so it can reuse its findings and only fix the format.
3. **Give up without stopping the run.** After 3 failed attempts, the report records a note (`code review not performed: ...` or `live test not performed: ...`) that appears in the final summary. The previous round's unresolved findings stay open, so they still count. If it was the **code reviewer** that gave up, the result is not applied to your branch automatically.

## Exit codes

| Code | Meaning | What is kept |
|---|---|---|
| `0` | Success: every task is merged and the last review has no open blockers or majors. The result is applied to your branch as uncommitted changes unless something stopped it (see [the final step](#the-final-step-your-branch-gets-the-changes-uncommitted)). | The branch `graph/<run-id>` and `.graph-execution/<run-id>/` (state, logs, reports). **All worktrees are removed.** |
| `1` | Review loop exhausted: blockers or majors are still open after the last fix pass. | Everything: branch, worktrees, reports. |
| `2` | Abort: retries exhausted, merge resolver failed, validation exhausted, Ctrl+C, or a startup failure (bad arguments, invalid graph, invalid config, missing spec, provider not on the `PATH`, not a git repo). | Everything, ready for `--resume`. |

## Resume

```bash
graph-execution --resume            # latest run
graph-execution --resume --run <id> # a specific run
```

An aborted run prints the exact resume command. On resume:

- git is the source of truth. Tasks recorded as `merged` must still have their merge commit on the branch, otherwise they run again.
- Tasks interrupted while running get a fresh worktree, and their attempt counter is kept. A task that failed gets 3 new attempts.
- The review loop continues from the saved round and step. Valid existing reports are not generated again.
- A PID lock file prevents two concurrent resumes of the same run.

## Skills: `graph-execution install skills`

```bash
graph-execution install skills                 # → .agents/skills/to-tasks/
graph-execution install skills --target claude # → .claude/skills/to-tasks/ (Claude Code project skills)
graph-execution install skills --target both
graph-execution install skills --force         # overwrite an existing install
```

This copies the bundled **`to-tasks`** skill into the current directory. The skill turns a PRD into a task folder:

- It explores the codebase, drafts vertical (tracer-bullet) slices and asks you about granularity and dependencies until you approve them.
- It writes one task file per slice to `.agents/tasks/<id>.json` in the format above. Each `content` is a full, self-sufficient issue.
- At the end it runs the bundled `validate-tasks.mjs`, a standalone Node script with no dependencies that applies the same rules as graph-execution. It keeps fixing the files until the script passes.

The command refuses to overwrite an existing skill folder unless you pass `--force`.

Then run:

```bash
npx graph-execution .agents/tasks --spec PRD.md --provider claude
```

## Safety

- **Agents run in full-auto mode** in their worktree: `claude --dangerously-skip-permissions`, `codex exec --dangerously-bypass-approvals-and-sandbox`, `opencode run --auto`. **This is not a sandbox.** Agents can run arbitrary commands with your user's permissions, so only run tasks and specs you trust.
- The tool itself **never pushes**. It never commits on your current branch. At the very end of a clean run it leaves the result there as uncommitted changes, rolled back if git refuses the merge (`--no-merge` to skip it). Otherwise it writes only to `.graph-execution/` and to git worktree and branch metadata.
- Logs are not redacted. Don't put secrets in task files, `TESTING.md` or the spec unless you accept that they appear in `.graph-execution/<run-id>/logs/`.

## Manual smoke test with real providers

The automated tests use a fake provider. Before a release, run this checklist once per provider (`claude`, `codex`, `opencode`):

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
2. **Check startup.** Make sure the provider CLI is installed and logged in (`claude --version`, `codex --version`, `opencode --version`).
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
7. **Skills.** In an empty folder, `npx graph-execution install skills` creates `.agents/skills/to-tasks/`. Running it a second time refuses. `--force` overwrites.

## Development

```bash
npm install
npm run typecheck && npm run lint && npm test
npm run build && npm pack --dry-run   # the tarball contains only dist/, skills/ and README.md
```

The tests drive the CLI with a hidden `--provider fake`, scripted through the `GRAPH_EXECUTION_FAKE_SCRIPT` env var.

## License

MIT
