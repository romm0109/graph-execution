// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import RunDetail from "./RunDetail";
import Runs from "./Runs";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const RUN = {
  workspaceId: "github~octo~hello",
  type: "run",
  id: "r1",
  status: "running",
  kind: "live",
  live: true,
  viewUrl: "/runs/github~octo~hello/r1/view/",
  createdAt: new Date().toISOString(),
  provider: "fake",
  taskCounts: { merged: 2, running: 2 },
};

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/runs" element={<Runs />} />
        <Route path="/runs/:ws/:runId" element={<RunDetail />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

describe("Runs page", () => {
  it("lists runs and opens one on click", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === "/api/runs" ? json(200, { runs: [RUN] }) : json(404, { error: "not found" }))));
    renderAt("/runs");
    const row = await screen.findByTestId("run-row-github~octo~hello-r1");
    expect(row.textContent).toContain("github/octo/hello");
    expect(row.textContent).toContain("2/4");
    expect(row.querySelector(".status-running")).toBeTruthy();
    fireEvent.click(row);
    expect(screen.getByTestId("where").textContent).toBe("/runs/github~octo~hello/r1");
  });

  it("shows the start error on 400 and navigates on 201", async () => {
    let fail = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/runs/github~octo~hello" && init?.method === "POST") {
        return fail ? json(400, { error: "error: spec not found" }) : json(201, { runId: "gm-1", viewUrl: "/runs/github~octo~hello/gm-1/view/" });
      }
      if (url === "/api/runs") return json(200, { runs: [RUN] });
      return json(404, { error: "not found" });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/runs?workspace=github~octo~hello");
    fireEvent.click(await screen.findByTestId("start-run"));
    fireEvent.change(screen.getByTestId("start-run-spec"), { target: { value: "spec.md" } });
    fireEvent.change(screen.getByTestId("start-run-provider"), { target: { value: "fake" } });
    fireEvent.click(screen.getByTestId("start-run-submit"));
    expect((await screen.findByTestId("start-run-error")).textContent).toContain("spec not found");
    const sent = fetchMock.mock.calls.find(([u, i]) => u === "/api/runs/github~octo~hello" && i?.method === "POST");
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ tasksDir: ".agents/tasks", spec: "spec.md", provider: "fake" });
    fail = false;
    fireEvent.click(screen.getByTestId("start-run-submit"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/runs/github~octo~hello/gm-1"));
  });
});

describe("RunDetail page", () => {
  it("shows the live page in an iframe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { summary: RUN })));
    renderAt("/runs/github~octo~hello/r1");
    const frame = await screen.findByTestId("run-live-view");
    expect(frame.getAttribute("src")).toBe("/runs/github~octo~hello/r1/view/");
    expect(screen.getByTestId("run-pr")).toBeTruthy();
  });

  it("shows the static graph when the run's page is down", async () => {
    const graph = {
      nodes: [
        { id: "1", title: "Base", status: "merged" },
        { id: "2", title: "Feature", status: "failed" },
      ],
      edges: [["1", "2"]],
      layers: [["1"], ["2"]],
    };
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { summary: { ...RUN, live: false, viewUrl: undefined, status: "failed" }, graph })));
    renderAt("/runs/github~octo~hello/r1");
    const view = await screen.findByTestId("run-static-graph");
    expect(view.querySelectorAll("path.graph-edge")).toHaveLength(1);
    expect(screen.getByTestId("graph-node-2").getAttribute("class")).toContain("status-failed");
    expect(screen.queryByTestId("run-live-view")).toBeNull();
  });
});
