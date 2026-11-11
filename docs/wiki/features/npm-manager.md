# graph-manager from npm: `graph-execution manager`, generated password, sandboxes on macOS and Windows

## Summary

graph-manager ships inside the `graph-execution` npm package. `npm install -g graph-execution` followed by `graph-execution manager` starts it, with no clone of the repository and no Docker.

- The root `npm run build` builds the engine, then graph-manager, then copies graph-manager's built files into the engine's `dist/manager`. The manager's source stays in `apps/graph-manager`.
- A local start needs no configuration. Without `GM_PASSWORD`, a password is generated once, saved in `<dataDir>/password` and printed after the URL.
- On Windows the terminals get `graph-execution.cmd` and `graph-manager-mcp.cmd`, so the command and the agent tools work there.
- Sandboxes find Docker by themselves on Linux, macOS (Docker Desktop sockets) and Windows (the named pipe). On Windows the workspace is mounted at `/workspaces/<rel>` and paths are translated at the manager's edge.
- The Docker image is built the same way and starts through `cli.js manager --no-open`.

Sources:

- Spec: `docs/prd/npm-manager.md` (`docs/prd/done/npm-manager.md` once the PR is created). There is no Jira ticket: the Ticket column says `npm-manager`.
- User documentation: `packages/graph-execution/README.md` ("graph-manager") and `apps/graph-manager/README.md` ("Quick start", "Configuration", "Platforms").

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| One npm package. The manager's built files are copied into the engine package at `dist/manager/` (`server/*.js`, `web/*`, `package.json`). | The user chose one package over a separate `graph-manager` package. | npm-manager |
| The manager's source stays in `apps/graph-manager` (still `private`, its own workspace and tests). `packages/graph-execution/scripts/bundle-manager.mjs` copies `apps/graph-manager/dist` into `packages/graph-execution/dist/manager`, without test files. It removes only `server`, `web` and `package.json` there first. | Moving the manager into the engine's source tree would be a large change with no benefit to users. The engine's own `src/manager/*.ts` compiles into the same folder, so the folder can't be removed whole. | npm-manager |
| The manager keeps importing `graph-execution/api`. From `node_modules/graph-execution/dist/manager/server` this resolves to the package itself. | No import is rewritten, and the same compiled files work in the workspace, in the Docker image and in `node_modules`. | npm-manager |
| The sandbox tools copy of the engine (`copyEngine` in `sandbox-tools.ts`) leaves out the bundle (`dist/manager/server`, `web`, `package.json`) and the manager-only dependencies (`MANAGER_ONLY_DEPENDENCIES`). | A sandbox only runs the engine. node-pty and the manager would add host-built files to every tools folder. | npm-manager |
| `graph-execution manager` removes a `NODE_ENV=production` that the CLI itself defaulted, before it loads the manager. | Terminals inherit the manager's environment, and `npm install` in a terminal would skip devDependencies. | npm-manager |
| The manager's server dependencies (`fastify`, `@fastify/cookie`, `@fastify/static`, `@fastify/websocket`, `node-pty`) are `dependencies` of `graph-execution`. The web UI's dependencies are not: Vite bundles them. A test (`bundle-imports.test.ts`) checks that the server imports nothing else. | The server files are plain compiled TypeScript that import these at runtime. | npm-manager |
| `node-pty` is a hard dependency. | The user chose it over an optional dependency. node-pty 1.1.0 ships prebuilds for `darwin-arm64`, `darwin-x64`, `win32-arm64` and `win32-x64` only, so on Linux `npm install graph-execution` needs Python 3, make and a C++ compiler. The READMEs say so. | npm-manager |
| No `postinstall` in the published package. The macOS `spawn-helper` chmod also runs when the manager starts (`pty-helper.ts`). | Install scripts in a published package are often disabled and are a supply-chain concern. | npm-manager |
| The command is `graph-execution manager`, with `--port`, `--host`, `--data-dir`, `--workspaces-dir` and `--no-open`. Each flag overrides the matching `GM_*` variable; everything else is still set through `GM_*`. | The user chose the name. These are the settings a local user changes, and `loadConfig` stays the one source of truth. | npm-manager |
| The engine loads the manager through a computed `import()` of `dist/manager/server/main.js`, which exports `startManager(env)`. | No other command loads fastify or node-pty, and the engine's source imports no manager code. | npm-manager |
| Without `GM_PASSWORD`, the password is read from `<dataDir>/password`; when the file is missing or empty, 24 random bytes (base64url) are generated and saved there with mode `0600`, through a temp file and a rename. `GM_PASSWORD` wins and is never written to the file. This applies to every start, also `npm start` and Docker. | The user chose "generate and save one". One rule everywhere is simpler than a rule per entry point. | npm-manager |
| At startup the manager prints `graph-manager listening on <url>`, then `Password: <password> (saved in <file>)` or `Password: from GM_PASSWORD`. | A local user needs the password to log in. A password set by the operator is not echoed into logs. | npm-manager |
| The compose file still requires `GM_PASSWORD`. | A server deployment should set its own. | npm-manager |
| `graph-execution manager` opens the browser once the server listens, unless `--no-open`, `GRAPH_EXECUTION_NO_OPEN=1`, an SSH session (`SSH_CONNECTION` or `SSH_TTY`) or no TTY. | A start in a script or over SSH must not try to open a browser. | npm-manager |
| Without `dist/manager/server/main.js`, `graph-execution manager` exits 2 with `error: graph-manager is not part of this build: run npm run build at the repository root`. A port in use exits 1 with `port <n> is already in use: pass --port or set GM_PORT`. | Clear messages instead of a stack trace. | npm-manager |
| The root `npm run build` builds the engine, then the manager, then bundles. The root `typecheck` runs it first, and the engine's `prepublishOnly` ends with it. | The manager's build needs the engine's `dist` for types, so the order is fixed, and a published tarball always contains `dist/manager`. | npm-manager |
| The Docker image is built with the root build and starts `node /app/packages/graph-execution/dist/cli.js manager --no-open`. | One code path for both ways of running. | npm-manager |
| The manager's version (sandbox image tags, the tools version) is read from `dist/manager/package.json` when bundled; the bundle step writes the engine's version there. | The app's own `package.json` is not in the bundle. In the published package the manager's version is the package's version. | npm-manager |
| On Windows the shims are `.cmd` files in `<dataDir>\bin`: `graph-execution.cmd` and `graph-manager-mcp.cmd`. Claude Code, Codex and OpenCode are given `graph-manager-mcp.cmd` as the MCP command there. | PowerShell and cmd find `.cmd` files on `PATH`; an agent spawns the MCP server without a shell, so the name must carry the extension. | npm-manager |
| Qwen Code's committed `.qwen/settings.json` keeps the bare `graph-manager-mcp` on every platform. | The file is committed and shared between machines: a `.cmd` name would break it on Linux and macOS. | npm-manager |
| A path containing `%`, `"` or a line break gets no `.cmd` shim (the function returns false). | `cmd.exe` expands `%`, and `"` ends the quoting: the file would be broken. | npm-manager |
| The Docker endpoint is `GM_DOCKER_SOCKET`; else `DOCKER_HOST` when it is `unix://…` or `npipe://…`; else `//./pipe/docker_engine` on Windows; else the first existing of `/var/run/docker.sock`, `~/.docker/run/docker.sock`, `~/.docker/desktop/docker.sock`, and `/var/run/docker.sock` when none exists (`defaultDockerSocket`). | Docker Desktop for macOS does not always create `/var/run/docker.sock`; Windows uses a named pipe, which `node:http`'s `socketPath` accepts. | npm-manager |
| `tcp://` and `ssh://` values of `DOCKER_HOST` are ignored. | A remote daemon can't see the workspace folder. | npm-manager |
| The "not reachable" reason names the endpoint, and on macOS and Windows ends with `; is Docker Desktop running?`. | The user sees what was tried and the likely cause. | npm-manager |
| When Docker's `/info` reports an `OSType` other than `linux`, sandboxes are off with `Docker is running Windows containers: switch Docker Desktop to Linux containers`. A failing `/info` is ignored. | The sandbox images are Linux images. | npm-manager |
| On Linux and macOS a sandbox mounts the workspace at its own absolute path, as before. | It works: Docker Desktop for macOS shares `/Users`, and the run page is reached through a published port. This supersedes the "not supported on macOS outside Docker" entry of the sandboxes page's README section. | npm-manager |
| On Windows a sandbox mounts the workspace at `/workspaces/<rel>`. Paths handed to the container (working directory, ready file, reviewers file, the tasks folder, `--spec`, `--reviewers`) are translated to that form, and `tasksDir` and `specPath` read back from a sandboxed run's `state.json` are translated back (`sandbox-paths.ts`, `runDetail` in `runs.ts`). | A Windows path can't be a mount target in a Linux container. Mapping at the manager's edge keeps the engine unchanged. | npm-manager |
| On Windows the container runs as `1000:1000`, with `safe.directory=*`, `core.filemode=false` and the host's `core.autocrlf` passed as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`. | `stat` on Windows reports uid 0, and provider CLIs refuse to run unattended as root. Docker Desktop shows mounted Windows files as owned by another user and as executable, and the container can't see the host's git config. | npm-manager |
| The engine CLI keeps refusing `--sandbox` outside a graph-manager terminal. | Unchanged: only the manager talks to Docker. | npm-manager |
| macOS and Windows behaviour is covered by unit tests with an injected platform, by the fake Docker daemon (`--os-type`) and by CI on macOS and Windows. | The run happened on Linux. The README's platform table says which combinations were exercised only by tests. | npm-manager |

