// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRequestHost, requestText, useSetVisibleTerminals, VisibleTerminalsProvider } from "./agentRequests";
import { OverviewProvider, useOverview } from "./overview";
import type { AgentRequest, WorkspaceEntry } from "./types";
import { ToastProvider } from "./ui/toast";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const HELLO = "github~octo~hello";
const WORKSPACES: WorkspaceEntry[] = [{ id: HELLO, forge: "github", fullPath: "octo/hello", path: "/ws/github/octo/hello", branch: "main", dirty: false, remoteUrl: "" }];

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
    expect(drawer.classList.contains("drawer-agent")).toBe(true);
    const badge = within(drawer).getByTestId("drawer-badge");
    expect(badge.textContent).toBe("Opened by Claude Code");
    expect(within(badge).getByTestId("agent-icon-claude")).toBeTruthy();
  });

  it("badges an unknown agent as An agent, with no icon", async () => {
    serve([request({ agent: "mystery" })]);
    renderHost(["t2"]);
    const drawer = await screen.findByTestId("start-run-drawer");
    expect(drawer.classList.contains("drawer-agent")).toBe(true);
    const badge = within(drawer).getByTestId("drawer-badge");
    expect(badge.textContent).toBe("Opened by An agent");
    expect(badge.querySelector("[data-testid^='agent-icon-']")).toBeNull();
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
    expect(drawer.classList.contains("drawer-agent")).toBe(true);
    expect(within(drawer).getByTestId("drawer-badge").textContent).toBe("Opened by Claude Code");
  });

  it("names an unknown agent generically", () => {
    expect(requestText(request({ agent: undefined, workspaceId: "gitlab~platform~infra~deploy-tools" }))).toBe("An agent in deploy-tools wants to start a run");
  });
});
