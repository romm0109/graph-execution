import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeForge, type FakeForge } from "../../../scripts/fake-forge.mjs";
import type { Config } from "../config.js";
import { appWithLogin } from "../test-helpers.js";
import { cloneProgressOf, stripCredentials, type CloneJob } from "./workspaces.js";

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
  ({ app, cookie, config, cleanup } = await appWithLogin({
    githubApiUrl: `${forge.url}/github`,
  }));
});

afterEach(async () => {
  await cleanup();
});

const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });

async function connectBoth(): Promise<void> {
  expect((await req("PUT", "/api/forges/github", { token: "gh-good" })).statusCode).toBe(200);
  expect(
    (
      await req("PUT", "/api/forges/gitlab", {
        token: "gl-good",
        baseUrl: `${forge.url}/gitlab`,
      })
    ).statusCode,
  ).toBe(200);
}

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

const jobs = async (): Promise<CloneJob[]> => ((await req("GET", "/api/workspaces/clones")).json() as { jobs: CloneJob[] }).jobs;

/** Polls `/api/workspaces/clones` until the job is no longer running; returns it and every state seen. */
async function waitForClone(id: string, timeoutMs = 15_000): Promise<{ job: CloneJob; seen: CloneJob[] }> {
  const seen: CloneJob[] = [];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const job = (await jobs()).find((j) => j.id === id);
    if (!job) throw new Error(`clone job ${id} is gone`);
    seen.push(job);
    if (job.status !== "running") return { job, seen };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`clone job ${id} still running after ${timeoutMs}ms`);
}

/** POSTs a clone, expects 202, and waits for the job to end. */
async function clone(forgeKind: "github" | "gitlab", fullPath: string): Promise<CloneJob> {
  const res = await req("POST", "/api/workspaces", {
    forge: forgeKind,
    fullPath,
  });
  expect(res.statusCode).toBe(202);
  const { job } = res.json() as { job: CloneJob };
  expect(job).toMatchObject({ forge: forgeKind, fullPath, status: "running" });
  return (await waitForClone(job.id)).job;
}

