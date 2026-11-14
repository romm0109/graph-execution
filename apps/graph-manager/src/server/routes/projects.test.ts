import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { projectOf, projectsOf, type UserStore } from "../store.js";
import { appWithLogin, repoOfId, signUp, writeProjectFolderForTest } from "../test-helpers.js";
import type { ProjectView } from "./projects.js";

let app: FastifyInstance;
let cookie: string;
let config: Config;
let store: UserStore;
let cleanup: () => Promise<void>;

const REPOS = ["github/octo/api", "github/octo/web", "gitlab/grp/lib", "github/other/api", "github/octo/my.app"];
const API = "github~octo~api";
const WEB = "github~octo~web";
const OTHER = "github~other~api";

const wsPath = (rel: string) => path.join(config.workspacesDir, ...rel.split("/"));
const projectDir = (id = "billing") => path.join(config.workspacesDir, ".projects", id);

beforeEach(async () => {
  ({ app, cookie, config, store, cleanup } = await appWithLogin({ signup: "open" }));
  for (const rel of REPOS) {
    mkdirSync(wsPath(rel), { recursive: true });
    await execa("git", ["init", "-q", "-b", "main"], { cwd: wsPath(rel) });
    writeFileSync(path.join(wsPath(rel), "README.md"), `# ${rel}\n`);
  }
});

afterEach(async () => {
  await cleanup();
});

const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
const create = (name: string, workspaces: string[]) => req("POST", "/api/projects", { name, repos: workspaces.map(repoOfId) });
const patch = (workspaces: string[], id = "billing") => req("PATCH", `/api/projects/${id}`, { repos: workspaces.map(repoOfId) });
/** The folder a project session's prepare writes. */
const folder = (workspaces: string[], id = "billing", name = id) => writeProjectFolderForTest(config.workspacesDir, id, name, workspaces);
/** A live project session of the admin on `billing`. */
const liveSession = () =>
  store.update((d) => {
    d.sessions.s1 = {
      id: "s1",
      repo: repoOfId(API),
      projectId: "billing",
      repos: [repoOfId(API), repoOfId(WEB)],
      workspaceId: "project~billing",
      branch: "gm/x",
      state: "live",
      startedAt: new Date().toISOString(),
    };
  });
const gitOut = async (cwd: string, args: string[]) => (await execa("git", args, { cwd })).stdout;
const projectJson = (id = "billing") => JSON.parse(readFileSync(path.join(projectDir(id), "project.json"), "utf8")) as unknown;

describe("POST /api/projects", () => {
  it("rejects a bad name, a repository twice, too few and two forges", async () => {
    let res = await create("bad name!", [API, WEB]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid project name: use letters, digits, - and _" });

    res = await create("billing", [API, API]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "a repository is listed twice" });

    res = await create("billing", [API]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "a project needs at least 2 repositories" });

    res = await create("billing", [API, "gitlab~grp~lib"]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "all repositories of a project must come from one forge" });

    expect((await req("POST", "/api/projects", { name: "billing", repos: [API, WEB].map(repoOfId), extra: 1 })).statusCode).toBe(400);
    expect((await req("POST", "/api/projects", { name: "billing", workspaces: [API, WEB] })).statusCode).toBe(400);
    expect((await req("POST", "/api/projects", { name: "billing" })).statusCode).toBe(400);

    expect(existsSync(path.join(config.workspacesDir, ".projects", "billing"))).toBe(false);
    expect(projectsOf(store.get())).toEqual([]);
  });

  it("stores the repositories without cloning or making a folder", async () => {
    const res = await create("billing", [API, "github~octo~nope"]);
    expect(res.statusCode).toBe(201);
    expect(res.json<ProjectView>()).toEqual({
      id: "billing",
      name: "billing",
      forge: "github",
      path: path.resolve(projectDir()),
      createdAt: expect.any(String) as string,
      repos: [
        { forge: "github", owner: "octo", name: "api" },
        { forge: "github", owner: "octo", name: "nope" },
      ],
      workspaces: [
        { id: API, fullPath: "octo/api", repo: "api" },
        { id: "github~octo~nope", fullPath: "octo/nope", repo: "nope" },
      ],
    });
    expect(projectOf(store.get(), "billing")).toMatchObject({ id: "billing", workspaces: [API, "github~octo~nope"] });
    expect(existsSync(projectDir())).toBe(false);
    expect(existsSync(wsPath("github/octo/nope"))).toBe(false);

    const again = await create("Billing", [API, OTHER]);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "a project named billing already exists" });
  });

  it("makes the id from the name and safe repo names", async () => {
    const res = await create("Billing_v2", [API, OTHER, "github~octo~my.app"]);
    expect(res.statusCode).toBe(201);
    expect(res.json<ProjectView>()).toMatchObject({
      id: "billing-v2",
      name: "Billing_v2",
      workspaces: [{ repo: "api" }, { repo: "api-2" }, { repo: "my-app" }],
    });
  });

  it("answers 409 to a second create of the same name in flight", async () => {
    const [a, b] = await Promise.all([create("billing", [API, WEB]), create("billing", [API, WEB])]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  });
});

