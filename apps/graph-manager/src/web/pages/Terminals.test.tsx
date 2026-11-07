// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewProvider } from "../overview";
import type { RunSummary, TerminalInfo, WorkspaceEntry } from "../types";
import { ToastProvider } from "../ui/toast";
import { LAYOUT_KEY } from "./layout";
import Terminals from "./Terminals";

/** Stand-in for the xterm view: exposes its callbacks as buttons, and the key filter it was given. */
const keyFilters = new Map<string, (e: KeyboardEvent) => boolean>();
vi.mock("../components/TerminalView", () => ({
  default: (p: { id: string; active: boolean; onExit?(c: number): void; onRestart?(): void; onConnection?(s: string): void; keyFilter?(e: KeyboardEvent): boolean }) => {
    if (p.keyFilter) keyFilters.set(p.id, p.keyFilter);
    return (
      <div data-testid={`terminal-view-${p.id}`} data-active={String(p.active)}>
        <button type="button" onClick={() => p.onExit?.(1)}>
          sim-exit-{p.id}
        </button>
        <button type="button" onClick={() => p.onConnection?.("reconnecting")}>
          sim-drop-{p.id}
        </button>
      </div>
    );
  },
}));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
const HELLO = "github~octo~hello";
const TOOLS = "gitlab~platform~infra~deploy-tools";

const WORKSPACES: WorkspaceEntry[] = [
  { id: HELLO, forge: "github", fullPath: "octo/hello", path: "/ws/github/octo/hello", branch: "main", dirty: false, remoteUrl: "" },
  { id: TOOLS, forge: "gitlab", fullPath: "platform/infra/deploy-tools", path: "/ws/gitlab/platform/infra/deploy-tools", branch: "main", dirty: false, remoteUrl: "" },
];

const term = (id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, title: id, cwd: "/ws", status: "idle", createdAt: ago(600), ...extra });

const TERMS: TerminalInfo[] = [
  term("t1", { title: "fix-auth", workspaceId: TOOLS, status: "idle", lastOutputAt: ago(240), process: "claude" }),
  term("t2", { title: "plan", workspaceId: HELLO, status: "working", process: "bash", workingSince: ago(14), lastOutputAt: ago(1) }),
  term("t3", { title: "scratch", status: "exited", exitCode: 0, lastOutputAt: ago(1320) }),
  term("t4", { title: "runner", workspaceId: HELLO, status: "exited", exitCode: 1 }),
];

const RUNS: RunSummary[] = [{ workspaceId: HELLO, type: "run", id: "20261106-201510-44c2", status: "running", kind: "live", live: true, viewUrl: "http://127.0.0.1:7801/" }];

