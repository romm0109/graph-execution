import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import type { DataStore } from "../store.js";
import { appWithLogin } from "../test-helpers.js";
import type { ProjectView } from "./projects.js";

let app: FastifyInstance;
let cookie: string;
let config: Config;
let store: DataStore;
let cleanup: () => Promise<void>;

const REPOS = ["github/octo/api", "github/octo/web", "gitlab/grp/lib", "github/other/api", "github/octo/my.app"];
const API = "github~octo~api";
const WEB = "github~octo~web";
const OTHER = "github~other~api";

const wsPath = (rel: string) => path.join(config.workspacesDir, ...rel.split("/"));
const projectDir = (id = "billing") => path.join(config.workspacesDir, ".projects", id);

beforeEach(async () => {
  ({ app, cookie, config, store, cleanup } = await appWithLogin());
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
const create = (name: string, workspaces: string[]) => req("POST", "/api/projects", { name, workspaces });
const gitOut = async (cwd: string, args: string[]) => (await execa("git", args, { cwd })).stdout;
const projectJson = (id = "billing") => JSON.parse(readFileSync(path.join(projectDir(id), "project.json"), "utf8")) as unknown;

describe("POST /api/projects", () => {
  it("rejects a bad name, too few or unknown workspaces and two forges", async () => {
    let res = await create("bad name!", [API, WEB]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid project name: use letters, digits, - and _" });

    res = await create("billing", [API, API]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "a workspace is listed twice" });

    res = await create("billing", [API]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "a project needs at least 2 workspaces" });

    res = await create("billing", [API, "github~octo~nope"]);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "unknown workspace github~octo~nope" });

    res = await create("billing", [API, "gitlab~grp~lib"]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "all workspaces of a project must come from one forge" });

    expect((await req("POST", "/api/projects", { name: "billing", workspaces: [API, WEB], extra: 1 })).statusCode).toBe(400);
    expect((await req("POST", "/api/projects", { name: "billing" })).statusCode).toBe(400);

    expect(existsSync(path.join(config.workspacesDir, ".projects", "billing"))).toBe(false);
    expect(store.projects()).toEqual([]);
  });

  it("creates the folder: project.json, links, .gitignore and one commit", async () => {
    const res = await create("billing", [API, WEB]);
    expect(res.statusCode).toBe(201);
    const view = res.json<ProjectView>();
    expect(view).toEqual({
      id: "billing",
      name: "billing",
      forge: "github",
      path: path.resolve(projectDir()),
      createdAt: expect.any(String) as string,
      workspaces: [
        { id: API, fullPath: "octo/api", repo: "api" },
        { id: WEB, fullPath: "octo/web", repo: "web" },
      ],
    });
    expect(store.project("billing")).toMatchObject({ id: "billing", name: "billing", workspaces: [API, WEB] });

    const dir = projectDir();
    expect(projectJson()).toEqual({
      name: "billing",
      repos: [
        { name: "api", path: "repos/api" },
        { name: "web", path: "repos/web" },
      ],
    });
    expect(lstatSync(path.join(dir, "repos", "api")).isSymbolicLink()).toBe(true);
    expect(realpathSync(path.join(dir, "repos", "api"))).toBe(realpathSync(wsPath("github/octo/api")));
    expect(realpathSync(path.join(dir, "repos", "web"))).toBe(realpathSync(wsPath("github/octo/web")));
    expect(readFileSync(path.join(dir, "repos", "api", "README.md"), "utf8")).toBe("# github/octo/api\n");
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("repos/\n.graph-execution/\n");
    expect(await gitOut(dir, ["log", "--format=%s"])).toBe("chore: create project billing");
    expect(await gitOut(dir, ["status", "--porcelain"])).toBe("");
    expect(await gitOut(dir, ["remote"])).toBe("");

    const again = await create("Billing", [API, OTHER]);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "a project named billing already exists" });

    const ws = (await req("GET", "/api/workspaces")).json<{ workspaces: { id: string }[] }>().workspaces;
    expect(ws.map((w) => w.id).sort()).toEqual(REPOS.map((r) => r.replaceAll("/", "~")).sort());
  });

  it("makes the id from the name and safe repo names", async () => {
    const res = await create("Billing_v2", [API, OTHER, "github~octo~my.app"]);
    expect(res.statusCode).toBe(201);
    expect(res.json<ProjectView>()).toMatchObject({
      id: "billing-v2",
      name: "Billing_v2",
      workspaces: [{ repo: "api" }, { repo: "api-2" }, { repo: "my-app" }],
    });
    expect(projectJson("billing-v2")).toEqual({
      name: "Billing_v2",
      repos: [
        { name: "api", path: "repos/api" },
        { name: "api-2", path: "repos/api-2" },
        { name: "my-app", path: "repos/my-app" },
      ],
    });
  });

  it("answers 409 to a second create of the same name in flight", async () => {
    const [a, b] = await Promise.all([create("billing", [API, WEB]), create("billing", [API, WEB])]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  });
});

