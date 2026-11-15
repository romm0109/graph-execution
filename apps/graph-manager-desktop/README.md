# graph-manager-desktop

## What it is

graph-manager as a desktop app for macOS and Windows, built with Electron. It either runs graph-manager on this computer (local mode) or connects to a graph-manager server somewhere else (remote mode). Local mode needs no Node.js install: the app runs the bundled server with its own Electron binary. It's the same graph-manager as in [`apps/graph-manager`](../graph-manager/README.md), with the same UI, workspaces and runs.

## Install

1. Download the installer from the artifacts of a run of the `desktop` workflow on GitHub Actions (`.github/workflows/desktop.yml`): `graph-manager-macos-latest` holds the `.dmg` files (arm64 and x64), and `graph-manager-windows-latest` holds the `Setup .exe` (x64).
2. Install it. The builds are unsigned, so the first launch needs one extra step:
   - **macOS:** right-click the app in Applications and choose **Open**, then **Open** again. Or clear the quarantine flag:

     ```bash
     xattr -dr com.apple.quarantine /Applications/graph-manager.app
     ```

   - **Windows:** when SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**. The installer installs per user and doesn't need admin rights.

Requirements:

- `git` on the PATH.
- An agent CLI on the PATH: `claude`, `codex`, `opencode` or `qwen`.
- Docker only for [sandboxed runs](../graph-manager/README.md#sandboxed-runs).

## Modes

On first start the app asks how to run it. The choice is saved in `desktop.json` and used on the next start.

- **Run on this computer** (local mode):
  - The app starts graph-manager in a child process. It listens on `127.0.0.1` only, on port 7420 when it is free, else on a free port.
  - The server generates its password (`~/.graph-manager/password`). The app reads it and logs you in, so you never see the login page.
  - Workspaces are in `~/graph-manager-workspaces`.
  - Quitting the app (or closing its window) stops the server.
- **Connect to a server** (remote mode):
  - Enter the server's URL. `gm.example.com` means `https://gm.example.com`. The app checks that `<url>/api/auth/info` answers, then shows that server's own login page. Log in with the server's password.
  - Plain `http://` to a host other than this computer asks before connecting: the password would go over the network unencrypted.
  - The login is kept after the app restarts.
  - To run a server, see the [graph-manager README](../graph-manager/README.md#quick-start).

The **File** menu switches modes:

| Item | Shown in | What it does |
| --- | --- | --- |
| **Switch to server…** | local mode | Opens the picker. Choosing a server stops the local server. |
| **Switch to local** | remote mode | Opens the picker. |
| **Change server URL…** | remote mode | Opens the picker with the current URL filled in. |
| **Open server log** | local mode | Opens `logs/server.log`. |
| **Open workspaces folder** | both | Opens `~/graph-manager-workspaces`. |

After you log out, the login page also has a **Switch server** button. It opens the picker with the server URL filled in, so you can connect to another server or run on this computer. The button is shown only in the app, not in a browser.

**Help → graph-manager on GitHub** opens the repository. **View** has **Reload** and **Toggle Developer Tools**.

When local mode finds a graph-manager already running on the same data folder (for example `npm start` in a terminal), it shows "graph-manager is already running on this computer (port N)." with **Connect to it**, which switches to remote mode at `http://127.0.0.1:N`. If that server stops later, the error page offers **Run on this computer**.

Links: a link on graph-manager's own server that opens a new tab (the run page "open ↗") opens in a new app window. Every other `http(s)` or `mailto:` link, such as a PR on GitHub, opens in your default browser.

## Where things live

| What | Where |
| --- | --- |
| graph-manager's data: `password`, `server.lock`, tokens, settings (`graph-manager.json`) | `~/.graph-manager` (`%USERPROFILE%\.graph-manager` on Windows) |
| Workspaces | `~/graph-manager-workspaces` |
| The app's settings: `desktop.json` (`mode`, `remoteUrl`, window bounds) | the userData folder |
| Logs: `logs/server.log` (the local server's output) and `logs/main.log` (the app) | the userData folder |

The userData folder is `~/Library/Application Support/graph-manager` on macOS and `%APPDATA%\graph-manager` on Windows (named after `productName` in `electron-builder.yml`).

Local mode uses the same data and workspaces folders as `npm start` and `graph-execution manager`, so they all see the same workspaces, runs and settings. Only one server runs on a data folder at a time: the second one finds `server.lock` and stops. `GM_DATA_DIR` and `GM_WORKSPACES_DIR` in the app's environment change the two folders, as they do for the server.

## Develop

From the repository root:

```bash
npm ci
npm run build -w graph-execution && npm run build -w graph-manager && npm start -w graph-manager-desktop
```

`npm start -w graph-manager-desktop` compiles the app (`tsc` and `scripts/copy-pages.mjs`) and starts Electron. In dev, the server and the graph-execution CLI come from the workspace packages, so rebuild them after changing them.

Tests and typecheck:

```bash
npm test -w graph-manager-desktop
npm run typecheck -w graph-manager-desktop
```

## Package and smoke-test

```bash
npm run dist -w graph-manager-desktop    # unsigned installers in apps/graph-manager-desktop/release/
npm run smoke -w graph-manager-desktop   # starts the packaged app and checks it
```

- `npm run dist` builds only the current OS's installer: a `.dmg` (arm64 and x64) on macOS, an NSIS `Setup .exe` (x64) on Windows.
  - `scripts/stage.mjs` builds the packages, `npm pack`s graph-execution and graph-manager, and installs the tarballs for production into `stage/`. `scripts/dist.mjs` then runs electron-builder in `stage/` with `electron-builder.yml`. `electronVersion` is taken from the `electron` devDependency.
  - `node-pty`, `graph-manager` and `graph-execution` are unpacked from the asar archive (`app.asar.unpacked`). node-pty's N-API prebuilds load in Electron without a rebuild (`npmRebuild: false`). On macOS, `scripts/after-pack.cjs` makes node-pty's `spawn-helper` executable.
  - To check the layout on Linux: `npm run dist -w graph-manager-desktop -- --linux dir`.
  - `npm run check-layout -w graph-manager-desktop [-- <release subfolder>...]` checks an unpacked app without running it: the bundled server, CLI and node-pty are real files under `app.asar.unpacked`, and on macOS `spawn-helper` is executable. A macOS `.app` can be laid out on Linux for this (`npm run dist -w graph-manager-desktop -- --mac dir --arm64 --x64`, then `-- mac mac-arm64`). CI does both on ubuntu; running the mac app is left to the `macos-latest` job.
- `npm run smoke` starts the packaged app with `GM_DESKTOP_SMOKE=1`, a temp `--user-data-dir`, and temp `GM_DATA_DIR` and `GM_WORKSPACES_DIR`. It checks that:
  - the bundled server answers `/healthz`,
  - the session cookie the app set works,
  - a terminal echoes over its WebSocket (node-pty loads inside Electron),
  - quitting removes `server.lock` and stops the server.

  On Linux, run it under `xvfb-run`. Smoke mode always uses local mode and never saves `mode`. It writes `<userData>/smoke.json` (port, server pid and session cookie) once the UI has loaded, and quits when `<userData>/smoke-quit` appears.
- `.github/workflows/desktop.yml` runs both on `macos-latest` and `windows-latest`, then uploads the installers.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "graph-manager did not start" | Click **Open log** on the error page, or use **File → Open server log**. The page shows the last lines of `logs/server.log`. |
| "The local server stopped." | The server exited while the app ran. Check the log, then click **Restart server**. |
| "graph-manager is already running on this computer (port N)." | Another graph-manager uses `~/.graph-manager`. Click **Connect to it**, or stop the other one and click **Retry**. |
| `git` or `claude` not found in a terminal on macOS | The app reads your login shell's `PATH` at startup (`$SHELL -ilc`). Make sure the tools are on the PATH in your shell profile. If `logs/main.log` has "shell PATH failed", the app used the inherited PATH plus `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`. |
| Remote: "Can't reach <url>." or "No graph-manager server answered at <url>." | Check that `<url>/api/auth/info` answers in a browser. Click **Retry**, or **Change server**. |

## Manual Windows checklist (before a release)

CI builds and smoke-tests on `windows-latest`. Before a release, also check these by hand on a Windows machine:

- [ ] The installer runs from a path with spaces and installs per user without admin rights.
- [ ] First launch shows the picker. Local mode opens the UI with no password prompt.
- [ ] A terminal opens PowerShell, `graph-execution --version` works in it, and so does `git --version`.
- [ ] A run with `--provider fake` on a small workspace finishes and its run page opens in a new app window.
- [ ] A PR link opens in the default browser.
- [ ] Quitting the app leaves no `graph-manager.exe` in Task Manager, and no `%USERPROFILE%\.graph-manager\server.lock`.
- [ ] With `npm start` already running in a terminal, local mode shows "graph-manager is already running". **Connect
      to it** opens it. Stopping `npm start` (Ctrl+C) then shows the error page with **Run on this computer**, which
      starts the app's own server.
- [ ] With another program on port 7420 (for example `python -m http.server 7420`), local mode starts on another port.
- [ ] Remote mode against a server over HTTPS logs in, and the login survives an app restart.
- [ ] After **Log out**, the login page shows **Switch server**, which opens the picker with the URL filled in. The same
      server opened in a browser has no **Switch server**.
- [ ] A user folder with non-ASCII characters works (for example `C:\Users\Ünal`).