function serve(initial: TerminalInfo[] = TERMS) {
  const terminals = [...initial];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/terminals" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { workspaceId?: string; title?: string };
      const t = term(`t${terminals.length + 1}`, { title: body.title ?? "new", ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}) });
      terminals.push(t);
      return json(201, t);
    }
    if (url === "/api/terminals") return json(200, { terminals });
    const m = /^\/api\/terminals\/([^/]+)(\/restart)?$/.exec(url);
    if (m && method === "DELETE") {
      const i = terminals.findIndex((t) => t.id === m[1]);
      if (i >= 0) terminals.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    if (m && m[2] && method === "POST") return json(200, { ...terminals.find((t) => t.id === m[1]), status: "idle", exitCode: undefined });
    if (m && method === "PATCH") return json(200, { ...terminals.find((t) => t.id === m[1]), ...(JSON.parse(String(init?.body)) as object) });
    if (url === "/api/runs") return json(200, { runs: RUNS });
    if (url.startsWith("/api/runs/")) return json(200, { summary: RUNS[0], graph: { nodes: [], edges: [], layers: [] } });
    if (url === "/api/workspaces") return json(200, { workspaces: WORKSPACES, root: "/ws" });
    if (url === "/api/forges") return json(200, { github: { connected: false }, gitlab: { connected: false } });
    return json(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function mount(entry = "/terminals", strict = false) {
  const tree = (
    <MemoryRouter initialEntries={[entry]}>
      <ToastProvider>
        <OverviewProvider>
          <Terminals />
          <Where />
        </OverviewProvider>
      </ToastProvider>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const calls = (fetchMock: ReturnType<typeof serve>, method: string, url?: string) =>
  fetchMock.mock.calls.filter(([u, init]) => (init?.method ?? "GET") === method && (url === undefined || u === url));

const prefix = () => fireEvent.keyDown(window, { key: " ", code: "Space", ctrlKey: true });

beforeEach(() => {
  localStorage.clear();
  keyFilters.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Terminals page", () => {
  it("groups the sidebar: NEEDS YOU (idle), one section per workspace, WORKSPACES ROOT", async () => {
    serve();
    mount();
    const needs = await screen.findByTestId("section-needs-you");
    expect(needs.textContent).toContain("NEEDS YOU");
    expect(within(needs).getByTestId("terminal-item-t1").textContent).toContain("deploy-tools · claude · idle 4m");
    const hello = screen.getByTestId(`section-ws:${HELLO}`);
    expect(hello.textContent).toContain("OCTO/HELLO");
    expect(within(hello).getByTestId("terminal-item-t2").textContent).toMatch(/bash · working 1[45]s/);
    expect(within(hello).getByTestId("terminal-item-t4").textContent).toContain("exited 1");
    expect(screen.queryByTestId(`section-ws:${TOOLS}`)).toBeNull();
    const root = screen.getByTestId("section-root");
    expect(root.textContent).toContain("WORKSPACES ROOT");
    expect(within(root).getByTestId("terminal-item-t3").textContent).toContain("exited 0 · 22m ago");
    // A live run in the workspace shows its last 4 chars; clicking it opens the run in a pane.
    fireEvent.click(within(screen.getByTestId("terminal-item-t2")).getByTestId("run-chip-20261106-201510-44c2"));
    expect(await screen.findByLabelText("run 44c2")).toBeTruthy();
    expect(screen.getByTestId("pane-grid").dataset.panes).toBe("2");
  });

  it("filter chips toggle and sync ?filter=", async () => {
    serve();
    mount("/terminals?filter=other");
    await screen.findByTestId("terminal-item-t3");
    expect(screen.queryByTestId("terminal-item-t1")).toBeNull();
    expect(screen.getByTestId("filter-other").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("filter-working").textContent).toContain("1 working");
    fireEvent.click(screen.getByTestId("filter-idle"));
    expect(screen.getByTestId("where").textContent).toBe("/terminals?filter=idle");
    expect(screen.getByTestId("terminal-item-t1")).toBeTruthy();
    expect(screen.queryByTestId("terminal-item-t2")).toBeNull();
    fireEvent.click(screen.getByTestId("filter-idle"));
    expect(screen.getByTestId("where").textContent).toBe("/terminals");
    expect(screen.getByTestId("terminal-item-t2")).toBeTruthy();
  });

  it("the layout buttons show 1, 2 or 4 panes, and the layout survives a remount", async () => {
    serve();
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t2"));
    expect(screen.getByTestId("pane-grid").dataset.panes).toBe("1");
    fireEvent.click(screen.getByTestId("layout-4"));
    expect(screen.getByTestId("pane-grid").dataset.panes).toBe("4");
    expect(screen.getByTestId("layout-4").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("layout-2"));
    expect(screen.getByTestId("pane-grid").dataset.panes).toBe("2");
    fireEvent.mouseDown(screen.getByTestId("pane-2"));
    fireEvent.click(screen.getByTestId("terminal-item-t1"));
    // The pane badge: t2 in pane 1, t1 in the focused pane 2.
    expect(screen.getByTestId("pane-badge-t1").textContent).toBe("2");
    expect(screen.getByTestId("pane-badge-t1").className).toContain("focused");
    expect(screen.getByTestId("pane-badge-t2").className).not.toContain("focused");
    // t1 (first under NEEDS YOU) filled the empty screen on mount, so its tab comes first.
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}")).toMatchObject({ layout: 2, tabs: ["t:t1", "t:t2"] });

    cleanup();
    mount();
    await screen.findByTestId("terminal-view-t1");
    expect(screen.getByTestId("pane-grid").dataset.panes).toBe("2");
    expect(screen.getByTestId("terminal-view-t2")).toBeTruthy();
  });

  it("puts a terminal in the empty screen when none is shown, e.g. after a server restart with a saved 2x2 layout", async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ layout: 4, tabs: [], panes: [null, null, null, null], focused: 0 }));
    serve();
    mount();
    expect(await screen.findByTestId("terminal-view-t1")).toBeTruthy();
    expect(screen.getByTestId("pane-1").getAttribute("aria-label")).toBe("fix-auth");
  });

  it("closing a working terminal asks first; an idle one closes right away", async () => {
    const fetchMock = serve();
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t2"));
    fireEvent.click(screen.getByRole("button", { name: "Close plan" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Close “plan”?");
    expect(dialog.textContent).toContain("bash is still working");
    fireEvent.click(within(dialog).getByRole("button", { name: /Keep running/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls(fetchMock, "DELETE")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Close plan" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close terminal" }));
    await waitFor(() => expect(calls(fetchMock, "DELETE", "/api/terminals/t2")).toHaveLength(1));

    fireEvent.click(screen.getByTestId("terminal-item-t1"));
    fireEvent.click(screen.getByTestId("pane-close-1"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(calls(fetchMock, "DELETE", "/api/terminals/t1")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("terminal-item-t1")).toBeNull());
  });

  it("shows the exit bar; Restart calls the endpoint and clears it; a dropped socket shows the reconnecting bar", async () => {
    const fetchMock = serve();
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t1"));
    fireEvent.click(screen.getByText("sim-exit-t1"));
    expect(screen.getByTestId("exit-bar").textContent).toContain("Process exited with code 1");
    fireEvent.click(screen.getByTestId("restart-terminal"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals/t1/restart")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("exit-bar")).toBeNull());
    fireEvent.click(screen.getByText("sim-drop-t1"));
    expect(screen.getByTestId("reconnect-bar").textContent).toContain("Reconnecting to the container… your scrollback is kept on the server.");
  });

  it("Ctrl Space prefix: n opens the new-terminal dialog, 1–4 focus panes, | cycles, and the key never reaches the terminal", async () => {
    const fetchMock = serve();
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t2"));
    const filter = keyFilters.get("t2")!;
    expect(filter(new KeyboardEvent("keydown", { key: "n" }))).toBe(true);

    prefix();
    expect(screen.getByTestId("prefix-hint")).toBeTruthy();
    expect(filter(new KeyboardEvent("keydown", { key: "n" }))).toBe(false);
    fireEvent.keyDown(window, { key: "n" });
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    expect(screen.queryByTestId("prefix-hint")).toBeNull();
    // Defaults to the focused pane's workspace.
    expect((within(dialog).getByTestId("new-terminal-workspace") as HTMLSelectElement).value).toBe(HELLO);
    fireEvent.change(within(dialog).getByTestId("new-terminal-title"), { target: { value: "build" } });
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]?.[1]?.body))).toEqual({ workspaceId: HELLO, title: "build" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByTestId("terminal-view-t5")).toBeTruthy();

    prefix();
    fireEvent.keyDown(window, { key: "|", shiftKey: true });
    expect(screen.getByTestId("pane-grid").dataset.panes).toBe("2");
    prefix();
    fireEvent.keyDown(window, { key: "|" });
    expect(screen.getByTestId("pane-grid").dataset.panes).toBe("4");
    prefix();
    fireEvent.keyDown(window, { key: "3" });
    expect(screen.getByTestId("pane-3").className).toContain("focused");
    expect(screen.getByTestId("pane-1").className).not.toContain("focused");
    prefix();
    fireEvent.keyDown(window, { key: "1" });
    expect(screen.getByTestId("pane-1").className).toContain("focused");

    // a: the next idle terminal goes into the focused pane.
    prefix();
    fireEvent.keyDown(window, { key: "a" });
    // fix-auth is already in a pane (it filled the empty screen on mount), so the focus moves there.
    await waitFor(() =>
      expect([1, 2, 3, 4].map((n) => screen.getByTestId(`pane-${n}`)).find((p) => p.className.includes("focused"))?.getAttribute("aria-label")).toBe("fix-auth"),
    );
  });

  it("the prefix hint times out after 1.5 s", async () => {
    serve();
    mount();
    await screen.findByTestId("terminal-item-t2");
    vi.useFakeTimers();
    try {
      prefix();
      expect(screen.getByTestId("prefix-hint")).toBeTruthy();
      act(() => vi.advanceTimersByTime(1600));
      expect(screen.queryByTestId("prefix-hint")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("?workspace= opens one terminal there (StrictMode) and becomes ?focus=", async () => {
    const fetchMock = serve([]);
    mount(`/terminals?workspace=${HELLO}`, true);
    expect(await screen.findByTestId("terminal-view-t1")).toBeTruthy();
    expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1);
    expect(JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]?.[1]?.body))).toEqual({ workspaceId: HELLO });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/terminals?focus=t1"));
  });

  it("creates the terminal on Enter in the workspace select", async () => {
    const fetchMock = serve([]);
    mount();
    fireEvent.click(within(await screen.findByTestId("terminals-empty")).getByRole("button", { name: /New terminal/ }));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    fireEvent.keyDown(within(dialog).getByTestId("new-terminal-workspace"), { key: "Enter" });
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1));
  });

  it("shows the empty state without terminals", async () => {
    serve([]);
    mount();
    const empty = await screen.findByTestId("terminals-empty");
    expect(empty.textContent).toContain("No terminals open");
    await waitFor(() => expect(empty.textContent).toContain("or in /ws if none is selected"));
    fireEvent.click(within(empty).getByRole("button", { name: /New terminal/ }));
    expect(await screen.findByRole("dialog", { name: "New terminal" })).toBeTruthy();
  });

  it("renames a terminal by double-clicking its tab title", async () => {
    const fetchMock = serve();
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t1"));
    const tab = screen.getByTestId("tab-t:t1");
    fireEvent.doubleClick(within(tab).getByText("fix-auth"));
    const input = within(tab).getByLabelText("Terminal title");
    fireEvent.change(input, { target: { value: "auth-fix" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls(fetchMock, "PATCH", "/api/terminals/t1")).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, "PATCH")[0]?.[1]?.body))).toEqual({ title: "auth-fix" });
    expect(within(tab).getByText("auth-fix")).toBeTruthy();
  });
});
