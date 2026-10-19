# PRD: `run-graph` skill and the `--web` run view

## 1. Summary

After `to-tasks` has written the task folder, the user should be able to tell their coding agent "start the run" and have it happen. The agent checks what it can, starts `graph-execution` with `--web`, and **stops**. The run goes to a background process that the operating system owns, not the agent, and the user watches it in a **browser page** that the CLI opens. The agent never follows, waits for or monitors the run.

The platform logic for handing the run to the OS and opening the browser lives in the CLI, behind the `--web` flag, not in the skill. The skill only has to call one command.

Three deliverables:

1. **`--web`**: a CLI flag that checks the arguments, hands the run to the OS as a detached background process, waits until that process serves its page, opens the page in the browser, and exits.
2. **The web view**: a local HTTP server inside the run process that shows the same live graph as the Ink TUI. It has one button: **Abort** while the run is going, **Close** once it has ended. More buttons come later (§10).
3. **`run-graph` skill**: a bundled skill, installed by `graph-execution install skills`. It works out the arguments, runs the CLI with `--web`, reports what it did, and stops. `to-tasks` ends by offering to hand over to it.

## 2. Goals and non-goals

**Goals**
- From the moment the tasks exist, a user can start a run without knowing the CLI syntax.
- The run outlives the agent: it isn't killed when the agent's command or session ends, and it isn't inside the agent's sandbox.
- The page shows the run live and can be reloaded or opened later at any point, including after the run ends, to show the summary and the result of the final apply.
- The run can be aborted from the page, with the same effect as Ctrl+C today (state kept, resumable).
- Works on Windows, macOS and Linux.
- Fails fast, before anything is started, on arguments a normal run would reject, and fails visibly if the background process dies before its page is up.

**Non-goals**
- The agent monitoring, polling or reporting on the run. It stops once the CLI exits.
- Buttons other than Abort/Close (retry a task, resume, …). See §10.
- Remote access. The server binds to `127.0.0.1` only.
- Replacing the Ink TUI for runs started without `--web`. Those are unchanged.

## 3. User stories

1. **As a developer who just generated tasks with `to-tasks`, I want to say "run it" and see a browser tab with the run, so that I don't have to remember the command.**
   Example: the agent replies "Started `graph-execution .agents/tasks --spec PRD.md --provider claude --web`. The run is at http://127.0.0.1:53817/", and the tab shows the live graph.
