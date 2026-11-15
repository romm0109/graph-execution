// The application menu as a pure template, so its labels can be tested without Electron (type imports are erased).
import type { MenuItemConstructorOptions } from "electron";

export type Mode = "local" | "remote";

export interface MenuHandlers {
  /** Opens the picker (Switch to local / Switch to server…). */
  switchMode: () => void;
  /** Opens the picker with the URL field filled. */
  changeServer: () => void;
  openServerLog: () => void;
  openWorkspaces: () => void;
  openGitHub: () => void;
}

export function menuTemplate(mode: Mode, platform: NodeJS.Platform, h: MenuHandlers): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const file: MenuItemConstructorOptions[] = [
    { label: mode === "remote" ? "Switch to local" : "Switch to server…", click: () => h.switchMode() },
  ];
  if (mode === "remote") file.push({ label: "Change server URL…", click: () => h.changeServer() });
  file.push({ type: "separator" });
  if (mode === "local") file.push({ label: "Open server log", click: () => h.openServerLog() });
  file.push({ label: "Open workspaces folder", click: () => h.openWorkspaces() });
  if (!mac) file.push({ type: "separator" }, { role: "quit" });

  return [
    ...(mac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    { label: "File", submenu: file },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }] },
    { role: "windowMenu" },
    { role: "help", label: "Help", submenu: [{ label: "graph-manager on GitHub", click: () => h.openGitHub() }] },
  ];
}
