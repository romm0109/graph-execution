# Changelog

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
