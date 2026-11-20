# Changelog

## 2.0.6 (2026-11-19)

Published to npm from `05380e1`. npm `latest` is 2.0.6. 2.0.5 was GitHub-only.

### Added

- Escalation ([#43](https://github.com/romm0109/graph-execution/pull/43)). A task agent, or the review-phase fixer, can pause its branch and ask for a decision when the task contradicts the spec or the code, or needs a product decision. A task whose validation is still failing after its fix rounds escalates too. That task and the tasks that depend on it wait; the other tasks keep running. The review starts after every task has merged and no escalation is open. The run page shows "1 decision needed" or "N decisions needed", marks the node **needs decision**, and has a **Decision** tab (**Talk to an agent**, **Apply resolution**, **Abort run**). `graph-execution escalations [--run <id>]` lists them. `graph-execution resolve [--run <id>] --file <resolution.json>` applies a resolution. `--escalation` / `--no-escalation` override the `escalation` config key, which defaults to on. Suite feature runs are started with `--no-escalation`.
- Project terminals, and a base branch on every new terminal ([#42](https://github.com/romm0109/graph-execution/pull/42)). The New terminal dialog's **Base** list picks the branch a workspace terminal is cut from. A terminal opened on a project works in a worktree of the project folder, and each repo gets its own worktree cut from the branch on that repo's row, so the workspace checkouts stay as they were. Closing a project terminal with work offers **Delete all**, **Keep all**, **Merge project files** (the project folder's own files) and **Create PR** (one pull request per repo with work, bodies linked). Kept project worktrees are listed under the project. A project terminal can start a normal run of one repo, listed under that repo's workspace, or the project's suite.

### Fixed

- A `git fetch` that does not answer while a terminal is opening settles at its timeout (**Offline: local branches**), and a failed worktree add deletes a `gm-term/<id>` branch it created when that branch was new (`ec65b26`, in [#44](https://github.com/romm0109/graph-execution/pull/44)).

## 2.0.5 (2026-11-15)

Tagged `v2.0.5` at `e1b4669`. The [GitHub release](https://github.com/romm0109/graph-execution/releases/tag/v2.0.5) attaches the desktop installers (`graph-manager-0.1.0-arm64.dmg`, `graph-manager-0.1.0.dmg`, `graph-manager.Setup.0.1.0.exe`). 2.0.5 was GitHub-only. 2.0.6 is on npm.

### Added

- Desktop app for macOS and Windows ([#38](https://github.com/romm0109/graph-execution/pull/38)). Local mode runs the bundled server on `127.0.0.1` and logs in from `~/.graph-manager/password`. Remote mode loads a server's own UI. `server.lock` keeps a single server on one data folder. The installers are unsigned. A push to `main` that bumps `packages/graph-execution/package.json` tags `v<version>` and publishes the release with those installers ([#40](https://github.com/romm0109/graph-execution/pull/40)).
- **Switch server** on the desktop app's login page, which opens the mode picker ([#40](https://github.com/romm0109/graph-execution/pull/40)).
- Phone use of the web app ([#37](https://github.com/romm0109/graph-execution/pull/37)): a nav drawer below 900 px, a touch terminal with Esc, Tab, Ctrl, arrow keys and Ctrl-Space, a home-screen install over HTTPS, and optional TLS (`GM_TLS_CERT` and `GM_TLS_KEY`, or `--tls-cert` and `--tls-key`).
- Isolated workspace runs and terminals ([#39](https://github.com/romm0109/graph-execution/pull/39)). `--base <ref>` starts a run from a branch or commit. A workspace run passes `--base <branch> --no-merge` and ends on `graph/<run-id>`. Each workspace terminal gets its own worktree. **Create PR** checks push access, moves the spec in a throwaway worktree, pushes `graph/<run-id>` and opens the pull request into **Merge into**. **Retry** runs those steps again. After a resume, tasks and reports are marked **reused** or **ran again**. Validation shows **fixing N/M**, then **checking fix N/M**.
- The landing site ([#33](https://github.com/romm0109/graph-execution/pull/33), [#34](https://github.com/romm0109/graph-execution/pull/34)).

### Fixed

- Terminal input on a slow link: each typed character is drawn at once, the terminal uses WebGL, and PTY output is batched ([#35](https://github.com/romm0109/graph-execution/pull/35)).
- Listing runs no longer walks every file of every run folder to measure its size ([#35](https://github.com/romm0109/graph-execution/pull/35), [#36](https://github.com/romm0109/graph-execution/pull/36)).
- Sandboxes negotiate the Docker API version, so they run on Docker 20.10 and newer. A named-volume subpath mount still needs Docker 26 ([#39](https://github.com/romm0109/graph-execution/pull/39)).
- The packaged macOS app finds node-pty's `spawn-helper` ([#38](https://github.com/romm0109/graph-execution/pull/38)).

## 2.0.4 (2026-11-13)

Published to npm from `0d46d64`. That commit's `package.json` still said `2.0.3`. `a2911c8` sets the field to `2.0.4`.

### Added

- Multi-repo runs ([#31](https://github.com/romm0109/graph-execution/pull/31)). A project groups workspaces from one forge. `graph-execution suite --project <dir>` runs one feature per repo, then a joint validation, review and test, and applies to every repo or to none. **Create PR** opens one linked pull request per repo that changed.

## 2.0.3 (2026-11-12)

Published to npm from `20fd0c9`. `packages/graph-execution/package.json` is set to `2.0.3` to match that release.

### Fixed

- graph-manager's OpenCode terminal: OpenCode 2 and later is started as `opencode --standalone`. OpenCode 1, and a version that cannot be read, is started as `opencode`. On Windows the MCP command is `graph-manager-mcp.cmd` again (2.0.2 used `node` and the path of `mcp.js`).

## 2.0.2 (2026-11-12)

Published to npm from `1440c82`.

### Fixed

- graph-manager's OpenCode terminal on Windows started its MCP server as `node` with the path of `mcp.js`, instead of `graph-manager-mcp.cmd`. 2.0.3 starts `graph-manager-mcp.cmd` again.

## 2.0.1 (2026-11-12)

Published to npm from `d389547`. That commit's `package.json` still said `2.0.0`.

### Fixed

- graph-manager's OpenCode terminal runs `opencode --version` when the terminal opens. Major 2 and later gets the MCP server under `mcp.servers` (`disabled: false`). OpenCode 1, and a version that cannot be read, gets it under `mcp` (`enabled: true`). The source comment says OpenCode 2 ignores an entry directly under `mcp`, and OpenCode 1 rejects `mcp.servers`.

## 2.0.0 (2026-11-12)

### Added

- `graph-execution manager` starts graph-manager, the web app for workspaces, terminals and runs, from the npm package. Flags: `--port`, `--host`, `--data-dir`, `--workspaces-dir`, `--no-open`.
- graph-manager generates a password when `GM_PASSWORD` is unset, saves it in `<data dir>/password` (mode 600) and prints it at startup.
- graph-manager finds the Docker endpoint for sandboxes by itself: `DOCKER_HOST` (`unix://` or `npipe://`), the Docker Desktop sockets under `~/.docker`, and the named pipe `//./pipe/docker_engine` on Windows.
- Sandboxed runs on Windows with Docker Desktop in Linux-containers mode: the workspace is mounted at `/workspaces/<rel>` and the container runs as `1000:1000`. Covered by unit tests and CI, not yet run against a real Docker Desktop.
- `.cmd` shims (`graph-execution.cmd`, `graph-manager-mcp.cmd`) for graph-manager's terminals on Windows, so the `graph-execution` command and the agent tools work there.
- `GRAPH_EXECUTION_NO_OPEN=1` stops `graph-execution manager` from opening the browser.

### Changed

- The package now depends on `fastify`, `@fastify/cookie`, `@fastify/static`, `@fastify/websocket` and `node-pty`, which graph-manager uses. `node-pty` has prebuilt binaries for macOS and Windows only: on Linux, `npm install` compiles it and needs Python 3, make and a C++ compiler.

## 1.2.0 (2026-11-06)

### Fixed

- Ctrl-C during setup or validation stops their whole process tree, exits 2 and prints the resume hint (GE-01, GE-02).
- Agents left running by a CLI that was killed (`kill -9`, the OOM killer) are stopped by `--resume`, `suite --resume` and `clean` (GE-06).
- A hung provider or summarizer times out (`idleTimeoutMinutes`, default 20) and counts as a failed attempt; provider output lines are capped (GE-05, GE-12).
- A failed final apply exits 2, and `--resume` on a finished run refuses instead of applying again (GE-04, GE-08).
- Startup fails fast without a git identity or with leftover task worktrees (GE-03, GE-09).
- The suite page and a second browser tab on the run page no longer lose log text (GE-10).
- `GRAPH_EXECUTION_*_ARGS` respect shell-style quoting (GE-11).
- The run lock can't be taken twice in one process, and release is owner-safe (GE-13).
- Windows: leftover processes are killed after an agent exits, the provider CLI is found the way it is spawned, `--web` and `readme` work with spaces in paths, and setup/validate run through a POSIX `sh` (GE-14 … GE-17).
- `clean` no longer reports a run as skipped and then deletes it.

### Added

- `--version` / `-v` (GE-18).
- Config key `idleTimeoutMinutes`.
- `GRAPH_EXECUTION_SHELL` (Windows) to choose the shell for setup/validate.
- MIT `LICENSE`, and links from the npm page to GitHub.

### Changed

- A run whose final apply fails exits 2 instead of 0.
- `--resume` on a finished run exits 2.
- Windows: setup/validate commands run through `sh`, not `cmd.exe`. Set `GRAPH_EXECUTION_SHELL=cmd` for the old behaviour.

## 1.1.0

Published to npm from `dd6f53a`.
