// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewProvider } from "../overview";
import type { AgentInfo, ForgeRepoEntry, ProjectEntry, RunSummary, SessionInfo, TerminalInfo } from "../types";
import { ToastProvider } from "../ui/toast";
import { LAYOUT_KEY } from "./layout";
import Terminals, { isShell } from "./Terminals";

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

const term = (id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, title: id, cwd: "/ws", status: "idle", createdAt: ago(600), ...extra });

const TERMS: TerminalInfo[] = [
  term("t1", { title: "fix-auth", workspaceId: TOOLS, status: "idle", lastOutputAt: ago(240), process: "claude" }),
  term("t2", { title: "plan", workspaceId: HELLO, status: "working", process: "bash", workingSince: ago(14), lastOutputAt: ago(1) }),
  term("t3", { title: "scratch", status: "exited", exitCode: 0, lastOutputAt: ago(1320) }),
  term("t4", { title: "runner", workspaceId: HELLO, status: "exited", exitCode: 1 }),
];

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  repo: { forge: "github", owner: "octo", name: "hello" },
  workspaceId: HELLO,
  branch: "gm/admin-20261113-k3x9",
  state: "live",
  startedAt: "2026-11-13T10:00:00.000Z",
  terminals: [],
  ...over,
});

const SESSIONS: SessionInfo[] = [
  session("s-hello", { terminals: ["t2", "t4"] }),
  session("s-tools", {
    repo: { forge: "gitlab", owner: "platform/infra", name: "deploy-tools" },
    workspaceId: TOOLS,
    branch: "gm/admin-20261113-zz11",
    startedAt: "2026-11-13T11:00:00.000Z",
    terminals: ["t1"],
  }),
];

const repoEntry = (forge: "github" | "gitlab", owner: string, name: string, over: Partial<ForgeRepoEntry> = {}): ForgeRepoEntry => ({
  repo: { forge, owner, name },
  fullPath: `${owner}/${name}`,
  defaultBranch: "main",
  private: false,
  webUrl: "",
  live: false,
  ...over,
});

const REPOS: ForgeRepoEntry[] = [
  repoEntry("github", "octo", "hello", { live: true, sessionId: "s-hello", branch: "gm/admin-20261113-k3x9" }),
  repoEntry("github", "octo", "web"),
  repoEntry("github", "octo", "api", { private: true }),
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
  repos: [
    { forge: "github", owner: "octo", name: "hello" },
    { forge: "github", owner: "octo", name: "web" },
  ],
  workspaces: [
    { id: HELLO, fullPath: "octo/hello", repo: "hello" },
    { id: "github~octo~web", fullPath: "octo/web", repo: "web" },
  ],
};

/** Lets a test hold the session POSTs (`gate`), replace their answer (`answer`), or the DELETE answer (`del`). */
const postHooks: {
  gate?: Promise<void>;
  answer?: (url: string, body: Record<string, unknown>) => Response | undefined;
  del?: (id: string) => Response | undefined;
} = {};

/** The fake server's state: terminals and sessions change as the page posts. */
interface Served {
  terminals: TerminalInfo[];
  sessions: SessionInfo[];
  limit: number | null;
  repos: ForgeRepoEntry[];
  forges: { github: boolean; gitlab: boolean };
}

let server: Served;

