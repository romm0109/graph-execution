# graph-manager desktop app for macOS and Windows (KAN-86)

## Summary

`apps/graph-manager-desktop` is an Electron app that wraps graph-manager. On first start a picker asks for a mode, and the choice is saved in `desktop.json` in the app's userData folder. In local mode the main process forks graph-manager's server with Electron's own binary (`ELECTRON_RUN_AS_NODE=1`) on `127.0.0.1`, reads the generated password from `~/.graph-manager/password`, logs in itself and puts the `gm_session` cookie into the `persist:local` session, so the user never sees a login page. In remote mode the window loads a graph-manager server's own UI and login page in the `persist:remote` session. The server gained a `server.lock` so the app, `npm start` and `graph-execution manager` never run two servers on one data folder. Builds are unsigned `.dmg` and NSIS `.exe` installers, built and smoke-tested by `.github/workflows/desktop.yml`. Spec: `docs/prd/done/desktop-app.md`. Tasks: `.agents/tasks/desktop-app/`. User docs: `apps/graph-manager-desktop/README.md` and "Desktop app" in `apps/graph-manager/README.md`.

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| Local mode runs the bundled server in a child process forked with Electron's own binary and `ELECTRON_RUN_AS_NODE=1`. | The user needs no Node install. A server crash stays out of the window's process, and graph-manager's `main.ts` runs unchanged as the entry point. | KAN-86 |
| Remote mode loads the remote server's own UI in the window. No KAN-84 device tokens, no CORS changes. | The page and its API share one origin, so the `sameSite: strict` cookie and the same-origin checks in `auth.ts` keep working. KAN-84 is only needed for the mobile app. | KAN-86 |
| Local mode shares `~/.graph-manager` and `~/graph-manager-workspaces` with `npm start`, and logs in from the main process with `~/.graph-manager/password`. The app doesn't pass `GM_PASSWORD` (`serverEnv` deletes it). | The app and a terminal graph-manager see the same workspaces, runs and settings. One password per data folder, the one `npm start` prints, and no second copy in `desktop.json`. | KAN-86 |
| The local server binds `127.0.0.1` and tries port 7420 first. With `GM_PORT_FALLBACK=1` it takes a free port when 7420 is in use. | Nothing outside the machine can reach it. The URL stays the same on most launches, and another program on 7420 doesn't stop the app. `npm start` without the variable still fails on a taken port. | KAN-86 |
| `startManager` refuses to start when `<dataDir>/server.lock` (pid + port) names a live pid **and** that port answers `/api/auth/info`; otherwise the lock is stale and is overwritten. The server exits with code 3 and sends `{ type: "already-running" }` over IPC. | Two servers on one data folder overwrite each other's state. Checking the process and the port means a crash or a kill never leaves a lock that blocks the next start. It is in the server, so it covers the app, `npm start` and `graph-execution manager`. | KAN-86 |
| From the lock check until `server.lock` is written, `startManager` holds `<dataDir>/server.lock.starting`, created exclusively with its pid. A second start waits for it (a dead pid's file is replaced at once, a live one's after 30 s), then finds the first server. | Without it, two servers launched in the same second both pass the check, and with `GM_PORT_FALLBACK` the second listens on another port on the same data folder. | KAN-86 |
| The launch script of a handed-off run (`--web`, through launchctl or schtasks) keeps `ELECTRON_RUN_AS_NODE` when the engine has it. | Under the app, `process.execPath` is the Electron binary; without the variable the handed-off run started the desktop app instead of graph-execution. The run's own children still drop it (`RUN_ENV_UNSET`). The smoke test starts a fake run to prove it. | KAN-86 |
| When a server already runs, the app shows "graph-manager is already running on this computer (port N)." with **Connect to it** (remote mode at `http://127.0.0.1:N`). A remote server on `127.0.0.1`/`localhost`/`[::1]` is polled every 5 s, and its error page adds **Run on this computer**. | The user keeps working with the running server. When that terminal server stops, the port is free, and one click starts the app's own. | KAN-86 |
| The app stops the server with the IPC message `{ type: "shutdown" }`, not `SIGTERM`. After 5 s it force-kills (`taskkill /T /F` on Windows, `SIGKILL` elsewhere). | On Windows `child.kill()` ends the process without running its signal handler, so `server.lock` and the terminals would be left behind. | KAN-86 |
| Separate cookie sessions: `persist:local` and `persist:remote`. | Switching modes never mixes cookies, and each mode keeps its login across restarts. | KAN-86 |
| Link rules (`classifyLink`): a same-origin `window.open` opens a new app window in the same partition, same-origin navigation stays, other `http(s)` and `mailto:` links open in the default browser, everything else is denied. | The run page ("open ↗") needs the session cookie. GitHub and PR links belong in the user's browser. Other schemes have no use in the app. | KAN-86 |
| Packaging stages a clean production install from `npm pack` tarballs of graph-execution and graph-manager (`scripts/stage.mjs`), then runs electron-builder in `stage/`. | npm workspaces hoist and symlink packages, which electron-builder doesn't handle well. A staged folder is predictable on both OSes. | KAN-86 |
| `npmRebuild: false`; `node-pty`, `graph-manager` and `graph-execution` are in `asarUnpack`; `scripts/after-pack.cjs` chmods node-pty's macOS `spawn-helper` to 0755. | node-pty 1.1 ships N-API prebuilds that Electron loads as they are. Its `.node` files and `spawn-helper` must be real files on disk, and `spawn-helper` must be executable. The CI smoke test proves a terminal works. | KAN-86 |
| On macOS the app replaces `PATH` with the login shell's (`$SHELL -ilc`, 5 s timeout). On failure it logs "shell PATH failed" and adds `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`. | An app started from the Finder or the Dock gets launchd's minimal PATH, so `git`, `claude`, `codex` and `docker` would not be found. | KAN-86 |
| The server deletes `ELECTRON_RUN_AS_NODE` from its own env at start, terminals strip it, and Node children use `nodeCommand()`: `process.execPath` plus `ELECTRON_RUN_AS_NODE=1` only when `process.versions.electron` is set. | The variable is needed to start Electron's binary as Node, but it would break Electron apps the user starts from a terminal. Under Electron there is no `node` on the PATH to fall back on. | KAN-86 |
| The terminal shim runs the absolute runtime path. On Windows it is `graph-execution.cmd`, and it isn't written for a path with `%`, `"` or a line break. | `graph-execution` must work in a terminal without Node installed. `cmd.exe` expands `%` and a `"` ends the quoting. | KAN-86 |
| Unsigned builds, no auto-update. | Agreed for v1. Signing needs an Apple Developer account and a Windows certificate. | KAN-86 |

