import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { appWithLogin } from "../test-helpers.js";
import { stripCredentials } from "./workspaces.js";

let app: FastifyInstance;
let cookie: string;
let config: Config;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ app, cookie, config, cleanup } = await appWithLogin());
});

afterEach(async () => {
  await cleanup();
});

const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });

interface Entry {
  id: string;
  forge: string;
  fullPath: string;
  path: string;
  branch: string;
  dirty: boolean;
  changes: number;
  remoteUrl: string;
}

const list = async (): Promise<Entry[]> => ((await req("GET", "/api/workspaces")).json() as { workspaces: Entry[] }).workspaces;

/** A clone as a session leaves it: `<workspaces>/<forge>/<owner…>/<name>` with one commit on main. */
async function fakeClone(...parts: string[]): Promise<string> {
  const dir = path.join(config.workspacesDir, ...parts);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execa("git", ["-C", dir, ...args]);
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  await git("remote", "add", "origin", `https://x:secret@example.com/${parts.slice(1).join("/")}.git`);
  writeFileSync(path.join(dir, "README.md"), "hi");
  await git("add", "README.md");
  await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "readme");
  return dir;
}

describe("workspace routes", () => {
  it("need a login", async () => {
    expect((await app.inject({ url: "/api/workspaces" })).statusCode).toBe(401);
  });

  it("list the workspaces root", async () => {
    const res = await req("GET", "/api/workspaces");
    expect(res.json()).toEqual({ workspaces: [], root: config.workspacesDir });
  });

  it("list the clones with branch, dirty state and a remote without credentials", async () => {
    const dest = await fakeClone("github", "octo", "hello");
    await fakeClone("gitlab", "grp", "sub", "proj");
    let ws = await list();
    expect(ws.map((w) => w.id)).toEqual(["github~octo~hello", "gitlab~grp~sub~proj"]);
    expect(ws[0]).toMatchObject({ id: "github~octo~hello", forge: "github", fullPath: "octo/hello", path: dest, branch: "main", dirty: false, changes: 0 });
    expect(ws[0]!.remoteUrl).toBe("https://example.com/octo/hello.git");

    mkdirSync(path.join(dest, ".graph-execution", "x"), { recursive: true });
    writeFileSync(path.join(dest, ".graph-execution", "x", "state.json"), "{}");
    expect((await list()).find((w) => w.id === "github~octo~hello")?.dirty).toBe(false);
    writeFileSync(path.join(dest, "new.txt"), "hi");
    expect((await list()).find((w) => w.id === "github~octo~hello")).toMatchObject({ dirty: true, changes: 1 });
    writeFileSync(path.join(dest, "README.md"), "changed");
    ws = await list();
    expect(ws.find((w) => w.id === "github~octo~hello")).toMatchObject({ dirty: true, changes: 2 });
  });

  it("have no clone or delete route any more (sessions clone, docs/prd/hosted-sessions.md)", async () => {
    await fakeClone("github", "octo", "hello");
    expect((await req("POST", "/api/workspaces", { forge: "github", fullPath: "octo/hello" })).statusCode).toBe(404);
    expect((await req("GET", "/api/workspaces/clones")).statusCode).toBe(404);
    expect((await req("DELETE", "/api/workspaces/github~octo~hello")).statusCode).toBe(404);
    expect((await list()).map((w) => w.id)).toEqual(["github~octo~hello"]);
  });
});

describe("stripCredentials", () => {
  it("removes user info from URLs", () => {
    expect(stripCredentials("https://x:secret@github.com/octo/hello.git")).toBe("https://github.com/octo/hello.git");
    expect(stripCredentials("https://github.com/octo/hello.git")).toBe("https://github.com/octo/hello.git");
    expect(stripCredentials("git@github.com:octo/hello.git")).toBe("git@github.com:octo/hello.git");
  });
});
