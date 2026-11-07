// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewProvider } from "../overview";
import type { RunSummary, TerminalInfo, WorkspaceEntry } from "../types";
import { ToastProvider } from "../ui/toast";
import Runs, { GROUP_KEY, byAttention } from "./Runs";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const HELLO = "github~octo~hello";
const TOOLS = "gitlab~platform~infra~deploy-tools";

const run = (over: Partial<RunSummary> & { id: string }): RunSummary => ({
  workspaceId: HELLO,
  type: "run",
  status: "done",
  kind: "finished",
  live: false,
  provider: "claude",
  createdAt: ago(60),
  taskCounts: { merged: 3 },
  ...over,
});

const RUNS: RunSummary[] = [
  run({ id: "r-done", status: "done", createdAt: ago(1), provider: "codex" }),
  run({ id: "r-applied", status: "applied", createdAt: ago(120) }),
  run({ id: "r-pr", status: "applied", createdAt: ago(10), pr: { url: "https://github.com/octo/hello/pull/3", number: 3, forge: "github" } }),
  run({ id: "r-running", status: "running", live: true, createdAt: ago(3), taskCounts: { merged: 4, running: 3 } }),
  run({ id: "r-failed", workspaceId: TOOLS, status: "failed", createdAt: ago(300), provider: "opencode", failure: "validation failed" }),
  run({ id: "gm-suite-1", workspaceId: TOOLS, type: "suite", status: "running", live: true, createdAt: ago(12), taskCounts: undefined }),
];

const WORKSPACES: WorkspaceEntry[] = [
  { id: HELLO, forge: "github", fullPath: "octo/hello", path: "/ws/github/octo/hello", branch: "main", dirty: true, remoteUrl: "" },
  { id: TOOLS, forge: "gitlab", fullPath: "platform/infra/deploy-tools", path: "/ws/gitlab/platform/infra/deploy-tools", branch: "develop", dirty: false, remoteUrl: "" },
];

const TERMINALS: TerminalInfo[] = [
  { id: "t1", title: "a", cwd: "/", status: "idle", createdAt: ago(5) },
  { id: "t2", title: "b", cwd: "/", status: "working", createdAt: ago(5) },
];