## Known follow-ups

- Code signing and notarization for macOS, and signing for Windows, so the first launch needs no right-click → Open or SmartScreen step.
- Auto-update.
- KAN-84 device tokens, if the app should ever ship its own bundled UI against a remote server instead of loading the server's UI.
- Linux packages (`npm run dist -- --linux dir` only checks the layout today).
- Several saved servers in remote mode; today `desktop.json` keeps one `remoteUrl`.
- The manual Windows checklist in `apps/graph-manager-desktop/README.md` has to be run on a Windows machine before each release. CI covers only the build and the smoke test.

## Code references

- `apps/graph-manager-desktop/src/main.ts`: the main process: `startLocal`, `startRemote`, `showPicker`, `showError`, `guardLinks`, the single-instance lock, smoke mode (`GM_DESKTOP_SMOKE`), and the `gm:*` IPC handlers that only the app's `file:` pages may call.
- `apps/graph-manager-desktop/src/localServer.ts:125`: `startLocalServer` (fork, `listening` / `already-running` IPC, `stop()` with `{ type: "shutdown" }`).
- `apps/graph-manager-desktop/src/localServer.ts:79`: `loginCookie`.
- `apps/graph-manager-desktop/src/localServer.ts:43`: `serverEnv` (deletes `GM_PASSWORD` and `GM_PORT`, sets `GM_HOST=127.0.0.1`, `GM_PORT_FALLBACK=1`, `GM_GRAPH_EXECUTION_BIN`).
- `apps/graph-manager-desktop/src/localServer.ts:29`: `AlreadyRunning`, the app's side of the server's `AlreadyRunningError`.
- `apps/graph-manager-desktop/src/links.ts:4`: `classifyLink`.
- `apps/graph-manager-desktop/src/shellEnv.ts:21`: `resolvePath`.
- `apps/graph-manager-desktop/src/paths.ts:15`: `bundledPaths` (`app.asar.unpacked/node_modules` when packaged, else the workspace packages).
- `apps/graph-manager-desktop/src/remote.ts:8`: `normalizeServerUrl`; `remote.ts:26`: `isLoopback`; `remote.ts:35`: `probeServer`.
- `apps/graph-manager-desktop/src/menu.ts:16`: `menuTemplate`.
- `apps/graph-manager-desktop/src/settings.ts`: `readSettings` / `writeSettings` for `desktop.json`.
- `apps/graph-manager-desktop/src/preload.cts`, `src/pages/picker.html`, `src/pages/error.html`: the app's own pages.
- `apps/graph-manager-desktop/scripts/stage.mjs`, `scripts/dist.mjs`, `scripts/after-pack.cjs`, `scripts/smoke.mjs`, `electron-builder.yml`: packaging and the smoke test.
- `apps/graph-manager/src/server/node.ts:10`: `nodeCommand`.
- `apps/graph-manager/src/server/terminals.ts:192`: `writeGraphExecutionShim` (and `cmdShim` for Windows).
- `apps/graph-manager/src/server/lock.ts:85`: `findRunning`; `lock.ts:94`: `writeLock`.
- `apps/graph-manager/src/server/config.ts:39`: `AlreadyRunningError`.
- `apps/graph-manager/src/server/main.ts:32`: `startManager` (the lock check and `writeLock`); the `listening` message, the `shutdown` handler and the `ELECTRON_RUN_AS_NODE` delete are further down in the same file.
- `.github/workflows/desktop.yml`: build and smoke test on `macos-latest` and `windows-latest`.
