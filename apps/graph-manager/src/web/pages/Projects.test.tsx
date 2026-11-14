// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewProvider } from "../overview";
import type { ProjectEntry, RepoRef } from "../types";
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

interface Repo {
  ref: RepoRef;
  fullPath: string;
}
const repo = (forge: "github" | "gitlab", fullPath: string): Repo => {
  const parts = fullPath.split("/");
  return { ref: { forge, owner: parts.slice(0, -1).join("/"), name: parts[parts.length - 1]! }, fullPath };
};

const API = repo("github", "octo/api");
const WEB = repo("github", "octo/web");
const OTHER = repo("github", "other/api");
const LIB = repo("gitlab", "grp/lib");
const ALL = [API, WEB, OTHER, LIB];

const viewOf = (name: string, list: RepoRef[]): ProjectEntry => {
  const used = new Set<string>();
  return {
    id: name.toLowerCase(),
    name,
    forge: list[0]?.forge ?? "",
    path: `/ws/.projects/${name.toLowerCase()}`,
    createdAt: "2026-11-13T00:00:00.000Z",
    repos: list,
    workspaces: list.map((r) => {
      let name = r.name;
      for (let n = 2; used.has(name); n++) name = `${r.name}-${n}`;
      used.add(name);
      return { id: [r.forge, ...r.owner.split("/"), r.name].join("~"), fullPath: `${r.owner}/${r.name}`, repo: name };
    }),
  };
};

interface FakeOpts {
  repos?: Repo[];
  projects?: ProjectEntry[];
  forges?: { github: boolean; gitlab: boolean };
  sessions?: object[];
  /** The answer of POST instead of creating: `[status, error]`. */
  postError?: [number, string];
  deleteError?: [number, string];
  listError?: string;
}