describe("GET /api/projects", () => {
  it("lists the projects, and needs a session", async () => {
    expect((await req("GET", "/api/projects")).json()).toEqual([]);
    const view = (await create("billing", [API, WEB])).json<ProjectView>();
    await create("alpha", [WEB, OTHER]);
    const list = (await req("GET", "/api/projects")).json<ProjectView[]>();
    expect(list.map((p) => p.id)).toEqual(["alpha", "billing"]);
    expect(list[1]).toEqual(view);

    for (const [method, url] of [
      ["GET", "/api/projects"],
      ["POST", "/api/projects"],
      ["PATCH", "/api/projects/billing"],
      ["DELETE", "/api/projects/billing"],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
    }
  });

  it("still shows a workspace that is gone", async () => {
    await create("billing", [API, WEB]);
    rmSync(wsPath("github/octo/web"), { recursive: true, force: true });
    const list = (await req("GET", "/api/projects")).json<ProjectView[]>();
    expect(list[0]?.workspaces).toEqual([
      { id: API, fullPath: "octo/api", repo: "api" },
      { id: WEB, fullPath: "octo/web", repo: "web" },
    ]);
  });
});

describe("PATCH /api/projects/:id", () => {
  it("adds and removes repos, keeping the names of the ones that stay", async () => {
    await create("billing", [API, WEB]);
    const dir = projectDir();

    let res = await req("PATCH", "/api/projects/billing", { workspaces: [OTHER, API, WEB] });
    expect(res.statusCode).toBe(200);
    expect(res.json<ProjectView>().workspaces).toEqual([
      { id: OTHER, fullPath: "other/api", repo: "api-2" },
      { id: API, fullPath: "octo/api", repo: "api" },
      { id: WEB, fullPath: "octo/web", repo: "web" },
    ]);
    expect(realpathSync(path.join(dir, "repos", "api-2"))).toBe(realpathSync(wsPath("github/other/api")));
    expect(realpathSync(path.join(dir, "repos", "api"))).toBe(realpathSync(wsPath("github/octo/api")));
    expect(projectJson()).toEqual({
      name: "billing",
      repos: [
        { name: "api-2", path: "repos/api-2" },
        { name: "api", path: "repos/api" },
        { name: "web", path: "repos/web" },
      ],
    });
    expect((await gitOut(dir, ["log", "--format=%s"])).split("\n")).toEqual(["chore: update project repos", "chore: create project billing"]);
    expect(await gitOut(dir, ["status", "--porcelain"])).toBe("");

    res = await req("PATCH", "/api/projects/billing", { workspaces: [OTHER, API] });
    expect(res.statusCode).toBe(200);
    expect(res.json<ProjectView>().workspaces.map((w) => w.repo)).toEqual(["api-2", "api"]);
    expect(existsSync(path.join(dir, "repos", "web"))).toBe(false);
    expect(existsSync(path.join(wsPath("github/octo/web"), "README.md"))).toBe(true);
    expect(store.project("billing")?.workspaces).toEqual([OTHER, API]);
    expect((await gitOut(dir, ["log", "--format=%s"])).split("\n")).toHaveLength(3);

    // The same list again: nothing to commit.
    expect((await req("PATCH", "/api/projects/billing", { workspaces: [OTHER, API] })).statusCode).toBe(200);
    expect((await gitOut(dir, ["log", "--format=%s"])).split("\n")).toHaveLength(3);
  });

  it("checks the project and the workspaces", async () => {
    expect((await req("PATCH", "/api/projects/nope", { workspaces: [API, WEB] })).statusCode).toBe(404);
    await create("billing", [API, WEB]);
    let res = await req("PATCH", "/api/projects/billing", { workspaces: [API] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "a project needs at least 2 workspaces" });
    res = await req("PATCH", "/api/projects/billing", { workspaces: [API, "gitlab~grp~lib"] });
    expect(res.statusCode).toBe(400);
    res = await req("PATCH", "/api/projects/billing", { workspaces: [API, "github~octo~nope"] });
    expect(res.statusCode).toBe(404);
    expect(store.project("billing")?.workspaces).toEqual([API, WEB]);
  });

  it("answers 409 while a run of the project is live", async () => {
    await create("billing", [API, WEB]);
    mkdirSync(path.join(projectDir(), ".graph-execution", "r"), { recursive: true });
    writeFileSync(path.join(projectDir(), ".graph-execution", "r", "lock"), `${process.pid}\ntoken\n`);
    const res = await req("PATCH", "/api/projects/billing", { workspaces: [API, WEB, OTHER] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "a run of this project is live" });
    expect(existsSync(path.join(projectDir(), "repos", "api-2"))).toBe(false);
  });

  it("makes the folder again when it is gone", async () => {
    await create("billing", [API, WEB]);
    rmSync(path.join(projectDir(), "repos", "api"));
    rmSync(path.join(projectDir(), "repos", "web"));
    rmSync(projectDir(), { recursive: true, force: true });
    expect((await req("PATCH", "/api/projects/billing", { workspaces: [API, WEB] })).statusCode).toBe(200);
    expect(realpathSync(path.join(projectDir(), "repos", "web"))).toBe(realpathSync(wsPath("github/octo/web")));
  });
});

describe("deleting", () => {
  it("keeps a workspace that is part of a project, and a project with a live run", async () => {
    await create("billing", [API, WEB]);
    const dir = projectDir();

    const inUse = await req("DELETE", `/api/workspaces/${API}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json()).toEqual({ error: "workspace is part of project billing" });
    expect(existsSync(wsPath("github/octo/api"))).toBe(true);

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
    expect((await req("DELETE", `/api/workspaces/${API}`)).statusCode).toBe(204);
    expect(existsSync(wsPath("github/octo/api"))).toBe(false);
  });
});

describe("git identity", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("gives the folder its own identity when the machine has none", async () => {
    const empty = path.join(config.dataDir, "empty-gitconfig");
    writeFileSync(empty, "");
    process.env.GIT_CONFIG_GLOBAL = empty;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete process.env[k];
    expect((await create("billing", [API, WEB])).statusCode).toBe(201);
    expect(await gitOut(projectDir(), ["config", "--local", "user.email"])).toBe("graph-manager@localhost");
    expect(await gitOut(projectDir(), ["log", "--format=%an <%ae> %s"])).toBe("graph-manager <graph-manager@localhost> chore: create project billing");
  });
});
