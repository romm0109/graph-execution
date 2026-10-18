# PRD: `run-graph` skill and `--new-terminal` launch

## 1. Summary

After `to-tasks` has written the task folder, the user should be able to tell their coding agent "start the run" and have it happen. The agent checks what it can, then opens a **new terminal window** with the `graph-execution` command running in it, and **stops**. It never follows, waits for or monitors the run.

The platform logic for opening a terminal lives in the CLI, behind a new `--new-terminal` flag, not in the skill. Agents improvising `osascript` or `cmd /k` quoting would break on paths with spaces and differ by provider. The skill only has to call one command.

Two deliverables:

1. **`--new-terminal`**: a CLI flag that checks the arguments, opens a terminal window running the same command without the flag, and exits at once.
2. **`run-graph` skill**: a bundled skill, installed by `graph-execution install skills`. It figures out the arguments, runs the CLI with `--new-terminal`, reports what it did, and stops. `to-tasks` ends by offering to hand over to it.

## 2. Goals and non-goals

**Goals**
- From the moment the tasks exist, a user can start a run without knowing the CLI syntax.
- The run gets a real terminal, so the Ink TUI works, and the window stays open after the run so the summary and exit code stay readable.
- Works on Windows (Git Bash, else cmd), macOS (Terminal.app) and Linux (common terminal emulators).
- Fails fast, before any window opens, on arguments a normal run would reject.

**Non-goals**
- The agent monitoring, polling or reporting on the run. It stops once the window is open.
- Choosing a terminal app (iTerm2, Windows Terminal, …). Possible later through an env var, see §8.
- Running inside an agent's own shell. The run always gets its own window.

## 3. User stories

1. **As a developer who just generated tasks with `to-tasks`, I want to say "run it" and see a terminal open with the run, so that I don't have to remember the command.**
   Example: the agent replies "Started `graph-execution .agents/tasks --spec PRD.md --provider claude` in a new Git Bash window", and the window shows the live graph.
2. **As a Windows user, I want Git Bash when I have it and cmd otherwise.**
3. **As a developer, I want a mistake (a missing spec, a cycle in the graph, a provider not on the PATH) reported by the agent right away instead of in a window that closes or that I don't look at.**
4. **As a developer on SSH or in a headless environment, I want the exact command printed when no window can be opened, so that I can run it myself.**

## 4. `--new-terminal` (CLI)

### 4.1 Usage

```
graph-execution <tasks-dir> --spec <file> --provider <name> [other options] --new-terminal
graph-execution --resume [--run <id>] [--no-merge] --new-terminal
```

The flag works with a normal run and with `--resume`. It is not accepted with `install` or `readme`.

### 4.2 Behaviour

1. **Preflight, with no side effects.** It runs the checks a normal run does before creating anything:
   - arguments (same `UsageError`s as today: missing `--spec` or `--provider`, `--run` without `--resume`, …);
   - the spec check (`checkSpec`);
   - loading and validating the graph (`loadTasks` + `validateGraph`);
   - inside a git repository with at least one commit, not nested in a `.graph-execution` worktree (`assertNotNested`);
   - the config loads (`loadConfig`);
   - the provider CLI is on the PATH (`getProvider`).

   For `--resume`, it also checks that the run exists (`findRun`) and that its inputs didn't change (`changedInputs`), and does not take the lock. Preflight **does not** create a run id or directory, does not touch `.git/info/exclude`, and does not print the full-auto warning. All of that happens in the new window.

   A failing check prints the usual `error: …` and exits with code 2, and no window is opened.
2. **Build the child command.** It runs the same argv, with `--new-terminal` removed, using the current Node binary and CLI script: `"<process.execPath>" "<path to dist/cli.js>" <args…>`. It does not use `npx`, so nothing is downloaded again and the same version runs. The working directory is the current one.
3. **Environment.** Variables that start with `GRAPH_EXECUTION_` (provider extra args, etc.) are passed explicitly in the child command line. Terminal.app and some Linux terminals don't inherit the caller's environment. `PATH` comes from the user's shell profile in the new window.
4. **Open the window** (§4.3) and keep it open after the run ends. After the command, the window prints `graph-execution exited with code <n>` and keeps an interactive shell, or a paused prompt in cmd.
5. **Exit at once** with code 0, printing one line: `Started in a new <terminal name> window: <command>`.
6. **No window possible** (§4.4): print `Could not open a terminal window (<reason>). Run this in a terminal:` followed by the full command with a `cd` into the repo. Exit with code 0. Preflight passed, so this is not a failure, and the agent relays the command.

