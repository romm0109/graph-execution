import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeForge, type FakeForge } from "../../../scripts/fake-forge.mjs";
import type { Config } from "../config.js";
import { appWithLogin } from "../test-helpers.js";
import { stripCredentials } from "./workspaces.js";

let forge: FakeForge;
let app: FastifyInstance;
let cookie: string;
let config: Config;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  forge = await startFakeForge();
});

afterAll(async () => {
  await forge.close();
});

beforeEach(async () => {
  ({ app, cookie, config, cleanup } = await appWithLogin({ githubApiUrl: `${forge.url}/github` }));
});

afterEach(async () => {
  await cleanup();
});

const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });

async function connectBoth(): Promise<void> {
  expect((await req("PUT", "/api/forges/github", { token: "gh-good" })).statusCode).toBe(200);
  expect((await req("PUT", "/api/forges/gitlab", { token: "gl-good", baseUrl: `${forge.url}/gitlab` })).statusCode).toBe(200);
}

interface Entry {
  id: string;
  forge: string;
  fullPath: string;
  path: string;
  branch: string;
  dirty: boolean;
  remoteUrl: string;
}

const list = async (): Promise<Entry[]> => ((await req("GET", "/api/workspaces")).json() as { workspaces: Entry[] }).workspaces;

describe("workspace routes", () => {
  it("need a login", async () => {
    expect((await app.inject({ url: "/api/workspaces" })).statusCode).toBe(401);
  });

  it("clone, list, track dirty state and delete", async () => {
    await connectBoth();
    const res = await req("POST", "/api/workspaces", { forge: "github", fullPath: "octo/hello" });
    expect(res.statusCode).toBe(201);
    const dest = path.join(config.workspacesDir, "github", "octo", "hello");
    expect(res.json()).toMatchObject({ id: "github~octo~hello", forge: "github", fullPath: "octo/hello", path: dest, branch: "main", dirty: false });
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
    const extra = await execa("git", ["-C", dest, "config", "--get-regexp", "extraheader"], { reject: false });
    expect(extra.stdout).toBe("");
    expect(res.body).not.toContain("gh-good");

    expect((await req("POST", "/api/workspaces", { forge: "github", fullPath: "octo/hello" })).statusCode).toBe(409);

    const gl = await req("POST", "/api/workspaces", { forge: "gitlab", fullPath: "grp/sub/proj" });
    expect(gl.statusCode).toBe(201);
    expect(gl.json()).toMatchObject({ id: "gitlab~grp~sub~proj" });

    let ws = await list();
    expect(ws.map((w) => w.id)).toEqual(["github~octo~hello", "gitlab~grp~sub~proj"]);
    for (const w of ws) expect(w).toMatchObject({ branch: "main", dirty: false });
    expect(ws[0]!.remoteUrl).toMatch(/^file:/);

    mkdirSync(path.join(dest, ".graph-execution", "x"), { recursive: true });
    writeFileSync(path.join(dest, ".graph-execution", "x", "state.json"), "{}");
    expect((await list()).find((w) => w.id === "github~octo~hello")?.dirty).toBe(false);

    writeFileSync(path.join(dest, "new.txt"), "hi");
    expect((await list()).find((w) => w.id === "github~octo~hello")?.dirty).toBe(true);

    mkdirSync(path.join(dest, ".graph-execution", "r"), { recursive: true });
    writeFileSync(path.join(dest, ".graph-execution", "r", "lock"), `${process.pid}\ntoken\n`);
    const live = await req("DELETE", "/api/workspaces/github~octo~hello");
    expect(live.statusCode).toBe(409);
    expect(live.json()).toEqual({ error: "a run is live in this workspace" });
    expect(existsSync(dest)).toBe(true);

    rmSync(path.join(dest, ".graph-execution", "r", "lock"));
    expect((await req("DELETE", "/api/workspaces/github~octo~hello")).statusCode).toBe(204);
    expect(existsSync(dest)).toBe(false);
    ws = await list();
    expect(ws.map((w) => w.id)).toEqual(["gitlab~grp~sub~proj"]);
    expect((await req("DELETE", "/api/workspaces/github~octo~hello")).statusCode).toBe(404);
  });

  it("reject bad paths and unconnected forges with 400", async () => {
    expect((await req("POST", "/api/workspaces", { forge: "github", fullPath: "octo/hello" })).statusCode).toBe(400);
    await connectBoth();
    for (const fullPath of ["../evil", "octo//hello", "octo/..", "/abs"]) {
      expect((await req("POST", "/api/workspaces", { forge: "github", fullPath })).statusCode).toBe(400);
    }
    expect((await req("POST", "/api/workspaces", { forge: "bitbucket", fullPath: "a/b" })).statusCode).toBe(400);
    expect(existsSync(path.join(config.workspacesDir, "evil"))).toBe(false);
  });

  it("answer 502 with the token scrubbed when git clone fails, and leave nothing behind", async () => {
    await connectBoth();
    const bare = forge.addRepo("octo/broken", "github");
    rmSync(bare, { recursive: true, force: true });
    const res = await req("POST", "/api/workspaces", { forge: "github", fullPath: "octo/broken" });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toMatch(/^git clone failed: /);
    expect(res.body).not.toContain("gh-good");
    expect(existsSync(path.join(config.workspacesDir, "github", "octo", "broken"))).toBe(false);
  });
});

describe("stripCredentials", () => {
  it("removes user info from URLs", () => {
    expect(stripCredentials("https://x:secret@github.com/octo/hello.git")).toBe("https://github.com/octo/hello.git");
    expect(stripCredentials("https://github.com/octo/hello.git")).toBe("https://github.com/octo/hello.git");
    expect(stripCredentials("git@github.com:octo/hello.git")).toBe("git@github.com:octo/hello.git");
  });
});