function fakeApi(opts: FakeOpts = {}) {
  const forges = opts.forges ?? { github: true, gitlab: true };
  const state = { repos: opts.repos ?? ALL, projects: [...(opts.projects ?? [])], listError: opts.listError };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/runs") return json({ runs: [] });
    if (url === "/api/terminals") return json({ terminals: [] });
    if (url === "/api/sessions") return json({ sessions: opts.sessions ?? [], limit: null });
    if (url.startsWith("/api/repos?")) {
      const q = new URL(url, "http://x").searchParams.get("q") ?? "";
      const repos = state.repos
        .filter((r) => forges[r.ref.forge] && r.fullPath.includes(q))
        .map((r) => ({ repo: r.ref, fullPath: r.fullPath, defaultBranch: "main", private: false, webUrl: "", live: false }));
      return json({ repos, forges });
    }
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
    if (url === "/api/forges") return json({ github: { connected: forges.github, login: "octocat" }, gitlab: { connected: forges.gitlab } });
    if (url === "/api/projects" && method === "GET") {
      if (state.listError) return json({ error: state.listError }, 500);
      return json({ projects: state.projects });
    }
    if (url === "/api/projects" && method === "POST") {
      if (opts.postError) return json({ error: opts.postError[1] }, opts.postError[0]);
      const body = JSON.parse(String(init?.body)) as { name: string; repos: RepoRef[] };
      const view = viewOf(body.name, body.repos);
      state.projects.push(view);
      return json(view, 201);
    }
    const one = /^\/api\/projects\/([^/]+)$/.exec(url);
    if (one && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { repos: RepoRef[] };
      const i = state.projects.findIndex((p) => p.id === one[1]);
      if (i < 0) return json({ error: "project not found" }, 404);
      state.projects[i] = viewOf(state.projects[i]!.name, body.repos);
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
  const searches = () => fetchMock.mock.calls.map(([url]) => String(url)).filter((u) => u.startsWith("/api/repos?"));
  return { fetchMock, state, calls, searches };
}

const testIdOf = (r: Repo) => `project-repo-${r.ref.forge}-${r.ref.owner}/${r.ref.name}`;
const check = (r: Repo) => fireEvent.click(screen.getByTestId(testIdOf(r)));
const saveButton = () => screen.getByTestId<HTMLButtonElement>("project-save");

describe("Projects page", () => {
  it("lists a project with its forge chip, folder and repo chips", async () => {
    fakeApi({ projects: [viewOf("billing", [API.ref, OTHER.ref])] });
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
    expect(screen.queryByTestId("project-live-billing")).toBeNull();
    expect(screen.getByText("Deleting a project removes its folder only. The clones stay.")).toBeTruthy();
  });

  it("names a repo chip by its repository when the project has no folder names yet", async () => {
    const view = { ...viewOf("billing", [API.ref, WEB.ref]), workspaces: [] };
    fakeApi({ projects: [view] });
    renderPage();
    await screen.findByTestId("project-billing");
    expect([...screen.getByTestId("project-repos-billing").querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["api", "web"]);
  });

  it("shows a live badge on a project with a live session", async () => {
    const session = { id: "s1", repo: API.ref, projectId: "billing", workspaceId: "project~billing", branch: "gm/x", state: "live", startedAt: "", terminals: ["t1"] };
    fakeApi({ projects: [viewOf("billing", [API.ref, WEB.ref])], sessions: [session] });
    renderPage();
    expect((await screen.findByTestId("project-live-billing")).textContent).toBe("live");
  });

  it("each row has the agent buttons and a plain Terminal button; a CLI that is not installed is disabled", async () => {
    fakeApi({ projects: [viewOf("billing", [API.ref, WEB.ref])] });
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
    const claude = within(group).getByRole<HTMLButtonElement>("button", { name: "Open Claude Code on billing" });
    fireEvent.click(claude);
    expect((await screen.findByTestId("where")).textContent).toBe("/terminals?project=billing&agent=claude");
  });

  it("the plain Terminal button opens the New terminal dialog on the project", async () => {
    fakeApi({ projects: [viewOf("billing", [API.ref, WEB.ref])] });
    renderPage();
    fireEvent.click(await screen.findByTestId("project-terminal-billing"));
    expect((await screen.findByTestId("where")).textContent).toBe("/terminals?project=billing");
  });

  it("asks to connect a forge first when none is connected", async () => {
    fakeApi({ forges: { github: false, gitlab: false } });
    renderPage();
    expect(await screen.findByText("Connect GitHub or GitLab first")).toBeTruthy();
    expect(within(screen.getByTestId("empty-state")).getByRole("link").getAttribute("href")).toBe("/settings");
  });

  it("offers New project when there are no projects", async () => {
    fakeApi();
    renderPage();
    expect(await screen.findByText("No projects yet")).toBeTruthy();
    expect(screen.getByText("A project groups repositories of one forge in one folder, for specs, tasks and runs across them.")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("empty-state")).getByRole("button", { name: "New project" }));
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeTruthy();
  });

  it("the dialog says to connect a forge when none is", async () => {
    fakeApi({ forges: { github: false, gitlab: false } });
    renderPage("/projects?new=1");
    expect((await screen.findByTestId("project-no-forge")).textContent).toBe("Connect GitHub or GitLab in Settings first.");
    expect(screen.queryByTestId("project-repo-search")).toBeNull();
  });

  it("shows a load error with Retry", async () => {
    const { state } = fakeApi({ projects: [viewOf("billing", [API.ref, WEB.ref])], listError: "internal error" });
    renderPage();
    const alert = await screen.findByTestId("projects-error");
    expect(alert.textContent).toContain("internal error");
    state.listError = undefined;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("project-billing")).toBeTruthy();
    expect(screen.queryByTestId("projects-error")).toBeNull();
  });

  it("creates a project from searched repositories of one forge, in the order they were picked", async () => {
    const { calls, searches } = fakeApi();
    renderPage();
    await screen.findByText("No projects yet");
    fireEvent.click(screen.getByTestId("project-new"));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    expect(screen.getByTestId<HTMLInputElement>("project-repo-search").placeholder).toBe("Search repositories");
    expect(await screen.findByTestId(testIdOf(LIB))).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(screen.getByTestId("project-name"), { target: { value: "bad name!" } });
    expect(screen.getByTestId("project-name-error")).toBeTruthy();
    fireEvent.change(screen.getByTestId("project-name"), { target: { value: "billing" } });
    expect(dialog.textContent).toContain(".projects/billing");
    expect(screen.getByTestId("project-forge-hint").textContent).toBe("Pick at least two repositories of one forge.");

    check(WEB);
    expect(screen.queryByTestId(testIdOf(LIB))).toBeNull();
    expect(screen.getByTestId("project-forge-hint").textContent).toBe("Only github repositories: a project uses one forge connection.");
    expect(saveButton().disabled).toBe(true);

    // A new search: the pick stays (as a chip) though the results no longer list it.
    fireEvent.change(screen.getByTestId("project-repo-search"), { target: { value: "octo/api" } });
    await waitFor(() => expect(searches()).toContain("/api/repos?q=octo%2Fapi"));
    await waitFor(() => expect(screen.queryByTestId(testIdOf(WEB))).toBeNull());
    expect(screen.getByTestId("project-picked").textContent).toContain("octo/web");
    check(API);
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().textContent).toBe("Create");
    expect([...screen.getByTestId("project-picked").querySelectorAll(".chip")].map((c) => c.textContent?.replace("×", ""))).toEqual(["octo/web", "octo/api"]);

    fireEvent.click(saveButton());
    expect(await screen.findByText("Created billing")).toBeTruthy();
    expect(calls("POST")).toEqual([{ url: "/api/projects", body: { name: "billing", repos: [WEB.ref, API.ref] } }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const row = await screen.findByTestId("project-billing");
    expect([...row.querySelectorAll(".pj-repos-cell .chip")].map((c) => c.textContent)).toEqual(["web", "api"]);
  });

  it("removing the last pick brings the other forge back", async () => {
    fakeApi();
    renderPage("/projects?new=1");
    await screen.findByTestId(testIdOf(LIB));
    check(API);
    expect(screen.queryByTestId(testIdOf(LIB))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove octo/api" }));
    expect(screen.getByTestId(testIdOf(LIB))).toBeTruthy();
    expect(screen.queryByTestId("project-picked")).toBeNull();
  });

  it("keeps the dialog open with the server's error", async () => {
    fakeApi({ postError: [409, "a project named billing already exists"] });
    renderPage("/projects?new=1");
    await screen.findByRole("dialog", { name: "New project" });
    fireEvent.change(screen.getByTestId("project-name"), { target: { value: "Billing" } });
    await screen.findByTestId(testIdOf(API));
    check(API);
    check(WEB);
    fireEvent.click(saveButton());
    expect((await screen.findByTestId("project-error")).textContent).toBe("a project named billing already exists");
    expect(screen.getByRole("dialog", { name: "New project" })).toBeTruthy();
  });

  it("opens the dialog on ?new=1 and Esc closes it", async () => {
    fakeApi();
    renderPage("/projects?new=1");
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("edits the repos of a project, starting with its repos", async () => {
    const { calls } = fakeApi({ projects: [viewOf("billing", [API.ref, WEB.ref])] });
    renderPage();
    fireEvent.click(await screen.findByTestId("project-edit-billing"));
    await screen.findByRole("dialog", { name: "Edit repos of billing" });
    const name = screen.getByTestId<HTMLInputElement>("project-name");
    expect(name.value).toBe("billing");
    expect(name.readOnly).toBe(true);
    await screen.findByTestId(testIdOf(OTHER));
    expect(screen.getByTestId<HTMLInputElement>(testIdOf(API)).checked).toBe(true);
    expect(screen.getByTestId<HTMLInputElement>(testIdOf(OTHER)).checked).toBe(false);
    expect(screen.queryByTestId(testIdOf(LIB))).toBeNull();
    expect(saveButton().textContent).toBe("Save");

    check(WEB);
    expect(saveButton().disabled).toBe(true);
    check(OTHER);
    fireEvent.click(saveButton());
    expect(await screen.findByText("Saved billing")).toBeTruthy();
    expect(calls("PATCH")).toEqual([{ url: "/api/projects/billing", body: { repos: [API.ref, OTHER.ref] } }]);
    await waitFor(() =>
      expect([...screen.getByTestId("project-repos-billing").querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["api", "api-2"]),
    );
  });

  it("deletes a project after asking", async () => {
    const { calls } = fakeApi({ projects: [viewOf("billing", [API.ref, WEB.ref])] });
    renderPage();
    fireEvent.click(await screen.findByTestId("project-delete-billing"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Delete project billing?");
    expect(dialog.textContent).toContain("This removes the project folder /ws/.projects/billing with its specs, tasks and runs. The clones stay.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Deleted billing")).toBeTruthy();
    expect(calls("DELETE")).toEqual([{ url: "/api/projects/billing", body: undefined }]);
    expect(await screen.findByText("No projects yet")).toBeTruthy();
  });

  it("says why a delete failed", async () => {
    fakeApi({ projects: [viewOf("billing", [API.ref, WEB.ref])], deleteError: [409, "project billing has a live session. Close it first."] });
    renderPage();
    fireEvent.click(await screen.findByTestId("project-delete-billing"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Couldn’t delete billing: project billing has a live session. Close it first.")).toBeTruthy();
    expect(screen.getByTestId("project-billing")).toBeTruthy();
  });
});