### 4.3 Platform matrix

| Platform | Detection | Launch |
|---|---|---|
| Windows + Git Bash | `where git` → `<git root>\git-bash.exe` (from `...\Git\cmd\git.exe` go two levels up), else `%ProgramFiles%\Git\git-bash.exe`, `%ProgramFiles(x86)%\Git\git-bash.exe`, `%LocalAppData%\Programs\Git\git-bash.exe` | `git-bash.exe --cd=<repo> -c "<cmd>; echo; echo \"graph-execution exited with code $?\"; exec bash"`. Windows paths in `<cmd>` use forward slashes. |
| Windows, no Git Bash | always available | `cmd.exe /c start "graph-execution" cmd /k "cd /d "<cwd>" && <cmd> & echo graph-execution exited with code %ERRORLEVEL%"` |
| macOS | `process.platform === "darwin"` | `osascript -e 'tell application "Terminal" to do script "cd <cwd> && <cmd>"' -e 'tell application "Terminal" to activate'`. Terminal.app windows stay open by default. |
| Linux | the first one found on the PATH: `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm` | each with its own "execute" flag (`--` for gnome-terminal, `-e` for the others) running `bash -c "cd <cwd> && <cmd>; echo; echo \"graph-execution exited with code $?\"; exec bash"` |

The launcher is started detached, with `stdio: "ignore"` and `unref()`, so the CLI exits straight away. A launcher that fails to start (ENOENT, non-zero exit within ~2 s) falls through to the next option and finally to §4.4.

### 4.4 When no window can be opened

- `SSH_CONNECTION` or `SSH_TTY` is set, or on Linux neither `DISPLAY` nor `WAYLAND_DISPLAY` is set → no attempt, print the command.
- Every launcher for the platform failed → print the command.

### 4.5 Quoting

All quoting goes through one tested function per shell (POSIX `sh`, `cmd`, AppleScript string). Paths with spaces, quotes, `&`, `%` and non-ASCII characters must survive. This is the riskiest part of the feature, and §7 lists the test cases.

### 4.6 Code layout

- `src/launch/terminal.ts`: detection, command building, quoting, spawning. It is a pure function `planLaunch(platform, env, which) → { launcher, args } | { fallback: reason }` plus a thin `launch()` that spawns. This keeps every platform testable on any OS.
- `src/cli.ts`: the `--new-terminal` option, a preflight path that reuses the existing checks, and the call to `launch`.
- `README.md`: the flag in the usage table, and a short "Starting a run from your agent" section.

## 5. `run-graph` skill

### 5.1 Packaging

- `skills/run-graph/SKILL.md`, shipped in the npm tarball next to `skills/to-tasks/`.
- `graph-execution install skills` installs **every** bundled skill (`to-tasks` and `run-graph`) into the chosen target. The refusal without `--force` is decided per skill folder: an existing `to-tasks` doesn't block installing a missing `run-graph`. The command prints one line per installed skill and one per skipped skill (with the `--force` hint). It exits with code 2 only when nothing was installed and something was skipped.

### 5.2 Skill frontmatter

```yaml
name: run-graph
description: Start a graph-execution run of a task folder in a new terminal window. Use when the user wants to run, start or execute the tasks created by to-tasks, or asks to "run the graph".
```

### 5.3 Skill steps

1. **Work out the arguments.**
   - Tasks folder: the one `to-tasks` just wrote in this conversation, else `.agents/tasks` if it exists, else ask.
   - Spec: the PRD used to make the tasks in this conversation, else ask. Never guess between several files.
   - Provider: what the user said. Otherwise default to the agent's own CLI (Claude Code → `claude`, Codex → `codex`, OpenCode → `opencode`, Qwen Code → `qwen`), and say so.
   - Pass `--concurrency`, `--model` and `--no-merge` only if the user asked for them.
