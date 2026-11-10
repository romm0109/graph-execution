// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../ui/toast";
import RunDetail from "./RunDetail";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const summary = (ws: string) => ({ workspaceId: ws, type: "run", id: "r1", status: "applied", kind: "done", live: false, createdAt: new Date().toISOString() });
const SUGGESTED = { branch: "gm/r1", title: "Hello feature", body: "- [x] 1 Say hello", base: "main" };

function renderAt(ws: string, hash = "") {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/runs/${ws}/r1${hash}`]}>
        <Routes>
          <Route path="/runs/:ws/:runId" element={<RunDetail />} />
          <Route path="/terminals" element={<p data-testid="terminals-page">terminals</p>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const WS = "github~octo~hello";
const VIEW_URL = `/runs/${WS}/r1/view/`;
const GRAPH = {
  nodes: [
    { id: "01", title: "schema", status: "merged" },
    { id: "02", title: "config", status: "merged" },
    { id: "03", title: "auth", status: "merged" },
  ],
  edges: [
    ["01", "03"],
    ["02", "03"],
  ],
  layers: [["01", "02"], ["03"]],
};

const flush = () => act(async () => vi.advanceTimersByTimeAsync(0));

describe("RunDetail live", () => {
  it("shows the run page in an iframe, falls back to the static graph when the probe fails twice, and Retry goes back", async () => {
    vi.useFakeTimers();
    let pageUp = false;
    const probes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === `${VIEW_URL}state`) {
          probes.push(url);
          if (!pageUp) throw new TypeError("connection refused");
          return json(200, {});
        }
        if (url.endsWith("/pr")) return json(200, { eligible: false, reason: "the run has not landed (status running)" });
        return json(200, {
          summary: { ...summary(WS), status: "running", live: true, viewUrl: VIEW_URL, taskCounts: { merged: 1, running: 1, pending: 1 } },
          state: { runId: "r1", provider: "fake", createdAt: "", status: "running", tasks: {} },
          graph: GRAPH,
          tasks: [],
        });
      }),
    );
    renderAt(WS);
    await flush();
    const frame = screen.getByTestId("run-live-view");
    expect(frame.getAttribute("src")).toMatch(new RegExp(`^${VIEW_URL}\\?theme=`));
    expect(screen.getByTestId("run-meta").textContent).toContain("1/3 merged");
    expect(screen.getByTestId("open-live").getAttribute("href")).toBe(VIEW_URL);

    // Polls don't remount the iframe.
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByTestId("run-live-view")).toBe(frame);

    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.queryByTestId("page-down-banner")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(probes.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("page-down-banner").textContent).toContain("The run page stopped responding. Showing the static graph.");
    expect(screen.queryByTestId("run-live-view")).toBeNull();
    expect(screen.getByTestId("graph-node-03")).toBeTruthy();

    pageUp = true;
    fireEvent.click(screen.getByTestId("page-retry"));
    await flush();
    expect(screen.getByTestId("run-live-view")).toBeTruthy();
    expect(screen.queryByTestId("page-down-banner")).toBeNull();
  });

  it("switches to the static view with the banner when the summary turns live:false", async () => {
    vi.useFakeTimers();
    let live = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/pr")) return json(200, { eligible: false, reason: "x" });
        if (url.endsWith("/state")) return json(200, {});
        return json(200, { summary: { ...summary(WS), status: "running", live, viewUrl: live ? VIEW_URL : undefined }, graph: GRAPH });
      }),
    );
    renderAt(WS);
    await flush();
    expect(screen.getByTestId("run-live-view")).toBeTruthy();
    live = false;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.queryByTestId("run-live-view")).toBeNull();
    expect(screen.getByTestId("page-down-banner")).toBeTruthy();
    expect(screen.getByTestId("run-meta").textContent).toContain("page not live");
  });

  it("shows no banner when the run finished and its page was closed", async () => {
    vi.useFakeTimers();
    let live = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/pr")) return json(200, { eligible: false, reason: "x" });
        if (url.endsWith("/state")) {
          if (!live) throw new TypeError("connection refused");
          return json(200, {});
        }
        return json(200, { summary: { ...summary(WS), status: live ? "running" : "applied", live, viewUrl: live ? VIEW_URL : undefined }, graph: GRAPH });
      }),
    );
    renderAt(WS);
    await flush();
    expect(screen.getByTestId("run-live-view")).toBeTruthy();
    live = false;
    await act(async () => vi.advanceTimersByTimeAsync(12000));
    expect(screen.queryByTestId("run-live-view")).toBeNull();
    expect(screen.queryByTestId("page-down-banner")).toBeNull();
    expect(screen.getByTestId("run-meta").textContent).toContain("page not live");
  });
});

describe("RunDetail #pr", () => {
  it("shows the Pull request form instead of the iframe for a landed run whose page is still open", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/pr")) return json(200, { eligible: true, forge: "github", suggested: SUGGESTED, branches: ["main"] });
        if (url.endsWith("/state")) return json(200, {});
        return json(200, {
          summary: { ...summary(WS), status: "applied", live: true, viewUrl: VIEW_URL },
          state: { runId: "r1", provider: "fake", createdAt: "", status: "applied", tasks: {} },
          graph: GRAPH,
          tasks: [],
        });
      }),
    );
    renderAt(WS, "#pr");
    await flush();
    await flush();
    expect(screen.queryByTestId("run-live-view")).toBeNull();
    expect(screen.getByTestId("run-static-graph")).toBeTruthy();
    expect(screen.getByTestId("open-live").getAttribute("href")).toBe(VIEW_URL);
    expect(screen.queryByTestId("page-down-banner")).toBeNull();
  });
});

describe("RunDetail ?node=", () => {
  it("shows the static graph instead of the iframe for a live run and selects the node", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/pr")) return json(200, { eligible: false, reason: "running" });
        if (url.endsWith("/state")) return json(200, {});
        return json(200, {
          summary: { ...summary(WS), status: "running", live: true, viewUrl: VIEW_URL },
          state: { runId: "r1", provider: "fake", createdAt: "", status: "running", tasks: {} },
          graph: GRAPH,
          tasks: [
            { id: "01", title: "schema", status: "merged", attempts: 1, deps: [] },
            { id: "02", title: "config", status: "merged", attempts: 1, deps: [] },
            { id: "03", title: "auth", status: "running", attempts: 1, deps: ["01", "02"] },
          ],
        });
      }),
    );
    renderAt(WS, "?node=03");
    await flush();
    await flush();
    expect(screen.queryByTestId("run-live-view")).toBeNull();
    expect(screen.getByTestId("run-static-graph")).toBeTruthy();
    expect(screen.getByTestId("graph-node-03").className).toContain("selected");
    expect(screen.getByTestId("task-row-03").className).toContain("focused");
  });
});

describe("RunDetail finished", () => {
  const applied = {
    summary: { ...summary(WS), provider: "fake", taskCounts: { merged: 3 } },
    state: { runId: "r1", provider: "fake", createdAt: "", status: "applied", tasks: {} },
    graph: GRAPH,
    view: {
      version: 1,
      runId: "r1",
      savedAt: "",
      final: true,
      phase: { phase: "done", fixPasses: 3 },
      nodes: {},
      gate: { status: "done" },
      agents: { reviewer: { status: "done" }, tester: { status: "done" }, fixer: { status: "done", round: 1 } },
      summary: { exitCode: 0, fixPasses: 3, findings: 3 },
    },
    tasks: [
      { id: "01", title: "schema", status: "merged", attempts: 1, startedAt: 0, endedAt: 130_000, added: 212, deleted: 4, deps: [] },
      { id: "02", title: "config", status: "merged", attempts: 1, startedAt: 0, endedAt: 48_000, added: 31, deleted: 2, deps: [] },
      { id: "03", title: "auth", status: "merged", attempts: 2, deps: ["01", "02"] },
    ],
    landed: { files: 14, added: 803, deleted: 24 },
  };

  it("shows the phase cards, the graph and the task table of an applied run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.endsWith("/pr") ? json(200, { eligible: false, reason: "GitHub is not connected" }) : json(200, applied))),
    );
    renderAt(WS);
    expect((await screen.findByTestId("phase-validation")).textContent).toContain("passed");
    expect(screen.getByTestId("phase-review").textContent).toContain("passed · 3 findings");
    expect(screen.getByTestId("phase-fixer").textContent).toContain("1 / 3 passes");
    expect(screen.getByTestId("phase-landed").textContent).toContain("14 files uncommitted");
    expect(screen.getByTestId("phase-landed").textContent).toContain("+803 −24 in octo/hello");
    expect(screen.getByTestId("task-elapsed-01").textContent).toBe("2m10s");
    expect(screen.getByTestId("task-elapsed-02").textContent).toBe("48s");
    expect(screen.getByTestId("task-elapsed-03").textContent).toBe("—");
    expect(screen.getByTestId("task-lines-01").textContent).toBe("+212 −4");
    expect(screen.getByTestId("task-lines-03").textContent).toBe("—");
    expect(screen.getByTestId("task-deps-01").textContent).toBe("—");
    expect(screen.getByTestId("task-deps-03").textContent).toBe("← 01, 02");
    expect(screen.getByTestId("run-meta").textContent).toContain("page not live");
    expect(screen.queryByTestId("open-live")).toBeNull();
    expect(screen.getByTestId("pr-panel").textContent).toContain("GITHUB");

    // Clicking a node highlights its row.
    expect(screen.getByTestId("graph-node-03").className).not.toContain("selected");
    fireEvent.click(screen.getByTestId("graph-node-03"));
    expect(screen.getByTestId("task-row-03").className).toContain("focused");
  });

  it("lists each reviewer of the run in the Review + live test card", async () => {
    const withReviewers = {
      ...applied,
      view: {
        ...applied.view,
        agents: { ...applied.view.agents, security: { status: "done" } },
        reviewers: [
          { id: "code", title: "Code review", node: { status: "done" }, findings: { blocker: 0, major: 1, minor: 0 } },
          { id: "tester", title: "Live test", node: { status: "done" }, findings: { blocker: 0, major: 0, minor: 0 } },
          { id: "security", title: "Security", node: { status: "done" }, findings: { blocker: 0, major: 1, minor: 1 } },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.endsWith("/pr") ? json(200, { eligible: false, reason: "GitHub is not connected" }) : json(200, withReviewers))),
    );
    renderAt(WS);
    const security = await screen.findByTestId("phase-reviewer-security");
    expect(security.textContent).toContain("Security");
    expect(security.textContent).toContain("0 blocker · 1 major · 1 minor");
    expect(screen.getByTestId("phase-review-rows").children).toHaveLength(3);
    expect(screen.getByTestId("phase-review").textContent).toContain("passed · 3 findings");
  });

  it("shows 'not reached' on the later phases of a failed run", async () => {
    const failed = {
      summary: { ...summary(WS), status: "failed", taskCounts: { merged: 2, failed: 1 } },
      state: { runId: "r1", provider: "fake", createdAt: "", status: "failed", tasks: {} },
      graph: { ...GRAPH, nodes: GRAPH.nodes.map((n) => (n.id === "03" ? { ...n, status: "failed" } : n)) },
      // What the engine's page reports for a run whose task failed: the gate and the fixer are skipped.
      view: {
        version: 1,
        runId: "r1",
        savedAt: "",
        final: true,
        phase: { phase: "tasks" },
        nodes: {},
        gate: { status: "skipped" },
        agents: { gateFixer: { status: "skipped" }, reviewer: { status: "pending" }, tester: { status: "pending" }, fixer: { status: "skipped" } },
        summary: { exitCode: 2, fixPasses: 3, findings: 0, abort: { step: "task 03", message: "task 03 failed after 3 attempts" } },
      },
      tasks: [
        { id: "01", title: "schema", status: "merged", attempts: 1, deps: [] },
        { id: "02", title: "config", status: "merged", attempts: 1, deps: [] },
        { id: "03", title: "auth", status: "failed", attempts: 3, deps: ["01", "02"], error: "tsc: 4 errors" },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.endsWith("/pr") ? json(200, { eligible: false, reason: "the run has not landed (status failed)" }) : json(200, failed))),
    );
    renderAt(WS);
    expect((await screen.findByTestId("phase-tasks")).textContent).toContain("03 failed after 3 attempts");
    expect(screen.getByTestId("phase-validation").textContent).toContain("not reached");
    expect(screen.getByTestId("phase-review").textContent).toContain("not reached");
    expect(screen.getByTestId("phase-fixer").textContent).toContain("not reached");
    expect(screen.getByTestId("phase-fixer").textContent).toContain("0 / 3 passes");
    expect(screen.queryByTestId("phase-landed")).toBeNull();
    expect(screen.getByTestId("graph-node-03").textContent).toContain("failed");
    expect(screen.getByTestId("graph-node-03").getAttribute("class")).toContain("tone-bad");
    expect((await screen.findByTestId("pr-reason")).textContent).toContain("has not landed");
  });

  it("opens a terminal in the workspace", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/terminals" && init?.method === "POST") return json(201, { id: "t9", title: "x", cwd: "/ws", status: "idle", createdAt: "" });
      if (url.endsWith("/pr")) return json(200, { eligible: false, reason: "x" });
      return json(200, applied);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAt(WS);
    fireEvent.click(await screen.findByTestId("open-terminal"));
    expect(await screen.findByTestId("terminals-page")).toBeTruthy();
    const sent = fetchMock.mock.calls.find(([u, i]) => u === "/api/terminals" && i?.method === "POST");
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ workspaceId: WS });
  });

  it("shows an empty state for a suite that is not live", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { summary: { ...summary(WS), type: "suite", status: "done" } })));
    renderAt(WS);
    expect((await screen.findByTestId("empty-state")).textContent).toContain("Suite r1 — open its page while it runs to see the features.");
  });
});

describe("RunDetail pull request section", () => {
  it("shows the prefilled Create PR form in the right column", async () => {
    const ws = "github~octo~hello";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === `/api/runs/${ws}/r1/pr` ? json(200, { eligible: true, suggested: SUGGESTED }) : json(200, { summary: summary(ws) }))),
    );
    renderAt(ws);
    expect((await screen.findByTestId("pr-submit")).textContent).toBe("Create PR");
    expect((screen.getByTestId("pr-branch") as HTMLInputElement).value).toBe("gm/r1");
    expect((screen.getByTestId("pr-body") as HTMLTextAreaElement).value).toBe("- [x] 1 Say hello");
  });

  it("shows the reason when the run cannot get a PR", async () => {
    const ws = "github~octo~hello";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/pr") ? json(200, { eligible: false, reason: "no uncommitted changes in the workspace" }) : json(200, { summary: summary(ws) }),
      ),
    );
    renderAt(ws);
    expect((await screen.findByTestId("pr-reason")).textContent).toContain("no uncommitted changes in the workspace");
    expect(screen.queryByTestId("pr-form")).toBeNull();
  });
});

describe("RunDetail Resume and Stop sandbox", () => {
  const RUN_URL = `/api/runs/${encodeURIComponent(WS)}/r1`;

  function stub(sum: Record<string, unknown>): { posts: string[] } {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push(url);
          if (url.endsWith("/resume")) return json(201, { runId: "r1", viewUrl: VIEW_URL });
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/pr")) return json(200, { eligible: false, reason: "x" });
        if (url.endsWith("/state")) return json(200, {});
        return json(200, { summary: { ...summary(WS), ...sum }, graph: GRAPH });
      }),
    );
    return { posts };
  }

  it("shows Resume for an aborted run that is not live; clicking it resumes the run", async () => {
    vi.useFakeTimers();
    const { posts } = stub({ status: "aborted", kind: "done" });
    renderAt(WS);
    await flush();
    fireEvent.click(screen.getByTestId("run-resume"));
    await flush();
    expect(posts).toEqual([`${RUN_URL}/resume`]);
    expect(document.body.textContent).toContain("Resumed run r1");
    expect(screen.queryByTestId("run-sandbox-chip")).toBeNull();
    expect(screen.queryByTestId("run-stop-sandbox")).toBeNull();
  });

  it("shows no Resume for an applied run", async () => {
    vi.useFakeTimers();
    stub({ status: "applied" });
    renderAt(WS);
    await flush();
    expect(screen.getByTestId("run-meta")).toBeTruthy();
    expect(screen.queryByTestId("run-resume")).toBeNull();
  });

  it("shows the sandbox chip and Stop sandbox for a live sandboxed run; confirming stops it", async () => {
    vi.useFakeTimers();
    const { posts } = stub({ status: "running", kind: "live", live: true, viewUrl: VIEW_URL, sandbox: { running: true } });
    renderAt(WS);
    await flush();
    expect(screen.getByTestId("run-sandbox-chip").textContent).toBe("sandbox");
    expect(screen.queryByTestId("run-resume")).toBeNull();
    fireEvent.click(screen.getByTestId("run-stop-sandbox"));
    expect(screen.getByRole("dialog").textContent).toContain("Stop the sandbox?");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop sandbox" }));
    await flush();
    expect(posts).toEqual([`${RUN_URL}/sandbox/stop`]);
  });
});

describe("RunDetail ?node= on a finished run", () => {
  it("selects the node in the graph and the task table; an unknown node is ignored", async () => {
    const detail = {
      summary: { ...summary(WS), provider: "fake" },
      state: { runId: "r1", provider: "fake", createdAt: "", status: "applied", tasks: {} },
      graph: GRAPH,
      tasks: [{ id: "03", title: "auth", status: "merged", attempts: 1, deps: ["01", "02"] }],
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/pr") ? json(200, { eligible: false, reason: "no" }) : json(200, detail))));
    renderAt(WS, "?node=03");
    await screen.findByTestId("graph-node-03");
    await vi.waitFor(() => expect(screen.getByTestId("graph-node-03").className).toContain("selected"));
    expect(screen.getByTestId("task-row-03").className).toContain("focused");
    cleanup();
    renderAt(WS, "?node=99");
    await screen.findByTestId("graph-node-03");
    expect(screen.getByTestId("graph-node-03").className).not.toContain("selected");
  });
});