describe("GET /api/projects", () => {
  it("lists the projects with repos and workspaces, and needs a session", async () => {
    expect((await req("GET", "/api/projects")).json()).toEqual([]);
    const view = (await create("billing", [API, WEB])).json<ProjectView>();
    await create("alpha", [WEB, OTHER]);
    const list = (await req("GET", "/api/projects")).json<ProjectView[]>();
    expect(list.map((p) => p.id)).toEqual(["alpha", "billing"]);
    expect(list[1]).toEqual(view);
    expect(list[0]?.repos).toEqual([repoOfId(WEB), repoOfId(OTHER)]);

    for (const [method, url] of [
      ["GET", "/api/projects"],
      ["POST", "/api/projects"],
      ["PATCH", "/api/projects/billing"],
      ["DELETE", "/api/projects/billing"],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
    }
  });

  it("names repos as project.json does once the folder exists", async () => {
    await create("billing", [OTHER, API]);
    await folder([OTHER, API]);
    const list = (await req("GET", "/api/projects")).json<ProjectView[]>();
    expect(list[0]?.workspaces).toEqual([
      { id: OTHER, fullPath: "other/api", repo: "api" },
      { id: API, fullPath: "octo/api", repo: "api-2" },
    ]);
  });

  it("reads a project stored with workspace ids as its repositories", async () => {
    await store.update((d) => {
      (d.projects as Record<string, unknown>).old = { name: "old", workspaces: [API, "gitlab~grp~sub~proj", "nonsense"], createdAt: "2026-01-01T00:00:00.000Z" };
    });
    const list = (await req("GET", "/api/projects")).json<ProjectView[]>();
    expect(list[0]?.repos).toEqual([repoOfId(API), { forge: "gitlab", owner: "grp/sub", name: "proj" }]);
    expect(list[0]?.workspaces.map((w) => w.id)).toEqual([API, "gitlab~grp~sub~proj"]);
  });

  it("does not show or change another user's projects", async () => {
    await create("billing", [API, WEB]);
    const bob = await signUp(app, "bob", "bob-secret-1");
    const as = (method: "GET" | "PATCH" | "DELETE", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie: bob } });
    expect((await as("GET", "/api/projects")).json()).toEqual([]);
    expect((await as("PATCH", "/api/projects/billing", { repos: [API, WEB].map(repoOfId) })).statusCode).toBe(404);
    expect((await as("DELETE", "/api/projects/billing")).statusCode).toBe(404);
    const sess = await app.inject({ method: "POST", url: "/api/sessions", headers: { cookie: bob }, payload: { projectId: "billing" } });
    expect(sess.statusCode).toBe(404);
    expect(sess.json()).toEqual({ error: "project not found" });
    expect(projectOf(store.get(), "billing")).toBeDefined();
  });
});

