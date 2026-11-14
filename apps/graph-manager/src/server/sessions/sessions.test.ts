import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startFakeForge, type FakeForge } from "../../../scripts/fake-forge.mjs";
import { createUser, hashPassword } from "../accounts.js";
import type { AppContext } from "../app.js";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import { ADMIN_USER } from "../identity.js";
import { appWithLogin, loginAs } from "../test-helpers.js";
import { defaultBranchName, validBranchName, type SessionView } from "./sessions.js";

let forge: FakeForge;
let app: FastifyInstance;
let cookie: string;
let config: Config;
let db: Db;
let ctx: AppContext;
let cleanup: (() => Promise<void>) | undefined;
let live = 0;

beforeAll(async () => {
  forge = await startFakeForge();
  forge.addRepo("octo/other", "github");
  forge.addRepo("grp/sub/proj", "gitlab");
});

afterAll(async () => {
  await forge.close();
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  live = 0;
});

async function start(overrides: Partial<Config> = {}): Promise<void> {
  const res = await appWithLogin(
    { githubApiUrl: `${forge.url}/github`, ...overrides },
    { sessions: { pollMs: 20, liveRuns: async () => live }, onContext: (c) => (ctx = c) },
  );
  ({ app, cookie, config, db, cleanup } = res);
  const put = await req("PUT", "/api/forges/github", { token: "gh-good" });
  expect(put.statusCode).toBe(200);
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const req = (method: Method, url: string, payload?: object, c = cookie) => app.inject({ method, url, payload, headers: { cookie: c } });

const HELLO = { forge: "github", owner: "octo", name: "hello" } as const;
const OTHER = { forge: "github", owner: "octo", name: "other" } as const;
const cloneDir = () => path.join(config.workspacesDir, "github", "octo", "hello");
const bare = (fullPath: string) => path.join(forge.dir, `${fullPath}.git`);
const git = async (cwd: string, args: string[]) => (await execa("git", args, { cwd })).stdout.trim();

async function open(repo: object = HELLO, branch?: object, c = cookie): Promise<{ sessionId: string; terminalId: string; branch: string }> {
  const res = await req("POST", "/api/sessions", { repo, ...(branch ? { branch } : {}) }, c);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function sessionsOf(c = cookie): Promise<SessionView[]> {
  return (await req("GET", "/api/sessions", undefined, c)).json<{ sessions: SessionView[] }>().sessions;
}

async function secondUser(): Promise<string> {
  await createUser(db, { username: "bob", displayName: "Bob", passwordHash: await hashPassword("bob-password-1") });
  return loginAs(app, "bob", "bob-password-1");
}

let branchNo = 0;
const uniqueBranch = (p: string) => `${p}-${Date.now()}-${++branchNo}`;

describe("branch names", () => {
  it("validates like git check-ref-format --branch", () => {
    for (const ok of ["feat-x", "gm/admin-20261114-ab12", "a/b.c"]) expect(validBranchName(ok), ok).toBe(true);
    for (const bad of ["", "-x", "/x", "x/", "x.lock", "a..b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", ".x", "x."]) {
      expect(validBranchName(bad), bad).toBe(false);
    }
  });

  it("defaults to gm/<user>-<yyyymmdd>-<4>", () => {
    expect(defaultBranchName("admin", new Date("2026-11-14T10:00:00Z"))).toMatch(/^gm\/admin-20261114-[a-z0-9]{4}$/);
    expect(defaultBranchName("a b@c")).toMatch(/^gm\/a-b-c-\d{8}-[a-z0-9]{4}$/);
  });
});

describe.skipIf(process.platform === "win32")("repo sessions", () => {
  it("opens a session on a new branch and lists it live with its terminal", async () => {
    await start();
    const branch = uniqueBranch("feat-x");
    const s = await open(HELLO, { new: branch });
    expect(s.branch).toBe(branch);
    expect(await git(cloneDir(), ["branch", "--show-current"])).toBe(branch);
    const res = await req("GET", "/api/sessions");
    expect(res.json()).toMatchObject({ limit: null, sessions: [{ id: s.sessionId, state: "live", branch, workspaceId: "github~octo~hello", terminals: [s.terminalId], repo: HELLO }] });
    expect(ctx.sessions.all()).toHaveLength(1);
  });

  it("names the branch gm/<user>-<date>-<4> without a name", async () => {
    await start();
    const s = await open();
    expect(s.branch).toMatch(/^gm\/admin-\d{8}-[a-z0-9]{4}$/);
    const s2 = await open(OTHER, { new: "" });
    expect(s2.branch).toMatch(/^gm\/admin-\d{8}-[a-z0-9]{4}$/);
  });

  it("rejects an invalid branch name", async () => {
    await start();
    const res = await req("POST", "/api/sessions", { repo: HELLO, branch: { new: "a..b" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "branch: invalid branch name" });
    expect(await sessionsOf()).toEqual([]);
  });

  it("joins the session of a repository that is already open, on its branch", async () => {
    await start();
    const branch = uniqueBranch("first");
    const a = await open(HELLO, { new: branch });
    const b = await open(HELLO, { new: "ignored" });
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.branch).toBe(branch);
    expect(b.terminalId).not.toBe(a.terminalId);
    expect((await sessionsOf())[0]?.terminals).toEqual([a.terminalId, b.terminalId]);
    const t = await req("POST", `/api/sessions/${a.sessionId}/terminals`, { title: "third" });
    expect(t.statusCode).toBe(201);
    expect(t.json()).toMatchObject({ title: "third", sessionId: a.sessionId, workspaceId: "github~octo~hello" });
  });

  it("refuses more sessions than GM_MAX_SESSIONS", async () => {
    await start({ maxSessions: 1 });
    expect((await req("GET", "/api/sessions")).json()).toMatchObject({ limit: 1 });
    const s = await open();
    const res = await req("POST", "/api/sessions", { repo: OTHER });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "You have 1 open repositories. Close all terminals of one to open another." });

    // Closing the last terminal of a clean clone ends the session; then another repository fits.
    const del = await req("DELETE", `/api/terminals/${s.terminalId}`);
    expect(del.statusCode).toBe(204);
    await ctx.sessions.settled();
    expect(await sessionsOf()).toEqual([]);
    await open(OTHER);
  });

  it("asks before closing a dirty clone; keep goes back to live and still counts", async () => {
    await start({ maxSessions: 1 });
    const s = await open();
    await writeFile(path.join(cloneDir(), "new.txt"), "x\n");
    const del = await req("DELETE", `/api/terminals/${s.terminalId}`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ sessionId: s.sessionId, ask: { changes: ["?? new.txt"] } });
    expect((await sessionsOf())[0]).toMatchObject({ state: "asking", terminals: [] });
    expect((await req("POST", "/api/sessions", { repo: OTHER })).statusCode).toBe(409);

    const keep = await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "keep" });
    expect(keep.statusCode).toBe(200);
    expect(keep.json()).toMatchObject({ session: { id: s.sessionId, state: "live" } });
    // keep only from asking
    expect((await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "keep" })).json()).toEqual({ error: "session is live" });
  });

  it("push commits without secrets, pushes and releases the session", async () => {
    await start();
    const branch = uniqueBranch("push");
    const s = await open(HELLO, { new: branch });
    for (const f of ["a.txt", ".env", "k.pem"]) await writeFile(path.join(cloneDir(), f), `${f}\n`);
    const del = await req("DELETE", `/api/sessions/${s.sessionId}`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ sessionId: s.sessionId, ask: { changes: expect.arrayContaining(["?? a.txt"]) } });
    const res = await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "push" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().skipped).toEqual(expect.arrayContaining([".env", "k.pem"]));
    await ctx.sessions.settled();
    expect(await sessionsOf()).toEqual([]);
    expect(await git(forge.dir, ["--git-dir", bare("octo/hello"), "log", "-1", "--format=%s", branch])).toBe(`graph-manager: save session ${s.sessionId}`);
    const files = (await git(forge.dir, ["--git-dir", bare("octo/hello"), "show", "--name-only", "--format=", branch])).split("\n");
    expect(files).toEqual(["a.txt"]);
  });

  it("the secret files a push skipped do not block the next session's new branch", async () => {
    await start();
    const s = await open(HELLO, { new: uniqueBranch("push") });
    for (const f of ["a.txt", ".env", "id.key"]) await writeFile(path.join(cloneDir(), f), `${f}\n`);
    await req("DELETE", `/api/sessions/${s.sessionId}`);
    expect((await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "push" })).statusCode).toBe(200);
    await ctx.sessions.settled();
    const next = await req("POST", "/api/sessions", { repo: HELLO, branch: { new: uniqueBranch("next") } });
    expect(next.statusCode, next.body).toBe(201);
    // They stay on disk, untracked, in the new branch.
    expect(existsSync(path.join(cloneDir(), ".env"))).toBe(true);
  });

  it("discard drops the changes and releases the session", async () => {
    await start();
    const s = await open();
    await writeFile(path.join(cloneDir(), "new.txt"), "x\n");
    await writeFile(path.join(cloneDir(), "README.md"), "changed\n");
    expect((await req("DELETE", `/api/terminals/${s.terminalId}`)).statusCode).toBe(200);
    const res = await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "discard" });
    expect(res.statusCode).toBe(200);
    await ctx.sessions.settled();
    expect(await sessionsOf()).toEqual([]);
    expect(await git(cloneDir(), ["status", "--porcelain"])).toBe("");
  });

  it("a failed push leaves the session save-failed; push retries, discard releases", async () => {
    await start();
    const branch = uniqueBranch("fail");
    const s = await open(HELLO, { new: branch });
    await writeFile(path.join(cloneDir(), "a.txt"), "a\n");
    const url = await git(cloneDir(), ["remote", "get-url", "origin"]);
    await git(cloneDir(), ["remote", "set-url", "origin", path.join(forge.dir, "missing.git")]);
    expect((await req("DELETE", `/api/terminals/${s.terminalId}`)).statusCode).toBe(200);
    const res = await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "push" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ session: { state: "save-failed", error: expect.any(String) } });
    expect((await sessionsOf())[0]).toMatchObject({ state: "save-failed" });
    // A closing session refuses new terminals.
    expect((await req("POST", "/api/sessions", { repo: HELLO })).json()).toEqual({ error: "octo/hello is closing. Try again when it has closed." });
    expect((await req("POST", `/api/sessions/${s.sessionId}/terminals`, {})).json()).toEqual({ error: "session is save-failed" });

    // Retry: still failing, then working.
    expect((await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "push" })).json()).toMatchObject({ session: { state: "save-failed" } });
    await git(cloneDir(), ["remote", "set-url", "origin", url]);
    const retry = await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "push" });
    expect(retry.json()).toMatchObject({ session: { state: "ending" } });
    await ctx.sessions.settled();
    expect(await sessionsOf()).toEqual([]);
    expect(await git(forge.dir, ["--git-dir", bare("octo/hello"), "log", "-1", "--format=%s", branch])).toBe(`graph-manager: save session ${s.sessionId}`);
  });

  it("discard from save-failed releases the session", async () => {
    await start();
    const s = await open();
    await writeFile(path.join(cloneDir(), "a.txt"), "a\n");
    await git(cloneDir(), ["remote", "set-url", "origin", path.join(forge.dir, "missing.git")]);
    await req("DELETE", `/api/terminals/${s.terminalId}`);
    await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "push" });
    const res = await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "discard" });
    expect(res.statusCode).toBe(200);
    await ctx.sessions.settled();
    expect(await sessionsOf()).toEqual([]);
    expect(await git(cloneDir(), ["status", "--porcelain"])).toBe("");
  });

  it("waits for live runs before releasing", async () => {
    await start();
    live = 1;
    const s = await open();
    expect((await req("DELETE", `/api/terminals/${s.terminalId}`)).statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 100));
    expect((await sessionsOf())[0]).toMatchObject({ id: s.sessionId, state: "ending" });
    live = 0;
    await ctx.sessions.settled();
    expect(await sessionsOf()).toEqual([]);
  });

  it("refuses to switch a dirty clone to another branch", async () => {
    await start();
    const s = await open();
    await req("DELETE", `/api/terminals/${s.terminalId}`);
    await ctx.sessions.settled();
    await writeFile(path.join(cloneDir(), "dirty.txt"), "x\n");
    const res = await req("POST", "/api/sessions", { repo: HELLO, branch: { new: uniqueBranch("other") } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "octo/hello has uncommitted changes. Close its session with Push or Discard first." });
    expect(await sessionsOf()).toEqual([]);
  });

  it("answers 404 for an unknown project and 400 for neither repo nor projectId", async () => {
    await start();
    expect((await req("POST", "/api/sessions", { projectId: "x" })).json()).toEqual({ error: "project not found" });
    expect((await req("POST", "/api/sessions", {})).statusCode).toBe(400);
    expect((await req("POST", "/api/sessions", {})).json()).toEqual({ error: "pass repo or projectId" });
    expect((await req("POST", "/api/sessions", { repo: HELLO, projectId: "x" })).statusCode).toBe(400);
  });

  it("answers 404 for unknown sessions", async () => {
    await start();
    expect((await req("POST", "/api/sessions/nope/close", { action: "push" })).json()).toEqual({ error: "session not found" });
    expect((await req("DELETE", "/api/sessions/nope")).statusCode).toBe(404);
  });

  it("keeps each account's sessions, terminals and runs to itself", async () => {
    await start();
    const s = await open();
    const bob = await secondUser();
    expect((await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "discard" }, bob)).statusCode).toBe(404);
    expect((await req("POST", `/api/sessions/${s.sessionId}/terminals`, {}, bob)).statusCode).toBe(404);
    expect((await req("DELETE", `/api/sessions/${s.sessionId}`, undefined, bob)).statusCode).toBe(404);
    const del = await req("DELETE", `/api/terminals/${s.terminalId}`, undefined, bob);
    expect(del.statusCode).toBe(404);
    expect(del.json()).toEqual({ error: "terminal not found" });
    expect((await req("PATCH", `/api/terminals/${s.terminalId}`, { title: "x" }, bob)).statusCode).toBe(404);
    expect((await req("POST", `/api/terminals/${s.terminalId}/restart`, {}, bob)).statusCode).toBe(404);
    const run = await req("GET", "/api/runs/github~octo~hello/x", undefined, bob);
    expect(run.statusCode).toBe(404);
    expect(run.json()).toEqual({ error: "unknown workspace" });
    expect((await req("GET", "/api/workspaces/github~octo~hello/specs", undefined, bob)).statusCode).toBe(404);
    expect((await req("POST", "/api/terminals", { workspaceId: "github~octo~hello" }, bob)).json()).toEqual({ error: "workspace not found" });
    expect((await req("GET", "/runs/github~octo~hello/20260101-000000-abcd/view/", undefined, bob)).statusCode).toBe(404);
    expect(await sessionsOf(bob)).toEqual([]);
    expect((await req("GET", "/api/terminals", undefined, bob)).json()).toEqual({ terminals: [] });
    expect((await req("GET", "/api/workspaces", undefined, bob)).json()).toMatchObject({ workspaces: [] });
    expect((await req("GET", "/api/runs?workspace=github~octo~hello", undefined, bob)).json()).toEqual({ runs: [] });
    // The owner still reaches everything.
    expect((await req("GET", "/api/workspaces")).json().workspaces).toHaveLength(1);
    expect((await req("GET", "/api/terminals")).json().terminals).toHaveLength(1);
    expect((await req("GET", "/api/runs/github~octo~hello/20260101-000000-abcd")).json()).toEqual({ error: "unknown run" });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${s.terminalId}/ws`, { headers: { cookie: bob } });
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => undefined);
    });
    expect(code).toBe(4404);
  });

  it("ends a disabled user's sessions without asking", async () => {
    await start();
    const s = await open();
    await writeFile(path.join(cloneDir(), "new.txt"), "x\n");
    await ctx.userLifecycle.disabled(ADMIN_USER.id);
    expect(ctx.sessions.all()).toEqual([]);
    expect(ctx.terminals.get(s.terminalId)).toBeUndefined();
    // No push, no discard: the clone keeps its changes.
    expect(await git(cloneDir(), ["status", "--porcelain"])).toBe("?? new.txt");
  });

  it("drops sessions that never finished opening and resumes ends after a restart", async () => {
    await start();
    const s = await open();
    const us = await ctx.store.forUser(ADMIN_USER);
    await us.update((d) => {
      d.sessions[s.sessionId]!.state = "ending";
      d.sessions.x = { id: "x", repo: OTHER, workspaceId: "", branch: "b", state: "starting", startedAt: new Date().toISOString() };
    });
    await ctx.sessions.restore();
    await ctx.sessions.settled();
    expect(Object.keys(us.get().sessions)).toEqual([]);
    expect(us.get().ownedWorkspaces).toEqual(["github~octo~hello"]);
  });

  it("lists repos with live sessions first and their branches", async () => {
    await start();
    await req("PUT", "/api/forges/gitlab", { token: "gl-good", baseUrl: `${forge.url}/gitlab` });
    let res = await req("GET", "/api/repos?q=hel");
    expect(res.statusCode).toBe(200);
    expect(res.json().forges).toEqual({ github: true, gitlab: true });
    const hello = res.json().repos.find((r: { fullPath: string }) => r.fullPath === "octo/hello");
    expect(hello).toMatchObject({ repo: HELLO, defaultBranch: "main", live: false });

    const s = await open(OTHER);
    res = await req("GET", "/api/repos");
    const repos = res.json().repos as Array<{ repo: { forge: string; owner: string; name: string; baseUrl?: string }; live: boolean; sessionId?: string; branch?: string }>;
    expect(repos[0]).toMatchObject({ repo: OTHER, live: true, sessionId: s.sessionId, branch: s.branch });
    expect(repos.find((r) => r.repo.forge === "gitlab" && r.repo.name === "proj")?.repo).toEqual({
      forge: "gitlab",
      owner: "grp/sub",
      name: "proj",
      baseUrl: `${forge.url}/gitlab`,
    });

    const br = await req("GET", "/api/repos/branches?forge=github&owner=octo&name=hello");
    expect(br.statusCode, br.body).toBe(200);
    expect(br.json().defaultBranch).toBe("main");
    expect(br.json().branches[0]).toBe("main");
    // A forge's 404 is answered as 400 (the app's ForgeError rule).
    expect((await req("GET", "/api/repos/branches?forge=gitlab&owner=x&name=y")).statusCode).toBe(400);
    await rename(bare("octo/other"), `${bare("octo/other")}.gone`);
    try {
      const bad = await req("GET", "/api/repos/branches?forge=github&owner=octo&name=other");
      expect(bad.statusCode).toBe(502);
      expect(bad.json().error).toMatch(/^cannot list branches: /);
      expect(bad.body).not.toContain("gh-good");
    } finally {
      await rename(`${bare("octo/other")}.gone`, bare("octo/other"));
    }
  });

  it("answers an empty list without a forge, and 400 for branches of one not connected", async () => {
    await start();
    await req("DELETE", "/api/forges/github");
    expect((await req("GET", "/api/repos")).json()).toEqual({ repos: [], forges: { github: false, gitlab: false } });
    expect((await req("GET", "/api/repos/branches?forge=github&owner=octo&name=hello")).statusCode).toBe(400);
  });
});
