// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewProvider } from "../overview";
import type { RunPlan, RunSummary, WorkspaceEntry } from "../types";
import { ToastProvider } from "../ui/toast";
import Approvals from "./Approvals";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const HELLO = "github~octo~hello";
const WAITING = "gm-20261113-100000-aaaa";

const run = (over: Partial<RunSummary> & { id: string }): RunSummary => ({
  workspaceId: HELLO,
  type: "run",
  status: "awaiting-approval",
  kind: "run",
  live: false,
  provider: "fake",
  createdAt: ago(30),
  ...over,
});

const WORKSPACES: WorkspaceEntry[] = [
  { id: HELLO, forge: "github", fullPath: "octo/hello", path: "/ws/github/octo/hello", branch: "main", dirty: false, remoteUrl: "" },
];

const PLAN: RunPlan = {
  name: "hello-feature",
  spec: { path: "docs/prd/hello-feature.md", title: "Hello feature", text: "# Hello feature\n\nThe planned body." },
  tasks: [{ id: "1", title: "Say hello" }],
  refs: [{ ref: "A", url: "https://example.com/A" }],
  questions: [],
  dropped: [],
  feedback: [],
};

const DEFAULT_RUNS = [run({ id: WAITING }), run({ id: "gm-20261113-090000-bbbb", status: "running", live: true })];

function stub(opts: { runs?: RunSummary[]; approve?: () => Response; reject?: () => Response } = {}) {
  const runs = opts.runs ?? DEFAULT_RUNS;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/runs") return json(200, { runs });
    if (url === "/api/terminals") return json(200, { terminals: [] });
    if (url === "/api/workspaces") return json(200, { workspaces: WORKSPACES });
    if (url === "/api/forges") return json(200, { github: { connected: false }, gitlab: { connected: false } });
    if (url === "/api/agent-requests") return json(200, { requests: [] });
    const base = `/api/runs/${encodeURIComponent(HELLO)}/${WAITING}`;
    if (url === `${base}/plan`) return json(200, PLAN);
    if (url === `${base}/approve` && init?.method === "POST") return opts.approve?.() ?? json(200, { id: WAITING, status: "running" });
    if (url === `${base}/reject` && init?.method === "POST") return opts.reject?.() ?? json(200, { id: WAITING, status: "planning" });
    return json(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/approvals"]}>
        <OverviewProvider>
          <Routes>
            <Route path="/approvals" element={<Approvals />} />
            <Route path="*" element={<div />} />
          </Routes>
        </OverviewProvider>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const row = () => screen.findByTestId(`approval-${HELLO}-${WAITING}`);
const posts = (fetchMock: ReturnType<typeof stub>) =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST").map(([url, init]) => [url, (init as RequestInit).body]);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Approvals", () => {
  it("lists only runs awaiting approval, with refs, the spec title and the task count", async () => {
    stub();
    renderPage();
    const r = await row();
    expect(screen.getAllByTestId(/^approval-github~/)).toHaveLength(1);
    expect(within(r).getByText("octo/hello")).toBeTruthy();
    expect(within(r).getByRole("link", { name: WAITING }).getAttribute("href")).toBe(`/runs/${encodeURIComponent(HELLO)}/${WAITING}`);
    await waitFor(() => expect(within(r).getByText("Hello feature")).toBeTruthy());
    expect(within(r).getByRole("link", { name: "A ↗" }).getAttribute("href")).toBe("https://example.com/A");
    expect(within(r).getByTestId("approval-task-count").textContent).toBe("1 task");
    expect(screen.queryByTestId(`approval-${HELLO}-gm-20261113-090000-bbbb`)).toBeNull();
  });

  it("opens the spec in SpecView with the task titles", async () => {
    stub();
    renderPage();
    const r = await row();
    const view = within(r).getByTestId("approval-view-spec");
    await waitFor(() => expect((view as HTMLButtonElement).disabled).toBe(false));
    expect(view.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(view);
    expect(view.getAttribute("aria-expanded")).toBe("true");
    expect(within(r).getByTestId("spec-view").textContent).toContain("The planned body.");
    expect(within(r).getByText("Say hello")).toBeTruthy();
  });

  it("approves a run", async () => {
    const fetchMock = stub();
    renderPage();
    const r = await row();
    fireEvent.click(within(r).getByTestId("approval-approve"));
    await waitFor(() => expect(posts(fetchMock)).toEqual([[`/api/runs/${encodeURIComponent(HELLO)}/${WAITING}/approve`, undefined]]));
    expect(await screen.findByText(`Approved ${WAITING}`)).toBeTruthy();
    expect(within(r).getByText("approved, starting…")).toBeTruthy();
  });

  it("toasts the server's message when approve fails", async () => {
    stub({ approve: () => json(409, { error: "the run is not awaiting approval (status running)" }) });
    renderPage();
    const r = await row();
    fireEvent.click(within(r).getByTestId("approval-approve"));
    expect(await screen.findByText("Couldn't approve: the run is not awaiting approval (status running)")).toBeTruthy();
    expect((within(r).getByTestId("approval-approve") as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends feedback with Request changes; Send is disabled while it is blank", async () => {
    const fetchMock = stub();
    renderPage();
    const r = await row();
    fireEvent.click(within(r).getByTestId("approval-request-changes"));
    const box = within(r).getByTestId("approval-feedback");
    const send = () => within(r).getByTestId("approval-send") as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    fireEvent.change(box, { target: { value: "   " } });
    expect(send().disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Use blue" } });
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    await waitFor(() => expect(posts(fetchMock)).toEqual([[`/api/runs/${encodeURIComponent(HELLO)}/${WAITING}/reject`, '{"feedback":"Use blue"}']]));
    expect(await screen.findByText("Sent back for re-planning")).toBeTruthy();
    expect(within(r).queryByTestId("approval-feedback")).toBeNull();
  });

  it("shows a reject error under the textarea", async () => {
    stub({ reject: () => json(400, { error: "feedback: must not be blank" }) });
    renderPage();
    const r = await row();
    fireEvent.click(within(r).getByTestId("approval-request-changes"));
    fireEvent.change(within(r).getByTestId("approval-feedback"), { target: { value: "x" } });
    fireEvent.click(within(r).getByTestId("approval-send"));
    expect((await within(r).findByRole("alert")).textContent).toBe("feedback: must not be blank");
  });

  it("shows the empty state when nothing waits", async () => {
    stub({ runs: [run({ id: "gm-x", status: "done" })] });
    renderPage();
    expect((await screen.findByTestId("empty-state")).textContent).toContain("Nothing waits for approval.");
  });
});