2. **As a developer, I want a mistake (a missing spec, a cycle in the graph, a provider that isn't on the PATH) reported by the agent right away, not in a tab that never loads.**
3. **As a developer, I want to stop a run from the page**, because there is no terminal to press Ctrl+C in.
4. **As a developer who closed the tab, I want to get back to the run's page.**
5. **As a developer on SSH, I want the URL and a port-forwarding hint printed, so that I can open the page from my laptop.**
6. **As a developer whose agent runs in a strict sandbox, I want the exact command printed when the hand-off is blocked, so that I can run it myself.**

## 4. `--web` (CLI)

### 4.1 Usage

```
graph-execution <tasks-dir> --spec <file> --provider <name> [other options] --web
graph-execution --resume [--run <id>] [--no-merge] --web
graph-execution open [--run <id>]
```

`--web` works with a normal run and with `--resume`, and behaves the same whether a human or an agent types it: it always detaches. It is not accepted with `install`, `readme` or `open`.

### 4.2 Two processes

- The **launcher** is the process the user or agent starts. It runs preflight, hands off, waits, opens the browser and exits. It never creates a run.
- The **run process** is started by the OS. It is the same CLI with the same arguments, `--web` replaced by the internal `--web-serve`. It runs the graph exactly as a normal run does, but with the web view (§5) in place of the Ink UI.

### 4.3 Launcher behaviour

1. **Preflight, with no side effects.** It runs the checks a normal run does before creating anything:
   - arguments (the same `UsageError`s as today: missing `--spec` or `--provider`, `--run` without `--resume`, …);
   - the spec check (`checkSpec`);
   - loading and validating the graph (`loadTasks` + `validateGraph`);
   - inside a git repository with at least one commit, not nested in a `.graph-execution` worktree (`assertNotNested`);
   - the config loads (`loadConfig`);
   - the provider CLI is on the `PATH` (`getProvider`).

   For `--resume`, it also checks that the run exists (`findRun`), that its inputs didn't change (`changedInputs`), and that the run's lock isn't held by a live PID ("run <id> is already running (PID n)"). It does not take the lock.

   These checks are factored out of `runGraph`/`resume` into one `preflight()` that both the normal path and the launcher call, so the two can't drift apart. Preflight **does not** create a run id or directory, does not touch `.git/info/exclude`, and does not print the full-auto warning. All of that happens in the run process.

   A failing check prints the usual `error: …` and exits with code 2. Nothing is started.
2. **Write the wrapper script.** In a fresh directory under the OS temp dir (`graph-execution-launch-<random>/`), the launcher writes:
   - `run.sh` (POSIX) or `run.cmd` (Windows). It sets the environment (step 3), `cd`s into the current working directory, and runs `"<process.execPath>" "<path to dist/cli.js>" <args…> --web-serve`, with stdout and stderr redirected to `launch.log` in the same directory;
   - the path of a **ready file**, `ready.json`, passed to the run process in `GRAPH_EXECUTION_READY_FILE`.

   A script keeps the command handed to the OS short (Windows `schtasks /tr` is capped at 261 characters) and means each value is quoted once, for one shell (§4.6). Using `process.execPath` and the CLI's own path, not `npx`, means nothing is downloaded again and the same version runs.
3. **Environment.** OS-started processes don't get the caller's shell environment (launchd and `systemd --user` start with a bare `PATH`). The script therefore sets, explicitly:
   - `PATH`, as the launcher sees it. This is the `PATH` preflight checked the provider against;
   - every variable that starts with `GRAPH_EXECUTION_`;
   - `HOME`/`USERPROFILE`, so that provider CLIs find their logins.

   The script is created with mode `0700`, in a directory only the user can read, and deleted by the run process once it is ready.
4. **Hand off to the OS** (§4.5), so that the run process's parent is an OS service, not the launcher or the agent.
5. **Wait for the ready file**, for up to 15 s. The run process writes `{ "url", "runId", "pid" }` into it once its server is listening.
   - Ready → go to step 6.
   - The run process exited, or the timeout passed → print `error: the run did not start` followed by the last 20 lines of `launch.log`, and exit with code 2.
6. **Open the browser** at the URL with the existing `openCommand` from `src/readme/readme.ts`. Print one line, `Started run <id> in the background: <url>`, and exit with code 0.
   - Over SSH (`SSH_CONNECTION` or `SSH_TTY` set), or when no browser can be opened: don't try, or ignore the failure, and print `Run <id> started: <url>`, plus over SSH `From your machine: ssh -L <port>:127.0.0.1:<port> <host>, then open http://127.0.0.1:<port>/`. Exit 0.
7. **Hand-off blocked** (every option in §4.5 failed to spawn or was refused): print `Could not start the run in the background (<reason>). Run this in a terminal:` followed by the full foreground command (without `--web`) and a `cd` into the repo. Exit with code 3, so the skill can tell this apart from a started run (0) and from a preflight error (2).

### 4.4 Run process behaviour (`--web-serve`)

- It is internal. It isn't listed in `--help`, and it is refused unless `GRAPH_EXECUTION_READY_FILE` is set.
- It does the normal startup (run id, run dir, lock, exclude, full-auto warning), then starts the web server (§5) on a random free port (`listen(0)` on `127.0.0.1`).
- Once listening, it writes the URL to `.graph-execution/<run-id>/web.json` (`{ url, pid }`) and then to the ready file.
- Everything the run would log goes to the page's events panel and to `.graph-execution/<run-id>/run.log`.
- A fatal error after the server is up shows on the page as an error state, with the message and the resume hint, and is written to `run.log`. The server stays up.
- After the run ends (clean, exhausted or aborted), the server keeps serving the final state until **Close** is pressed. Then it exits with the run's exit code and removes `web.json`.

### 4.5 OS hand-off

| Platform | First choice | Fallback |
|---|---|---|
| macOS | `launchctl submit -l graph-execution.<random> -- /bin/sh <run.sh>` | `nohup /bin/sh <run.sh> &` in a new session (`setsid`-style detached spawn) |
| Linux | `systemd-run --user --collect --unit graph-execution-<random> /bin/sh <run.sh>` | detached spawn in a new session (`detached: true`, `stdio: "ignore"`, `unref()`), which covers WSL and containers without a user systemd |
| Windows | `schtasks /create /tn graph-execution-<random> /sc once /st 00:00 /f /tr "<run.cmd>"`, then `schtasks /run /tn …`. The run process deletes the task once it is ready. | detached spawn with `detached: true, windowsHide: true` |

A choice that fails to spawn (ENOENT, non-zero exit of `launchctl`/`systemd-run`/`schtasks`, which are synchronous) falls through to the next. If every choice fails, see §4.3 step 7. Only the first choice gets the run out of an agent's sandbox. The fallback still survives the agent's command ending in most harnesses, but stays inside the sandbox. The ready-file wait catches a run that is started but can't work: a sandboxed provider usually fails before the server is up. A run that fails later shows the error on its page.

### 4.6 Quoting

All quoting goes through one tested function per shell: POSIX `sh` for `run.sh`, and `cmd` for `run.cmd`, including `%` → `%%`. Paths with spaces, quotes, `&`, `%`, `!` and non-ASCII characters must survive. Since the OS only ever receives the script's path, this is the only quoting there is.

### 4.7 `graph-execution open`

`open [--run <id>]` reads `.graph-execution/<run-id>/web.json` (the latest run without `--run`). If the PID in it is alive, it opens the URL, or prints it over SSH. Otherwise it prints `run <id> has no live page (it was closed or isn't running with --web)` and exits with code 2. A resumed run (`--resume --web`) is a new process on a new port, and it overwrites `web.json`.

### 4.8 Code layout

- `src/launch/preflight.ts`: the checks of §4.3.1, used by the normal run, `--resume` and `--web`.
- `src/launch/handoff.ts`: script writing, quoting, the platform plan and the ready-file wait. It is a pure `planHandoff(platform, env, which) → Step[]` plus a thin `handoff()` that spawns, so every platform is testable on any OS.
- `src/web/server.ts`: the HTTP server and SSE (§5).
- `src/web/page.html`: the page, a single static file (§5.3).
- `src/web/start.ts`: a `startWebUi(opts: UiOptions): UiHandle`, which implements the same interface as `startUi` in `src/ui/start.tsx`, so `run()` doesn't change. It feeds a `RunStore` (`src/ui/store.ts`), whose `ViewState` is the snapshot the page renders.
- `src/cli.ts`: `--web`, the hidden `--web-serve`, and the `open` command.
- `README.md`: the flag and `open` in the usage table, and a short "Starting a run from your agent" section.

## 5. Web view

### 5.1 Server

- Binds to `127.0.0.1` on a random free port. Several runs at once each get their own port.
- **Host/Origin checks on every request:** a `Host` header other than `127.0.0.1:<port>` or `localhost:<port>` gets 421. A `POST` whose `Origin` isn't `http://127.0.0.1:<port>` or `http://localhost:<port>` gets 403. This blocks DNS rebinding, and other websites in the user's browser pressing the button. There is no token.
- Routes:
  - `GET /`: the page.
  - `GET /state`: the full `ViewState` snapshot, plus `layers`, `parents`, `mergeTarget`, `runId`, `provider`, and once ended the `RunEnd` with the summary.
  - `GET /events`: Server-Sent Events. It sends a `state` event with the full snapshot on connect, then one each time the store changes (throttled to 10 per second). The page re-renders from the latest snapshot, so a reload or a late open always shows the full current state. A `: ping` every 15 s keeps the connection open.
  - `POST /abort`: while the run is going, aborts it through the run's existing abort signal (`opts.signal` in `run()`), the same path as Ctrl+C. Running agents are killed, state is kept, and the summary shows the resume command. Answers 409 once the run has ended.
  - `POST /close`: only after the run has ended. It answers 200, then the process exits (§4.4). Answers 409 while the run is going.

### 5.2 Page

- The same content as the TUI: the task graph with arrows from each task to its dependents, then validate → code reviewer and live tester → fixer → apply. Each node shows status, attempt (`retry N/M`) and spinner state, plus the phase bar and the last events.
- Once the run has ended: the summary, the same content as `summaryContent` in `src/ui/Summary.tsx`. For a clean run that was applied, that means the applied files, any conflicts with the user's uncommitted edits, and the "drop them" command.
- The button: **Abort** while running, with a confirm dialog. **Close** once ended, which shows "Server closed. Reopen with `graph-execution open`… (only while a run is live)" after it succeeds.
- When the SSE connection drops (the server is gone), the page shows "Disconnected" and stops retrying after 1 minute.

### 5.3 Frontend

- One static `page.html`, vanilla JS, with an inline SVG for the graph. No build step and no framework. Shipped in the npm tarball.
- The page lays out the graph itself from `layers` and `parents`, top-down, with one row per layer. Reusing `src/ui/layout.ts` (a character grid) isn't a goal.
- Light and dark mode follow `prefers-color-scheme`. Status colours match `src/ui/theme.ts`.

## 6. `run-graph` skill

### 6.1 Packaging

- `skills/run-graph/SKILL.md`, shipped in the npm tarball next to `skills/to-tasks/`.
- `graph-execution install skills` installs **every** bundled skill (`to-tasks` and `run-graph`) into the chosen target. The refusal without `--force` is decided per skill folder: an existing `to-tasks` doesn't block installing a missing `run-graph`. The command prints one line per installed skill and one per skipped skill (with the `--force` hint). It exits with code 2 only when nothing was installed and something was skipped.

### 6.2 Skill frontmatter

```yaml
name: run-graph
description: Start a graph-execution run of a task folder in the background and open its live view in the browser. Use when the user wants to run, start or execute the tasks created by to-tasks, or asks to "run the graph".
```

### 6.3 Skill steps

1. **Work out the arguments.**
   - Tasks folder: the one `to-tasks` just wrote in this conversation, else `.agents/tasks` if it exists, else ask.
   - Spec: the PRD used to make the tasks in this conversation, else ask. Never guess between several files.
   - Provider: what the user said. Otherwise default to the agent's own CLI (Claude Code → `claude`, Codex → `codex`, OpenCode → `opencode`, Qwen Code → `qwen`), and say so. Any other agent: ask.
   - Pass `--concurrency`, `--model` and `--no-merge` only if the user asked for them.
2. **Warn, don't block, about uncommitted code.** If `git status --porcelain` shows changes outside the tasks folder and the spec, tell the user that agents only see committed code and ask whether to continue or commit first. The task folder and the spec don't need to be committed.
3. **Launch.** Run `npx graph-execution <tasks> --spec <spec> --provider <p> --web` from the repo root. If the package is installed globally, `graph-execution` works too.
4. **Report and stop.** It goes by the exit code, never by matching output:
   - **0**: give the user the URL printed by the CLI, and tell them:
     - the run is in their browser and can be aborted there;
     - when the review is clean, the result lands as uncommitted changes on the current branch, on top of whatever they edit in the meantime, with overlaps as conflicts;
     - `graph-execution open` brings the page back;
     - `graph-execution --resume --web` continues an interrupted run.

     **Then end the turn.** Do not sleep, poll, fetch the URL, read `.graph-execution/`, or tail logs.
   - **3** (hand-off blocked): give the user the printed command to run in their own terminal, then stop. Don't try to work around the sandbox.
   - **2**: show the error, fix what is fixable within the skill's scope (for example an invalid task file, by re-running `to-tasks` validation), or ask the user, then try again. Don't retry the same failing command unchanged.
5. **Never** run graph-execution without `--web` from the agent's shell, and never start a second run while one is live (check with `graph-execution open`) unless the user asks.

### 6.4 Hand-over from `to-tasks`

The last step of `skills/to-tasks/SKILL.md` changes from printing the command to:

> Tell the user the tasks are ready, show the command, and ask whether to start the run now. If they say yes and the `run-graph` skill is available, follow it; otherwise run the command with `--web` yourself, report the URL and stop.

## 7. Edge cases

| Case | Behaviour |
|---|---|
| Path to repo, spec or Node contains spaces, quotes, `%`, `!` | Quoted once, in the wrapper script (§4.6). Covered by tests. |
| Run started from a subdirectory | The script `cd`s into the launcher's cwd, so relative `<tasks-dir>` and `--spec` still resolve. |
| `--resume --web` while the run is live | Preflight sees the lock's live PID and exits 2 with "run <id> is already running (PID n); open it with `graph-execution open`". |
| Two `--web` launches of new runs at the same moment | Both pass preflight, and each gets its own run id, port and page, as two manual runs would. |
| Provider found by preflight but not in the run process | Can't happen through `PATH`, which is passed explicitly (§4.3.3). If the provider still fails (sandbox, not logged in), the run fails before or after the server is up: either the launcher prints the `launch.log` tail with exit 2, or the page shows the error. |
| Agent runs in a strict sandbox (e.g. Codex) | `launchctl`/`systemd-run`/`schtasks` is refused, and the fallback is spawned inside the sandbox. If the run process can't get ready, exit 2 with the log tail. If even spawning is refused, exit 3 with the command. |
| User keeps editing the checkout during the run | The final apply runs as today (result over uncommitted changes, overlaps left as conflicts). The page's summary lists the files and conflicts, and the "drop them" command. |
| Tab closed | The run continues. `graph-execution open` reopens the page. |
| Tab closed after the run ends, Close never pressed | The process keeps serving until the machine restarts or the user runs `graph-execution open` and presses Close. `open` lists such idle servers (see §10, idle timeout). |
| Machine sleeps or reboots | Like a killed run today: the lock's PID is dead, and `--resume --web` continues it. |
| Agent itself running inside a graph-execution worktree | Preflight's `assertNotNested` refuses (exit 2), as today. |

## 8. Testing

- **Preflight**: the normal path and the launcher call the same `preflight()`. With a missing spec, a cyclic graph, an unknown provider or a live lock, `--web` exits 2, calls no hand-off and creates no `.graph-execution/`.
- **Hand-off plan** (`src/launch/handoff.test.ts`): `planHandoff` for macOS, Linux with and without `systemd-run`, Windows, a blocked first choice, and every choice blocked (exit 3). It asserts the exact argv per step.
- **Wrapper script and quoting**: round-trip tests per shell for `C:\Users\A B\repo`, `/tmp/it's here`, `a&b`, `100%`, `wow!`, `ünï`. Where the shell exists on the CI runner (sh everywhere, cmd on Windows CI), actually run the generated script with an `echo` stand-in for Node, and compare argv and env.
- **Ready file**: a fake run process that writes the ready file → exit 0 and the browser opener is called once with the URL. One that exits early or never writes → exit 2 and the log tail is printed. With SSH set → no opener, URL and `ssh -L` hint printed.
- **Server**: `/state` and `/events` return the store's snapshot. A late SSE subscriber gets the full current state first. Bad `Host` → 421, foreign `Origin` on POST → 403. `/abort` while running ends in the normal abort path (exit 2, resumable). `/abort` after the end → 409. `/close` while running → 409. `/close` after the end → process exits with the run's code and `web.json` is gone.
- **E2E**: a fixture run with `--web-serve` and a fake provider, driven by HTTP only: watch the SSE stream reach `summary`, then Close.
- **`open`**: live PID → opener called; dead PID or no `web.json` → exit 2.
- **Install**: `install skills` installs both skills. With `to-tasks` already present, it installs only `run-graph` and reports the skip.
- **Manual smoke test** (added to the README checklist), once each on Windows, macOS and Linux desktop, started both by hand and from Claude Code and Codex: the page opens, shows the live graph, survives closing the agent, Abort works, `--resume --web` continues, and Close ends the process.

## 9. Acceptance criteria

- [ ] `graph-execution <tasks> --spec <f> --provider <p> --web` hands the run off per §4.5, opens the page, and exits 0 within a few seconds. The run behaves exactly like a run started by hand.
- [ ] The run survives the launching shell, and the agent session, ending.
- [ ] Any check a normal run would fail before starting agents makes `--web` exit 2 without starting anything or creating `.graph-execution/`.
- [ ] A run process that dies before its server is up makes the launcher exit 2 with the log tail.
- [ ] A blocked hand-off exits 3 with the full foreground command.
- [ ] Over SSH, the URL and an `ssh -L` hint are printed, and the exit code is 0.
- [ ] The page shows the live graph, survives reloads, shows the summary and the result of the final apply, and Abort/Close work as specified.
- [ ] Requests with a foreign `Host` or `Origin` are refused.
- [ ] `--resume --web` and `graph-execution open` work.
- [ ] `install skills` installs `run-graph` next to `to-tasks`, with per-skill refusal and `--force`.
- [ ] `to-tasks` ends by offering to start the run.
- [ ] `npm run typecheck && npm run lint && npm test` pass.

## 10. Out of scope / later

- More buttons: retry a failed task, resume an aborted run from the page, skip a task, open a task's log. Each needs its own POST route behind the same Host/Origin checks. Re-evaluate whether to add a URL token when a button can start agents rather than only stop them.
- An idle timeout after the run ends (for example 30 min with no page connected), so a forgotten server doesn't stay up forever.
- A `--web` for the outer loop command (PRD 03). It should come for free if it reuses the same preflight, hand-off and web view, and is to be checked there.
- `--web` combined with the TUI in the foreground, for humans who want both.
- Any monitoring by the agent.

## 11. Open questions

- `launchctl submit` is deprecated, though it still works on current macOS. If it stops working, the replacement is writing a one-shot plist and running `launchctl bootstrap gui/<uid>`.
- Does Codex's sandbox let a detached child outlive the sandboxed command? This needs a spike on each platform before the skill's wording about exit 3 is final.
