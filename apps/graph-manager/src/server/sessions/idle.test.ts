import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeForge, type FakeForge } from "../../../scripts/fake-forge.mjs";
import { createUser, hashPassword } from "../accounts.js";
import type { AppContext } from "../app.js";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import { appWithLogin, loginAs } from "../test-helpers.js";
import type { SessionView } from "./sessions.js";

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
});

afterAll(async () => {
  await forge.close();
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  live = 0;
});

async function start(overrides: Partial<Config> = { sessionIdleMinutes: 15 }): Promise<void> {
  const res = await appWithLogin(
    { githubApiUrl: `${forge.url}/github`, ...overrides },
    { sessions: { pollMs: 20, liveRuns: async () => live }, onContext: (c) => (ctx = c) },
  );
  ({ app, cookie, config, db, cleanup } = res);
  const put = await req("PUT", "/api/forges/github", { token: "gh-good" });
  expect(put.statusCode).toBe(200);
}

type Method = "GET" | "POST" | "PUT" | "DELETE";
const req = (method: Method, url: string, payload?: object, c = cookie) => app.inject({ method, url, payload, headers: { cookie: c } });

const HELLO = { forge: "github", owner: "octo", name: "hello" } as const;
const cloneDir = () => path.join(config.workspacesDir, "github", "octo", "hello");
const bare = path.join("octo", "hello.git");
const git = async (cwd: string, args: string[]) => (await execa("git", args, { cwd })).stdout.trim();
const forgeGit = (args: string[]) => git(forge.dir, ["--git-dir", path.join(forge.dir, bare), ...args]);
const later = (min: number) => new Date(Date.now() + min * 60_000);

let branchNo = 0;
const uniqueBranch = (p: string) => `${p}-${Date.now()}-${++branchNo}`;

