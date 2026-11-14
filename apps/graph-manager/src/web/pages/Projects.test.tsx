// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewProvider } from "../overview";
import type { ProjectEntry, WorkspaceEntry } from "../types";
import { ToastProvider } from "../ui/toast";
import Projects from "./Projects";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderPage(entry = "/projects") {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[entry]}>
        <OverviewProvider>
          <Routes>
            <Route path="/projects" element={<Projects />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </OverviewProvider>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const ws = (forge: string, fullPath: string): WorkspaceEntry => ({
  id: `${forge}~${fullPath.split("/").join("~")}`,
  forge,
  fullPath,
  path: `/ws/${forge}/${fullPath}`,
  branch: "main",
  dirty: false,
  changes: 0,
  remoteUrl: "",
});

const API = ws("github", "octo/api");
const WEB = ws("github", "octo/web");
const OTHER = ws("github", "other/api");
const LIB = ws("gitlab", "grp/lib");
const ALL = [API, WEB, OTHER, LIB];

const viewOf = (name: string, list: WorkspaceEntry[]): ProjectEntry => {
  const used = new Set<string>();
  return {
    id: name.toLowerCase(),
    name,
    forge: list[0]?.forge ?? "",
    path: `/ws/.projects/${name.toLowerCase()}`,
    createdAt: "2026-11-13T00:00:00.000Z",
    workspaces: list.map((w) => {
      const base = w.fullPath.split("/").pop()!;
      let repo = base;
      for (let n = 2; used.has(repo); n++) repo = `${base}-${n}`;
      used.add(repo);
      return { id: w.id, fullPath: w.fullPath, repo };
    }),
  };
};

interface FakeOpts {
  workspaces?: WorkspaceEntry[];
  projects?: ProjectEntry[];
  /** The answer of POST instead of creating: `[status, error]`. */
  postError?: [number, string];
  deleteError?: [number, string];
  listError?: string;
}

function fakeApi(opts: FakeOpts = {}) {
  const state = { workspaces: opts.workspaces ?? ALL, projects: [...(opts.projects ?? [])], listError: opts.listError };
  const byId = (ids: string[]) => ids.map((id) => state.workspaces.find((w) => w.id === id)!);
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/runs") return json({ runs: [] });
    if (url === "/api/terminals") return json({ terminals: [] });
    if (url === "/api/workspaces") return json({ workspaces: state.workspaces, root: "/ws" });
    if (url === "/api/agents") {
      return json({
        agents: [
          { id: "claude", label: "Claude Code", binary: "claude", installed: true, connect: "inject" },
          { id: "codex", label: "Codex", binary: "codex", installed: false, connect: "inject" },
          { id: "opencode", label: "OpenCode", binary: "opencode", installed: true, connect: "inject" },
          { id: "qwen", label: "Qwen Code", binary: "qwen", installed: true, connect: "project-config" },
        ],
      });
    }
    if (url === "/api/forges") return json({ github: { connected: true, login: "octocat" }, gitlab: { connected: false } });
    if (url === "/api/projects" && method === "GET") {
      if (state.listError) return json({ error: state.listError }, 500);
      return json({ projects: state.projects });
    }
    if (url === "/api/projects" && method === "POST") {
      if (opts.postError) return json({ error: opts.postError[1] }, opts.postError[0]);
      const body = JSON.parse(String(init?.body)) as { name: string; workspaces: string[] };
      const view = viewOf(body.name, byId(body.workspaces));
      state.projects.push(view);
      return json(view, 201);
    }
    const one = /^\/api\/projects\/([^/]+)$/.exec(url);
    if (one && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { workspaces: string[] };
      const i = state.projects.findIndex((p) => p.id === one[1]);
      if (i < 0) return json({ error: "project not found" }, 404);
      state.projects[i] = viewOf(state.projects[i]!.name, byId(body.workspaces));
      return json(state.projects[i]);
    }
    if (one && method === "DELETE") {
      if (opts.deleteError) return json({ error: opts.deleteError[1] }, opts.deleteError[0]);
      state.projects = state.projects.filter((p) => p.id !== one[1]);
      return new Response(null, { status: 204 });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  const calls = (method: string) =>
    fetchMock.mock.calls
      .filter(([url, init]) => String(url).startsWith("/api/projects") && (init?.method ?? "GET") === method)
      .map(([url, init]) => ({ url: String(url), body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown) }));
  return { fetchMock, state, calls };
}

const check = (id: string) => fireEvent.click(screen.getByTestId(`project-ws-${id}`));
const saveButton = () => screen.getByTestId<HTMLButtonElement>("project-save");

describe("Projects page", () => {
  it("lists a project with its forge chip, folder and repo chips", async () => {
    fakeApi({ projects: [viewOf("billing", [API, OTHER])] });
    renderPage();
    const row = await screen.findByTestId("project-billing");
    expect(row.querySelector(".chip[data-forge=github]")?.textContent).toBe("GITHUB");
    expect(row.querySelector(".pj-name")?.textContent).toBe("billing");
    expect(row.querySelector(".pj-path")?.textContent).toBe("/ws/.projects/billing");
    const chips = [...screen.getByTestId("project-repos-billing").querySelectorAll(".chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["api", "api-2"]);
    expect(chips.map((c) => c.getAttribute("title"))).toEqual(["octo/api", "other/api"]);
    expect(screen.getByTestId("project-count").textContent).toBe("1");
    expect(screen.getByTestId("project-edit-billing").textContent).toBe("Edit repos");
    expect(screen.getByRole("button", { name: "Delete billing" })).toBeTruthy();
  });

  it("each row has the agent buttons and a plain Terminal button; a CLI that is not installed is disabled", async () => {
    fakeApi({ projects: [viewOf("billing", [API, WEB])] });
    renderPage();
    const row = await screen.findByTestId("project-billing");
    const group = within(row).getByRole("group", { name: "Open a terminal on billing" });
    await waitFor(() => expect(screen.getByTestId<HTMLButtonElement>("project-agent-billing-codex").disabled).toBe(true));
    expect(within(group).getAllByRole("button").map((b) => b.getAttribute("data-testid"))).toEqual([
      "project-agent-billing-claude",
      "project-agent-billing-codex",
      "project-agent-billing-opencode",
      "project-agent-billing-qwen",
      "project-terminal-billing",
    ]);
    expect(screen.getByTestId("project-agent-billing-codex").getAttribute("title")).toBe("codex is not installed");
    const claude = within(group).getByRole<HTMLButtonElement>("button", { name: "Open Claude Code on billing" });
    expect(claude.disabled).toBe(false);
    expect(claude.querySelector(".agent-icon.agent-claude")).toBeTruthy();
    expect(screen.getByTestId("project-terminal-billing").textContent).toBe("Terminal");
    fireEvent.click(claude);
    expect((await screen.findByTestId("where")).textContent).toBe("/terminals?project=billing&agent=claude");
  });

  it("the plain Terminal button opens a terminal on the project", async () => {
    fakeApi({ projects: [viewOf("billing", [API, WEB])] });
    renderPage();
    fireEvent.click(await screen.findByTestId("project-terminal-billing"));
    expect((await screen.findByTestId("where")).textContent).toBe("/terminals?project=billing");
  });

  it("asks for two workspaces first when there are fewer", async () => {
    fakeApi({ workspaces: [API] });
    renderPage();
    expect(await screen.findByText("Clone at least two repositories first")).toBeTruthy();
    expect(within(screen.getByTestId("empty-state")).getByRole("link").getAttribute("href")).toBe("/workspaces");
    cleanup();
    fakeApi({ workspaces: [] });
    renderPage();
    expect(await screen.findByText("Clone at least two repositories first")).toBeTruthy();
  });

  it("offers New project when there are no projects", async () => {
    fakeApi();
    renderPage();
    expect(await screen.findByText("No projects yet")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("empty-state")).getByRole("button", { name: "New project" }));
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeTruthy();
  });

  it("shows a load error with Retry", async () => {
    const { state } = fakeApi({ projects: [viewOf("billing", [API, WEB])], listError: "internal error" });
    renderPage();
    const alert = await screen.findByTestId("projects-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("internal error");
    state.listError = undefined;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("project-billing")).toBeTruthy();
    expect(screen.queryByTestId("projects-error")).toBeNull();
  });

  it("creates a project from workspaces of one forge, in the order they were checked", async () => {
    const { calls } = fakeApi();
    renderPage();
    await screen.findByText("No projects yet");
    fireEvent.click(screen.getByTestId("project-new"));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    expect(screen.getByTestId("project-ws-gitlab~grp~lib")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(screen.getByTestId("project-name"), { target: { value: "bad name!" } });
    expect(screen.getByTestId("project-name-error")).toBeTruthy();
    fireEvent.change(screen.getByTestId("project-name"), { target: { value: "billing" } });
    expect(screen.queryByTestId("project-name-error")).toBeNull();
    expect(dialog.textContent).toContain(".projects/billing");

    check(WEB.id);
    expect(screen.queryByTestId("project-ws-gitlab~grp~lib")).toBeNull();
    expect(screen.getByTestId("project-forge-hint").textContent).toBe("Only github workspaces: a project uses one forge connection.");
    expect(saveButton().disabled).toBe(true);
    check(API.id);
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().textContent).toBe("Create");

    // Unchecking the last one brings the other forges back.
    check(API.id);
    check(WEB.id);
    expect(screen.getByTestId("project-ws-gitlab~grp~lib")).toBeTruthy();
    check(API.id);
    check(WEB.id);

    fireEvent.click(saveButton());
    expect(await screen.findByText("Created billing")).toBeTruthy();
    expect(calls("POST")).toEqual([{ url: "/api/projects", body: { name: "billing", workspaces: [API.id, WEB.id] } }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const row = await screen.findByTestId("project-billing");
    expect([...row.querySelectorAll(".pj-repos-cell .chip")].map((c) => c.textContent)).toEqual(["api", "web"]);
  });

  it("keeps the dialog open with the server's error", async () => {
    fakeApi({ postError: [409, "a project named billing already exists"] });
    renderPage("/projects?new=1");
    await screen.findByRole("dialog", { name: "New project" });
    fireEvent.change(screen.getByTestId("project-name"), { target: { value: "Billing" } });
    await screen.findByTestId(`project-ws-${API.id}`);
    check(API.id);
    check(WEB.id);
    fireEvent.click(saveButton());
    expect((await screen.findByTestId("project-error")).textContent).toBe("a project named billing already exists");
    expect(screen.getByRole("dialog", { name: "New project" })).toBeTruthy();
    expect(screen.getByTestId<HTMLInputElement>("project-name").value).toBe("Billing");
  });

  it("opens the dialog on ?new=1 and Esc closes it", async () => {
    fakeApi();
    renderPage("/projects?new=1");
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("edits the repos of a project", async () => {
    const { calls } = fakeApi({ projects: [viewOf("billing", [API, WEB])] });
    renderPage();
    fireEvent.click(await screen.findByTestId("project-edit-billing"));
    await screen.findByRole("dialog", { name: "Edit repos of billing" });
    const name = screen.getByTestId<HTMLInputElement>("project-name");
    expect(name.value).toBe("billing");
    expect(name.readOnly).toBe(true);
    expect(screen.getByTestId<HTMLInputElement>(`project-ws-${API.id}`).checked).toBe(true);
    expect(screen.getByTestId<HTMLInputElement>(`project-ws-${OTHER.id}`).checked).toBe(false);
    expect(screen.queryByTestId("project-ws-gitlab~grp~lib")).toBeNull();
    expect(saveButton().textContent).toBe("Save");

    check(WEB.id);
    expect(saveButton().disabled).toBe(true);
    check(OTHER.id);
    fireEvent.click(saveButton());
    expect(await screen.findByText("Saved billing")).toBeTruthy();
    expect(calls("PATCH")).toEqual([{ url: "/api/projects/billing", body: { workspaces: [API.id, OTHER.id] } }]);
    await waitFor(() =>
      expect([...screen.getByTestId("project-repos-billing").querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["api", "api-2"]),
    );
  });

  it("deletes a project after asking", async () => {
    const { calls } = fakeApi({ projects: [viewOf("billing", [API, WEB])] });
    renderPage();
    fireEvent.click(await screen.findByTestId("project-delete-billing"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Delete project billing?");
    expect(dialog.textContent).toContain("This removes the project folder /ws/.projects/billing with its specs, tasks and runs. The workspaces stay.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Deleted billing")).toBeTruthy();
    expect(calls("DELETE")).toEqual([{ url: "/api/projects/billing", body: undefined }]);
    expect(await screen.findByText("No projects yet")).toBeTruthy();
  });

  it("says why a delete failed", async () => {
    fakeApi({ projects: [viewOf("billing", [API, WEB])], deleteError: [409, "a run of this project is live"] });
    renderPage();
    fireEvent.click(await screen.findByTestId("project-delete-billing"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Couldn’t delete billing: a run of this project is live")).toBeTruthy();
    expect(screen.getByTestId("project-billing")).toBeTruthy();
  });
});