describe("PATCH /api/projects/:id", () => {
  it("stores the repos; a folder of an earlier session follows, keeping the names of the ones that stay", async () => {
    await create("billing", [API, WEB]);
    await folder([API, WEB]);
    const dir = projectDir();

    let res = await patch([OTHER, API, WEB]);
    expect(res.statusCode).toBe(200);
    expect(res.json<ProjectView>().workspaces).toEqual([
      { id: OTHER, fullPath: "other/api", repo: "api-2" },
      { id: API, fullPath: "octo/api", repo: "api" },
      { id: WEB, fullPath: "octo/web", repo: "web" },
    ]);
    expect(realpathSync(path.join(dir, "repos", "api-2"))).toBe(realpathSync(wsPath("github/other/api")));
    expect(projectJson()).toEqual({
      name: "billing",
      repos: [
        { name: "api-2", path: "repos/api-2" },
        { name: "api", path: "repos/api" },
        { name: "web", path: "repos/web" },
      ],
    });
    expect((await gitOut(dir, ["log", "--format=%s"])).split("\n")).toEqual(["chore: update project repos", "chore: create project billing"]);

    res = await patch([OTHER, API]);
    expect(res.statusCode).toBe(200);
    expect(existsSync(path.join(dir, "repos", "web"))).toBe(false);
    expect(existsSync(path.join(wsPath("github/octo/web"), "README.md"))).toBe(true);
    expect(projectOf(store.get(), "billing")?.repos).toEqual([repoOfId(OTHER), repoOfId(API)]);

    // A repository without a clone: stored, the folder waits for the next session.
    res = await patch([OTHER, API, "github~octo~nope"]);
    expect(res.statusCode).toBe(200);
    expect(projectOf(store.get(), "billing")?.workspaces).toEqual([OTHER, API, "github~octo~nope"]);
    expect(existsSync(path.join(dir, "repos", "nope"))).toBe(false);
  });

  it("checks the project and the repositories, and makes no folder", async () => {
    expect((await patch([API, WEB], "nope")).statusCode).toBe(404);
    await create("billing", [API, WEB]);
    let res = await patch([API]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "a project needs at least 2 repositories" });
    res = await patch([API, "gitlab~grp~lib"]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "all repositories of a project must come from one forge" });
    res = await patch([API, WEB, API]);
    expect(res.json()).toEqual({ error: "a repository is listed twice" });
    expect(projectOf(store.get(), "billing")?.workspaces).toEqual([API, WEB]);
    expect((await patch([WEB, OTHER])).statusCode).toBe(200);
    expect(existsSync(projectDir())).toBe(false);
  });

  it("answers 409 while a run of the project is live", async () => {
    await create("billing", [API, WEB]);
    await folder([API, WEB]);
    mkdirSync(path.join(projectDir(), ".graph-execution", "r"), { recursive: true });
    writeFileSync(path.join(projectDir(), ".graph-execution", "r", "lock"), `${process.pid}\ntoken\n`);
    const res = await patch([API, WEB, OTHER]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "a run of this project is live" });
    expect(existsSync(path.join(projectDir(), "repos", "api-2"))).toBe(false);
  });

  it("answers 409 while the project has a live session", async () => {
    await create("billing", [API, WEB]);
    await liveSession();
    const res = await patch([API, OTHER]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "project billing has a live session. Close it first." });
    expect(projectOf(store.get(), "billing")?.workspaces).toEqual([API, WEB]);
  });
});

describe("deleting", () => {
  it("keeps a project with a live run, and its clones when it is deleted", async () => {
    await create("billing", [API, WEB]);
    await folder([API, WEB]);
    const dir = projectDir();

    mkdirSync(path.join(dir, ".graph-execution", "r"), { recursive: true });
    writeFileSync(path.join(dir, ".graph-execution", "r", "lock"), `${process.pid}\ntoken\n`);
    const live = await req("DELETE", "/api/projects/billing");
    expect(live.statusCode).toBe(409);
    expect(live.json()).toEqual({ error: "a run of this project is live" });
    expect(existsSync(dir)).toBe(true);

    rmSync(path.join(dir, ".graph-execution", "r", "lock"));
    expect((await req("DELETE", "/api/projects/billing")).statusCode).toBe(204);
    expect(existsSync(dir)).toBe(false);
    for (const rel of ["github/octo/api", "github/octo/web"]) {
      expect(existsSync(path.join(wsPath(rel), ".git"))).toBe(true);
      expect(readFileSync(path.join(wsPath(rel), "README.md"), "utf8")).toBe(`# ${rel}\n`);
    }
    expect((await req("GET", "/api/projects")).json()).toEqual([]);
    expect((await req("DELETE", "/api/projects/billing")).statusCode).toBe(404);
  });

  it("deletes a project that never had a session, and refuses one with a live session", async () => {
    await create("billing", [API, WEB]);
    await liveSession();
    const res = await req("DELETE", "/api/projects/billing");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "project billing has a live session. Close it first." });
    await store.update((d) => {
      delete d.sessions.s1;
    });
    expect((await req("DELETE", "/api/projects/billing")).statusCode).toBe(204);
    expect(projectsOf(store.get())).toEqual([]);
  });
});
