// The desktop app's main process. Local mode: forks graph-manager's server with Electron's own binary, logs in from
// here, puts the session cookie into the window's session and loads the UI, so the user never sees a login page.
// Remote mode: loads a graph-manager server's own UI (and its login page) in the persist:remote session. With no saved
// mode, the picker (dist/pages/picker.html) asks which one.
import { createWriteStream, existsSync, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, session, shell, type BrowserWindowConstructorOptions } from "electron";
import { classifyLink } from "./links.js";
import {
  AlreadyRunning,
  localDataDir,
  localWorkspacesDir,
  loginCookie,
  logTail,
  readLocalPassword,
  startLocalServer,
  type RunningServer,
} from "./localServer.js";
import { menuTemplate, type Mode } from "./menu.js";
import { bundledPaths } from "./paths.js";
import { isLoopback, normalizeServerUrl, probeServer } from "./remote.js";
import { readSettings, writeSettings } from "./settings.js";
import { resolvePath } from "./shellEnv.js";

type Action = "retry" | "restart" | "log" | "change" | "connect" | "local";

const distDir = path.dirname(fileURLToPath(import.meta.url));
const preloadFile = path.join(distDir, "preload.cjs");
const errorPage = path.join(distDir, "pages", "error.html");
const pickerPage = path.join(distDir, "pages", "picker.html");
const GITHUB_URL = "https://github.com/romm0109/graph-execution";
/** How often a remote window on this machine checks that its server still answers. */
const LOOPBACK_POLL_MS = 5000;
const SESSION_DAYS = 30;

/** The secure defaults of every window that shows graph-manager's pages. */
const appPrefs = (partition: string): BrowserWindowConstructorOptions["webPreferences"] => ({
  partition,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
});

let userData = "";
let serverLog = "";
let mainLog: WriteStream | undefined;
let mainWindow: BrowserWindow | undefined;
/** The origin the windows may navigate within, and the partition their child windows use. */
let appOrigin = "null";
let appPartition = "persist:local";
let server: RunningServer | undefined;
/** Servers this process stopped on purpose: their exit is not a crash. */
const stoppedOnPurpose = new WeakSet<RunningServer>();
let pendingConnect: string | undefined;
let quitting = false;
let busy = false;
/** The mode the menu shows: the saved mode, `local` before one is chosen. */
let menuMode: Mode = "local";
/** Stops the loopback poll of the current remote window. */
let stopRemotePoll: (() => void) | undefined;
/** While true, closing the last window doesn't quit: a mode switch is about to open the next one. */
let switching = false;

/**
 * Smoke mode (GM_DESKTOP_SMOKE=1, used by scripts/smoke.mjs on the packaged app): always local mode, never reads or
 * saves `mode`, writes <userData>/smoke.json once the UI loaded and quits when <userData>/smoke-quit appears.
 */
const SMOKE = process.env.GM_DESKTOP_SMOKE === "1";
const SMOKE_POLL_MS = 500;

