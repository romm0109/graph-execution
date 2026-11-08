// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewProvider } from "../overview";
import type { CloneJob, ForgesInfo, RunSummary, WorkspaceEntry } from "../types";
import { ToastProvider } from "../ui/toast";
import Workspaces, { LIVE_DELETE_HINT, deleteBody } from "./Workspaces";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderPage(entry = "/workspaces") {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[entry]}>
        <OverviewProvider>
          <Routes>
            <Route path="/workspaces" element={<Workspaces />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </OverviewProvider>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const ws = (fullPath: string, extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({
  id: `github~${fullPath.split("/").join("~")}`,
  forge: "github",
  fullPath,
  path: `/ws/github/${fullPath}`,
  branch: "main",
  dirty: false,
  changes: 0,
  remoteUrl: `https://github.com/${fullPath}.git`,
  ...extra,
});

const run = (workspaceId: string, id: string, live: boolean): RunSummary => ({
  workspaceId,
  id,
  live,
  status: live ? "running" : "applied",
  type: "run",
  kind: "run",
});

const REPOS = [
  { fullPath: "octo/hello", name: "hello", private: false, webUrl: "" },
  { fullPath: "octo/secret", name: "secret", private: true, webUrl: "" },
  { fullPath: "octo/cli", name: "cli", private: false, webUrl: "" },
];

interface FakeOpts {
  forges?: ForgesInfo;
  workspaces?: WorkspaceEntry[];
  runs?: RunSummary[];
  deleteStatus?: number;
  reposError?: string;
  wsImage?: string | null;
  wsSettingsError?: string;
}

function fakeApi(opts: FakeOpts = {}) {
  const state = {
    forges: opts.forges ?? {
      github: { connected: true, login: "octocat" },
      gitlab: { connected: false },
    },
    workspaces: [...(opts.workspaces ?? [])],
    runs: opts.runs ?? [],
    jobs: [] as CloneJob[],
    wsImage: opts.wsImage ?? null,
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/runs") return json({ runs: state.runs });
    if (url === "/api/terminals") return json({ terminals: [] });
    if (url === "/api/workspaces" && method === "GET") return json({ workspaces: state.workspaces, root: "/srv/ws" });
    if (url === "/api/forges") return json(state.forges);
    if (url === "/api/workspaces/clones") return json({ jobs: state.jobs });
    if (url.startsWith("/api/forges/github/repos")) {
      if (opts.reposError) return json({ error: opts.reposError }, 400);
      const q = new URL(url, "http://x").searchParams.get("q") ?? "";
      return json({ repos: REPOS.filter((r) => r.fullPath.includes(q)) });
    }
    if (url === "/api/workspaces" && method === "POST") {
      const { forge, fullPath } = JSON.parse(String(init?.body)) as {
        forge: "github";
        fullPath: string;
      };
      const job: CloneJob = {
        id: `job-${fullPath}`,
        forge,
        fullPath,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      state.jobs.push(job);
      return json({ job }, 202);
    }
    if (url === "/api/sandbox/status") return json({ available: true, defaultImage: "ghcr.io/acme/gm:1" });
    if (/^\/api\/workspaces\/[^/]+\/settings$/.test(url) && method === "GET") return json({ image: state.wsImage, sandbox: false });
    if (/^\/api\/workspaces\/[^/]+\/settings$/.test(url) && method === "PUT") {
      if (opts.wsSettingsError) return json({ error: opts.wsSettingsError }, 400);
      state.wsImage = (JSON.parse(String(init?.body)) as { image: string | null }).image;
      return json({ image: state.wsImage, sandbox: false });
    }
    const del = /^\/api\/workspaces\/(.+)$/.exec(url);
    if (del && method === "DELETE") {
      if (opts.deleteStatus) return json({ error: "a run is live in this workspace" }, opts.deleteStatus);
      state.workspaces = state.workspaces.filter((w) => w.id !== decodeURIComponent(del[1]!));
      return new Response(null, { status: 204 });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, state };
}

describe("Workspaces table", () => {
  it("renders root, forge, branch, tree, runs and remote", async () => {
    fakeApi({
      workspaces: [ws("octo/hello", { dirty: true, changes: 3 }), ws("octo/docs")],
      runs: [run("github~octo~hello", "r1", true), run("github~octo~hello", "r2", false), run("github~octo~hello", "r3", false)],
    });
    renderPage();
    const row = await screen.findByTestId("workspace-github~octo~hello");
    expect(screen.getByTestId("workspaces-root").textContent).toBe("/srv/ws");
    expect(screen.getByTestId("workspace-count").textContent).toBe("2");
    expect(row.textContent).toContain("GITHUB");
    expect(row.textContent).toContain("https://github.com/octo/hello.git");
    expect(row.textContent).toContain("main");
    expect(within(row).getByTestId("state-github~octo~hello").textContent).toBe("dirty");
    expect(within(row).getByTestId("runs-count-github~octo~hello").textContent).toBe("3 · 1 live");
    expect(screen.getByTestId("runs-count-github~octo~docs").textContent).toBe("—");
    expect(screen.getByTestId("state-github~octo~docs").textContent).toBe("clean");
    expect(within(row).getByTestId("open-terminal-github~octo~hello").getAttribute("href")).toBe("/terminals?workspace=github~octo~hello");
    expect(within(row).getByTestId("runs-github~octo~hello").getAttribute("href")).toBe("/runs?workspace=github~octo~hello");
    expect(screen.getByText(/Delete is disabled while a run is live/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter workspaces"), {
      target: { value: "docs" },
    });
    expect(screen.queryByTestId("workspace-github~octo~hello")).toBeNull();
    expect(screen.getByTestId("workspace-github~octo~docs")).toBeTruthy();
  });

  it("opens a terminal in the focused row with j and Enter", async () => {
    fakeApi({ workspaces: [ws("octo/hello"), ws("octo/docs")] });
    renderPage();
    await screen.findByTestId("workspace-github~octo~hello");
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect((await screen.findByTestId("where")).textContent).toBe("/terminals?workspace=github~octo~docs");
  });

  it("disables Delete while a run is live and explains why", async () => {
    fakeApi({
      workspaces: [ws("octo/hello")],
      runs: [run("github~octo~hello", "20261106-193934-b2dc", true)],
    });
    renderPage();
    await screen.findByTestId("workspace-github~octo~hello");
    const btn = screen.getByTestId("delete-github~octo~hello") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(LIVE_DELETE_HINT);
    fireEvent.click(screen.getByTestId("delete-wrap-github~octo~hello"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Can’t delete octo/hello yet");
    expect(dialog.textContent).toContain("Run 20261106-193934-b2dc is live in this workspace. Abort it or wait for it to finish.");
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["OK Esc", "Open run"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Open run" }));
    expect((await screen.findByTestId("where")).textContent).toBe("/runs/github~octo~hello/20261106-193934-b2dc");
  });

  it("shows the Can't delete dialog when the server answers 409", async () => {
    fakeApi({ workspaces: [ws("octo/hello")], deleteStatus: 409 });
    renderPage();
    await screen.findByTestId("workspace-github~octo~hello");
    fireEvent.click(screen.getByTestId("delete-github~octo~hello"));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    expect((await screen.findByText("Can’t delete octo/hello yet")).closest("[role=dialog]")).toBeTruthy();
  });

  it("confirms deletion with the changes count, deletes and toasts", async () => {
    fakeApi({ workspaces: [ws("octo/hello", { dirty: true, changes: 2 })] });
    renderPage();
    await screen.findByTestId("workspace-github~octo~hello");
    fireEvent.click(screen.getByTestId("delete-github~octo~hello"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Delete workspace octo/hello?");
    expect(dialog.textContent).toContain("This removes the clone and its 2 uncommitted files from the container. Its runs are removed with it.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Deleted octo/hello")).toBeTruthy();
    expect(await screen.findByText("No workspaces yet")).toBeTruthy();
  });

  it("words the delete body by the changes count", () => {
    expect(deleteBody(ws("a/b"))).toBe("This removes the clone from the container. Its runs are removed with it.");
    expect(deleteBody(ws("a/b", { dirty: true, changes: 1 }))).toContain("its 1 uncommitted file from");
  });

  it("shows the empty states", async () => {
    fakeApi({
      forges: { github: { connected: false }, gitlab: { connected: false } },
    });
    renderPage();
    expect(await screen.findByText("Connect GitHub or GitLab first")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Settings" }).getAttribute("href")).toBe("/settings");
    cleanup();
    fakeApi();
    renderPage();
    expect(await screen.findByText("No workspaces yet")).toBeTruthy();
    expect(screen.getByText(/Connected as/).textContent).toContain("octocat");
  });
});

describe("Clone drawer", () => {
  it("searches, marks cloned repos, clones with progress, then toasts", async () => {
    const { fetchMock, state } = fakeApi({ workspaces: [ws("octo/hello")] });
    renderPage("/workspaces?clone=1");
    const drawer = await screen.findByTestId("clone-drawer");
    expect(within(drawer).getByTestId("clone-forge-github").textContent).toContain("as octocat");
    const gl = within(drawer).getByTestId("clone-forge-gitlab") as HTMLButtonElement;
    expect(gl.disabled).toBe(true);
    expect(gl.textContent).toContain("not connected");
    expect(drawer.textContent).toContain("Repos are cloned into /srv/ws/<forge>/<full path>");

    fireEvent.change(within(drawer).getByTestId("repo-search"), {
      target: { value: "octo" },
    });
    const hello = await within(drawer).findByTestId("repo-octo/hello", {}, { timeout: 2000 });
    await waitFor(() => expect(within(drawer).getByTestId("repo-count").textContent).toBe("3 results"));
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/forges/github/repos?q=octo")).toBe(true);
    expect(hello.textContent).toContain("already cloned");
    expect(within(hello).queryByRole("button", { name: "Clone" })).toBeNull();
    expect(within(drawer).getByTestId("repo-octo/secret").textContent).toContain("private");

    fireEvent.click(within(drawer).getByTestId("clone-octo/cli"));
    await waitFor(() => expect(state.jobs).toHaveLength(1));
    const job = state.jobs[0]!;
    expect(fetchMock.mock.calls.some(([u, init]) => u === "/api/workspaces" && (init as RequestInit | undefined)?.method === "POST")).toBe(true);

    Object.assign(job, {
      progress: 0.58,
      phase: "Receiving objects: 64% (1204/2071)",
    });
    const cli = within(drawer).getByTestId("repo-octo/cli");
    await waitFor(() => expect(within(cli).getByTestId("clone-pct-octo/cli").textContent).toBe("58%"), { timeout: 3000 });
    expect(cli.textContent).toContain("Receiving objects: 64% (1204/2071)");
    expect(within(cli).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("58");

    const done = ws("octo/cli");
    Object.assign(job, {
      status: "done",
      progress: 1,
      workspace: done,
      endedAt: new Date().toISOString(),
    });
    state.workspaces.push(done);
    expect(await screen.findByText("Cloned octo/cli", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open terminal" })).toBeTruthy();
    await waitFor(() => expect(within(drawer).getByTestId("repo-octo/cli").textContent).toContain("already cloned"));
  });

  it("shows a failed clone's error with the Clone button back", async () => {
    const { state } = fakeApi();
    renderPage("/workspaces?clone=1");
    const drawer = await screen.findByTestId("clone-drawer");
    fireEvent.click(await within(drawer).findByTestId("clone-octo/secret", {}, { timeout: 2000 }));
    await waitFor(() => expect(state.jobs).toHaveLength(1));
    Object.assign(state.jobs[0]!, {
      status: "failed",
      error: "clone failed: repository is empty",
      endedAt: new Date().toISOString(),
    });
    const row = within(drawer).getByTestId("repo-octo/secret");
    expect((await within(row).findByRole("alert", {}, { timeout: 3000 })).textContent).toBe("clone failed: repository is empty");
    expect(within(row).getByTestId("clone-octo/secret")).toBeTruthy();
  });

  it("says when no forge is connected", async () => {
    fakeApi({
      forges: { github: { connected: false }, gitlab: { connected: false } },
    });
    renderPage();
    await screen.findByText("Connect GitHub or GitLab first");
    fireEvent.click(screen.getByTestId("clone-open"));
    const box = await screen.findByTestId("clone-no-forge");
    expect(box.textContent).toContain("No forge connected.");
    expect(within(box).getByRole("link", { name: "Connect one in Settings" }).getAttribute("href")).toBe("/settings");
  });

  it("says when the search is empty, and shows forge errors", async () => {
    fakeApi();
    renderPage("/workspaces?clone=1");
    const drawer = await screen.findByTestId("clone-drawer");
    fireEvent.change(within(drawer).getByTestId("repo-search"), {
      target: { value: "paymnts" },
    });
    expect((await within(drawer).findByTestId("clone-empty", {}, { timeout: 2000 })).textContent).toBe("No repositories match “paymnts” for octocat.");
    cleanup();
    fakeApi({ reposError: "github token is invalid or revoked" });
    renderPage("/workspaces?clone=1");
    expect((await screen.findByTestId("clone-search-error", {}, { timeout: 2000 })).textContent).toBe("github token is invalid or revoked");
  });

  it("closes with Escape and drops ?clone=1", async () => {
    fakeApi();
    renderPage("/workspaces?clone=1");
    await screen.findByTestId("clone-drawer");
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });
    });
    await waitFor(() => expect(screen.queryByTestId("clone-drawer")).toBeNull());
  });
});

describe("Workspace settings drawer", () => {
  const SETTINGS_URL = "/api/workspaces/github~octo~hello/settings";

  it("opens with the loaded image and the default image as placeholder", async () => {
    fakeApi({ workspaces: [ws("octo/hello")], wsImage: "node:22-bookworm" });
    renderPage();
    fireEvent.click(await screen.findByTestId("settings-github~octo~hello"));
    const drawer = await screen.findByTestId("workspace-settings-drawer");
    expect(drawer.textContent).toContain("Workspace settings");
    expect(drawer.textContent).toContain("octo/hello");
    const input = within(drawer).getByTestId("workspace-image") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("node:22-bookworm"));
    await waitFor(() => expect(input.placeholder).toBe("ghcr.io/acme/gm:1"));
    expect(drawer.textContent).toContain("Needs node 20+, git and glibc (not Alpine). Empty: the image built in Settings → Sandbox.");
  });

  it("saves the image with PUT, toasts and closes", async () => {
    const { fetchMock } = fakeApi({ workspaces: [ws("octo/hello")] });
    renderPage();
    fireEvent.click(await screen.findByTestId("settings-github~octo~hello"));
    const drawer = await screen.findByTestId("workspace-settings-drawer");
    const input = within(drawer).getByTestId("workspace-image") as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "python:3.12-bookworm" } });
    fireEvent.click(within(drawer).getByTestId("workspace-settings-save"));
    await waitFor(() => expect(screen.queryByTestId("workspace-settings-drawer")).toBeNull());
    expect(await screen.findByText("Saved settings for octo/hello")).toBeTruthy();
    const puts = fetchMock.mock.calls.filter(([u, init]) => u === SETTINGS_URL && init?.method === "PUT");
    expect(puts[0]?.[1]?.body).toBe(JSON.stringify({ image: "python:3.12-bookworm" }));
  });

  it("sends null for an empty image and shows a 400 in the drawer", async () => {
    const { fetchMock } = fakeApi({ workspaces: [ws("octo/hello")], wsImage: "node:22", wsSettingsError: "image: not a valid image reference" });
    renderPage();
    fireEvent.click(await screen.findByTestId("settings-github~octo~hello"));
    const drawer = await screen.findByTestId("workspace-settings-drawer");
    const input = within(drawer).getByTestId("workspace-image") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("node:22"));
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.click(within(drawer).getByTestId("workspace-settings-save"));
    expect((await within(drawer).findByRole("alert")).textContent).toBe("image: not a valid image reference");
    expect(screen.getByTestId("workspace-settings-drawer")).toBeTruthy();
    const puts = fetchMock.mock.calls.filter(([u, init]) => u === SETTINGS_URL && init?.method === "PUT");
    expect(puts[0]?.[1]?.body).toBe(JSON.stringify({ image: null }));
  });
});