2. **Warn, don't block, about uncommitted code.** If `git status --porcelain` shows changes outside the tasks folder and the spec, tell the user that agents only see committed code and ask whether to continue or commit first. The task folder and the spec don't need to be committed.
3. **Launch.** Run `npx graph-execution <tasks> --spec <spec> --provider <p> --new-terminal` from the repo root. If the package is installed globally, `graph-execution` works too.
4. **Report and stop.**
   - Exit 0 with "Started in a new … window": tell the user the run is in that window, that the result will land as uncommitted changes on the current branch when the review is clean, and that `graph-execution --resume --new-terminal` continues an interrupted run. **Then end the turn.** Do not sleep, poll, read `.graph-execution/`, or tail logs.
   - Exit 0 with "Could not open a terminal window": give the user the printed command to run themselves, then stop.
   - Exit 2: show the error, fix what is fixable within the skill's scope (for example an invalid task file, by re-running `to-tasks` validation), or ask the user, then try again. Don't retry the same failing command unchanged.
5. **Never** run graph-execution without `--new-terminal` from the agent's shell, and never start a second run while one is open in a window unless the user asks.

### 5.4 Hand-over from `to-tasks`

The last step of `skills/to-tasks/SKILL.md` changes from printing the command to:

> Tell the user the tasks are ready, show the command, and ask whether to start the run now. If they say yes and the `run-graph` skill is available, follow it; otherwise run the command with `--new-terminal` yourself and stop.

## 6. Edge cases

| Case | Behaviour |
|---|---|
| Path to repo or spec contains spaces / quotes | Quoted per shell (§4.5). Covered by tests. |
| Run started from a subdirectory | `cwd` is passed through unchanged, so relative `<tasks-dir>` and `--spec` still resolve. |
| `--new-terminal` together with a run that is already locked (resume) | Preflight checks the lock file's PID. If it is alive, exit 2 with "run <id> is already running (PID n)". |
| Windows PowerShell 5.1 user | Not involved: the window is Git Bash or cmd, never PowerShell. |
| macOS automation permission prompt | The first `osascript` call may show "… wants to control Terminal". The skill mentions this once if the launch fails with error -1743 (not authorized), and falls back to the printed command. |
| Agent itself running inside a graph-execution worktree | Preflight's `assertNotNested` refuses (exit 2), as today. |

## 7. Testing

- **Unit (`src/launch/terminal.test.ts`)**: `planLaunch` for each platform/environment combination in §4.3–4.4: Git Bash found via `where`, Git Bash found via `%ProgramFiles%`, none (cmd), macOS, each Linux emulator, Linux without a display, SSH. It asserts the exact argv.
- **Quoting**: round-trip tests per shell for `C:\Users\A B\repo`, `/tmp/it's here`, `a&b`, `100%`, `ünï`. Where the shell exists on the CI runner (sh everywhere, cmd on Windows CI), actually execute the quoted command with `echo` and compare.
- **CLI**: `--new-terminal` with a missing spec, a cyclic graph, or an unknown provider exits 2 and calls no launcher (launcher injected as a fake). A valid invocation calls the launcher once, with the argv minus `--new-terminal`, and exits 0 without creating `.graph-execution/`.
- **Install**: `install skills` installs both skills; with `to-tasks` already present it installs only `run-graph` and reports the skip.
- **Manual smoke test** (added to the README checklist): one launch each on Windows with Git Bash, Windows without Git Bash, macOS and Linux desktop. The window opens in the repo and shows the TUI, and stays open with the exit code after the run.

## 8. Out of scope / later

- `GRAPH_EXECUTION_TERMINAL` to pick a specific terminal (iTerm2, Windows Terminal, kitty).
- A `--new-terminal` for the outer loop command (PRD 03). It should come for free if it reuses the same preflight-and-launch path, and is to be checked there.
- Any monitoring by the agent.

## 9. Acceptance criteria

- [ ] `graph-execution <tasks> --spec <f> --provider <p> --new-terminal` opens a window per §4.3, exits 0 at once, and the run in the window behaves exactly like a run started by hand.
- [ ] The window stays open after the run and shows the exit code.
- [ ] Any check a normal run would fail before starting agents makes `--new-terminal` exit 2 without opening a window or creating `.graph-execution/`.
- [ ] With no desktop, the full command is printed and the exit code is 0.
- [ ] `--resume --new-terminal` works.
- [ ] `install skills` installs `run-graph` next to `to-tasks`, with per-skill refusal and `--force`.
- [ ] `to-tasks` ends by offering to start the run.
- [ ] `npm run typecheck && npm run lint && npm test` pass.
