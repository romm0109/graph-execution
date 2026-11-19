// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewProvider } from "../overview";
import type { AgentInfo, BranchList, KeptProjectWorktree, KeptWorktree, ProjectEntry, RunSummary, TerminalInfo, WorkspaceEntry } from "../types";
import { ToastProvider } from "../ui/toast";
import { LAYOUT_KEY } from "./layout";
import { COARSE } from "../ui/media";
import { defaultEcho } from "./TerminalPane";
import Terminals, { isShell } from "./Terminals";

/** Stand-in for the xterm view: exposes its callbacks as buttons, and the key filter it was given. */
const keyFilters = new Map<string, (e: KeyboardEvent) => boolean>();
/** The touch tap callback each view was given. */
const taps = new Map<string, () => void>();
/** What the extra-keys row typed, per terminal, and the sticky Ctrl / phone prefix callbacks each view was given. */
const inputs: [string, string][] = [];
const ctrlArmeds = new Map<string, () => boolean>();
const ctrlUseds = new Map<string, () => void>();
const prefixDatas = new Map<string, (d: string) => boolean>();
vi.mock("../components/TerminalView", () => ({
  default: (p: {
    id: string;
    active: boolean;
    onExit?(c: number): void;
    onRestart?(): void;
    onConnection?(s: string): void;
    keyFilter?(e: KeyboardEvent): boolean;
    onTap?(): void;
    instantEcho?: boolean;
    handleRef?: { current: unknown };
    ctrlArmed?(): boolean;
    onCtrlUsed?(): void;
    onPrefixData?(d: string): boolean;
  }) => {
    if (p.keyFilter) keyFilters.set(p.id, p.keyFilter);
    if (p.onTap) taps.set(p.id, p.onTap);
    if (p.handleRef) p.handleRef.current = { input: (d: string) => inputs.push([p.id, d]), focus() {}, appCursor: () => false };
    if (p.ctrlArmed) ctrlArmeds.set(p.id, p.ctrlArmed);
    if (p.onCtrlUsed) ctrlUseds.set(p.id, p.onCtrlUsed);
    if (p.onPrefixData) prefixDatas.set(p.id, p.onPrefixData);
    return (
      <div data-testid={`terminal-view-${p.id}`} data-active={String(p.active)} data-echo={String(p.instantEcho)}>
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

/** Stand-in for the spec view: prints the text, so the tests need neither marked nor mermaid. */
vi.mock("../components/SpecView", () => ({
  SpecView: (p: { text: string; theme: string }) => (
    <div data-testid="spec-view" data-theme={p.theme}>
      {p.text}
    </div>
  ),
}));

/** The specs each workspace serves, and their files; tests change them between polls. */
const specs: Record<string, { path: string; name: string; title: string; mtimeMs: number; size: number }[]> = {};
const specFiles: Record<string, { text: string; mtimeMs: number }> = {};

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

const AGENTS: AgentInfo[] = [
  { id: "claude", label: "Claude Code", installed: true, connect: "inject" },
  { id: "codex", label: "Codex", installed: false, connect: "inject" },
  { id: "opencode", label: "OpenCode", installed: true, connect: "inject" },
  { id: "qwen", label: "Qwen Code", installed: true, connect: "project-config" },
];

const BILLING: ProjectEntry = {
  id: "billing",
  name: "billing",
  forge: "github",
  path: "/ws/.projects/billing",
  createdAt: ago(60),
  workspaces: [
    { id: HELLO, fullPath: "octo/hello", repo: "hello" },
    { id: "github~octo~web", fullPath: "octo/web", repo: "web" },
  ],
};

/** Worktree terminals with work (KAN-100): DELETE without `?worktree=` answers 409 for these ids. */
const withWork = new Set<string>();
/** What GET /api/worktrees lists. */
const keptList: KeptWorktree[] = [];
/** What GET /api/worktrees lists under projectWorktrees. */
const keptProjectList: KeptProjectWorktree[] = [];

/** Lets a test hold the POST /api/terminals answer (`gate`) or replace it (`answer`). */
const postHooks: { gate?: Promise<void>; answer?: (body: Record<string, unknown>) => Response | undefined } = {};

/** What GET /api/workspaces/:id/branches answers (`local`), and with ?fetch=1 (`fetched`, held by `gate` when set). */
const branchHooks: { local?: BranchList; fetched?: BranchList; gate?: Promise<void> } = {};
/** GET /api/projects/:id/branches (404 when unset), and per-workspace ?fetch=1 answers each held by its own gate. */
const projectHooks: {
  branches?: unknown;
  fetched: Record<string, { answer: BranchList; gate?: Promise<void> }>;
  /** The 409 body of DELETE on a project terminal in `withWork`. */
  work?: Record<string, unknown>;
  /** The answer of POST …/merge-project (default 200 `{ merged: true, fastForward: true }`). */
  merge?: { status: number; body: Record<string, unknown> };
} = { fetched: {} };
const LOCAL_BRANCHES: BranchList = { branches: ["development", "main"], default: "main", current: "development" };

function serve(initial: TerminalInfo[] = TERMS) {
  const terminals = [...initial];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/agents") return json(200, { agents: AGENTS });
    if (url === "/api/projects") return json(200, { projects: [BILLING] });
    if (url === "/api/terminals" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { workspaceId?: string; projectId?: string; title?: string; agent?: TerminalInfo["agent"] };
      if (postHooks.gate) await postHooks.gate;
      const answer = postHooks.answer?.(body);
      if (answer) return answer;
      const t = term(`t${terminals.length + 1}`, {
        title: body.title ?? "new",
        ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
        ...(body.projectId ? { projectId: body.projectId } : {}),
        ...(body.agent ? { agent: body.agent } : {}),
      });
      terminals.push(t);
      return json(201, t);
    }
    if (url === "/api/terminals") return json(200, { terminals });
    if (url === "/api/worktrees") return json(200, { worktrees: keptList, projectWorktrees: keptProjectList });
    if (/^\/api\/projects\/[^/]+\/branches$/.test(url)) return projectHooks.branches ? json(200, projectHooks.branches) : json(404, { error: "not found" });
    const br = /^\/api\/workspaces\/([^/]+)\/branches(\?fetch=1)?$/.exec(url);
    const perWs = br && br[2] ? projectHooks.fetched[decodeURIComponent(br[1]!)] : undefined;
    if (perWs) {
      if (perWs.gate) await perWs.gate;
      return json(200, perWs.answer);
    }
    if (br && br[2]) {
      if (branchHooks.gate) await branchHooks.gate;
      return json(200, branchHooks.fetched ?? { ...(branchHooks.local ?? LOCAL_BRANCHES), fetched: true });
    }
    if (br) return json(200, branchHooks.local ?? LOCAL_BRANCHES);
    const wpr = /^\/api\/workspaces\/([^/]+)\/worktrees\/([^/]+)\/pr$/.exec(url);
    if (wpr) {
      const steps = (state: string) => ["access", "commit", "push", "create"].map((name) => ({ name, state }));
      if (method === "POST") return json(202, { job: { id: "j1", status: "running", steps: steps("pending"), base: "main", branch: `gm-term/${wpr[2]}`, startedAt: ago(0) } });
      return json(200, { job: { id: "j1", status: "done", steps: steps("done"), base: "main", branch: `gm-term/${wpr[2]}`, startedAt: ago(0) }, pr: { url: "http://forge/pull/9", number: 9 } });
    }
    if (/\/merge-project$/.test(url) && method === "POST") {
      const a = projectHooks.merge ?? { status: 200, body: { merged: true, fastForward: true } };
      return json(a.status, a.body);
    }
    const ppr = /^\/api\/projects\/([^/]+)\/worktrees\/([^/]+)\/pr$/.exec(url);
    if (ppr) {
      const steps = (state: string) => ["access", "commit", "push", "create"].map((name) => ({ name, state }));
      const repo = (name: string, status: string, n?: number) => ({ name, status, steps: steps(status === "done" ? "done" : "pending"), ...(n ? { pr: { url: `http://forge/${name}/pull/${n}`, number: n, branch: `gm-term/${ppr[2]}` } } : {}) });
      if (method === "POST") return json(202, { job: { id: "pj1", status: "running", startedAt: ago(0), repos: [repo("a", "pending"), repo("b", "pending"), repo("c", "skipped")], link: { state: "pending" } } });
      return json(200, { job: { id: "pj1", status: "done", startedAt: ago(0), repos: [repo("a", "done", 3), repo("b", "done", 4), repo("c", "skipped")], link: { state: "done" } } });
    }
    const m = /^\/api\/terminals\/([^/?]+)(\/restart)?(\?worktree=\w+)?$/.exec(url);
    if (m && method === "DELETE" && withWork.has(m[1]!) && !m[3]) {
      const t = terminals.find((x) => x.id === m[1]);
      if (t?.projectId && projectHooks.work) return json(409, { error: "the terminal has work", needsChoice: true, branch: t.worktree?.branch, ...projectHooks.work });
      return json(409, { error: "the terminal has work", needsChoice: true, dirty: 2, ahead: 1, branch: t?.worktree?.branch });
    }
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
    const tsp = /^\/api\/terminals\/([^/]+)\/specs(\/file\?path=(.*))?$/.exec(url);
    if (tsp && tsp[2]) {
      const path = decodeURIComponent(tsp[3] ?? "");
      const f = specFiles[`term:${tsp[1]}:${path}`];
      return f ? json(200, { path, ...f }) : json(404, { error: "not found" });
    }
    if (tsp) return json(200, { specs: specs[`term:${tsp[1]}`] ?? [] });
    const sp = /^\/api\/workspaces\/([^/]+)\/specs(\/file\?path=(.*))?$/.exec(url);
    if (sp && sp[2]) {
      const path = decodeURIComponent(sp[3] ?? "");
      const f = specFiles[`${decodeURIComponent(sp[1]!)}:${path}`];
      return f ? json(200, { path, ...f }) : json(404, { error: "not found" });
    }
    if (sp) return json(200, { specs: specs[decodeURIComponent(sp[1]!)] ?? [] });
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

/** A touch screen (or not); every other media query stays false, so the wide layout stays. */
function stubCoarse(on: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: on && query === COARSE, media: query, addEventListener: () => {}, removeEventListener: () => {} })),
  );
}

const prefix = () => fireEvent.keyDown(window, { key: " ", code: "Space", ctrlKey: true });

beforeEach(() => {
  localStorage.clear();
  for (const k of Object.keys(specs)) delete specs[k];
  for (const k of Object.keys(specFiles)) delete specFiles[k];
  keyFilters.clear();
  taps.clear();
  inputs.length = 0;
  ctrlArmeds.clear();
  ctrlUseds.clear();
  prefixDatas.clear();
  delete postHooks.gate;
  delete postHooks.answer;
  withWork.clear();
  keptList.length = 0;
  keptProjectList.length = 0;
  delete branchHooks.local;
  delete branchHooks.fetched;
  delete branchHooks.gate;
  delete projectHooks.branches;
  delete projectHooks.work;
  delete projectHooks.merge;
  projectHooks.fetched = {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("isShell", () => {
  it("knows the plain shells by basename, ignoring a login dash", () => {
    for (const n of ["bash", "sh", "zsh", "fish", "dash", "ash", "tcsh", "csh", "ksh", "pwsh", "-bash", "/usr/bin/zsh", "/bin/-sh"]) expect(isShell(n)).toBe(true);
    for (const n of ["node", "claude", "vim", "python3", "bashtop", ""]) expect(isShell(n)).toBe(false);
  });
});

describe("defaultEcho", () => {
  it("a saved choice wins; with none, instant echo is off only on touch screens", () => {
    expect(defaultEcho(null, false)).toBe(true);
    expect(defaultEcho(null, true)).toBe(false);
    expect(defaultEcho("on", true)).toBe(true);
    expect(defaultEcho("off", false)).toBe(false);
  });
});

describe("Terminals page", () => {
  it("a tap on a terminal focuses its pane", async () => {
    serve();
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t2"));
    fireEvent.click(screen.getByTestId("layout-2"));
    fireEvent.mouseDown(screen.getByTestId("pane-2"));
    fireEvent.click(screen.getByTestId("terminal-item-t1"));
    fireEvent.mouseDown(screen.getByTestId("pane-1"));
    expect(screen.getByTestId("pane-2").className).not.toContain("focused");
    act(() => taps.get("t1")!());
    expect(screen.getByTestId("pane-2").className).toContain("focused");
  });

  it("instant echo starts off on a touch screen with no saved choice", async () => {
    stubCoarse(true);
    serve();
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t1"));
    const chip = screen.getByTestId("echo-toggle");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.textContent).toContain("instant echo off");
    expect(screen.getByTestId("terminal-view-t1").dataset.echo).toBe("false");
    fireEvent.click(chip);
    expect(screen.getByTestId("echo-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("gm.instantEcho")).toBe("on");
  });

  it("a saved choice wins on a touch screen", async () => {
    localStorage.setItem("gm.instantEcho", "on");
    stubCoarse(true);
    serve();
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t1"));
    expect(screen.getByTestId("echo-toggle").getAttribute("aria-pressed")).toBe("true");
  });

  it("instant echo stays on by default with a fine pointer", async () => {
    stubCoarse(false);
    serve();
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t1"));
    expect(screen.getByTestId("echo-toggle").getAttribute("aria-pressed")).toBe("true");
  });

  it("groups the sidebar per workspace, then Workspaces root, with the process as the sub-line and no statuses", async () => {
    serve();
    mount();
    const hello = await screen.findByTestId(`section-ws:${HELLO}`);
    expect(hello.textContent).toContain("octo/hello");
    // Sections follow the workspaces list; a mix of working, idle and exited terminals gets no NEEDS YOU section (GMD-15).
    expect([...document.querySelectorAll("[data-testid^=section-]")].map((e) => e.getAttribute("data-testid"))).toEqual([`section-ws:${HELLO}`, `section-ws:${TOOLS}`, "section-root"]);
    expect(screen.queryByTestId("section-needs-you")).toBeNull();
    const sidebar = screen.getByTestId("terminal-sidebar");
    expect(sidebar.textContent).not.toMatch(/NEEDS YOU|working|idle|waiting on you|other|exited/i);
    expect(sidebar.querySelector(".tsb-chip, [data-testid^=filter-]")).toBeNull();
    // The sub-line is the foreground process, "shell" while it is not known; no time, tone or status glyph.
    const sub = (id: string) => screen.getByTestId(`terminal-item-${id}`).querySelector(".tsb-item-sub")!;
    expect(sub("t2").textContent).toBe("bash");
    expect(sub("t1").textContent).toBe("claude");
    expect(sub("t3").textContent).toBe("shell");
    expect(sub("t4").className).toBe("tsb-item-sub mono");
    expect(sidebar.querySelector(".tsb-item .glyph")).toBeNull();
    expect(within(hello).getByTestId("terminal-item-t4")).toBeTruthy();
    expect(within(screen.getByTestId(`section-ws:${TOOLS}`)).getByTestId("terminal-item-t1")).toBeTruthy();
    const root = screen.getByTestId("section-root");
    expect(root.textContent).toContain("Workspaces root");
    expect(within(root).getByTestId("terminal-item-t3")).toBeTruthy();
    expect(sidebar.querySelector(".tsb-foot")!.textContent).not.toContain("next idle");
    // A live run in the workspace shows its last 4 chars; clicking it opens the run in a pane.
    fireEvent.click(within(screen.getByTestId("terminal-item-t2")).getByTestId("run-chip-20261106-201510-44c2"));
    expect(await screen.findByLabelText("run 44c2")).toBeTruthy();
    expect(screen.getByTestId("pane-grid").dataset.panes).toBe("2");
  });

  it("ignores ?filter= and shows no status on tabs and pane headers", async () => {
    serve();
    mount("/terminals?filter=other");
    await screen.findByTestId("terminal-item-t3");
    for (const id of ["t1", "t2", "t3", "t4"]) expect(screen.getByTestId(`terminal-item-${id}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId("terminal-item-t1"));
    const tab = screen.getByTestId("tab-t:t1");
    expect(tab.querySelector(".glyph")).toBeNull();
    const pane = screen.getByTestId("pane-1");
    expect(pane.querySelector(".badge")).toBeNull();
    expect(pane.className).not.toContain("idle");
    expect(pane.textContent).not.toMatch(/working|idle|waiting on you/i);
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
    // t2 (first in the sidebar) filled the empty screen on mount, so its tab comes first.
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}")).toMatchObject({ layout: 2, tabs: ["t:t2", "t:t1"] });

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
    expect(await screen.findByTestId("terminal-view-t2")).toBeTruthy();
    expect(screen.getByTestId("pane-1").getAttribute("aria-label")).toBe("plan");
  });

  it("closing a terminal running a program asks first; one at its shell prompt, or exited, closes right away", async () => {
    const fetchMock = serve([
      term("t1", { title: "dev", workspaceId: TOOLS, status: "idle", process: "node" }),
      term("t2", { title: "plan", workspaceId: HELLO, status: "working", process: "bash" }),
      term("t3", { title: "login", workspaceId: HELLO, status: "idle", process: "/bin/-zsh" }),
      term("t4", { title: "runner", workspaceId: HELLO, status: "exited", exitCode: 1, process: "node" }),
    ]);
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t1"));
    fireEvent.click(screen.getByRole("button", { name: "Close dev" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Close “dev”?");
    expect(dialog.textContent).toContain("node is running. Closing the tab ends it and its scrollback.");
    expect(dialog.textContent).not.toMatch(/working|output/);
    fireEvent.click(within(dialog).getByRole("button", { name: /Keep running/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls(fetchMock, "DELETE")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Close dev" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close terminal" }));
    await waitFor(() => expect(calls(fetchMock, "DELETE", "/api/terminals/t1")).toHaveLength(1));

    // bash, even with recent output (status "working"), closes without a dialog.
    for (const id of ["t2", "t3", "t4"]) {
      fireEvent.click(screen.getByTestId(`terminal-item-${id}`));
      fireEvent.click(screen.getByTestId("pane-close-1"));
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(calls(fetchMock, "DELETE", `/api/terminals/${id}`)).toHaveLength(1));
      await waitFor(() => expect(screen.queryByTestId(`terminal-item-${id}`)).toBeNull());
    }
  });

  it("asks Delete / Keep / Cancel before closing a worktree terminal with work, and shows its branch (KAN-100)", async () => {
    const wt = { id: "wabc", path: "/ws/.gm-worktrees/wabc", branch: "gm-term/wabc" };
    const fetchMock = serve([term("t1", { title: "dev", process: "bash", workspaceId: HELLO, worktree: wt })]);
    withWork.add("t1");
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t1"));
    expect(screen.getByTestId("pane-branch").textContent).toBe("gm-term/wabc");
    fireEvent.click(screen.getByTestId("pane-close-1"));
    const dialog = await screen.findByTestId("worktree-close");
    expect(dialog.textContent).toContain("gm-term/wabc has 2 uncommitted files and 1 commit");
    // Cancel leaves the terminal open.
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancel/ }));
    expect(screen.queryByTestId("worktree-close")).toBeNull();
    expect(screen.getByTestId("terminal-item-t1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pane-close-1"));
    fireEvent.click(await screen.findByTestId("close-keep"));
    await waitFor(() => expect(calls(fetchMock, "DELETE", "/api/terminals/t1?worktree=keep")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("terminal-item-t1")).toBeNull());
  });

  it("Create PR from the close dialog opens the PR form for the terminal's worktree (KAN-100)", async () => {
    const wt = { id: "wabc", path: "/ws/.gm-worktrees/wabc", branch: "gm-term/wabc" };
    const fetchMock = serve([term("t1", { title: "dev", process: "bash", workspaceId: HELLO, worktree: wt })]);
    withWork.add("t1");
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t1"));
    fireEvent.click(screen.getByTestId("pane-close-1"));
    fireEvent.click(await screen.findByTestId("close-pr"));
    const dialog = await screen.findByTestId("worktree-pr");
    expect(dialog.textContent).toContain("gm-term/wabc");
    expect((within(dialog).getByTestId("worktree-pr-title") as HTMLInputElement).value).toBe("dev");
    fireEvent.change(within(dialog).getByTestId("worktree-pr-base"), { target: { value: "develop" } });
    fireEvent.click(within(dialog).getByTestId("worktree-pr-submit"));
    await waitFor(() => expect(calls(fetchMock, "POST", `/api/workspaces/${HELLO}/worktrees/wabc/pr`)).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, "POST", `/api/workspaces/${HELLO}/worktrees/wabc/pr`)[0]![1]!.body))).toEqual({ title: "dev", body: "", base: "develop" });
    expect((await screen.findByTestId("worktree-pr-link", {}, { timeout: 3000 })).textContent).toBe("Pull request #9 ↗");
  });

  it("lists kept worktrees under their workspace; Open reopens one and Delete asks first (KAN-100)", async () => {
    keptList.push({ id: "wk1", workspaceId: HELLO, path: "/ws/.gm-worktrees/wk1", branch: "gm-term/wk1", title: "old work", createdAt: ago(60), dirty: 0, ahead: 2 });
    const fetchMock = serve([]);
    mount();
    const item = await screen.findByTestId("kept-worktree");
    expect(item.textContent).toContain("gm-term/wk1 · 2 commits");
    fireEvent.click(screen.getByTestId("kept-open-wk1"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]![1]!.body))).toEqual({ workspaceId: HELLO, worktreeId: "wk1" });
    fireEvent.click(screen.getByTestId("kept-delete-wk1"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("gm-term/wk1 and its 2 commits are deleted");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete worktree" }));
    await waitFor(() => expect(calls(fetchMock, "DELETE", `/api/workspaces/${HELLO}/worktrees/wk1`)).toHaveLength(1));
  });

  it("lists kept project worktrees under their project; Open terminal reopens one without the dialog and Delete asks first", async () => {
    keptProjectList.push({
      id: "wp1",
      projectId: "billing",
      path: "/ws/.projects/billing/.gm-worktrees/wp1",
      branch: "gm-term/wp1",
      title: "billing work",
      createdAt: ago(60),
      project: { dirty: 1, ahead: 0 },
      repos: [
        { name: "hello", isolated: true, dirty: 1, ahead: 2 },
        { name: "web", isolated: true, dirty: 0, ahead: 0 },
      ],
    });
    const fetchMock = serve([]);
    mount();
    const item = await screen.findByTestId("kept-project-worktree");
    expect(screen.getByTestId("section-project:billing").contains(item)).toBe(true);
    expect(item.textContent).toContain("billing work");
    expect(item.textContent).toContain("2 repos · 2 uncommitted files and 2 commits");
    fireEvent.click(within(item).getByTestId("kept-project-open"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]![1]!.body))).toEqual({ projectId: "billing", projectWorktreeId: "wp1" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(item).getByTestId("kept-project-delete"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Delete the worktree “billing work”?");
    expect(dialog.textContent).toContain("Its worktrees in 2 repos and the project files are deleted. This cannot be undone.");
    expect(calls(fetchMock, "DELETE", "/api/projects/billing/worktrees/wp1")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete worktree" }));
    await waitFor(() => expect(calls(fetchMock, "DELETE", "/api/projects/billing/worktrees/wp1")).toHaveLength(1));
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
    await waitFor(() => expect((within(dialog).getByTestId("new-terminal-base") as HTMLSelectElement).value).toBe("main"));
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]?.[1]?.body))).toEqual({ workspaceId: HELLO, base: "main", title: "build" });
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

    // a does nothing any more (there is no "next idle"), and it still never reaches the terminal.
    const panes = () => [1, 2, 3, 4].map((n) => `${screen.getByTestId(`pane-${n}`).getAttribute("aria-label")}:${screen.getByTestId(`pane-${n}`).className}`);
    const before = panes();
    prefix();
    expect(filter(new KeyboardEvent("keydown", { key: "a" }))).toBe(false);
    fireEvent.keyDown(window, { key: "a" });
    expect(screen.queryByTestId("prefix-hint")).toBeNull();
    expect(panes()).toEqual(before);
    expect(screen.queryByRole("dialog")).toBeNull();
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

  it("?workspace= opens the dialog prefilled once (StrictMode), posts only on Create, then becomes ?focus=", async () => {
    const fetchMock = serve([]);
    mount(`/terminals?workspace=${HELLO}`, true);
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    await waitFor(() => expect((within(dialog).getByTestId("new-terminal-workspace") as HTMLSelectElement).value).toBe(HELLO));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/terminals"));
    await waitFor(() => expect((within(dialog).getByTestId("new-terminal-base") as HTMLSelectElement).value).toBe("main"));
    expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(0);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    expect(await screen.findByTestId("terminal-view-t1")).toBeTruthy();
    expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1);
    expect(JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]?.[1]?.body))).toEqual({ workspaceId: HELLO, base: "main" });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/terminals?focus=t1"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a project's terminals in its own section, after the workspaces and before Workspaces root", async () => {
    serve([...TERMS, term("t7", { title: "billing", cwd: "/ws/.projects/billing", projectId: "billing" }), term("t8", { title: "old", projectId: "gone" })]);
    mount();
    const section = await screen.findByTestId("section-project:billing");
    await waitFor(() => expect(section.querySelector(".tsb-section-label")?.textContent).toBe("billing"));
    expect(within(section).getByTestId("terminal-item-t7")).toBeTruthy();
    const keys = [...screen.getByTestId("terminal-list").querySelectorAll(".tsb-section")].map((s) => s.getAttribute("data-testid"));
    expect(keys).toEqual([`section-ws:${HELLO}`, `section-ws:${TOOLS}`, "section-project:billing", "section-project:gone", "section-root"]);
    expect(within(screen.getByTestId("section-root")).queryByTestId("terminal-item-t7")).toBeNull();
  });

  it("?project=&agent= opens the agent dialog on the project (StrictMode); Create posts and becomes ?focus=", async () => {
    const fetchMock = serve([]);
    mount("/terminals?project=billing&agent=claude", true);
    const dialog = await screen.findByRole("dialog", { name: "New Claude Code terminal" });
    await waitFor(() => expect((within(dialog).getByTestId("new-terminal-workspace") as HTMLSelectElement).value).toBe("project:billing"));
    expect(within(dialog).queryByTestId("new-terminal-base")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/terminals"));
    expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(0);
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    expect(await screen.findByTestId("terminal-view-t1")).toBeTruthy();
    expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1);
    expect(JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]?.[1]?.body))).toEqual({ projectId: "billing", agent: "claude" });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/terminals?focus=t1"));
    expect(within(screen.getByTestId("section-project:billing")).getByTestId("terminal-item-t1")).toBeTruthy();
  });

  it("?project= alone opens the plain dialog on the project; an unknown agent is ignored", async () => {
    const fetchMock = serve([]);
    mount("/terminals?project=billing", true);
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    await waitFor(() => expect((within(dialog).getByTestId("new-terminal-workspace") as HTMLSelectElement).value).toBe("project:billing"));
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    expect(await screen.findByTestId("terminal-view-t1")).toBeTruthy();
    expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1);
    expect(JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]?.[1]?.body))).toEqual({ projectId: "billing" });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/terminals?focus=t1"));
    cleanup();
    const second = serve([]);
    mount("/terminals?project=billing&agent=vim");
    const plain = await screen.findByRole("dialog", { name: "New terminal" });
    await waitFor(() => expect((within(plain).getByTestId("new-terminal-workspace") as HTMLSelectElement).value).toBe("project:billing"));
    fireEvent.click(within(plain).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(second, "POST", "/api/terminals")).toHaveLength(1));
    expect(JSON.parse(String(calls(second, "POST", "/api/terminals")[0]?.[1]?.body))).toEqual({ projectId: "billing" });
  });

  describe("Base branch", () => {
    const openOn = async (wsId: string) => {
      mount(`/terminals?workspace=${wsId}`);
      const dialog = await screen.findByRole("dialog", { name: "New terminal" });
      await waitFor(() => expect((within(dialog).getByTestId("new-terminal-workspace") as HTMLSelectElement).value).toBe(wsId));
      return dialog;
    };
    const options = (el: HTMLElement) => [...(el as HTMLSelectElement).options].map((o) => o.value);
    const body = (fetchMock: ReturnType<typeof serve>) => JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]?.[1]?.body)) as Record<string, unknown>;

    it("lists local branches before the fetch answers, preselects the default, then refreshes; Create posts the base", async () => {
      let release!: () => void;
      branchHooks.gate = new Promise<void>((r) => (release = r));
      branchHooks.fetched = { branches: ["development", "main", "release"], default: "main", current: "development", fetched: true };
      const fetchMock = serve([]);
      const dialog = await openOn(HELLO);
      const base = within(dialog).getByTestId("new-terminal-base") as HTMLSelectElement;
      await waitFor(() => expect(options(base)).toEqual(["development", "main"]));
      expect(base.value).toBe("main");
      expect(within(dialog).getByTestId("new-terminal-base-loading")).toBeTruthy();
      expect((within(dialog).getByTestId("new-terminal-create") as HTMLButtonElement).disabled).toBe(false);
      await act(async () => release());
      await waitFor(() => expect(options(base)).toEqual(["development", "main", "release"]));
      expect(within(dialog).queryByTestId("new-terminal-base-loading")).toBeNull();
      expect(within(dialog).queryByTestId("new-terminal-base-offline")).toBeNull();
      expect(base.value).toBe("main");
      fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
      await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1));
      expect(body(fetchMock)).toEqual({ workspaceId: HELLO, base: "main" });
    });

    it("keeps a manual choice across the refresh", async () => {
      let release!: () => void;
      branchHooks.gate = new Promise<void>((r) => (release = r));
      branchHooks.fetched = { branches: ["development", "main", "release"], default: "main", fetched: true };
      const fetchMock = serve([]);
      const dialog = await openOn(HELLO);
      const base = within(dialog).getByTestId("new-terminal-base") as HTMLSelectElement;
      await waitFor(() => expect(options(base)).toEqual(["development", "main"]));
      fireEvent.change(base, { target: { value: "development" } });
      await act(async () => release());
      await waitFor(() => expect(options(base)).toContain("release"));
      expect(base.value).toBe("development");
      fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
      await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1));
      expect(body(fetchMock)).toEqual({ workspaceId: HELLO, base: "development" });
    });

    it("a failed fetch shows Offline: local branches, and Create still posts", async () => {
      branchHooks.fetched = { ...LOCAL_BRANCHES, fetched: false, error: "could not reach origin" };
      const fetchMock = serve([]);
      const dialog = await openOn(HELLO);
      expect((await within(dialog).findByTestId("new-terminal-base-offline")).textContent).toBe("Offline: local branches");
      expect(within(dialog).queryByTestId("new-terminal-base-loading")).toBeNull();
      fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
      await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1));
      expect(body(fetchMock)).toEqual({ workspaceId: HELLO, base: "main" });
    });

    it("a workspace without commits disables the dropdown and posts no base", async () => {
      branchHooks.local = { branches: [], noCommit: true };
      branchHooks.fetched = { branches: [], noCommit: true };
      const fetchMock = serve([]);
      const dialog = await openOn(HELLO);
      expect((await within(dialog).findByTestId("new-terminal-base-nocommit")).textContent).toBe("No commits yet: not isolated");
      expect((within(dialog).getByTestId("new-terminal-base") as HTMLSelectElement).disabled).toBe(true);
      fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
      await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1));
      expect(body(fetchMock)).toEqual({ workspaceId: HELLO });
    });

    it("the workspaces root and projects show no Base field", async () => {
      serve([]);
      const dialog = await openOn(HELLO);
      const select = within(dialog).getByTestId("new-terminal-workspace");
      fireEvent.change(select, { target: { value: "" } });
      expect(within(dialog).queryByTestId("new-terminal-base")).toBeNull();
      await waitFor(() => expect(select.querySelector("optgroup[label=Projects]")).toBeTruthy());
      fireEvent.change(select, { target: { value: "project:billing" } });
      expect(within(dialog).queryByTestId("new-terminal-base")).toBeNull();
    });

    it("shows the create answer's warnings", async () => {
      postHooks.answer = (b) => json(201, { ...term("t1", { workspaceId: String(b.workspaceId) }), warnings: ["Could not fetch origin/main; used the local main."] });
      serve([]);
      const dialog = await openOn(HELLO);
      await waitFor(() => expect((within(dialog).getByTestId("new-terminal-base") as HTMLSelectElement).value).toBe("main"));
      fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
      expect(await screen.findByText("Could not fetch origin/main; used the local main.")).toBeTruthy();
    });

    it("the pane header shows the worktree branch and its base", async () => {
      const wt = { id: "wabc", path: "/ws/.gm-worktrees/wabc", branch: "gm-term/wabc", baseBranch: "main" };
      serve([term("t9", { workspaceId: HELLO, process: "bash", worktree: wt })]);
      mount();
      expect((await screen.findByTestId("pane-branch")).textContent).toBe("gm-term/wabc ← main");
    });
  });

  describe("project terminals", () => {
    const WS_A = "github~octo~a";
    const WS_B = "github~octo~b";
    const WS_C = "github~octo~c";
    const options = (el: HTMLElement) => [...(el as HTMLSelectElement).options].map((o) => o.value);

    it("shows one Base row per repo with its default; rows refresh on their own; a no-commit repo is disabled; Create posts bases", async () => {
      projectHooks.branches = {
        repos: [
          { name: "a", workspaceId: WS_A, branches: ["main"], default: "main" },
          { name: "b", workspaceId: WS_B, branches: ["main", "develop"], default: "main" },
          { name: "c", workspaceId: WS_C, branches: [], noCommit: true },
        ],
      };
      let releaseA!: () => void;
      let releaseB!: () => void;
      projectHooks.fetched[WS_A] = { answer: { branches: ["main", "next"], default: "main", fetched: true }, gate: new Promise<void>((r) => (releaseA = r)) };
      projectHooks.fetched[WS_B] = { answer: { branches: ["main", "develop"], default: "main", fetched: false }, gate: new Promise<void>((r) => (releaseB = r)) };
      const fetchMock = serve([]);
      mount("/terminals?project=billing");
      const dialog = await screen.findByRole("dialog", { name: "New terminal" });
      const a = (await within(dialog).findByTestId("new-terminal-base-a")) as HTMLSelectElement;
      const b = within(dialog).getByTestId("new-terminal-base-b") as HTMLSelectElement;
      const c = within(dialog).getByTestId("new-terminal-base-c") as HTMLSelectElement;
      expect(a.value).toBe("main");
      expect(b.value).toBe("main");
      expect(c.disabled).toBe(true);
      expect(within(dialog).getByTestId("new-terminal-base-nocommit-c").textContent).toBe("No commits yet: not isolated");
      expect(within(dialog).getByTestId("new-terminal-base-loading-a")).toBeTruthy();
      expect(within(dialog).getByTestId("new-terminal-base-loading-b")).toBeTruthy();
      expect(within(dialog).queryByTestId("new-terminal-base-loading-c")).toBeNull();
      expect((within(dialog).getByTestId("new-terminal-create") as HTMLButtonElement).disabled).toBe(false);
      fireEvent.change(b, { target: { value: "develop" } });
      await act(async () => releaseA());
      await waitFor(() => expect(options(a)).toEqual(["main", "next"]));
      expect(within(dialog).queryByTestId("new-terminal-base-loading-a")).toBeNull();
      expect(within(dialog).getByTestId("new-terminal-base-loading-b")).toBeTruthy();
      await act(async () => releaseB());
      expect((await within(dialog).findByTestId("new-terminal-base-offline-b")).textContent).toBe("Offline: local branches");
      expect(within(dialog).queryByTestId("new-terminal-base-offline-a")).toBeNull();
      expect(b.value).toBe("develop");
      fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
      await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1));
      expect(JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]?.[1]?.body))).toEqual({ projectId: "billing", bases: { a: "main", b: "develop" } });
    });

    const projectWt = {
      id: "wp1",
      path: "/ws/.projects/billing/.gm-worktrees/wp1",
      branch: "gm-term/wp1",
      repos: [
        { name: "a", branch: "gm-term/wp1", baseBranch: "main", isolated: true },
        { name: "c", isolated: false },
      ],
    };

    it("the pane header shows a chip per repo", async () => {
      serve([term("t1", { title: "proj", process: "bash", projectId: "billing", worktree: projectWt })]);
      mount();
      expect((await screen.findByTestId("pane-branch")).textContent).toBe("gm-term/wp1");
      expect(screen.getByTestId("pane-repo-a").textContent).toBe("a: main");
      expect(screen.getByTestId("pane-repo-c").textContent).toBe("c: not isolated");
    });

    it("closing a project terminal with work shows the work table; Cancel, Keep all and Delete all", async () => {
      projectHooks.work = {
        project: { dirty: 1, ahead: 0 },
        repos: [
          { name: "a", isolated: true, dirty: 2, ahead: 1 },
          { name: "c", isolated: false, dirty: 0, ahead: 0 },
        ],
      };
      const fetchMock = serve([
        term("t1", { title: "proj", process: "bash", projectId: "billing", worktree: projectWt }),
        term("t2", { title: "proj2", process: "bash", projectId: "billing", worktree: { ...projectWt, id: "wp2", branch: "gm-term/wp2" } }),
      ]);
      withWork.add("t1");
      withWork.add("t2");
      mount();
      fireEvent.click(await screen.findByTestId("terminal-item-t1"));
      fireEvent.click(screen.getByTestId("pane-close-1"));
      const dialog = await screen.findByTestId("worktree-close");
      const rows = [...within(dialog).getByTestId("close-work-table").querySelectorAll("tr")].map((r) => [...r.children].map((c) => c.textContent));
      expect(rows).toEqual([
        ["Project files", "1 uncommitted file"],
        ["a", "2 uncommitted files and 1 commit"],
        ["c", "not isolated"],
      ]);
      expect(within(dialog).getByTestId("close-delete").textContent).toBe("Delete all");
      expect(within(dialog).getByTestId("close-keep").textContent).toBe("Keep all");
      expect(within(dialog).getByTestId("close-pr").textContent).toBe("Create PR");
      fireEvent.click(within(dialog).getByRole("button", { name: /Cancel/ }));
      expect(screen.queryByTestId("worktree-close")).toBeNull();
      expect(screen.getByTestId("terminal-item-t1")).toBeTruthy();
      fireEvent.click(screen.getByTestId("pane-close-1"));
      fireEvent.click(await screen.findByTestId("close-keep"));
      await waitFor(() => expect(calls(fetchMock, "DELETE", "/api/terminals/t1?worktree=keep")).toHaveLength(1));
      await waitFor(() => expect(screen.queryByTestId("terminal-item-t1")).toBeNull());
      fireEvent.click(await screen.findByTestId("terminal-item-t2"));
      fireEvent.click(screen.getByTestId("pane-close-1"));
      fireEvent.click(await screen.findByTestId("close-delete"));
      await waitFor(() => expect(calls(fetchMock, "DELETE", "/api/terminals/t2?worktree=delete")).toHaveLength(1));
    });

    it("Merge project files in the close dialog merges, then the row reads merged and the button goes", async () => {
      projectHooks.work = { project: { dirty: 1, ahead: 1 }, repos: [{ name: "a", isolated: true, dirty: 1, ahead: 0 }] };
      const fetchMock = serve([term("t1", { title: "proj", process: "bash", projectId: "billing", worktree: projectWt })]);
      withWork.add("t1");
      mount();
      fireEvent.click(await screen.findByTestId("terminal-item-t1"));
      fireEvent.click(screen.getByTestId("pane-close-1"));
      const dialog = await screen.findByTestId("worktree-close");
      fireEvent.click(within(dialog).getByTestId("close-merge-project"));
      await waitFor(() => expect(within(dialog).queryByTestId("close-merge-project")).toBeNull());
      expect(calls(fetchMock, "POST", "/api/terminals/t1/merge-project")).toHaveLength(1);
      expect(within(dialog).getByTestId("close-project-work").textContent).toBe("merged");
      expect(within(dialog).queryByTestId("close-merge-error")).toBeNull();
      // The repo still holds work: the dialog stays for Keep all / Delete all.
      expect(within(dialog).getByTestId("close-keep")).toBeTruthy();
    });

    it("a merge conflict in the close dialog names the files and keeps the button", async () => {
      projectHooks.work = { project: { dirty: 2, ahead: 0 }, repos: [] };
      projectHooks.merge = { status: 409, body: { error: "merge conflict", files: ["a.md", "b.md"] } };
      serve([term("t1", { title: "proj", process: "bash", projectId: "billing", worktree: projectWt })]);
      withWork.add("t1");
      mount();
      fireEvent.click(await screen.findByTestId("terminal-item-t1"));
      fireEvent.click(screen.getByTestId("pane-close-1"));
      const dialog = await screen.findByTestId("worktree-close");
      fireEvent.click(within(dialog).getByTestId("close-merge-project"));
      const alert = await within(dialog).findByTestId("close-merge-error");
      expect(alert.getAttribute("role")).toBe("alert");
      expect(alert.textContent).toBe("Merge conflict in: a.md, b.md. The worktree stays; resolve it in a terminal on it.");
      expect(within(dialog).getByTestId("close-project-work").textContent).toBe("2 uncommitted files");
      expect(within(dialog).getByTestId("close-merge-project")).toBeTruthy();
    });

    it("hides Merge project files when only the repos hold work", async () => {
      projectHooks.work = { project: { dirty: 0, ahead: 0 }, repos: [{ name: "a", isolated: true, dirty: 1, ahead: 0 }] };
      serve([term("t1", { title: "proj", process: "bash", projectId: "billing", worktree: projectWt })]);
      withWork.add("t1");
      mount();
      fireEvent.click(await screen.findByTestId("terminal-item-t1"));
      fireEvent.click(screen.getByTestId("pane-close-1"));
      const dialog = await screen.findByTestId("worktree-close");
      expect(within(dialog).queryByTestId("close-merge-project")).toBeNull();
    });
  });

  it("Merge project files on a kept project worktree posts the merge and toasts; a conflict toasts the files", async () => {
    const kept: KeptProjectWorktree = {
      id: "wp1",
      projectId: "billing",
      path: "/ws/.projects/billing/.gm-worktrees/wp1",
      branch: "gm-term/wp1",
      title: "billing work",
      createdAt: ago(60),
      project: { dirty: 1, ahead: 0 },
      repos: [],
    };
    keptProjectList.push(kept, { ...kept, id: "wp2", title: "repo work", project: { dirty: 0, ahead: 0 }, repos: [{ name: "hello", isolated: true, dirty: 1, ahead: 0 }] });
    const fetchMock = serve([]);
    mount();
    const items = await screen.findAllByTestId("kept-project-worktree");
    expect(within(items[1]!).queryByTestId("kept-project-merge")).toBeNull();
    fireEvent.click(within(items[0]!).getByTestId("kept-project-merge"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/projects/billing/worktrees/wp1/merge-project")).toHaveLength(1));
    expect(await screen.findByText("Merged project files")).toBeTruthy();
    projectHooks.merge = { status: 409, body: { error: "merge conflict", files: ["project.json"] } };
    fireEvent.click(within(items[0]!).getByTestId("kept-project-merge"));
    expect(await screen.findByText("Merge conflict in: project.json")).toBeTruthy();
  });

  it("Create PR from the project close dialog has one Merge into per changed repo and posts the bases", async () => {
    projectHooks.work = {
      project: { dirty: 0, ahead: 0 },
      repos: [
        { name: "a", isolated: true, dirty: 1, ahead: 0 },
        { name: "b", isolated: true, dirty: 0, ahead: 2 },
        { name: "c", isolated: true, dirty: 0, ahead: 0 },
      ],
    };
    const wt = {
      id: "wp1",
      path: "/ws/.projects/billing/.gm-worktrees/wp1",
      branch: "gm-term/wp1",
      repos: [
        { name: "a", branch: "gm-term/wp1", baseBranch: "main", isolated: true },
        { name: "b", branch: "gm-term/wp1", baseBranch: "main", isolated: true },
        { name: "c", branch: "gm-term/wp1", baseBranch: "main", isolated: true },
      ],
    };
    const fetchMock = serve([term("t1", { title: "proj", process: "bash", projectId: "billing", worktree: wt })]);
    withWork.add("t1");
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t1"));
    fireEvent.click(screen.getByTestId("pane-close-1"));
    fireEvent.click(await screen.findByTestId("close-pr"));
    const dialog = await screen.findByTestId("project-worktree-pr");
    expect((within(dialog).getByTestId("project-pr-title") as HTMLInputElement).value).toBe("proj");
    expect((within(dialog).getByTestId("pr-base-a") as HTMLInputElement).value).toBe("main");
    expect((within(dialog).getByTestId("pr-base-b") as HTMLInputElement).value).toBe("main");
    expect(within(dialog).queryByTestId("pr-base-c")).toBeNull();
    expect(within(dialog).getByTestId("project-pr-skip-c").textContent).toContain("no changes · skipped");
    fireEvent.click(within(dialog).getByTestId("project-pr-submit"));
    const url = "/api/projects/billing/worktrees/wp1/pr";
    await waitFor(() => expect(calls(fetchMock, "POST", url)).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, "POST", url)[0]![1]!.body))).toEqual({ title: "proj", body: "", bases: { a: "main", b: "main" } });
    expect((await screen.findByTestId("project-pr-link-a", {}, { timeout: 3000 })).textContent).toBe("#3 ↗");
    expect(screen.getByTestId("project-pr-link-b").textContent).toBe("#4 ↗");
    await waitFor(() => expect(screen.queryByTestId("terminal-item-t1")).toBeNull());
  });

  it("the New terminal dialog lists the projects; Create with one posts its projectId", async () => {
    const fetchMock = serve();
    mount();
    await screen.findByTestId("terminal-item-t2");
    fireEvent.click(screen.getByTestId("new-terminal"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    const select = within(dialog).getByTestId("new-terminal-workspace") as HTMLSelectElement;
    await waitFor(() => expect(select.querySelector("optgroup[label=Projects]")).toBeTruthy());
    const group = select.querySelector("optgroup[label=Projects]")!;
    expect([...group.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["billing"]);
    fireEvent.change(select, { target: { value: "project:billing" } });
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]?.[1]?.body))).toEqual({ projectId: "billing" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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

  describe("floating spec pane", () => {
    const specCalls = (fetchMock: ReturnType<typeof serve>, ws: string) => calls(fetchMock, "GET").filter(([u]) => String(u) === `/api/workspaces/${encodeURIComponent(ws)}/specs`);
    const setSpec = (mtimeMs: number, text: string) => {
      specs[HELLO] = [{ path: "docs/prd/a.md", name: "a.md", title: "A", mtimeMs, size: text.length }];
      specFiles[`${HELLO}:docs/prd/a.md`] = { text, mtimeMs };
    };
    const POLL = { timeout: 3500 };

    it("opens when a spec is created (never on edits), follows it, closes, and reopens from the chip (KAN-99)", async () => {
      setSpec(100, "# A v1");
      const fetchMock = serve();
      mount();
      // t2 (octo/hello) fills the screen; the first answer only records the specs that exist.
      expect(await screen.findByTestId("terminal-view-t2")).toBeTruthy();
      await waitFor(() => expect(specCalls(fetchMock, HELLO).length).toBeGreaterThan(0));
      const chip = await screen.findByTestId("pane-spec-chip");
      expect(chip.textContent).toBe("spec a.md");
      expect(screen.queryByTestId("spec-float")).toBeNull();

      // An edit of an existing spec does not open the pane.
      setSpec(200, "# A v2");
      const before = specCalls(fetchMock, HELLO).length;
      await waitFor(() => expect(specCalls(fetchMock, HELLO).length).toBeGreaterThan(before), POLL);
      await act(async () => {});
      expect(screen.queryByTestId("spec-float")).toBeNull();

      // A new spec is created: the pane opens within a poll, with the file's text.
      specs[HELLO] = [{ path: "docs/prd/b.md", name: "b.md", title: "B", mtimeMs: 300, size: 6 }, ...specs[HELLO]!];
      specFiles[`${HELLO}:docs/prd/b.md`] = { text: "# B v1", mtimeMs: 300 };
      const float = await screen.findByTestId("spec-float", {}, POLL);
      expect(float.getAttribute("role")).toBe("dialog");
      expect(float.getAttribute("aria-label")).toBe("Spec b.md");
      expect(float.getAttribute("aria-modal")).toBe("false");
      expect(float.textContent).toContain("docs/prd/b.md");
      await waitFor(() => expect(within(float).getByTestId("spec-view").textContent).toBe("# B v1"));

      // It follows the file while it is written.
      specs[HELLO]![0] = { ...specs[HELLO]![0]!, mtimeMs: 350 };
      specFiles[`${HELLO}:docs/prd/b.md`] = { text: "# B v2", mtimeMs: 350 };
      await waitFor(() => expect(within(screen.getByTestId("spec-float")).getByTestId("spec-view").textContent).toBe("# B v2"), POLL);

      // Close; more edits do not reopen it; the chip brings it back; Escape inside closes it again.
      fireEvent.click(screen.getByTestId("spec-close"));
      expect(screen.queryByTestId("spec-float")).toBeNull();
      specs[HELLO]![0] = { ...specs[HELLO]![0]!, mtimeMs: 400 };
      const seen = specCalls(fetchMock, HELLO).length;
      await waitFor(() => expect(specCalls(fetchMock, HELLO).length).toBeGreaterThan(seen), POLL);
      await act(async () => {});
      expect(screen.queryByTestId("spec-float")).toBeNull();
      expect(screen.getByTestId("pane-spec-chip").textContent).toBe("spec b.md");
      fireEvent.click(screen.getByTestId("pane-spec-chip"));
      const again = await screen.findByTestId("spec-float");
      fireEvent.keyDown(within(again).getByTestId("spec-body"), { key: "Escape" });
      expect(screen.queryByTestId("spec-float")).toBeNull();
    }, 20_000);

    it("watches a worktree terminal's own specs, not the workspace's (KAN-99)", async () => {
      const wt = { id: "wabc", path: "/ws/.gm-worktrees/wabc", branch: "gm-term/wabc" };
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ layout: 1, tabs: ["t:t9"], panes: ["t:t9", null, null, null], focused: 0 }));
      specs["term:t9"] = [{ path: "docs/prd/mine.md", name: "mine.md", title: "Mine", mtimeMs: 10, size: 4 }];
      const fetchMock = serve([term("t9", { workspaceId: HELLO, process: "bash", worktree: wt })]);
      mount();
      expect(await screen.findByTestId("terminal-view-t9")).toBeTruthy();
      expect((await screen.findByTestId("pane-spec-chip")).textContent).toBe("spec mine.md");
      expect(calls(fetchMock, "GET").some(([u]) => String(u) === "/api/terminals/t9/specs")).toBe(true);
      expect(specCalls(fetchMock, HELLO)).toHaveLength(0);
    });

    it("a deleted spec shows a note", async () => {
      setSpec(100, "# A");
      serve();
      mount();
      fireEvent.click(await screen.findByTestId("pane-spec-chip"));
      expect(await screen.findByTestId("spec-view")).toBeTruthy();
      delete specFiles[`${HELLO}:docs/prd/a.md`];
      await waitFor(() => expect(screen.getByTestId("spec-float").textContent).toContain("This spec was moved or deleted."), POLL);
    }, 10_000);

    it("a terminal without a workspace asks for no specs", async () => {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ layout: 1, tabs: ["t:t3"], panes: ["t:t3", null, null, null], focused: 0 }));
      const fetchMock = serve();
      mount();
      expect(await screen.findByTestId("terminal-view-t3")).toBeTruthy();
      await waitFor(() => expect(calls(fetchMock, "GET", "/api/workspaces").length).toBeGreaterThan(0));
      await act(async () => {});
      expect(calls(fetchMock, "GET").filter(([u]) => String(u).includes("/specs"))).toHaveLength(0);
      expect(screen.queryByTestId("pane-spec-chip")).toBeNull();
    });
  });

  it("shows one button per agent and a Plain terminal button; a CLI that is not installed is disabled", async () => {
    serve();
    mount();
    await waitFor(() => expect((screen.getByTestId("agent-btn-codex") as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId("agent-btn-codex").getAttribute("title")).toBe("codex is not installed");
    for (const [id, label] of [["claude", "Claude Code"], ["opencode", "OpenCode"], ["qwen", "Qwen Code"]] as const) {
      const b = screen.getByTestId(`agent-btn-${id}`) as HTMLButtonElement;
      expect(b.textContent).toBe(label);
      expect(b.disabled).toBe(false);
      expect(within(b).getByTestId(`agent-icon-${id}`)).toBeTruthy();
      expect(b.className).toContain(`agent-${id}`);
    }
    expect(screen.getByTestId("new-terminal").textContent).toContain("Plain terminal");
    fireEvent.click(screen.getByTestId("new-terminal"));
    expect(await screen.findByRole("dialog", { name: "New terminal" })).toBeTruthy();
  });

  it("an agent button opens its dialog; Create posts the agent, shows Connecting tools… and opens the pane", async () => {
    const fetchMock = serve();
    mount();
    await waitFor(() => expect((screen.getByTestId("agent-btn-codex") as HTMLButtonElement).disabled).toBe(true));
    let release!: () => void;
    postHooks.gate = new Promise<void>((r) => (release = r));
    fireEvent.click(screen.getByTestId("agent-btn-claude"));
    const dialog = await screen.findByRole("dialog", { name: "New Claude Code terminal" });
    expect(within(dialog).getByText("New Claude Code terminal")).toBeTruthy();
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1));
    expect(JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]?.[1]?.body))).toMatchObject({ agent: "claude" });
    await waitFor(() => expect(within(dialog).getByTestId("new-terminal-create").textContent).toBe("Connecting tools…"));
    expect((within(dialog).getByTestId("new-terminal-create") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("agent-btn-claude").textContent).toBe("Connecting tools…");
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByTestId("terminal-view-t5")).toBeTruthy();
    expect(screen.getByTestId("agent-btn-claude").textContent).toBe("Claude Code");
    expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(1);
  });

  it("Qwen Code needs a workspace, hints at the commit, and shows a 409 in the dialog, which stays open", async () => {
    const fetchMock = serve();
    mount();
    await waitFor(() => expect((screen.getByTestId("agent-btn-codex") as HTMLButtonElement).disabled).toBe(true));
    postHooks.answer = (body) => (body.agent === "qwen" ? json(409, { error: "cannot commit .qwen/settings.json: it has uncommitted changes" }) : undefined);
    fireEvent.click(screen.getByTestId("agent-btn-qwen"));
    const dialog = await screen.findByRole("dialog", { name: "New Qwen Code terminal" });
    const select = within(dialog).getByTestId("new-terminal-workspace") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).not.toContain("Workspaces root");
    await waitFor(() => expect(select.value).toBe(HELLO));
    expect(dialog.textContent).toContain("Commits .qwen/settings.json once");
    await waitFor(() => expect((within(dialog).getByTestId("new-terminal-base") as HTMLSelectElement).value).toBe("main"));
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    expect((await within(dialog).findByTestId("new-terminal-error")).textContent).toBe("cannot commit .qwen/settings.json: it has uncommitted changes");
    expect(screen.getByRole("dialog", { name: "New Qwen Code terminal" })).toBeTruthy();
    expect(JSON.parse(String(calls(fetchMock, "POST", "/api/terminals")[0]?.[1]?.body))).toEqual({ workspaceId: HELLO, base: "main", agent: "qwen" });
    expect(within(dialog).getByTestId("new-terminal-create").textContent).toBe("Create");
    expect((screen.getByTestId("agent-btn-claude") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows an agent terminal's logo, with its label for screen readers only", async () => {
    serve([...TERMS, term("t9", { title: "agent", agent: "claude" })]);
    mount();
    await waitFor(() => expect(screen.getByTestId("agent-label-t9").textContent).toBe(", Claude Code"));
    expect(screen.getByTestId("agent-label-t9").className).toBe("visually-hidden");
    expect(screen.queryByTestId("agent-label-t1")).toBeNull();
    expect(within(screen.getByTestId("terminal-item-t9")).getByTestId("agent-icon-claude")).toBeTruthy();
  });
});

describe("extra keys", () => {
  /** Opens t2 and puts DOM focus inside its terminal body (the mock's button). */
  async function openAndFocus(coarse: boolean) {
    stubCoarse(coarse);
    serve();
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t2"));
    expect(screen.queryByTestId("extra-keys")).toBeNull();
    act(() => (screen.getByText("sim-exit-t2") as HTMLButtonElement).focus());
  }

  it("with a coarse pointer and a focused terminal the row shows and sends keys", async () => {
    await openAndFocus(true);
    expect(screen.getByTestId("extra-keys")).toBeTruthy();
    expect(screen.getByTestId("page-terminals").className).toContain("xk");
    expect(document.documentElement.classList.contains("xk-open")).toBe(true);
    fireEvent.click(screen.getByTestId("xk-esc"));
    expect(inputs).toContainEqual(["t2", "\x1b"]);
    fireEvent.click(screen.getByTestId("xk-up"));
    expect(inputs).toContainEqual(["t2", "\x1b[A"]);
  });

  it("xk-prefix arms the prefix", async () => {
    await openAndFocus(true);
    fireEvent.click(screen.getByTestId("xk-prefix"));
    expect(screen.getByTestId("prefix-hint")).toBeTruthy();
    expect(keyFilters.get("t2")!(new KeyboardEvent("keydown", { key: "n" }))).toBe(false);
    // Android reports the next key as "Unidentified"; the window listener leaves it to onData.
    fireEvent.keyDown(window, { key: "Unidentified", keyCode: 229 });
    expect(screen.getByTestId("prefix-hint")).toBeTruthy();
    let swallowed = false;
    act(() => {
      swallowed = prefixDatas.get("t2")!("n");
    });
    expect(swallowed).toBe(true);
    expect(await screen.findByRole("dialog", { name: "New terminal" })).toBeTruthy();
    expect(screen.queryByTestId("prefix-hint")).toBeNull();
    // Unarmed, typed data goes through.
    expect(prefixDatas.get("t2")!("n")).toBe(false);
  });

  it("sticky Ctrl turns on with xk-ctrl and clears after one use or a pane change", async () => {
    await openAndFocus(true);
    const ctrl = () => screen.getByTestId("xk-ctrl");
    fireEvent.click(ctrl());
    expect(ctrl().getAttribute("aria-pressed")).toBe("true");
    expect(ctrlArmeds.get("t2")!()).toBe(true);
    act(() => ctrlUseds.get("t2")!());
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
    expect(ctrlArmeds.get("t2")!()).toBe(false);

    fireEvent.click(ctrl());
    expect(ctrl().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("layout-2"));
    fireEvent.mouseDown(screen.getByTestId("pane-2"));
    expect(screen.getByTestId("pane-2").className).toContain("focused");
    expect(ctrl().getAttribute("aria-pressed")).toBe("false");
  });

  it("no extra keys with a fine pointer", async () => {
    await openAndFocus(false);
    expect(screen.queryByTestId("extra-keys")).toBeNull();
    expect(screen.getByTestId("page-terminals").className).not.toContain("xk");
  });

  it("the row hides when focus leaves the terminals", async () => {
    await openAndFocus(true);
    expect(screen.getByTestId("extra-keys")).toBeTruthy();
    act(() => (screen.getByTestId("new-terminal") as HTMLButtonElement).focus());
    expect(screen.queryByTestId("extra-keys")).toBeNull();
    expect(document.documentElement.classList.contains("xk-open")).toBe(false);
  });
});