async function open(branch = uniqueBranch("idle")): Promise<{ sessionId: string; terminalId: string; branch: string }> {
  const res = await req("POST", "/api/sessions", { repo: HELLO, branch: { new: branch } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function sessionsOf(c = cookie): Promise<SessionView[]> {
  return (await req("GET", "/api/sessions", undefined, c)).json<{ sessions: SessionView[] }>().sessions;
}

async function notices(c = cookie): Promise<Array<{ id: string; text: string; createdAt: string }>> {
  const res = await req("GET", "/api/notices", undefined, c);
  expect(res.statusCode).toBe(200);
  return res.json<{ notices: Array<{ id: string; text: string; createdAt: string }> }>().notices;
}

describe("idle config", () => {
  it("without GM_SESSION_IDLE_MINUTES there is no idle monitor", async () => {
    await start({});
    expect(ctx.idle).toBeUndefined();
    expect(await notices()).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("idle sessions", () => {
  it("pushes the changes to gm/backup/<id>, ends the session and leaves a notice once", async () => {
    await start();
    const s = await open();
    const head = await forgeGit(["rev-parse", s.branch]).catch(() => "");
    for (const f of ["a.txt", ".env"]) await writeFile(path.join(cloneDir(), f), `${f}\n`);
    await ctx.idle!.check(later(16));
    await ctx.sessions.settled();

    const backup = `gm/backup/${s.sessionId}`;
    expect(await forgeGit(["log", "-1", "--format=%s", backup])).toBe(`graph-manager: save session ${s.sessionId}`);
    expect((await forgeGit(["show", "--name-only", "--format=", backup])).split("\n")).toEqual(["a.txt"]);
    // The session branch on the forge is untouched.
    expect(await forgeGit(["rev-parse", s.branch]).catch(() => "")).toBe(head);
    expect(await sessionsOf()).toEqual([]);
    expect(ctx.terminals.get(s.terminalId)).toBeUndefined();
    expect(ctx.terminals.ofSession(s.sessionId)).toEqual([]);

    expect(await notices()).toEqual([
      {
        id: expect.any(String),
        text: `Your session on octo/hello was closed after 15 minutes idle. Changes were saved to branch gm/backup/${s.sessionId}.`,
        createdAt: expect.any(String),
      },
    ]);
    expect(await notices()).toEqual([]);
  });

  it("keeps a session with recent terminal output or input", async () => {
    await start();
    const s = await open();
    await ctx.idle!.check(later(1));
    expect((await sessionsOf())[0]).toMatchObject({ id: s.sessionId, state: "live" });

    const att = ctx.terminals.attach(s.terminalId, () => undefined, () => undefined);
    att.write("echo hi\r");
    att.detach();
    const at = ctx.terminals.get(s.terminalId)?.lastInputAt;
    expect(at).toEqual(expect.any(String));
    await ctx.idle!.check(new Date(Date.parse(at!) + 14 * 60_000));
    await ctx.sessions.settled();
    expect((await sessionsOf())[0]).toMatchObject({ id: s.sessionId, state: "live" });
    expect(ctx.terminals.get(s.terminalId)).toBeDefined();
    expect(await notices()).toEqual([]);
  });

  it("keeps a session with a live run", async () => {
    await start();
    const s = await open();
    live = 1;
    await ctx.idle!.check(later(16));
    await ctx.sessions.settled();
    expect((await sessionsOf())[0]).toMatchObject({ id: s.sessionId, state: "live" });
    expect(ctx.terminals.get(s.terminalId)).toBeDefined();
    expect(await notices()).toEqual([]);
  });

  it("ends an asking session the same way", async () => {
    await start();
    const s = await open();
    await writeFile(path.join(cloneDir(), "b.txt"), "b\n");
    const del = await req("DELETE", `/api/terminals/${s.terminalId}`);
    expect(del.statusCode).toBe(200);
    expect((await sessionsOf())[0]).toMatchObject({ state: "asking" });
    await ctx.idle!.check(later(16));
    await ctx.sessions.settled();
    expect(await sessionsOf()).toEqual([]);
    expect(await forgeGit(["show", "--name-only", "--format=", `gm/backup/${s.sessionId}`])).toBe("b.txt");
    expect((await notices()).map((n) => n.text)).toEqual([
      `Your session on octo/hello was closed after 15 minutes idle. Changes were saved to branch gm/backup/${s.sessionId}.`,
    ]);
  });

  it("ends a clean idle session with a notice and no backup", async () => {
    await start();
    // Earlier tests leave committed work and an untracked .env: start from a clean clone.
    const s = await open();
    await git(cloneDir(), ["clean", "-fdqx"]);
    await ctx.idle!.check(later(16));
    await ctx.sessions.settled();
    expect(await sessionsOf()).toEqual([]);
    await expect(forgeGit(["rev-parse", "--verify", `gm/backup/${s.sessionId}`])).rejects.toThrow();
    expect((await notices()).map((n) => n.text)).toEqual(["Your session on octo/hello was closed after 15 minutes idle."]);
  });

  it("a failed backup push leaves the session save-failed with a notice", async () => {
    await start();
    const s = await open();
    await writeFile(path.join(cloneDir(), "c.txt"), "c\n");
    const url = await git(cloneDir(), ["remote", "get-url", "origin"]);
    await git(cloneDir(), ["remote", "set-url", "origin", path.join(forge.dir, "missing.git")]);
    try {
      await ctx.idle!.check(later(16));
      await ctx.sessions.settled();
      const [view] = await sessionsOf();
      expect(view).toMatchObject({ id: s.sessionId, state: "save-failed", error: expect.any(String) });
      expect(ctx.terminals.get(s.terminalId)).toBeUndefined();
      const texts = (await notices()).map((n) => n.text);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toMatch(new RegExp(`^Your session on octo/hello was idle for 15 minutes, but saving its changes to gm/backup/${s.sessionId} failed: .+\\. Open it to retry or discard\\.$`));
      // Not handled again while save-failed.
      await ctx.idle!.check(later(32));
      expect(await notices()).toEqual([]);
    } finally {
      await git(cloneDir(), ["remote", "set-url", "origin", url]);
    }
    const discard = await req("POST", `/api/sessions/${s.sessionId}/close`, { action: "discard" });
    expect(discard.statusCode).toBe(200);
    await ctx.sessions.settled();
    expect(await sessionsOf()).toEqual([]);
  });

  it("notices are per user", async () => {
    await start();
    await open();
    await ctx.idle!.check(later(16));
    await ctx.sessions.settled();
    await createUser(db, { username: "bob", displayName: "Bob", passwordHash: await hashPassword("bob-password-1") });
    const bob = await loginAs(app, "bob", "bob-password-1");
    expect(await notices(bob)).toEqual([]);
    expect((await notices()).map((n) => n.text)).toEqual([expect.stringContaining(`octo/hello was closed after 15 minutes idle`)]);
  });
});
