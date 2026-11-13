// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewProvider } from "./overview";
import { Shell } from "./Shell";
import { ToastProvider } from "./ui/toast";
import { useKey } from "./keys";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Run {
  workspaceId: string;
  id: string;
  status: string;
  live: boolean;
  type: string;
  kind: string;
}
let runs: Run[] = [];
let forges = { github: { connected: true, login: "me" }, gitlab: { connected: false } };

const terminals = [
  { id: "t1", title: "claude plan", cwd: "/w/o/r", workspaceId: "github~o~r", status: "working", createdAt: "x", process: "claude" },
  { id: "t2", title: "bash", cwd: "/w/o/r", workspaceId: "github~o~r", status: "working", createdAt: "x" },
  { id: "t3", title: "agent", cwd: "/w/o/r", workspaceId: "github~o~r", status: "idle", createdAt: "x" },
];
const workspaces = [{ id: "github~o~r", forge: "github", fullPath: "o/r", path: "/w/o/r", branch: "main", dirty: false, remoteUrl: "" }];

beforeEach(() => {
  runs = [
    { workspaceId: "github~o~r", id: "20261106-193934-b2dc", status: "running", live: true, type: "run", kind: "run" },
    { workspaceId: "github~o~r", id: "20261106-120155-a3f0", status: "failed", live: false, type: "run", kind: "run" },
  ];
  forges = { github: { connected: true, login: "me" }, gitlab: { connected: false } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/info") return json({ host: "dev-vm-01" });
      if (url === "/api/runs") return json({ runs });
      if (url === "/api/terminals") return json({ terminals });
      if (url === "/api/workspaces") return json({ workspaces });
      if (url === "/api/forges") return json(forges);
      return json({ error: "nope" }, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

/** A page binding on "s", like Runs' Start run; its listener registers before Shell's (child effects run first). */
let pageS = 0;
function PageWithS() {
  useKey("s", (e) => {
    e.preventDefault();
    pageS++;
  });
  return <Where />;
}

function renderShell(path = "/runs", withPageKey = false) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <OverviewProvider>
          <Shell onLogout={() => {}}>
            <Routes>
              <Route path="*" element={withPageKey ? <PageWithS /> : <Where />} />
            </Routes>
          </Shell>
        </OverviewProvider>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const where = () => screen.getByTestId("where").textContent;
const termBadge = () => screen.getByRole("link", { name: "Terminals" }).querySelector(".nav-badge");
const loaded = () =>
  waitFor(() => {
    expect(termBadge()?.textContent).toBe("3");
    expect(screen.getByTestId("status-live").textContent).toContain("1");
  });

describe("Shell", () => {
  it("collapses the nav to a rail on the detail page of a live run only", async () => {
    renderShell("/runs/github~o~r/20261106-193934-b2dc");
    await loaded();
    expect(screen.getByTestId("gm-shell").className).toBe("gm-shell rail");
    cleanup();
    renderShell("/runs/github~o~r/20261106-120155-a3f0");
    await loaded();
    expect(screen.getByTestId("gm-shell").className).toBe("gm-shell");
    cleanup();
    renderShell("/runs");
    await loaded();
    expect(screen.getByTestId("gm-shell").className).toBe("gm-shell");
  });

  it("shows the host and the status block counts", async () => {
    renderShell();
    await loaded();
    expect((await screen.findByTestId("nav-host")).textContent).toBe("dev-vm-01");
    // Only the run rows: terminals have no working / idle status (GMD-15).
    expect([...screen.getByTestId("nav-status").querySelectorAll(".status-row")].map((a) => a.getAttribute("data-testid"))).toEqual(["status-live", "status-failed"]);
    expect(screen.queryByTestId("status-working")).toBeNull();
    expect(screen.queryByTestId("status-idle")).toBeNull();
    expect(screen.getByTestId("status-live").textContent).toBe("1runs live");
    expect(screen.getByTestId("status-failed").textContent).toBe("1run failed");
    expect(screen.getByTestId("status-failed").className).toContain("tone-bad");
    expect(screen.getByTestId("status-live").getAttribute("href")).toBe("/runs?status=live");
    expect(screen.getByTestId("status-failed").getAttribute("href")).toBe("/runs?status=failed");
    fireEvent.click(screen.getByTestId("status-failed"));
    expect(where()).toBe("/runs?status=failed");
  });

  it("lists the links in order with their badges, and no Settings dot while a forge is connected", async () => {
    renderShell();
    await loaded();
    const links = screen.getAllByRole("link").filter((a) => a.classList.contains("nav-item"));
    expect(links.map((a) => a.getAttribute("aria-label"))).toEqual(["Runs", "Approvals", "Terminals", "Workspaces", "Projects", "Reviewers", "Settings"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/runs", "/approvals", "/terminals", "/workspaces", "/projects", "/reviewers", "/settings"]);
    // No Approvals badge or dot while nothing awaits approval.
    expect(links[1]!.querySelector(".nav-badge")).toBeNull();
    expect(screen.queryByTestId("dot-Approvals")).toBeNull();
    expect(links[0]!.querySelector(".nav-badge")!.textContent).toBe("1 live · 1 failed");
    expect(links[0]!.querySelector(".tone-text-bad")!.textContent).toBe("1 failed");
    // The Terminals badge is the plain terminal count, without a working · idle pair.
    expect(links[2]!.querySelector(".nav-badge")!.textContent).toBe("3");
    expect(links[2]!.querySelector(".nav-count")).not.toBeNull();
    expect(links[2]!.querySelector(".tone-text-live, .tone-text-warn")).toBeNull();
    expect(screen.queryByTestId("dot-Terminals")).toBeNull();
    expect(links[3]!.querySelector(".nav-badge")!.textContent).toBe("1");
    expect(screen.queryByTestId("settings-dot")).toBeNull();
    expect(links[0]!.getAttribute("aria-current")).toBe("page");
  });

  it("shows the count of runs awaiting approval on the Approvals item, and g a goes there", async () => {
    runs.push({ workspaceId: "github~o~r", id: "20261106-090000-c0de", status: "awaiting-approval", live: false, type: "run", kind: "run" });
    renderShell();
    await loaded();
    expect((await screen.findByTestId("approvals-count")).textContent).toBe("1");
    expect(screen.getByTestId("dot-Approvals").className).toContain("tone-warn");
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "a" });
    expect(where()).toBe("/approvals");
  });

  it("shows a Settings dot when no forge is connected", async () => {
    forges = { github: { connected: false } as never, gitlab: { connected: false } };
    renderShell();
    expect(await screen.findByTestId("settings-dot")).toBeTruthy();
  });

  it("opens the palette with Ctrl+K and jumps to a run", async () => {
    renderShell();
    await loaded();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox", { name: "Jump to" });
    fireEvent.change(input, { target: { value: "b2dc" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(where()).toBe("/runs/github~o~r/20261106-193934-b2dc");
    expect(screen.queryByTestId("palette")).toBeNull();
  });

  it("lists terminals in the palette with the workspace and process, without a status", async () => {
    renderShell();
    await loaded();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox", { name: "Jump to" });
    fireEvent.change(input, { target: { value: "claude plan" } });
    const [option] = screen.getAllByRole("option");
    expect(option!.querySelector(".palette-secondary")!.textContent).toBe("github/o/r · claude");
    expect(option!.querySelector(".badge")).toBeNull();
    fireEvent.change(input, { target: { value: "agent" } });
    expect(screen.getAllByRole("option")[0]!.textContent).not.toMatch(/working|idle/);
  });

  it("offers pages and workspace actions in the palette, and Esc closes it", async () => {
    renderShell();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Jump to…" }));
    const input = await screen.findByRole("combobox", { name: "Jump to" });
    fireEvent.change(input, { target: { value: "open terminal" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(where()).toBe("/terminals?workspace=github~o~r");
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const again = await screen.findByRole("combobox", { name: "Jump to" });
    fireEvent.change(again, { target: { value: "clone" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(screen.queryByTestId("palette")).toBeNull();
  });

  it("navigates with g then w, and ignores the chord while typing", async () => {
    renderShell();
    await loaded();
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "w" });
    expect(where()).toBe("/workspaces");
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "s" });
    expect(where()).toBe("/settings");
    fireEvent.keyDown(document.body, { key: "r" });
    expect(where()).toBe("/settings");
  });

  it("navigates to Reviewers with g then v and from the palette", async () => {
    renderShell();
    await loaded();
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "v" });
    expect(where()).toBe("/reviewers");
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "r" });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox", { name: "Jump to" });
    fireEvent.change(input, { target: { value: "Reviewers" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(where()).toBe("/reviewers");
  });

  it("navigates to Projects with g then p and from the palette", async () => {
    renderShell();
    await loaded();
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "p" });
    expect(where()).toBe("/projects");
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "r" });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox", { name: "Jump to" });
    fireEvent.change(input, { target: { value: "Projects" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(where()).toBe("/projects");
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const again = await screen.findByRole("combobox", { name: "Jump to" });
    fireEvent.change(again, { target: { value: "New project" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(where()).toBe("/projects?new=1");
  });

  it("lets g then s go to Settings over a page binding on s", async () => {
    pageS = 0;
    renderShell("/runs", true);
    await loaded();
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "s" });
    expect(where()).toBe("/settings");
    expect(pageS).toBe(0);
    fireEvent.keyDown(document.body, { key: "s" });
    expect(pageS).toBe(1);
  });

  it("shows a toast when a run turns failed", async () => {
    renderShell();
    await loaded();
    runs = runs.map((r) => (r.id.endsWith("b2dc") ? { ...r, status: "failed", live: false } : r));
    await waitFor(() => expect(screen.getByTestId("toasts").textContent).toContain("Run b2dc failed in r"), { timeout: 4000 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open" }));
    });
  });

  it("starts dark and cycles the theme dark → system → light → dark", async () => {
    renderShell();
    await loaded();
    const btn = () => screen.getByRole("button", { name: /^Theme:/ });
    expect(btn().dataset.themePref).toBe("dark");
    fireEvent.click(btn());
    expect(btn().dataset.themePref).toBe("system");
    expect(window.localStorage.getItem("gm.theme")).toBe("system");
    fireEvent.click(btn());
    expect(btn().dataset.themePref).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(btn());
    expect(btn().dataset.themePref).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("gm.theme")).toBe("dark");
  });

  it("shows a nav item per extension", async () => {
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={["/runs"]}>
          <OverviewProvider>
            <Shell onLogout={() => {}} extensions={["demo"]}>
              <Routes>
                <Route path="*" element={<Where />} />
              </Routes>
            </Shell>
          </OverviewProvider>
        </MemoryRouter>
      </ToastProvider>,
    );
    await loaded();
    expect(screen.getByRole("link", { name: "demo" }).getAttribute("href")).toBe("/x/demo");
    cleanup();
    renderShell();
    await loaded();
    expect(screen.queryByRole("link", { name: "demo" })).toBeNull();
  });
});
