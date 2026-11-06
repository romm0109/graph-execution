// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import RunDetail from "./RunDetail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const summary = (ws: string) => ({ workspaceId: ws, type: "run", id: "r1", status: "applied", kind: "done", live: false, createdAt: new Date().toISOString() });
const SUGGESTED = { branch: "gm/r1", title: "Hello feature", body: "- [x] 1 Say hello", base: "main" };

function renderAt(ws: string) {
  return render(
    <MemoryRouter initialEntries={[`/runs/${ws}/r1`]}>
      <Routes>
        <Route path="/runs/:ws/:runId" element={<RunDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunDetail pull request section", () => {
  it("creates a PR from the prefilled form and shows the link", async () => {
    const ws = "github~octo~hello";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `/api/runs/${ws}/r1/pr` && init?.method === "POST") return json(201, { pr: { url: "http://forge/pull/1", number: 1, branch: "gm/r1" } });
      if (url === `/api/runs/${ws}/r1/pr`) return json(200, { eligible: true, suggested: SUGGESTED });
      return json(200, { summary: summary(ws) });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAt(ws);
    const open = await screen.findByTestId("pr-open");
    expect(open.textContent).toBe("Create PR");
    fireEvent.click(open);
    expect((screen.getByTestId("pr-branch") as HTMLInputElement).value).toBe("gm/r1");
    expect((screen.getByTestId("pr-title") as HTMLInputElement).value).toBe("Hello feature");
    fireEvent.change(screen.getByTestId("pr-title"), { target: { value: "Edited" } });
    fireEvent.click(screen.getByTestId("pr-submit"));
    const link = await screen.findByTestId("pr-link");
    expect(link.textContent).toBe("Pull request #1");
    expect(link.getAttribute("href")).toBe("http://forge/pull/1");
    expect(link.getAttribute("target")).toBe("_blank");
    const sent = fetchMock.mock.calls.find(([u, i]) => u === `/api/runs/${ws}/r1/pr` && i?.method === "POST");
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ ...SUGGESTED, title: "Edited" });
  });

  it("shows the failed step and offers Create MR on GitLab", async () => {
    const ws = "gitlab~grp~sub~proj";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/pr") && init?.method === "POST") return json(502, { error: "push failed: denied", step: "push" });
        if (url.endsWith("/pr")) return json(200, { eligible: true, suggested: SUGGESTED });
        return json(200, { summary: summary(ws) });
      }),
    );
    renderAt(ws);
    const open = await screen.findByTestId("pr-open");
    expect(open.textContent).toBe("Create MR");
    fireEvent.click(open);
    fireEvent.click(screen.getByTestId("pr-submit"));
    expect((await screen.findByTestId("pr-error")).textContent).toBe("push failed: denied");
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
    expect(screen.queryByTestId("pr-open")).toBeNull();
  });
});
