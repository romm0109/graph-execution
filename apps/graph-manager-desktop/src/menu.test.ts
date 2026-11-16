import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { menuTemplate, type MenuHandlers } from "./menu.js";

const handlers = (): MenuHandlers => ({
  switchMode: vi.fn(),
  changeServer: vi.fn(),
  openServerLog: vi.fn(),
  openWorkspaces: vi.fn(),
  openGitHub: vi.fn(),
});

const fileItems = (t: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  (t.find((m) => m.label === "File")?.submenu ?? []) as MenuItemConstructorOptions[];
const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label).filter(Boolean);
const click = (item: MenuItemConstructorOptions | undefined) =>
  (item?.click as unknown as (() => void) | undefined)?.();

describe("menuTemplate", () => {
  it("builds the local macOS menu", () => {
    const t = menuTemplate("local", "darwin", handlers());
    expect(t[0]?.role).toBe("appMenu");
    const file = labels(fileItems(t));
    expect(file).toContain("Switch to server…");
    expect(file).toContain("Open server log");
    expect(file).toContain("Open workspaces folder");
    expect(file).not.toContain("Change server URL…");
    expect(fileItems(t).some((i) => i.role === "quit")).toBe(false);
  });

  it("builds the remote Windows menu", () => {
    const t = menuTemplate("remote", "win32", handlers());
    expect(t.some((m) => m.role === "appMenu")).toBe(false);
    const items = fileItems(t);
    expect(labels(items)).toEqual(expect.arrayContaining(["Switch to local", "Change server URL…", "Open workspaces folder"]));
    expect(labels(items)).not.toContain("Open server log");
    expect(items.some((i) => i.role === "quit")).toBe(true);
    const view = t.find((m) => m.label === "View")?.submenu as MenuItemConstructorOptions[];
    expect(view.map((i) => i.role)).toEqual(["reload", "toggleDevTools"]);
  });

  it("calls the matching handlers", () => {
    const h = handlers();
    const items = fileItems(menuTemplate("remote", "linux", h));
    click(items.find((i) => i.label === "Switch to local"));
    expect(h.switchMode).toHaveBeenCalledOnce();
    click(items.find((i) => i.label === "Change server URL…"));
    expect(h.changeServer).toHaveBeenCalledOnce();
    click(items.find((i) => i.label === "Open workspaces folder"));
    expect(h.openWorkspaces).toHaveBeenCalledOnce();
    click(fileItems(menuTemplate("local", "linux", h)).find((i) => i.label === "Open server log"));
    expect(h.openServerLog).toHaveBeenCalledOnce();
    const help = menuTemplate("local", "darwin", h).find((m) => m.label === "Help")?.submenu as MenuItemConstructorOptions[];
    click(help[0]);
    expect(h.openGitHub).toHaveBeenCalledOnce();
  });
});