function stub(runs: RunSummary[] = RUNS, workspaces: WorkspaceEntry[] = WORKSPACES) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/runs") return json(200, { runs });
    if (url === "/api/terminals") return json(200, { terminals: TERMINALS });
    if (url === "/api/workspaces") return json(200, { workspaces });
    if (url === "/api/forges") return json(200, { github: { connected: false }, gitlab: { connected: false } });
    if (url.includes("/inspect")) return json(200, { branch: "main", changes: 0 });
    return json(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}${loc.hash}`}</div>;
}

function renderAt(url: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[url]}>
        <OverviewProvider>
          <Routes>
            <Route path="/runs" element={<Runs />} />
            <Route path="*" element={<div />} />
          </Routes>
          <Where />
        </OverviewProvider>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const rowIds = () => screen.queryAllByRole("row").map((r) => r.getAttribute("data-run")).filter((x): x is string => x !== null);
const where = () => screen.getByTestId("where").textContent;
const key = (k: string) => fireEvent.keyDown(window, { key: k });

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("byAttention", () => {
  it("puts failed and live first, then ready for PR, then the rest, newest first in each", () => {
    expect([...RUNS].sort(byAttention).map((r) => r.id)).toEqual(["r-running", "gm-suite-1", "r-failed", "r-applied", "r-done", "r-pr"]);
  });
});

describe("Runs page", () => {
  it("shows skeleton rows until the first poll is in", async () => {
    stub();
    renderAt("/runs");
    expect(screen.getByTestId("skeleton")).toBeTruthy();
    await screen.findByTestId("runs-table");
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("groups runs by workspace in attention order, with the group's branch, state and terminal link", async () => {
    stub();
    renderAt("/runs");
    await screen.findByTestId("runs-table");
    // deploy-tools has a failed run and a live suite; hello's most urgent run is live and newer, so it comes first.
    expect(rowIds()).toEqual(["r-running", "r-applied", "r-done", "r-pr", "gm-suite-1", "r-failed"]);
    const hello = screen.getByTestId(`runs-group-${HELLO}`);
    expect(hello.textContent).toContain("GITHUB");
    expect(hello.textContent).toContain("octo/hello");
    expect(hello.textContent).toContain("main");
    expect(hello.textContent).toContain("dirty");
    expect(hello.textContent).toContain("4 runs");
    expect(within(hello).getByRole("link", { name: /Open terminal/ }).getAttribute("href")).toBe(`/terminals?workspace=${HELLO}`);
    const tools = screen.getByTestId(`runs-group-${TOOLS}`);
    expect(tools.textContent).toContain("GITLAB");
    expect(tools.textContent).toContain("clean");
  });

  it("lists every run flat when grouping is off, and remembers the choice", async () => {
    stub();
    renderAt("/runs");
    await screen.findByTestId("runs-table");
    fireEvent.click(screen.getByTestId("runs-group-toggle"));
    expect(screen.queryByTestId(`runs-group-${HELLO}`)).toBeNull();
    expect(rowIds()).toEqual(["r-running", "gm-suite-1", "r-failed", "r-applied", "r-done", "r-pr"]);
    expect(localStorage.getItem(GROUP_KEY)).toBe("0");
  });

  it("filters by text on the run id and provider", async () => {
    stub();
    renderAt("/runs");
    await screen.findByTestId("runs-table");
    const input = screen.getByPlaceholderText("Filter by run id, provider…");
    expect(input.hasAttribute("data-filter")).toBe(true);
    fireEvent.change(input, { target: { value: "codex" } });
    expect(rowIds()).toEqual(["r-done"]);
    fireEvent.change(input, { target: { value: "suite" } });
    expect(rowIds()).toEqual(["gm-suite-1"]);
  });

  it("shows only failed runs with ?status=failed, and the cards toggle the filter", async () => {
    stub();
    renderAt("/runs?status=failed");
    await screen.findByTestId("runs-table");
    expect(rowIds()).toEqual(["r-failed"]);
    expect(screen.getByTestId("card-failed").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("card-ready"));
    expect(where()).toBe("/runs?status=ready");
    expect(rowIds()).toEqual(["r-applied"]);
    fireEvent.click(screen.getByTestId("card-ready"));
    expect(rowIds()).toHaveLength(6);
  });

  it("counts live, failed and ready in the three cards", async () => {
    stub();
    renderAt("/runs");
    await screen.findByTestId("runs-table");
    expect(screen.getByTestId("card-live").textContent).toContain("2");
    expect(screen.getByTestId("card-live").textContent).toContain("1 run · 1 suite");
    expect(screen.getByTestId("card-failed").textContent).toContain("deploy-tools · 5h ago");
    expect(screen.getByTestId("card-ready").textContent).toContain("applied, no PR yet");
    // Three cards: no "Terminals idle" card, even with an idle terminal in the overview (GMD-15).
    expect(screen.queryByTestId("card-idle")).toBeNull();
    expect(document.querySelectorAll(".runs-cards > *")).toHaveLength(3);
    expect(document.body.textContent).not.toMatch(/idle|waiting on you/i);
  });

  it("renders the action cells: Create PR, the PR link and the failure reason", async () => {
    stub();
    renderAt("/runs");
    await screen.findByTestId("runs-table");
    const pr = within(screen.getByTestId(`run-row-${HELLO}-r-pr`)).getByRole("link", { name: "PR #3 ↗" });
    expect(pr.getAttribute("href")).toBe("https://github.com/octo/hello/pull/3");
    expect(pr.getAttribute("target")).toBe("_blank");
    expect(screen.getByTestId(`run-row-${TOOLS}-r-failed`).textContent).toContain("validation failed");
    expect(screen.getByTestId(`run-row-${HELLO}-r-running`).textContent).toContain("live");
    expect(screen.getByTestId(`run-row-${HELLO}-r-running`).textContent).toContain("4/7");
    fireEvent.click(within(screen.getByTestId(`run-row-${HELLO}-r-applied`)).getByRole("button", { name: "Create PR" }));
    expect(where()).toBe(`/runs/${HELLO}/r-applied#pr`);
  });

  it("labels the button Create MR on a GitLab workspace", async () => {
    stub(
      [run({ id: "r-gl", workspaceId: TOOLS, status: "applied" })],
      WORKSPACES.map((w) => (w.id === TOOLS ? { ...w, dirty: true, changes: 2 } : w)),
    );
    renderAt("/runs");
    await screen.findByTestId("runs-table");
    expect(within(screen.getByTestId(`run-row-${TOOLS}-r-gl`)).getByRole("button", { name: "Create MR" })).toBeTruthy();
  });

  it("does not count an applied run as ready for PR when its workspace has no uncommitted changes", async () => {
    stub([run({ id: "r-gl", workspaceId: TOOLS, status: "applied" })]);
    renderAt("/runs");
    await screen.findByTestId("runs-table");
    const row = screen.getByTestId(`run-row-${TOOLS}-r-gl`);
    await waitFor(() => expect(within(row).queryByRole("button", { name: "Create MR" })).toBeNull());
    expect(row.textContent).toContain("no changes to open a PR");
    expect(screen.getByTestId("card-ready").textContent).toContain("0");
  });

  it("shows the empty state when there are no runs", async () => {
    stub([]);
    renderAt("/runs");
    expect(await screen.findByText("No runs yet")).toBeTruthy();
    expect(screen.getByText("graph-execution .agents/tasks --spec docs/prd.md --web")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("empty-state")).getByRole("button", { name: "Start run" }));
    expect(await screen.findByTestId("start-run-drawer")).toBeTruthy();
  });

  it("moves the focused row with j/k, opens it with Enter, and p opens Create PR on a ready row", async () => {
    stub();
    renderAt("/runs");
    await screen.findByTestId("runs-table");
    key("j");
    expect(screen.getByTestId(`run-row-${HELLO}-r-running`).classList.contains("focused")).toBe(true);
    key("j");
    expect(screen.getByTestId(`run-row-${HELLO}-r-applied`).classList.contains("focused")).toBe(true);
    expect(screen.getByTestId(`run-row-${HELLO}-r-running`).classList.contains("focused")).toBe(false);
    key("p");
    expect(where()).toBe(`/runs/${HELLO}/r-applied#pr`);
  });

  it("opens the focused run with Enter", async () => {
    stub();
    renderAt("/runs");
    await screen.findByTestId("runs-table");
    key("j");
    key("j");
    key("k");
    key("Enter");
    expect(where()).toBe(`/runs/${HELLO}/r-running`);
  });

  it("opens the Start run drawer with s and with ?start=1", async () => {
    stub();
    renderAt("/runs?start=1");
    expect(await screen.findByTestId("start-run-drawer")).toBeTruthy();
    cleanup();
    stub();
    renderAt("/runs");
    await screen.findByTestId("runs-table");
    expect(screen.queryByTestId("start-run-drawer")).toBeNull();
    act(() => key("s"));
    expect(screen.getByTestId("start-run-drawer")).toBeTruthy();
  });

  it("filters by workspace through ?workspace=", async () => {
    stub();
    renderAt(`/runs?workspace=${TOOLS}`);
    await screen.findByTestId("runs-table");
    expect(rowIds()).toEqual(["gm-suite-1", "r-failed"]);
    fireEvent.change(screen.getByTestId("runs-filter"), { target: { value: "" } });
    await waitFor(() => expect(rowIds()).toHaveLength(6));
  });
});