/** Writes <userData>/smoke.json. Only in smoke mode, where userData is the smoke test's temp dir. */
function writeSmoke(result: Record<string, unknown>): void {
  if (!SMOKE) return;
  try {
    writeFileSync(path.join(userData, "smoke.json"), JSON.stringify(result));
  } catch (err) {
    log(`writing smoke.json failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --user-data-dir=<dir>: Chromium honours the switch itself, app.getPath("userData") only after setPath.
const userDataArg = process.argv.find((a) => a.startsWith("--user-data-dir="));
if (userDataArg) {
  const dir = userDataArg.slice("--user-data-dir=".length);
  if (dir) app.setPath("userData", path.resolve(dir));
}

function log(msg: string): void {
  if (!mainLog) {
    const dir = path.join(userData || app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    mainLog = createWriteStream(path.join(dir, "main.log"), { flags: "a" });
  }
  mainLog.write(`${new Date().toISOString()} ${msg}\n`);
}

/**
 * Shows a new main window and closes the old one. The window with the preload (the app's own pages) and the windows
 * showing a server are never the same window: the preload must never reach graph-manager's origin.
 */
function replaceWindow(webPreferences: BrowserWindowConstructorOptions["webPreferences"]): BrowserWindow {
  const old = mainWindow;
  const bounds = old && !old.isDestroyed() ? old.getBounds() : readSettings(userData).bounds;
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    ...(bounds ?? {}),
    show: false,
    webPreferences,
  });
  win.once("ready-to-show", () => win.show());
  win.on("close", () => {
    if (mainWindow !== win) return;
    try {
      writeSettings(userData, { ...readSettings(userData), bounds: win.getBounds() });
    } catch (err) {
      log(`saving the window bounds failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  mainWindow = win;
  // The new window exists before the old one closes, so window-all-closed doesn't quit the app.
  if (old && !old.isDestroyed()) old.destroy();
  return win;
}

/** Loads graph-manager at `origin` in a main window with the session `partition`. */
async function showApp(origin: string, partition: string): Promise<void> {
  appOrigin = origin;
  appPartition = partition;
  const win = replaceWindow(appPrefs(partition));
  await win.loadURL(`${origin}/`);
}

/** Shows `error.html` with a title, an optional preformatted detail and the action buttons. */
async function showError(title: string, detail: string, actions: Action[]): Promise<void> {
  stopPolling();
  appOrigin = "null";
  const win = replaceWindow({ preload: preloadFile, contextIsolation: true, sandbox: true, nodeIntegration: false });
  const url = pathToFileURL(errorPage);
  url.search = new URLSearchParams({ title, ...(detail ? { detail } : {}), actions: actions.join(",") }).toString();
  await win.loadURL(url.href);
}

function stopPolling(): void {
  stopRemotePoll?.();
  stopRemotePoll = undefined;
}

/** Rebuilds the application menu for `mode`. */
function setMenu(mode: Mode): void {
  menuMode = mode;
  const template = menuTemplate(mode, process.platform, {
    switchMode: () => void showPicker(),
    changeServer: () => void showPicker(readSettings(userData).remoteUrl),
    openServerLog: () => void shell.openPath(serverLog),
    openWorkspaces: () => {
      const dir = localWorkspacesDir(process.env, os.homedir());
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        log(`creating ${dir} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      void shell.openPath(dir);
    },
    openGitHub: () => void shell.openExternal(GITHUB_URL),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Shows the mode picker; `url` fills its server field. */
async function showPicker(url?: string): Promise<void> {
  stopPolling();
  appOrigin = "null";
  const win = replaceWindow({ preload: preloadFile, contextIsolation: true, sandbox: true, nodeIntegration: false });
  const page = pathToFileURL(pickerPage);
  if (url) page.search = new URLSearchParams({ url }).toString();
  await win.loadURL(page.href);
}

/** Stops the local server on purpose (leaving local mode). */
async function stopLocal(): Promise<void> {
  const s = server;
  if (!s) return;
  stoppedOnPurpose.add(s);
  await s.stop();
  if (server === s) server = undefined;
}

/** Closes a main window that shows a server, so nothing of remote mode stays open while local mode starts. */
function closeRemoteWindow(): void {
  stopPolling();
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.webContents.getURL().startsWith("file:")) return;
  try {
    writeSettings(userData, { ...readSettings(userData), bounds: win.getBounds() });
  } catch (err) {
    log(`saving the window bounds failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  switching = true;
  mainWindow = undefined;
  win.destroy();
}

/** The error page for a remote server that doesn't answer. */
async function showRemoteError(remoteUrl: string, detail: string): Promise<void> {
  log(`remote server ${remoteUrl} did not answer: ${detail}`);
  await showError(`Can't reach ${remoteUrl}.`, detail, isLoopback(remoteUrl) ? ["retry", "change", "local"] : ["retry", "change"]);
}

/** Saves remote mode for `remoteUrl` (an origin) and shows that server; stops the local server first. */
async function startRemote(remoteUrl: string): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await stopLocal();
    stopPolling();
    writeSettings(userData, { ...readSettings(userData), mode: "remote", remoteUrl });
    setMenu("remote");
    const probe = await probeServer(remoteUrl);
    if (!probe.ok) {
      await showRemoteError(remoteUrl, probe.error);
      return;
    }
    appOrigin = remoteUrl;
    appPartition = "persist:remote";
    const win = replaceWindow(appPrefs("persist:remote"));
    const host = new URL(remoteUrl).host;
    win.on("page-title-updated", (event, title) => {
      event.preventDefault();
      win.setTitle(title ? `${title} — ${host}` : host);
    });
    let failed = false;
    const fail = (detail: string): void => {
      if (failed || mainWindow !== win) return;
      failed = true;
      void showRemoteError(remoteUrl, detail);
    };
    win.webContents.on("did-fail-load", (_event, code, desc, _url, isMainFrame) => {
      // -3 is ERR_ABORTED: a navigation replaced by another one, not a failure.
      if (!isMainFrame || code === -3) return;
      fail(`${desc} (${code})`);
    });
    if (isLoopback(remoteUrl)) {
      // A terminal graph-manager the user connected to can stop at any time; notice it without a reload.
      let checking = false;
      const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void probeServer(remoteUrl, fetch, 3000).then((r) => {
          checking = false;
          if (!r.ok && stopRemotePoll === stop) fail(r.error);
        });
      }, LOOPBACK_POLL_MS);
      const stop = (): void => clearInterval(timer);
      stopRemotePoll = stop;
      win.on("closed", () => {
        if (stopRemotePoll === stop) stopPolling();
        else stop();
      });
    }
    win.loadURL(`${remoteUrl}/`).catch(() => {
      // did-fail-load shows the error page.
    });
  } finally {
    busy = false;
  }
}

/** Starts the bundled server, logs in and shows the UI; shows an error page when any of it fails. */
async function startLocal(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    closeRemoteWindow();
    await stopLocal();
    if (!SMOKE) writeSettings(userData, { ...readSettings(userData), mode: "local" });
    setMenu("local");
    const dataDir = localDataDir(process.env, os.homedir());
    const { serverEntry, graphExecutionCli } = bundledPaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
    let s: RunningServer;
    try {
      s = await startLocalServer({
        serverEntry,
        graphExecutionCli,
        dataDir,
        logFile: serverLog,
        env: process.env,
        execPath: process.execPath,
        electron: true,
      });
    } catch (err) {
      if (err instanceof AlreadyRunning) {
        pendingConnect = `http://127.0.0.1:${err.port}`;
        log(`another graph-manager runs on ${dataDir} (port ${err.port}, pid ${err.pid})`);
        writeSmoke({ ok: false, error: err.message });
        await showError(`graph-manager is already running on this computer (port ${err.port}). Stop it, or connect to it.`, "", [
          "connect",
          "retry",
        ]);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`server start failed: ${message.split("\n")[0]}`);
      writeSmoke({ ok: false, error: message });
      await showError("graph-manager did not start", message, ["retry", "log", "change"]);
      return;
    }
    server = s;
    log(`server started on port ${s.port} (pid ${s.pid})`);
    void s.exited.then((code) => {
      if (server === s) server = undefined;
      if (quitting || stoppedOnPurpose.has(s)) return;
      log(`server exited with code ${code}`);
      void showError("The local server stopped.", logTail(serverLog), ["restart", "log"]);
    });

    let cookie: string;
    try {
      const value = await loginCookie(s.origin, readLocalPassword(dataDir));
      cookie = value;
      await session.fromPartition("persist:local").cookies.set({
        url: `${s.origin}/`,
        name: "gm_session",
        value,
        httpOnly: true,
        sameSite: "strict",
        expirationDate: Date.now() / 1000 + SESSION_DAYS * 24 * 3600,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`login failed: ${message}`);
      writeSmoke({ ok: false, error: message });
      stoppedOnPurpose.add(s);
      await s.stop();
      if (server === s) server = undefined;
      await showError("graph-manager did not start", message, ["retry", "log", "change"]);
      return;
    }
    try {
      await showApp(s.origin, "persist:local");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`loading the UI failed: ${message}`);
      writeSmoke({ ok: false, error: `loading the UI failed: ${message}` });
      return;
    }
    // loadURL resolves on did-finish-load.
    writeSmoke({ ok: true, port: s.port, serverPid: s.pid, cookie });
  } finally {
    busy = false;
    switching = false;
  }
}

/** Keeps every window on the app's origin: other web links open in the browser, other schemes are denied. */
function guardLinks(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    const kind = classifyLink(url, appOrigin, "open");
    if (kind === "new-window") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: { width: 1200, height: 800, webPreferences: appPrefs(appPartition) },
      };
    }
    if (kind === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    const kind = classifyLink(url, appOrigin, "navigate");
    if (kind === "same-window") return;
    event.preventDefault();
    if (kind === "external") void shell.openExternal(url);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("web-contents-created", (_event, contents) => guardLinks(contents));

  /** Only the app's own pages (file:) may ask; never a page of a server. */
  const fromAppPage = (event: Electron.IpcMainInvokeEvent): boolean => !!event.senderFrame?.url.startsWith("file:");

  ipcMain.handle("gm:action", async (event, name: unknown) => {
    if (!fromAppPage(event)) return;
    switch (name) {
      case "retry": {
        const s = readSettings(userData);
        if (s.mode === "remote" && s.remoteUrl) await startRemote(s.remoteUrl);
        else await startLocal();
        return;
      }
      case "restart":
      case "local":
        await startLocal();
        return;
      case "log":
        await shell.openPath(serverLog);
        return;
      case "change":
        await showPicker(readSettings(userData).remoteUrl);
        return;
      case "connect":
        if (pendingConnect) await startRemote(pendingConnect);
        return;
      default:
        return;
    }
  });

  ipcMain.handle("gm:workspacesDir", (event) => {
    if (!fromAppPage(event)) return undefined;
    return localWorkspacesDir(process.env, os.homedir());
  });

  // `probe: false` checks the URL only, so the picker can warn about plain http before it contacts the server.
  ipcMain.handle("gm:checkServer", async (event, url: unknown, wantProbe: unknown) => {
    if (!fromAppPage(event)) return { ok: false, error: "Not allowed." };
    const check = normalizeServerUrl(typeof url === "string" ? url : "");
    if (!check.ok || wantProbe === false) return check;
    const probe = await probeServer(check.origin);
    if (!probe.ok) return probe;
    return check;
  });

  ipcMain.handle("gm:chooseLocal", async (event) => {
    if (!fromAppPage(event)) return;
    await startLocal();
  });

  ipcMain.handle("gm:chooseRemote", async (event, origin: unknown) => {
    if (!fromAppPage(event)) return { ok: false, error: "Not allowed." };
    const check = normalizeServerUrl(typeof origin === "string" ? origin : "");
    if (!check.ok) return check;
    await startRemote(check.origin);
    return { ok: true };
  });

  app.on("before-quit", (event) => {
    quitting = true;
    const s = server;
    if (!s) return;
    event.preventDefault();
    stoppedOnPurpose.add(s);
    void s.stop().finally(() => {
      if (server === s) server = undefined;
      app.quit();
    });
  });

  // Closing the window quits the app (and stops the server) on every platform.
  app.on("window-all-closed", () => {
    if (!switching) app.quit();
  });

  void app.whenReady().then(async () => {
    userData = app.getPath("userData");
    serverLog = path.join(userData, "logs", "server.log");
    if (process.platform === "darwin") {
      process.env.PATH = await resolvePath({ platform: process.platform, env: process.env, home: os.homedir(), log });
    }
    if (SMOKE) {
      const quitFile = path.join(userData, "smoke-quit");
      const timer = setInterval(() => {
        if (!existsSync(quitFile)) return;
        clearInterval(timer);
        log("smoke: smoke-quit found, quitting");
        app.quit();
      }, SMOKE_POLL_MS);
      setMenu("local");
      await startLocal();
      return;
    }
    const s = readSettings(userData);
    if (s.mode === "local") {
      await startLocal();
    } else if (s.mode === "remote" && s.remoteUrl) {
      const check = normalizeServerUrl(s.remoteUrl);
      await startRemote(check.ok ? check.origin : s.remoteUrl);
    } else {
      setMenu(menuMode);
      await showPicker();
    }
  });
}