describe("workspace routes", () => {
  it("need a login", async () => {
    expect((await app.inject({ url: "/api/workspaces" })).statusCode).toBe(401);
  });

  it("clone, list, track dirty state and delete", async () => {
    await connectBoth();
    const job = await clone("github", "octo/hello");
    const dest = path.join(config.workspacesDir, "github", "octo", "hello");
    expect(job).toMatchObject({ status: "done", progress: 1 });
    expect(job.endedAt).toBeTruthy();
    expect(job.workspace).toMatchObject({
      id: "github~octo~hello",
      forge: "github",
      fullPath: "octo/hello",
      path: dest,
      branch: "main",
      dirty: false,
      changes: 0,
    });
    expect(existsSync(path.join(dest, "README.md"))).toBe(true);
    const extra = await execa("git", ["-C", dest, "config", "--get-regexp", "extraheader"], { reject: false });
    expect(extra.stdout).toBe("");
    expect(JSON.stringify(await jobs())).not.toContain("gh-good");

    const again = await req("POST", "/api/workspaces", {
      forge: "github",
      fullPath: "octo/hello",
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "already cloned" });

    expect(await clone("gitlab", "grp/sub/proj")).toMatchObject({
      status: "done",
      workspace: { id: "gitlab~grp~sub~proj" },
    });

    let ws = await list();
    expect(ws.map((w) => w.id)).toEqual(["github~octo~hello", "gitlab~grp~sub~proj"]);
    for (const w of ws) expect(w).toMatchObject({ branch: "main", dirty: false });
    expect(ws[0]!.remoteUrl).toMatch(/^file:/);

    mkdirSync(path.join(dest, ".graph-execution", "x"), { recursive: true });
    writeFileSync(path.join(dest, ".graph-execution", "x", "state.json"), "{}");
    expect((await list()).find((w) => w.id === "github~octo~hello")?.dirty).toBe(false);

    writeFileSync(path.join(dest, "new.txt"), "hi");
    expect((await list()).find((w) => w.id === "github~octo~hello")).toMatchObject({ dirty: true, changes: 1 });
    writeFileSync(path.join(dest, "README.md"), "changed");
    expect((await list()).find((w) => w.id === "github~octo~hello")).toMatchObject({ dirty: true, changes: 2 });

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
    expect(
      (
        await req("POST", "/api/workspaces", {
          forge: "github",
          fullPath: "octo/hello",
        })
      ).statusCode,
    ).toBe(400);
    await connectBoth();
    for (const fullPath of ["../evil", "octo//hello", "octo/..", "/abs"]) {
      expect((await req("POST", "/api/workspaces", { forge: "github", fullPath })).statusCode).toBe(400);
    }
    expect(
      (
        await req("POST", "/api/workspaces", {
          forge: "bitbucket",
          fullPath: "a/b",
        })
      ).statusCode,
    ).toBe(400);
    expect(existsSync(path.join(config.workspacesDir, "evil"))).toBe(false);
  });

  it("list the workspaces root", async () => {
    const res = await req("GET", "/api/workspaces");
    expect(res.json()).toEqual({ workspaces: [], root: config.workspacesDir });
  });

  it("report progress while cloning, then done", async () => {
    await connectBoth();
    const res = await req("POST", "/api/workspaces", {
      forge: "github",
      fullPath: "octo/hello",
    });
    expect(res.statusCode).toBe(202);
    const { job: started } = res.json() as { job: CloneJob };
    expect(started.startedAt).toBeTruthy();
    const { job, seen } = await waitForClone(started.id);
    expect(job.status).toBe("done");
    // A tiny repo may finish before a poll sees it running; when it doesn't, the running states carry valid progress.
    for (const s of seen.filter((x) => x.status === "running" && x.progress !== undefined)) {
      expect(s.progress).toBeGreaterThanOrEqual(0);
      expect(s.progress).toBeLessThanOrEqual(1);
      expect(s.phase).toMatch(/objects|deltas/);
    }
  });

  it("answer 409 to a second POST for the same repo", async () => {
    await connectBoth();
    const first = await req("POST", "/api/workspaces", {
      forge: "github",
      fullPath: "octo/hello",
    });
    expect(first.statusCode).toBe(202);
    const second = await req("POST", "/api/workspaces", {
      forge: "github",
      fullPath: "octo/hello",
    });
    expect(second.statusCode).toBe(409);
    expect(["already cloning", "already cloned"]).toContain((second.json() as { error: string }).error);
    await waitForClone((first.json() as { job: CloneJob }).job.id);
    expect((await jobs()).filter((j) => j.fullPath === "octo/hello")).toHaveLength(1);
  });

  it("start one clone for two concurrent POSTs of the same repo, and keep its folder", async () => {
    await connectBoth();
    const [a, b] = await Promise.all([
      req("POST", "/api/workspaces", { forge: "github", fullPath: "octo/hello" }),
      req("POST", "/api/workspaces", { forge: "github", fullPath: "octo/hello" }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([202, 409]);
    const winner = (a.statusCode === 202 ? a : b).json() as { job: CloneJob };
    const { job: done } = await waitForClone(winner.job.id);
    expect(done.status).toBe("done");
    expect((await jobs()).filter((j) => j.fullPath === "octo/hello")).toHaveLength(1);
    expect(existsSync(path.join(config.workspacesDir, "github", "octo", "hello", ".git"))).toBe(true);
  });

  it("end the job failed with the token scrubbed when git clone fails, and leave nothing behind", async () => {
    await connectBoth();
    const bare = forge.addRepo("octo/broken", "github");
    rmSync(bare, { recursive: true, force: true });
    const job = await clone("github", "octo/broken");
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/^clone failed: /);
    expect(JSON.stringify(job)).not.toContain("gh-good");
    expect(existsSync(path.join(config.workspacesDir, "github", "octo", "broken"))).toBe(false);
    expect(await list()).toEqual([]);
  });
});

describe("cloneProgressOf", () => {
  it("maps receiving objects to 0–90% and resolving deltas to 90–100%", () => {
    expect(cloneProgressOf("Receiving objects:  58% (1204/2071)")).toBeCloseTo(0.522);
    expect(cloneProgressOf("Receiving objects: 100% (3/3), done.")).toBeCloseTo(0.9);
    expect(cloneProgressOf("Resolving deltas:  50% (1/2)")).toBeCloseTo(0.95);
    expect(cloneProgressOf("remote: Counting objects: 50% (1/2)")).toBeUndefined();
    expect(cloneProgressOf("Cloning into 'x'...")).toBeUndefined();
  });
});

describe("stripCredentials", () => {
  it("removes user info from URLs", () => {
    expect(stripCredentials("https://x:secret@github.com/octo/hello.git")).toBe("https://github.com/octo/hello.git");
    expect(stripCredentials("https://github.com/octo/hello.git")).toBe("https://github.com/octo/hello.git");
    expect(stripCredentials("git@github.com:octo/hello.git")).toBe("git@github.com:octo/hello.git");
  });
});
