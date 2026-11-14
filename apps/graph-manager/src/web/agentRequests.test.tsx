// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRequestHost, requestText, useSetVisibleTerminals, VisibleTerminalsProvider } from "./agentRequests";
import { OverviewProvider, useOverview } from "./overview";
import type { AgentRequest } from "./types";
import { ToastProvider } from "./ui/toast";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const HELLO = "github~octo~hello";

const request = (extra: Partial<AgentRequest> = {}): AgentRequest => ({
  id: "req-1",
  kind: "start-run",
  terminalId: "t2",
  workspaceId: HELLO,
  agent: "claude",
  createdAt: new Date().toISOString(),
  prefill: { tasksDir: ".agents/tasks/agent-tools", spec: "docs/prd/agent-tools.md" },
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
    if (url === "/api/runs") return json(200, { runs: [] });
    if (url === "/api/terminals") return json(200, { terminals: [] });
    if (url === "/api/sessions")
      return json(200, {
        sessions: [{ id: "s1", repo: { forge: "github", owner: "octo", name: "hello" }, workspaceId: HELLO, branch: "main", state: "live", startedAt: "2026-11-13T00:00:00Z", terminals: [] }],
        limit: null,
      });
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

const acks = (f: ReturnType<typeof serve>) => f.mock.calls.filter(([u, i]) => i?.method === "POST" && String(u).endsWith("/ack")).map(([u]) => u);

function SetVisible({ ids }: { ids: string[] }) {
  useSetVisibleTerminals(useMemo(() => new Set(ids), [ids.join(",")]));
  return null;
}

function Refresh() {
  const { refresh } = useOverview();
  return (
    <button type="button" onClick={() => void refresh()}>
      poll
    </button>
  );
}

function renderHost(visible: string[] = []) {
  render(
    <MemoryRouter>
      <ToastProvider>
        <OverviewProvider>
          <VisibleTerminalsProvider>
            <SetVisible ids={visible} />
            <Refresh />
            <AgentRequestHost />
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

  it("names the project of a project request, and opens the project's form without paths", async () => {
    const project = request({ workspaceId: "project~billing", projectId: "billing", prefill: { provider: "fake" } });
    expect(requestText(project)).toBe("Claude Code in billing wants to start a run");

    const f = serve([project]);
    const base = f.getMockImplementation()!;
    f.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/projects") {
        return json(200, { projects: [{ id: "billing", name: "billing", forge: "github", path: "/ws/.projects/billing", createdAt: "", workspaces: [] }] });
      }
      if (url === "/api/projects/billing/inspect") return json(200, { id: "billing", name: "billing", contract: true, testPlan: false, repos: [] });
      return base(url, init);
    });
    renderHost(["t2"]);
    const drawer = await screen.findByTestId("start-run-drawer");
    await waitFor(() => expect((within(drawer).getByTestId("start-run-workspace") as HTMLSelectElement).value).toBe("project~billing"));
    await within(drawer).findByTestId("start-run-project-checks");
    expect(within(drawer).queryByTestId("start-run-tasks")).toBeNull();
    await waitFor(() => expect(screen.getByRole("radio", { name: "fake (test)" }).getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect(acks(f)).toEqual(["/api/agent-requests/req-1/ack"]));
  });

  it("names an unknown agent generically", () => {
    expect(requestText(request({ agent: undefined, workspaceId: "gitlab~platform~infra~deploy-tools" }))).toBe("An agent in deploy-tools wants to start a run");
  });
});