function serve(initial: TerminalInfo[] = TERMS, opts: { sessions?: SessionInfo[]; limit?: number | null; repos?: ForgeRepoEntry[]; forges?: Served["forges"] } = {}) {
  server = {
    terminals: [...initial],
    sessions: (opts.sessions ?? SESSIONS).map((x) => ({ ...x, terminals: [...x.terminals] })),
    limit: opts.limit ?? null,
    repos: opts.repos ?? REPOS,
    forges: opts.forges ?? { github: true, gitlab: false },
  };
  const { terminals, sessions } = server;
  const newTerminal = (extra: Partial<TerminalInfo>) => {
    const t = term(`t${terminals.length + 1}`, extra);
    terminals.push(t);
    return t;
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = () => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url === "/api/agents") return json(200, { agents: AGENTS });
    if (url === "/api/projects") return json(200, { projects: [BILLING] });
    if (url === "/api/auth/me") return json(200, { user: { id: "admin", name: "admin" }, mode: "users" });
    if (url === "/api/sessions" && method === "GET") return json(200, { sessions, limit: server.limit });
    if (url.startsWith("/api/repos?q=")) {
      const q = decodeURIComponent(url.slice("/api/repos?q=".length)).toLowerCase();
      return json(200, { repos: server.repos.filter((r) => r.fullPath.toLowerCase().includes(q)), forges: server.forges });
    }
    if (url.startsWith("/api/repos/branches?")) return json(200, { defaultBranch: "main", branches: ["main", "dev", "feature/x"] });
    if (url === "/api/sessions" && method === "POST") {
      const b = body();
      if (postHooks.gate) await postHooks.gate;
      const answer = postHooks.answer?.(url, b);
      if (answer) return answer;
      if (b.projectId) {
        if (b.projectId !== BILLING.id) return json(404, { error: "project not found" });
        const branchReq = b.branch as { new?: string; existing?: string } | undefined;
        const branch = branchReq?.existing ?? branchReq?.new ?? "gm/admin-20261113-srv1";
        const id = `s-new${sessions.length + 1}`;
        const ws = `project~${BILLING.id}`;
        const t = newTerminal({ title: BILLING.name, workspaceId: ws, projectId: BILLING.id, sessionId: id, ...(b.agent ? { agent: b.agent as TerminalInfo["agent"] } : {}) });
        sessions.push(session(id, { repo: BILLING.repos[0]!, projectId: BILLING.id, workspaceId: ws, branch, startedAt: new Date().toISOString(), terminals: [t.id] }));
        return json(201, { sessionId: id, terminalId: t.id, branch });
      }
      const repo = b.repo as { forge: "github" | "gitlab"; owner: string; name: string };
      const ws = `${repo.forge}~${repo.owner.split("/").join("~")}~${repo.name}`;
      const branchReq = b.branch as { new?: string; existing?: string } | undefined;
      const branch = branchReq?.existing ?? branchReq?.new ?? "gm/admin-20261113-srv1";
      const id = `s-new${sessions.length + 1}`;
      const t = newTerminal({ title: (b.title as string) ?? repo.name, workspaceId: ws, sessionId: id, ...(b.agent ? { agent: b.agent as TerminalInfo["agent"] } : {}) });
      sessions.push(session(id, { repo, workspaceId: ws, branch, startedAt: new Date().toISOString(), terminals: [t.id] }));
      return json(201, { sessionId: id, terminalId: t.id, branch });
    }
    const st = /^\/api\/sessions\/([^/]+)\/terminals$/.exec(url);
    if (st && method === "POST") {
      const b = body();
      if (postHooks.gate) await postHooks.gate;
      const answer = postHooks.answer?.(url, b);
      if (answer) return answer;
      const x = sessions.find((y) => y.id === decodeURIComponent(st[1]!));
      if (!x) return json(404, { error: "session not found" });
      const t = newTerminal({ title: (b.title as string) ?? "new", workspaceId: x.workspaceId, sessionId: x.id, ...(b.agent ? { agent: b.agent as TerminalInfo["agent"] } : {}) });
      x.terminals.push(t.id);
      return json(201, t);
    }
    const sc = /^\/api\/sessions\/([^/]+)\/close$/.exec(url);
    if (sc && method === "POST") {
      const action = body().action as string;
      const answer = postHooks.answer?.(url, { action });
      if (answer) return answer;
      const i = sessions.findIndex((y) => y.id === decodeURIComponent(sc[1]!));
      if (i < 0) return json(404, { error: "session not found" });
      const x = sessions[i]!;
      if (action === "keep") {
        x.state = "live";
        return json(200, { session: x });
      }
      sessions.splice(i, 1);
      return json(200, { session: { ...x, state: "ending" }, ...(action === "push" ? { skipped: [] } : {}) });
    }
    if (url === "/api/terminals") return json(200, { terminals });
    const m = /^\/api\/terminals\/([^/]+)(\/restart)?$/.exec(url);
    if (m && method === "DELETE") {
      const i = terminals.findIndex((t) => t.id === m[1]);
      if (i >= 0) terminals.splice(i, 1);
      for (const x of sessions) x.terminals = x.terminals.filter((id) => id !== m[1]);
      const answer = postHooks.del?.(m[1]!);
      if (answer) return answer;
      return new Response(null, { status: 204 });
    }
    if (m && m[2] && method === "POST") return json(200, { ...terminals.find((t) => t.id === m[1]), status: "idle", exitCode: undefined });
    if (m && method === "PATCH") return json(200, { ...terminals.find((t) => t.id === m[1]), ...(JSON.parse(String(init?.body)) as object) });
    if (url === "/api/runs") return json(200, { runs: RUNS });
    if (url.startsWith("/api/runs/")) return json(200, { summary: RUNS[0], graph: { nodes: [], edges: [], layers: [] } });
    const sp = /^\/api\/workspaces\/([^/]+)\/specs(\/file\?path=(.*))?$/.exec(url);
    if (sp && sp[2]) {
      const path = decodeURIComponent(sp[3] ?? "");
      const f = specFiles[`${decodeURIComponent(sp[1]!)}:${path}`];
      return f ? json(200, { path, ...f }) : json(404, { error: "not found" });
    }
    if (sp) return json(200, { specs: specs[decodeURIComponent(sp[1]!)] ?? [] });
    if (url === "/api/forges") return json(200, { github: { connected: true }, gitlab: { connected: false } });
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
/** The JSON body of the `n`th call (default: the last) of `method url`. */
const bodyOf = (fetchMock: ReturnType<typeof serve>, method: string, url: string, n = -1) => {
  const list = calls(fetchMock, method, url);
  return JSON.parse(String(list.at(n)?.[1]?.body ?? "null")) as unknown;
};

const prefix = () => fireEvent.keyDown(window, { key: " ", code: "Space", ctrlKey: true });

beforeEach(() => {
  localStorage.clear();
  for (const k of Object.keys(specs)) delete specs[k];
  for (const k of Object.keys(specFiles)) delete specFiles[k];
  keyFilters.clear();
  delete postHooks.gate;
  delete postHooks.answer;
  delete postHooks.del;
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

describe("Terminals page", () => {
  it("groups the sidebar by session (startedAt order) with branch and state, then Other terminals; the process is the sub-line", async () => {
    serve();
    mount();
    const hello = await screen.findByTestId("section-session:s-hello");
    expect(hello.querySelector(".tsb-section-label")?.textContent).toBe("octo/hello");
    expect(screen.getByTestId("session-branch-s-hello").textContent).toBe("gm/admin-20261113-k3x9");
    expect(screen.getByTestId("session-state-s-hello").textContent).toBe("live");
    expect(screen.getByTestId("section-session:s-tools").querySelector(".tsb-section-label")?.textContent).toBe("platform/infra/deploy-tools");
    // Sessions in startedAt order; a terminal of no session goes to "Other terminals"; no NEEDS YOU section (GMD-15).
    expect([...document.querySelectorAll("[data-testid^=section-]")].map((e) => e.getAttribute("data-testid"))).toEqual([
      "section-session:s-hello",
      "section-session:s-tools",
      "section-other",
    ]);
    expect(screen.queryByTestId("section-needs-you")).toBeNull();
    const sidebar = screen.getByTestId("terminal-sidebar");
    expect(sidebar.querySelector(".tsb-chip, [data-testid^=filter-]")).toBeNull();
    // The sub-line is the foreground process, "shell" while it is not known; no time, tone or status glyph.
    const sub = (id: string) => screen.getByTestId(`terminal-item-${id}`).querySelector(".tsb-item-sub")!;
    expect(sub("t2").textContent).toBe("bash");
    expect(sub("t1").textContent).toBe("claude");
    expect(sub("t3").textContent).toBe("shell");
    expect(sub("t4").className).toBe("tsb-item-sub mono");
    expect(sidebar.querySelector(".tsb-item .glyph")).toBeNull();
    expect(within(hello).getByTestId("terminal-item-t4")).toBeTruthy();
    expect(within(screen.getByTestId("section-session:s-tools")).getByTestId("terminal-item-t1")).toBeTruthy();
    const other = screen.getByTestId("section-other");
    expect(other.textContent).toContain("Other terminals");
    expect(within(other).getByTestId("terminal-item-t3")).toBeTruthy();
    expect(sidebar.querySelector(".tsb-foot")!.textContent).not.toContain("next idle");
    // Without GM_MAX_SESSIONS there is no "N of M" line.
    expect(screen.queryByTestId("session-count")).toBeNull();
    // A live run in the workspace shows its last 4 chars; clicking it opens the run in a pane.
    fireEvent.click(within(screen.getByTestId("terminal-item-t2")).getByTestId("run-chip-20261106-201510-44c2"));
    expect(await screen.findByLabelText("run 44c2")).toBeTruthy();
    expect(screen.getByTestId("pane-grid").dataset.panes).toBe("2");
  });

  it("shows \"2 of 3 repositories open\" when a limit is set, and a session without terminals still has its section", async () => {
    serve(TERMS, { limit: 3, sessions: [...SESSIONS, session("s-kept", { repo: { forge: "github", owner: "octo", name: "web" }, workspaceId: "github~octo~web", startedAt: "2026-11-13T12:00:00.000Z" })] });
    mount();
    expect((await screen.findByTestId("session-count")).textContent).toBe("3 of 3 repositories open");
    const kept = screen.getByTestId("section-session:s-kept");
    expect(kept.querySelectorAll(".tsb-item")).toHaveLength(0);
    cleanup();
    serve(TERMS, { limit: 3 });
    mount();
    expect((await screen.findByTestId("session-count")).textContent).toBe("2 of 3 repositories open");
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
    fireEvent.click(await within(dialog).findByTestId("new-terminal-live-s-hello"));
    fireEvent.change(within(dialog).getByTestId("new-terminal-title"), { target: { value: "build" } });
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions/s-hello/terminals")).toHaveLength(1));
    expect(bodyOf(fetchMock, "POST", "/api/sessions/s-hello/terminals")).toEqual({ title: "build" });
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

  it("?workspace= with a live session opens one terminal in it (StrictMode) and becomes ?focus=", async () => {
    const fetchMock = serve([], { sessions: [session("s-hello")] });
    mount(`/terminals?workspace=${HELLO}`, true);
    expect(await screen.findByTestId("terminal-view-t1")).toBeTruthy();
    expect(calls(fetchMock, "POST", "/api/sessions/s-hello/terminals")).toHaveLength(1);
    expect(calls(fetchMock, "POST", "/api/terminals")).toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/terminals?focus=t1"));
    expect(within(await screen.findByTestId("section-session:s-hello")).getByTestId("terminal-item-t1")).toBeTruthy();
  });

  it("?workspace= without a live session opens the dialog with the repository picked", async () => {
    const fetchMock = serve([], { sessions: [] });
    mount("/terminals?workspace=github~octo~web", true);
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/terminals"));
    expect(within(dialog).getByTestId("new-terminal-repo-github-octo/web").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions")).toHaveLength(1));
    expect(bodyOf(fetchMock, "POST", "/api/sessions")).toMatchObject({ repo: { forge: "github", owner: "octo", name: "web" } });
  });

  it("?new=1 opens the dialog once (StrictMode) and leaves the URL", async () => {
    serve();
    mount("/terminals?new=1", true);
    expect(await screen.findByRole("dialog", { name: "New terminal" })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/terminals"));
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("?session= opens the session's terminals (first in the pane, the rest as tabs) and becomes ?focus=", async () => {
    serve();
    mount("/terminals?session=s-hello");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/terminals?focus=t2"));
    expect(await screen.findByTestId("terminal-view-t2")).toBeTruthy();
    expect(screen.getByTestId("tab-t:t4")).toBeTruthy();
  });

  it("shows a project session's terminals under the project's name; terminals of no session go to Other terminals", async () => {
    serve([...TERMS, term("t7", { title: "billing", cwd: "/ws/.projects/billing", projectId: "billing" }), term("t8", { title: "old", projectId: "gone" })], {
      sessions: [...SESSIONS, session("s-billing", { projectId: "billing", workspaceId: "project~billing", startedAt: "2026-11-13T12:00:00.000Z" })],
    });
    mount();
    const section = await screen.findByTestId("section-session:s-billing");
    await waitFor(() => expect(section.querySelector(".tsb-section-label")?.textContent).toBe("billing"));
    expect(within(section).getByTestId("terminal-item-t7")).toBeTruthy();
    const keys = [...screen.getByTestId("terminal-list").querySelectorAll(".tsb-section")].map((x) => x.getAttribute("data-testid"));
    expect(keys).toEqual(["section-session:s-hello", "section-session:s-tools", "section-session:s-billing", "section-other"]);
    expect(within(screen.getByTestId("section-other")).getByTestId("terminal-item-t8")).toBeTruthy();
  });

  it("?project=&agent= opens the dialog with the project and agent picked (StrictMode); Open opens a project session", async () => {
    const fetchMock = serve([]);
    mount("/terminals?project=billing&agent=claude", true);
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/terminals"));
    await waitFor(() => expect(within(dialog).getByTestId("new-terminal-project-billing").getAttribute("aria-selected")).toBe("true"));
    expect(within(dialog).getByTestId("new-terminal-project-billing").textContent).toContain("2 repositories");
    await waitFor(() => expect((within(dialog).getByTestId("new-terminal-agent") as HTMLSelectElement).value).toBe("claude"));
    const name = within(dialog).getByTestId("new-terminal-branch-name") as HTMLInputElement;
    await waitFor(() => expect(name.value).toMatch(/^gm\/admin-\d{8}-[a-z0-9]{4}$/));
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions")).toHaveLength(1));
    expect(bodyOf(fetchMock, "POST", "/api/sessions")).toEqual({ projectId: "billing", branch: { new: name.value }, agent: "claude" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a project with a live session is listed once, as the live entry; picking it opens a terminal in the session", async () => {
    const fetchMock = serve([term("t7", { title: "billing", cwd: "/ws/.projects/billing", projectId: "billing", sessionId: "s-billing" })], {
      sessions: [session("s-billing", { projectId: "billing", workspaceId: "project~billing", branch: "gm/p", startedAt: "2026-11-13T12:00:00.000Z", terminals: ["t7"] })],
    });
    mount("/terminals?project=billing");
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    const live = await within(dialog).findByTestId("new-terminal-live-s-billing");
    expect(live.textContent).toContain("billing");
    expect(live.textContent).toContain("live");
    expect(within(dialog).queryByTestId("new-terminal-project-billing")).toBeNull();
    await waitFor(() => expect(live.getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions/s-billing/terminals")).toHaveLength(1));
    expect(calls(fetchMock, "POST", "/api/sessions")).toHaveLength(0);
  });

  it("finds a project by a repository's path, and lists the first repository's branches for Existing branch", async () => {
    const fetchMock = serve([]);
    mount();
    fireEvent.click(await screen.findByTestId("new-terminal"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    fireEvent.change(within(dialog).getByTestId("new-terminal-search"), { target: { value: "octo/web" } });
    fireEvent.click(await within(dialog).findByTestId("new-terminal-project-billing"));
    fireEvent.click(within(dialog).getByRole("radio", { name: "Existing branch" }));
    await waitFor(() => expect(calls(fetchMock, "GET", "/api/repos/branches?forge=github&owner=octo&name=hello")).toHaveLength(1));
    const select = within(dialog).getByTestId("new-terminal-branch-existing") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("main"));
    fireEvent.change(select, { target: { value: "dev" } });
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions")).toHaveLength(1));
    expect(bodyOf(fetchMock, "POST", "/api/sessions")).toEqual({ projectId: "billing", branch: { existing: "dev" } });
  });

  it("?project= with an unknown agent picks Shell", async () => {
    serve([]);
    mount("/terminals?project=billing&agent=vim");
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    expect((within(dialog).getByTestId("new-terminal-agent") as HTMLSelectElement).value).toBe("");
  });

  it("searches repositories: live sessions first with a live badge, then projects, then repositories; a live repository shows once", async () => {
    const fetchMock = serve();
    mount();
    fireEvent.click(await screen.findByTestId("new-terminal"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    const results = within(dialog).getByTestId("new-terminal-results");
    await waitFor(() => expect(within(results).getByTestId("new-terminal-repo-github-octo/web")).toBeTruthy());
    const ids = () => [...results.querySelectorAll("[role=option]")].map((o) => o.getAttribute("data-testid"));
    expect(ids()).toEqual([
      "new-terminal-live-s-hello",
      "new-terminal-live-s-tools",
      "new-terminal-project-billing",
      "new-terminal-repo-github-octo/web",
      "new-terminal-repo-github-octo/api",
    ]);
    expect(within(results).getByTestId("new-terminal-live-s-hello").textContent).toContain("live");
    expect(within(results).queryByTestId("new-terminal-repo-github-octo/hello")).toBeNull();
    fireEvent.change(within(dialog).getByTestId("new-terminal-search"), { target: { value: "hel" } });
    await waitFor(() => expect(calls(fetchMock, "GET", "/api/repos?q=hel")).toHaveLength(1));
    // The project matches through its repository octo/hello.
    await waitFor(() => expect(ids()).toEqual(["new-terminal-live-s-hello", "new-terminal-project-billing"]));
    fireEvent.change(within(dialog).getByTestId("new-terminal-search"), { target: { value: "tools" } });
    await waitFor(() => expect(ids()).not.toContain("new-terminal-project-billing"));
  });

  it("New branch is prefilled with gm/<user>-<date>-<4>; Open posts the repository and the name and opens the terminal", async () => {
    const fetchMock = serve();
    mount();
    fireEvent.click(await screen.findByTestId("new-terminal"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    fireEvent.click(await within(dialog).findByTestId("new-terminal-repo-github-octo/web"));
    const name = within(dialog).getByTestId("new-terminal-branch-name") as HTMLInputElement;
    await waitFor(() => expect(name.value).toMatch(/^gm\/admin-\d{8}-[a-z0-9]{4}$/));
    const branch = name.value;
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions")).toHaveLength(1));
    expect(bodyOf(fetchMock, "POST", "/api/sessions")).toEqual({ repo: { forge: "github", owner: "octo", name: "web" }, branch: { new: branch } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByTestId("terminal-view-t5")).toBeTruthy();
    // An emptied name lets the server pick the default.
    fireEvent.click(screen.getByTestId("new-terminal"));
    const again = await screen.findByRole("dialog", { name: "New terminal" });
    fireEvent.click(await within(again).findByTestId("new-terminal-repo-github-octo/api"));
    fireEvent.change(within(again).getByTestId("new-terminal-branch-name"), { target: { value: "" } });
    fireEvent.click(within(again).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions")).toHaveLength(2));
    expect(bodyOf(fetchMock, "POST", "/api/sessions")).toEqual({ repo: { forge: "github", owner: "octo", name: "api" }, branch: {} });
  });

  it("Existing branch loads the repository's branches and posts the picked one", async () => {
    const fetchMock = serve();
    mount();
    fireEvent.click(await screen.findByTestId("new-terminal"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    fireEvent.click(await within(dialog).findByTestId("new-terminal-repo-github-octo/web"));
    fireEvent.click(within(dialog).getByRole("radio", { name: "Existing branch" }));
    await waitFor(() => expect(calls(fetchMock, "GET", "/api/repos/branches?forge=github&owner=octo&name=web")).toHaveLength(1));
    const select = within(dialog).getByTestId("new-terminal-branch-existing") as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.value)).toEqual(["main", "dev", "feature/x"]));
    expect(select.value).toBe("main");
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions")).toHaveLength(1));
    expect(bodyOf(fetchMock, "POST", "/api/sessions")).toEqual({ repo: { forge: "github", owner: "octo", name: "web" }, branch: { existing: "main" } });
  });

  it("a live session shows its branch read-only and opens a terminal in it, without a branch", async () => {
    const fetchMock = serve();
    mount();
    fireEvent.click(await screen.findByTestId("new-terminal"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    fireEvent.click(await within(dialog).findByTestId("new-terminal-live-s-hello"));
    const branch = within(dialog).getByTestId("new-terminal-branch");
    expect(branch.textContent).toContain("gm/admin-20261113-k3x9");
    expect(branch.textContent).toContain("The branch is fixed while the session is live.");
    expect(within(branch).queryByRole("radio")).toBeNull();
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions/s-hello/terminals")).toHaveLength(1));
    expect(bodyOf(fetchMock, "POST", "/api/sessions/s-hello/terminals")).toEqual({});
    expect(calls(fetchMock, "POST", "/api/sessions")).toHaveLength(0);
  });

  it("shows the 409 limit message in the dialog, which stays open", async () => {
    serve();
    mount();
    postHooks.answer = (url) => (url === "/api/sessions" ? json(409, { error: "You have 3 open repositories. Close all terminals of one to open another." }) : undefined);
    fireEvent.click(await screen.findByTestId("new-terminal"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    fireEvent.click(await within(dialog).findByTestId("new-terminal-repo-github-octo/web"));
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    expect((await within(dialog).findByTestId("new-terminal-error")).textContent).toBe("You have 3 open repositories. Close all terminals of one to open another.");
    expect(screen.getByRole("dialog", { name: "New terminal" })).toBeTruthy();
    expect(within(dialog).getByTestId("new-terminal-create").textContent).toBe("Open");
  });

  it("Enter in the search picks the highlighted entry, a second Enter opens", async () => {
    const fetchMock = serve([], { sessions: [] });
    mount();
    fireEvent.click(within(await screen.findByTestId("terminals-empty")).getByRole("button", { name: /New terminal/ }));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    const search = within(dialog).getByTestId("new-terminal-search");
    fireEvent.change(search, { target: { value: "web" } });
    await waitFor(() => expect(calls(fetchMock, "GET", "/api/repos?q=web")).toHaveLength(1));
    await within(dialog).findByTestId("new-terminal-repo-github-octo/web");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(within(dialog).getByTestId("new-terminal-repo-github-octo/web").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions")).toHaveLength(1));
  });

  it("says to connect a forge when there are no repositories and no forge", async () => {
    serve([], { sessions: [], repos: [], forges: { github: false, gitlab: false } });
    mount();
    fireEvent.click(within(await screen.findByTestId("terminals-empty")).getByRole("button", { name: /New terminal/ }));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    // The project still lists; without it the list would only hold the hint.
    await waitFor(() => expect(within(dialog).getByTestId("new-terminal-project-billing")).toBeTruthy());
    fireEvent.change(within(dialog).getByTestId("new-terminal-search"), { target: { value: "zzz" } });
    await waitFor(() => expect(within(dialog).getByTestId("new-terminal-results").textContent).toBe("No repositories found. Connect GitHub or GitLab in Settings."));
  });

  it("shows the empty state without terminals", async () => {
    serve([]);
    mount();
    const empty = await screen.findByTestId("terminals-empty");
    expect(empty.textContent).toContain("No terminals open");
    expect(empty.textContent).toContain("Open a repository to start a session.");
    fireEvent.click(within(empty).getByRole("button", { name: /New terminal/ }));
    expect(await screen.findByRole("dialog", { name: "New terminal" })).toBeTruthy();
  });

  it("closing the last terminal with changes asks: Push posts push and toasts the skipped files", async () => {
    const fetchMock = serve([term("t1", { workspaceId: HELLO, sessionId: "s-hello", process: "bash" })], { sessions: [session("s-hello", { terminals: ["t1"] })] });
    const changes = Array.from({ length: 22 }, (_, i) => `src/f${i}.ts`);
    postHooks.del = () => json(200, { sessionId: "s-hello", ask: { changes } });
    postHooks.answer = (url, b) =>
      url === "/api/sessions/s-hello/close" && b.action === "push"
        ? json(200, { session: { ...session("s-hello"), state: "ending" }, skipped: [".env", "key.pem"] })
        : undefined;
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t1"));
    fireEvent.click(await screen.findByRole("button", { name: "Close t1" }));
    const dialog = await screen.findByTestId("close-session-dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("octo/hello has uncommitted changes.");
    const files = within(dialog).getByTestId("close-files");
    expect(files.querySelectorAll("li")).toHaveLength(21);
    expect(files.textContent).toContain("src/f19.ts");
    expect(files.textContent).not.toContain("src/f20.ts");
    expect(files.textContent).toContain("and 2 more");
    // No cancel: Esc leaves the question open.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("close-session-dialog")).toBeTruthy();
    fireEvent.click(within(dialog).getByTestId("close-push"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions/s-hello/close")).toHaveLength(1));
    expect(bodyOf(fetchMock, "POST", "/api/sessions/s-hello/close")).toEqual({ action: "push" });
    await waitFor(() => expect(screen.queryByTestId("close-session-dialog")).toBeNull());
    expect(await screen.findByText("Pushed to gm/admin-20261113-k3x9. Not committed: .env, key.pem")).toBeTruthy();
  });

  it("Keep open posts keep; Discard asks first, then posts discard", async () => {
    const fetchMock = serve([term("t1", { workspaceId: HELLO, sessionId: "s-hello" }), term("t2", { workspaceId: HELLO, sessionId: "s-hello" })], {
      sessions: [session("s-hello", { terminals: ["t1", "t2"] })],
    });
    postHooks.del = () => json(200, { sessionId: "s-hello", ask: { changes: ["a.txt"] } });
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t1"));
    fireEvent.click(await screen.findByRole("button", { name: "Close t1" }));
    fireEvent.click(within(await screen.findByTestId("close-session-dialog")).getByTestId("close-keep"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions/s-hello/close")).toHaveLength(1));
    expect(bodyOf(fetchMock, "POST", "/api/sessions/s-hello/close")).toEqual({ action: "keep" });
    await waitFor(() => expect(screen.queryByTestId("close-session-dialog")).toBeNull());

    fireEvent.click(await screen.findByTestId("terminal-item-t2"));
    fireEvent.click(await screen.findByRole("button", { name: "Close t2" }));
    fireEvent.click(within(await screen.findByTestId("close-session-dialog")).getByTestId("close-discard"));
    const confirm = await screen.findByRole("dialog", { name: "Discard all uncommitted changes in octo/hello?" });
    expect(screen.queryByTestId("close-session-dialog")).toBeNull();
    // Cancel goes back to the question.
    fireEvent.click(within(confirm).getByRole("button", { name: /Cancel/ }));
    fireEvent.click(within(await screen.findByTestId("close-session-dialog")).getByTestId("close-discard"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Discard all uncommitted changes in octo/hello?" })).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions/s-hello/close")).toHaveLength(2));
    expect(bodyOf(fetchMock, "POST", "/api/sessions/s-hello/close")).toEqual({ action: "discard" });
    await waitFor(() => expect(screen.queryByTestId("close-session-dialog")).toBeNull());
  });

  it("a failed push shows the error with Retry and Discard in the dialog", async () => {
    serve([term("t1", { workspaceId: HELLO, sessionId: "s-hello" })], { sessions: [session("s-hello", { terminals: ["t1"] })] });
    postHooks.del = () => json(200, { sessionId: "s-hello", ask: { changes: ["a.txt"] } });
    postHooks.answer = (url) => (url.endsWith("/close") ? json(200, { session: { ...session("s-hello"), state: "save-failed", error: "push rejected: protected branch" } }) : undefined);
    mount();
    fireEvent.click(await screen.findByTestId("terminal-item-t1"));
    fireEvent.click(await screen.findByRole("button", { name: "Close t1" }));
    const dialog = await screen.findByTestId("close-session-dialog");
    fireEvent.click(within(dialog).getByTestId("close-push"));
    expect((await within(dialog).findByTestId("close-error")).textContent).toBe("push rejected: protected branch");
    expect(within(dialog).getByTestId("close-push").textContent).toBe("Retry");
    expect(within(dialog).getByTestId("close-discard")).toBeTruthy();
    expect(within(dialog).queryByTestId("close-keep")).toBeNull();
  });

  it("a save-failed session shows its error with Retry (push) and Discard (asks, then discard); an asking one offers the question", async () => {
    const fetchMock = serve([], {
      sessions: [
        session("s-hello", { state: "save-failed", error: "push failed: remote rejected" }),
        session("s-tools", { repo: { forge: "gitlab", owner: "platform/infra", name: "deploy-tools" }, workspaceId: TOOLS, state: "asking", startedAt: "2026-11-13T11:00:00.000Z" }),
      ],
    });
    mount();
    expect((await screen.findByTestId("session-error-s-hello")).textContent).toBe("push failed: remote rejected");
    expect(screen.getByTestId("session-state-s-hello").textContent).toBe("save-failed");
    expect(screen.getByTestId("session-state-s-tools").textContent).toBe("asking");
    fireEvent.click(screen.getByTestId("session-retry-s-hello"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions/s-hello/close")).toHaveLength(1));
    expect(bodyOf(fetchMock, "POST", "/api/sessions/s-hello/close")).toEqual({ action: "push" });
    cleanup();
    const second = serve([], { sessions: [session("s-hello", { state: "save-failed", error: "push failed" }), session("s-tools", { repo: { forge: "gitlab", owner: "platform/infra", name: "deploy-tools" }, workspaceId: TOOLS, state: "asking", startedAt: "2026-11-13T11:00:00.000Z" })] });
    mount();
    fireEvent.click(await screen.findByTestId("session-discard-s-hello"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Discard all uncommitted changes in octo/hello?" })).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(calls(second, "POST", "/api/sessions/s-hello/close")).toHaveLength(1));
    expect(bodyOf(second, "POST", "/api/sessions/s-hello/close")).toEqual({ action: "discard" });
    fireEvent.click(await screen.findByTestId("session-ask-s-tools"));
    const dialog = await screen.findByTestId("close-session-dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("platform/infra/deploy-tools has uncommitted changes.");
  });

  it("+ on a session's head opens the dialog on that session", async () => {
    serve();
    mount();
    fireEvent.click(await screen.findByTestId("session-new-s-tools"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    expect(within(dialog).getByTestId("new-terminal-live-s-tools").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("session-new-s-tools").getAttribute("aria-label")).toBe("New terminal in platform/infra/deploy-tools");
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

    it("opens when a spec of the focused workspace changes, closes, and reopens from the chip", async () => {
      setSpec(100, "# A v1");
      const fetchMock = serve();
      mount();
      // t2 (octo/hello) fills the screen; the first answer is only the baseline.
      expect(await screen.findByTestId("terminal-view-t2")).toBeTruthy();
      await waitFor(() => expect(specCalls(fetchMock, HELLO).length).toBeGreaterThan(0));
      const chip = await screen.findByTestId("pane-spec-chip");
      expect(chip.textContent).toBe("spec a.md");
      expect(screen.queryByTestId("spec-float")).toBeNull();

      // The spec is written: the pane opens within a poll, with the file's text.
      setSpec(200, "# A v2");
      const float = await screen.findByTestId("spec-float", {}, POLL);
      expect(float.getAttribute("role")).toBe("dialog");
      expect(float.getAttribute("aria-label")).toBe("Spec a.md");
      expect(float.getAttribute("aria-modal")).toBe("false");
      expect(float.textContent).toContain("docs/prd/a.md");
      await waitFor(() => expect(within(float).getByTestId("spec-view").textContent).toBe("# A v2"));

      // It follows the file while it is written.
      setSpec(250, "# A v3");
      await waitFor(() => expect(within(screen.getByTestId("spec-float")).getByTestId("spec-view").textContent).toBe("# A v3"), POLL);

      // Close; the chip brings it back; Escape inside closes it again.
      fireEvent.click(screen.getByTestId("spec-close"));
      expect(screen.queryByTestId("spec-float")).toBeNull();
      expect(screen.getByTestId("pane-spec-chip").textContent).toBe("spec a.md");
      fireEvent.click(screen.getByTestId("pane-spec-chip"));
      const again = await screen.findByTestId("spec-float");
      fireEvent.keyDown(within(again).getByTestId("spec-body"), { key: "Escape" });
      expect(screen.queryByTestId("spec-float")).toBeNull();

      // The same mtime on the next poll does not reopen it.
      const seen = specCalls(fetchMock, HELLO).length;
      await waitFor(() => expect(specCalls(fetchMock, HELLO).length).toBeGreaterThan(seen), POLL);
      await act(async () => {});
      expect(screen.queryByTestId("spec-float")).toBeNull();
    }, 20_000);

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
      await waitFor(() => expect(calls(fetchMock, "GET", "/api/sessions").length).toBeGreaterThan(0));
      await act(async () => {});
      expect(calls(fetchMock, "GET").filter(([u]) => String(u).includes("/specs"))).toHaveLength(0);
      expect(screen.queryByTestId("pane-spec-chip")).toBeNull();
    });
  });

  it("shows one button per agent and a New terminal button; a CLI that is not installed is disabled", async () => {
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
    expect(screen.getByTestId("new-terminal").textContent).toContain("New terminal");
    expect(screen.getByTestId("new-terminal").getAttribute("title")).toBe("New terminal (Ctrl Space, n)");
    fireEvent.click(screen.getByTestId("new-terminal"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    expect([...(within(dialog).getByTestId("new-terminal-agent") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Shell", "Claude Code", "OpenCode", "Qwen Code"]);
  });

  it("an agent button opens the dialog with the agent picked; Open posts it, shows Connecting tools… and opens the pane", async () => {
    const fetchMock = serve();
    mount();
    await waitFor(() => expect((screen.getByTestId("agent-btn-codex") as HTMLButtonElement).disabled).toBe(true));
    let release!: () => void;
    postHooks.gate = new Promise<void>((r) => (release = r));
    fireEvent.click(screen.getByTestId("agent-btn-claude"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    expect((within(dialog).getByTestId("new-terminal-agent") as HTMLSelectElement).value).toBe("claude");
    fireEvent.click(await within(dialog).findByTestId("new-terminal-live-s-hello"));
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    await waitFor(() => expect(calls(fetchMock, "POST", "/api/sessions/s-hello/terminals")).toHaveLength(1));
    expect(bodyOf(fetchMock, "POST", "/api/sessions/s-hello/terminals")).toEqual({ agent: "claude" });
    await waitFor(() => expect(within(dialog).getByTestId("new-terminal-create").textContent).toBe("Connecting tools…"));
    expect((within(dialog).getByTestId("new-terminal-create") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("agent-btn-claude").textContent).toBe("Connecting tools…");
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByTestId("terminal-view-t5")).toBeTruthy();
    expect(screen.getByTestId("agent-btn-claude").textContent).toBe("Claude Code");
  });

  it("Qwen Code hints at the commit, and a 409 shows in the dialog, which stays open", async () => {
    const fetchMock = serve();
    mount();
    await waitFor(() => expect((screen.getByTestId("agent-btn-codex") as HTMLButtonElement).disabled).toBe(true));
    postHooks.answer = (_url, body) => (body.agent === "qwen" ? json(409, { error: "cannot commit .qwen/settings.json: it has uncommitted changes" }) : undefined);
    fireEvent.click(screen.getByTestId("agent-btn-qwen"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal" });
    expect(dialog.textContent).toContain("Commits .qwen/settings.json once");
    fireEvent.click(await within(dialog).findByTestId("new-terminal-live-s-hello"));
    fireEvent.click(within(dialog).getByTestId("new-terminal-create"));
    expect((await within(dialog).findByTestId("new-terminal-error")).textContent).toBe("cannot commit .qwen/settings.json: it has uncommitted changes");
    expect(screen.getByRole("dialog", { name: "New terminal" })).toBeTruthy();
    expect(bodyOf(fetchMock, "POST", "/api/sessions/s-hello/terminals")).toEqual({ agent: "qwen" });
    expect(within(dialog).getByTestId("new-terminal-create").textContent).toBe("Open");
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
