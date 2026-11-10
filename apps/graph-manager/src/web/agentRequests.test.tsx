// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRequestHost, requestText, useRunPaneOpener, useSetVisibleTerminals, VisibleTerminalsProvider, type RunOpener } from "./agentRequests";
import { OverviewProvider, useOverview } from "./overview";
import type { AgentRequest, OpenGraphRequest, OpenRunRequest, ProposeGraphRequest, StartRunRequest, WorkspaceEntry } from "./types";
import { ToastProvider } from "./ui/toast";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const HELLO = "github~octo~hello";
const WORKSPACES: WorkspaceEntry[] = [{ id: HELLO, forge: "github", fullPath: "octo/hello", path: "/ws/github/octo/hello", branch: "main", dirty: false, remoteUrl: "" }];

const request = (extra: Partial<StartRunRequest> = {}): StartRunRequest => ({
  id: "req-1",
  kind: "start-run",
  terminalId: "t2",
  workspaceId: HELLO,
  agent: "claude",
  createdAt: new Date().toISOString(),
  prefill: { tasksDir: ".agents/tasks/agent-tools", spec: "docs/prd/agent-tools.md" },
  ...extra,
});

const RUN = "gm-20261109-101500-ab12";
const openRunReq = (extra: Partial<OpenRunRequest> = {}): OpenRunRequest => ({
  id: "req-2",
  kind: "open-run",
  terminalId: "t2",
  workspaceId: HELLO,
  agent: "claude",
  createdAt: new Date().toISOString(),
  runId: RUN,
  ...extra,
});