## Known follow-ups

- Sandboxes on macOS and Windows have not been run against a real Docker Desktop.
- `node-pty` is a hard dependency, so installing the engine needs build tools on Linux, also for users who never start the manager.
- There is no publish workflow in CI. Publishing runs `prepublishOnly` by hand from a full checkout of the monorepo.
- `tcp://` and `ssh://` Docker hosts are ignored, without a message that says so. Podman and Windows containers are not supported.
- Windows sandboxes: the run's `state.json` and git worktree records hold `/workspaces/<rel>/…` paths, so the run page shows container paths.
- Windows sandboxes: a `git worktree prune` on the host (also one from a non-sandboxed run in the same workspace) drops the worktree records of a paused sandboxed run.
- Windows terminals: after Ctrl+C in a `.cmd` shim, `cmd.exe` asks `Terminate batch job (Y/N)?`. An install or data path with non-ASCII characters may not work in a `.cmd` file.
- Agent tools on Windows are not verified against any real agent CLI. Claude Code, Codex and OpenCode are given `graph-manager-mcp.cmd`; whether each of them starts a `.cmd` MCP command is unchecked (Node's `child_process.spawn` refuses a `.cmd` file without `shell: true` since 20.12 / 18.20.2). Qwen Code keeps the bare `graph-manager-mcp` in `.qwen/settings.json`, also unchecked there.
- `graph-execution.config.json` runs its setup as `npm ci --include=dev`: the root `typecheck` now builds the manager, whose vite is a devDependency that a plain `npm ci` skips under the `NODE_ENV=production` the engine defaults. Not part of the spec; a deliberate choice for this repository's own runs.
- macOS sandboxes: a provider login is copied from files under the home folder (`LOGIN_FILES`). Where a CLI keeps its login in the macOS Keychain, a sandboxed run needs the provider's API key or token variable (`LOGIN_KEYS`). Which CLIs do so was not checked.
- The mode `600` of the password file means nothing on Windows: the file is protected only by the permissions of the data folder.
- Differences from the spec, documented as the code behaves:
  - A `GM_PASSWORD` that is empty or only whitespace counts as unset (the spec says `GM_PASSWORD` always wins).
  - The `.cmd` shims also contain `setlocal` (when they set `GM_ENGINE_BIN`) and end with `exit /b %ERRORLEVEL%`, and a line break in a path is refused like `%` and `"`.
  - The bundle step exits 1 with `apps/graph-manager/dist is missing: build graph-manager first` also when only `web/index.html` is missing.

## Code references

- `packages/graph-execution/scripts/bundle-manager.mjs`, `packages/graph-execution/package.json` (`bundle:manager`, `prepublishOnly`, `dependencies`), the root `package.json` (`build`, `typecheck`): the bundle and the build order.
- `packages/graph-execution/src/cli.ts` (the `manager` subcommand), `packages/graph-execution/src/manager/start.ts` (`applyManagerEnv`, `shouldOpen`, `runManager`), with `start.test.ts`, `bundle.test.ts` and `manager.e2e.test.ts`.
- `apps/graph-manager/src/server/main.ts` (`startManager`, the two startup lines, the port message), `apps/graph-manager/src/server/password.ts` (`resolvePassword`), `apps/graph-manager/src/server/pty-helper.ts` (`fixSpawnHelper`), `apps/graph-manager/src/server/version.ts`.
- `apps/graph-manager/Dockerfile` (the `CMD`), `apps/graph-manager/docker-compose.yml`, `apps/graph-manager/src/server/dockerfile.test.ts`.
- `apps/graph-manager/src/server/terminals.ts` (`writeGraphExecutionShim`, `writeMcpShim`, the `.cmd` content), `apps/graph-manager/src/server/agents.ts` (`mcpCommand`, `QWEN_ENTRY`).
- `apps/graph-manager/src/server/config.ts` (`defaultDockerSocket`, `loadConfig`), `apps/graph-manager/src/server/docker.ts` (`info`, `inspectSelf`), `apps/graph-manager/src/server/sandbox.ts` (the reasons, the Windows owner and git settings).
- `apps/graph-manager/src/server/sandbox-paths.ts` (`containerRoot`, `toContainer`, `toHost`, `toContainerArgs`), `apps/graph-manager/src/server/sandbox-run.ts` (`workspaceMount`, `windowsGitConfig`, `LOGIN_FILES`, `LOGIN_KEYS`), `apps/graph-manager/src/server/runs.ts` (`toHost` on a sandboxed run's `tasksDir` and `specPath`).
- `apps/graph-manager/src/server/sandbox-tools.ts` (`MANAGER_ONLY_DEPENDENCIES`, `copyEngine`), `apps/graph-manager/src/server/bundle-imports.test.ts`.
- `apps/graph-manager/scripts/fake-docker.mjs` (`--os-type`).

## Related

- [graph-manager: web service and Docker image](graph-manager.md)
- [Sandboxed runs in their own Docker container (KAN-88)](sandboxes.md)
- [Agent tools](agent-tools.md)
- [Windows in CI](windows-ci.md)
- [Project wiki index](../index.md)

## Last updated

2026-11-11
