// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import Workspaces, { type WorkspaceEntry } from "./Workspaces";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/workspaces"]}>
      <Routes>
        <Route path="/workspaces" element={<Workspaces />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

function fakeApi(forges = { github: { connected: true, login: "octo" }, gitlab: { connected: false } }) {
  const workspaces: WorkspaceEntry[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/workspaces" && method === "GET") return json({ workspaces });
    if (url === "/api/forges") return json(forges);
    if (url.startsWith("/api/forges/github/repos")) {
      const q = new URL(url, "http://x").searchParams.get("q") ?? "";
      const all = [
        { fullPath: "octo/hello", name: "hello", private: false, webUrl: "" },
        { fullPath: "octo/secret", name: "secret", private: true, webUrl: "" },
      ];
      return json({ repos: all.filter((r) => r.fullPath.includes(q)) });
    }
    if (url === "/api/workspaces" && method === "POST") {
      const { forge, fullPath } = JSON.parse(String(init?.body)) as { forge: string; fullPath: string };
      if (fullPath === "octo/secret") return json({ error: "git clone failed: denied" }, 502);
      const ws = { id: `${forge}~${fullPath.split("/").join("~")}`, forge, fullPath, path: `/ws/${forge}/${fullPath}`, branch: "main", dirty: false, remoteUrl: "file:///x" };
      workspaces.push(ws);
      return json(ws, 201);
    }
    const del = /^\/api\/workspaces\/(.+)$/.exec(url);
    if (del && method === "DELETE") {
      const i = workspaces.findIndex((w) => w.id === decodeURIComponent(del[1]!));
      if (i >= 0) workspaces.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Workspaces", () => {
  it("clones from a search, lists the workspace and opens a terminal", async () => {
    const fetchMock = fakeApi();
    renderPage();
    expect(await screen.findByText(/No workspaces yet/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("clone-open"));
    fireEvent.change(await screen.findByTestId("repo-search"), { target: { value: "hello" } });
    const row = await screen.findByTestId("repo-octo/hello", {}, { timeout: 2000 });
    expect(screen.queryByTestId("repo-octo/secret")).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/forges/github/repos?q=hello")).toBe(true);
    fireEvent.click(within(row).getByTestId("clone-octo/hello"));
    const ws = await screen.findByTestId("workspace-github~octo~hello");
    expect(ws.textContent).toContain("main");
    expect(ws.textContent).toContain("clean");
    fireEvent.click(within(ws).getByTestId("open-terminal-github~octo~hello"));
    expect((await screen.findByTestId("where")).textContent).toBe("/terminals?workspace=github~octo~hello");
  });

  it("shows a clone error and deletes after confirming", async () => {
    fakeApi();
    vi.stubGlobal("confirm", () => true);
    renderPage();
    fireEvent.click(await screen.findByTestId("clone-open"));
    const secret = await screen.findByTestId("repo-octo/secret", {}, { timeout: 2000 });
    expect(secret.textContent).toContain("private");
    fireEvent.click(within(secret).getByTestId("clone-octo/secret"));
    expect((await within(secret).findByRole("alert")).textContent).toBe("git clone failed: denied");
    fireEvent.click(within(screen.getByTestId("repo-octo/hello")).getByTestId("clone-octo/hello"));
    await screen.findByTestId("workspace-github~octo~hello");
    fireEvent.click(screen.getByTestId("delete-github~octo~hello"));
    expect(await screen.findByText(/No workspaces yet/)).toBeTruthy();
  });

  it("links to Settings when no forge is connected", async () => {
    fakeApi({ github: { connected: false } as never, gitlab: { connected: false } });
    renderPage();
    fireEvent.click(await screen.findByTestId("clone-open"));
    expect((await screen.findByRole("link", { name: "Settings" })).getAttribute("href")).toBe("/settings");
  });
});