function serve(requests: AgentRequest[]) {
  const pending = [...requests];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const ack = /^\/api\/agent-requests\/([^/]+)\/ack$/.exec(url);
    if (ack && method === "POST") {
      const i = pending.findIndex((r) => r.id === decodeURIComponent(ack[1] ?? ""));
      if (i < 0) return json(404, { error: "not found" });
      pending.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    if (url === "/api/agent-requests") return json(200, { requests: pending });
    if (url.startsWith("/api/workspaces/") && url.includes("/graph?"))
      return json(200, {
        nodes: [
          { id: "1", title: "One", status: "pending" },
          { id: "2", title: "Two", status: "pending" },
        ],
        edges: [["1", "2"]],
        layers: [["1"], ["2"]],
      });
    if (url === "/api/runs") return json(200, { runs: [] });
    if (url === "/api/terminals") return json(200, { terminals: [] });
    if (url === "/api/workspaces") return json(200, { workspaces: WORKSPACES });
    if (url === "/api/forges") return json(200, { github: { connected: false }, gitlab: { connected: false } });
    if (url === "/api/sandbox/status") return json(200, { available: false, reason: "no docker" });
    if (url.endsWith("/run-defaults")) return json(200, {});
    if (url.endsWith("/settings")) return json(200, { image: null, sandbox: false });
    if (url.includes("/inspect")) return json(200, { branch: "main", changes: 0 });
    return json(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The ack POSTs as [url, body] (body undefined when none was sent). */
const ackBodies = (f: ReturnType<typeof serve>) =>
  f.mock.calls.filter(([u, i]) => i?.method === "POST" && String(u).endsWith("/ack")).map(([u, i]) => [u, i?.body]);

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

const acks = (f: ReturnType<typeof serve>) => f.mock.calls.filter(([u, i]) => i?.method === "POST" && String(u).endsWith("/ack")).map(([u]) => u);

function SetVisible({ ids }: { ids: string[] }) {
  useSetVisibleTerminals(useMemo(() => new Set(ids), [ids.join(",")]));
  return null;
}

function RegisterOpener({ fn }: { fn?: RunOpener }) {
  useRunPaneOpener(fn ?? NOOP);
  return null;
}
const NOOP: RunOpener = () => {};

function Refresh() {
  const { refresh } = useOverview();
  return (
    <button type="button" onClick={() => void refresh()}>
      poll
    </button>
  );
}

function renderHost(visible: string[] = [], opener?: RunOpener) {
  render(
    <MemoryRouter>
      <ToastProvider>
        <OverviewProvider>
          <VisibleTerminalsProvider>
            <SetVisible ids={visible} />
            {opener && <RegisterOpener fn={opener} />}
            <Refresh />
            <AgentRequestHost />
            <Routes>
              <Route path="*" element={<Where />} />
            </Routes>
          </VisibleTerminalsProvider>
        </OverviewProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("AgentRequestHost", () => {
  it("opens the prefilled drawer when the request's terminal is on screen, and acks it", async () => {
    const f = serve([request()]);
    renderHost(["t2"]);
    const drawer = await screen.findByTestId("start-run-drawer");
    await waitFor(() => expect((within(drawer).getByTestId("start-run-tasks") as HTMLInputElement).value).toBe(".agents/tasks/agent-tools"));
    expect((within(drawer).getByTestId("start-run-spec") as HTMLInputElement).value).toBe("docs/prd/agent-tools.md");
    expect((within(drawer).getByTestId("start-run-workspace") as HTMLSelectElement).value).toBe(HELLO);
    await waitFor(() => expect(acks(f)).toEqual(["/api/agent-requests/req-1/ack"]));
    expect(screen.queryByText("Claude Code in hello wants to start a run")).toBeNull();
  });

  it("applies the requested provider and options", async () => {
    serve([request({ prefill: { tasksDir: "diamond", spec: "spec.md", provider: "fake", options: { concurrency: 3 } } })]);
    renderHost(["t2"]);
    await screen.findByTestId("start-run-drawer");
    await waitFor(() => expect(screen.getByRole("radio", { name: "fake (test)" }).getAttribute("aria-checked")).toBe("true"));
    expect((screen.getByTestId("start-run-concurrency") as HTMLInputElement).value).toBe("3");
    expect((screen.getByTestId("start-run-tasks") as HTMLInputElement).value).toBe("diamond");
  });

  it("toasts once when the terminal is not on screen; Open opens the prefilled drawer and acks", async () => {
    const f = serve([request()]);
    renderHost([]);
    const text = await screen.findByText("Claude Code in hello wants to start a run");
    expect(screen.queryByTestId("start-run-drawer")).toBeNull();
    expect(acks(f)).toEqual([]);

    fireEvent.click(screen.getByText("poll"));
    fireEvent.click(screen.getByText("poll"));
    await waitFor(() => expect(f.mock.calls.filter(([u]) => u === "/api/agent-requests").length).toBeGreaterThanOrEqual(2));
    expect(screen.getAllByText("Claude Code in hello wants to start a run")).toHaveLength(1);

    fireEvent.click(within(text.closest(".toast") as HTMLElement).getByText("Open"));
    const drawer = await screen.findByTestId("start-run-drawer");
    await waitFor(() => expect((within(drawer).getByTestId("start-run-tasks") as HTMLInputElement).value).toBe(".agents/tasks/agent-tools"));
    expect((within(drawer).getByTestId("start-run-spec") as HTMLInputElement).value).toBe("docs/prd/agent-tools.md");
    await waitFor(() => expect(acks(f)).toEqual(["/api/agent-requests/req-1/ack"]));
  });

  it("names an unknown agent generically", () => {
    expect(requestText(request({ agent: undefined, workspaceId: "gitlab~platform~infra~deploy-tools" }))).toBe("An agent in deploy-tools wants to start a run");
  });

  it("opens an open-run request in the Terminals page's pane when its terminal is on screen, and acks it", async () => {
    const f = serve([openRunReq()]);
    const fn = vi.fn();
    renderHost(["t2"], fn);
    await waitFor(() => expect(fn).toHaveBeenCalledWith(HELLO, RUN));
    expect(fn).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(acks(f)).toEqual(["/api/agent-requests/req-2/ack"]));
    expect(screen.queryByText(`Claude Code in hello: run ${RUN}`)).toBeNull();
  });

  it("toasts an open-run request once when its terminal is not on screen; Open acks and goes to the run page", async () => {
    const f = serve([openRunReq()]);
    renderHost([]);
    const text = await screen.findByText(`Claude Code in hello: run ${RUN}`);
    fireEvent.click(screen.getByText("poll"));
    fireEvent.click(screen.getByText("poll"));
    await waitFor(() => expect(f.mock.calls.filter(([u]) => u === "/api/agent-requests").length).toBeGreaterThanOrEqual(2));
    expect(screen.getAllByText(`Claude Code in hello: run ${RUN}`)).toHaveLength(1);
    expect(acks(f)).toEqual([]);

    fireEvent.click(within(text.closest(".toast") as HTMLElement).getByText("Open"));
    await waitFor(() => expect(acks(f)).toEqual(["/api/agent-requests/req-2/ack"]));
    expect(window.location.pathname).toBe(`/runs/${HELLO}/${RUN}`);
  });

  it("re-polls at once on a refresh request, once per id, without acking it", async () => {
    const f = serve([{ id: "r-1", kind: "refresh", workspaceId: HELLO, createdAt: new Date().toISOString() } satisfies AgentRequest]);
    renderHost([]);
    const runsPolls = () => f.mock.calls.filter(([u]) => u === "/api/runs").length;
    await waitFor(() => expect(runsPolls()).toBeGreaterThanOrEqual(2), { timeout: 1500 });
    const n = runsPolls();
    await new Promise((r) => setTimeout(r, 300));
    expect(runsPolls()).toBe(n);
    expect(acks(f)).toEqual([]);
  });

  it("names a graph request", () => {
    const r: OpenGraphRequest = { id: "g", kind: "open-graph", terminalId: "t2", workspaceId: HELLO, agent: "claude", createdAt: "", tasksDir: "tasks" };
    expect(requestText(r)).toBe("Claude Code in hello wants to show you a graph");
  });

  const graphReq = (extra: Partial<OpenGraphRequest> = {}): OpenGraphRequest => ({
    id: "g-1",
    kind: "open-graph",
    terminalId: "t2",
    workspaceId: HELLO,
    agent: "claude",
    createdAt: new Date().toISOString(),
    ...extra,
  });
  const proposeReq = (extra: Partial<ProposeGraphRequest> = {}): ProposeGraphRequest => ({
    id: "p-1",
    kind: "propose-graph",
    terminalId: "t2",
    workspaceId: HELLO,
    agent: "claude",
    createdAt: new Date().toISOString(),
    prefill: { tasksDir: ".agents/tasks/x", spec: "docs/prd/x.md" },
    ...extra,
  });

  it("opens a read-only preview of a folder's graph when the terminal is on screen, and acks it", async () => {
    const f = serve([graphReq({ tasksDir: ".agents/tasks/x", node: "2" })]);
    renderHost(["t2"]);
    const dialog = await screen.findByTestId("graph-preview");
    expect(within(dialog).getByText("Graph of .agents/tasks/x")).toBeTruthy();
    await within(dialog).findByTestId("graph-node-1");
    expect(within(dialog).getByTestId("graph-node-2").className).toContain("selected");
    expect(within(dialog).queryByTestId("graph-preview-approve")).toBeNull();
    expect(f.mock.calls.some(([u]) => String(u) === `/api/workspaces/${HELLO}/graph?tasksDir=.agents%2Ftasks%2Fx`)).toBe(true);
    await waitFor(() => expect(acks(f)).toEqual(["/api/agent-requests/g-1/ack"]));
    fireEvent.click(within(dialog).getByTestId("graph-preview-close"));
    expect(screen.queryByTestId("graph-preview")).toBeNull();
  });

  it("toasts a run graph when the terminal is not on screen; Open goes to the run page at the node", async () => {
    const f = serve([graphReq({ runId: RUN, node: "2" })]);
    renderHost([]);
    const text = await screen.findByText("Claude Code in hello wants to show you a graph");
    expect(acks(f)).toEqual([]);
    fireEvent.click(within(text.closest(".toast") as HTMLElement).getByText("Open"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/runs/${HELLO}/${RUN}?node=2`));
    await waitFor(() => expect(acks(f)).toEqual(["/api/agent-requests/g-1/ack"]));
    expect(screen.queryByTestId("graph-preview")).toBeNull();
  });

  it("shows a proposed graph with Approve and Reject; Reject acks rejected, Approve acks approved and opens the drawer", async () => {
    const f = serve([proposeReq()]);
    renderHost(["t2"]);
    let dialog = await screen.findByTestId("graph-preview");
    await within(dialog).findByTestId("graph-node-2");
    expect(acks(f)).toEqual([]);
    fireEvent.click(within(dialog).getByTestId("graph-preview-reject"));
    expect(screen.queryByTestId("graph-preview")).toBeNull();
    await waitFor(() => expect(ackBodies(f)).toEqual([["/api/agent-requests/p-1/ack", JSON.stringify({ result: "rejected" })]]));
    expect(screen.queryByTestId("start-run-drawer")).toBeNull();

    cleanup();
    const g = serve([proposeReq({ id: "p-2" })]);
    renderHost(["t2"]);
    dialog = await screen.findByTestId("graph-preview");
    fireEvent.click(within(dialog).getByTestId("graph-preview-approve"));
    await waitFor(() => expect(ackBodies(g)).toEqual([["/api/agent-requests/p-2/ack", JSON.stringify({ result: "approved" })]]));
    const drawer = await screen.findByTestId("start-run-drawer");
    await waitFor(() => expect((within(drawer).getByTestId("start-run-tasks") as HTMLInputElement).value).toBe(".agents/tasks/x"));
    expect(screen.queryByTestId("graph-preview")).toBeNull();
  });

  it("keeps a proposed graph pending when its preview is closed, and offers it again from a toast (T2)", async () => {
    const f = serve([proposeReq()]);
    renderHost(["t2"]);
    const dialog = await screen.findByTestId("graph-preview");
    fireEvent.click(within(dialog).getByTestId("graph-preview-close"));
    const text = await screen.findByText("Claude Code in hello wants to show you a graph");
    expect(screen.queryByTestId("graph-preview")).toBeNull();
    expect(acks(f)).toEqual([]);
    // Open brings the preview back; closing it again, then × on the toast, rejects it.
    fireEvent.click(within(text.closest(".toast") as HTMLElement).getByText("Open"));
    fireEvent.click(within(await screen.findByTestId("graph-preview")).getByTestId("graph-preview-close"));
    const again = await screen.findByText("Claude Code in hello wants to show you a graph");
    fireEvent.click(within(again.closest(".toast") as HTMLElement).getByLabelText("Dismiss"));
    await waitFor(() => expect(ackBodies(f)).toEqual([["/api/agent-requests/p-1/ack", JSON.stringify({ result: "rejected" })]]));
  });

  it("makes agent-request toasts sticky; × acks the request and a request gone elsewhere takes its toast along (T3)", async () => {
    const f = serve([openRunReq(), openRunReq({ id: "req-3", runId: "gm-20261109-101500-cd34" })]);
    renderHost([]);
    const text = await screen.findByText(`Claude Code in hello: run ${RUN}`);
    fireEvent.click(within(text.closest(".toast") as HTMLElement).getByLabelText("Dismiss"));
    await waitFor(() => expect(acks(f)).toEqual(["/api/agent-requests/req-2/ack"]));
    expect(screen.queryByText(`Claude Code in hello: run ${RUN}`)).toBeNull();
    // req-3 is acked by another tab: the next poll drops its toast.
    await fetch("/api/agent-requests/req-3/ack", { method: "POST" });
    fireEvent.click(screen.getByText("poll"));
    await waitFor(() => expect(screen.queryByText("Claude Code in hello: run gm-20261109-101500-cd34")).toBeNull());
  });
});
