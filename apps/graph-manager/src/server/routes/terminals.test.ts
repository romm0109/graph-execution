import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execa } from "execa";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import { DATA_FILE } from "../store.js";
import { tempDir, testConfig } from "../test-helpers.js";

let app: FastifyInstance;
let cleanup: () => Promise<void>;
let dir: string;
let port: number;
let cookie: string;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  const config = testConfig(dir);
  await mkdir(config.workspacesDir, { recursive: true });
  await mkdir(path.join(config.workspacesDir, "github", "o", "r", ".git"), { recursive: true });
  app = await buildApp(config, { webDir: path.join(dir, "no-web"), viewCache: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "pw" } });
  const raw = res.headers["set-cookie"];
  cookie = (Array.isArray(raw) ? String(raw[0]) : String(raw)).split(";")[0] ?? "";
});

afterEach(async () => {
  await app.close();
  await cleanup();
});

function connect(id: string, headers: Record<string, string> = { cookie }) {
  return new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${id}/ws`, { headers });
}

describe.skipIf(process.platform === "win32")("terminal routes", () => {
  it("rejects a cwd outside the workspaces folder", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { cwd: "/etc" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "cwd must be inside the workspaces folder" });
  });

  it("rejects a cwd that is a symlink inside the workspaces folder pointing out of it (F4)", async () => {
    const link = path.join(dir, "ws", "github", "o", "r", "escape");
    await symlink("/etc", link);
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { cwd: link } });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a WebSocket upgrade from a foreign Origin, even with the session cookie (F1)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
    const { id } = res.json() as { id: string };
    const status = await new Promise<number>((resolve, reject) => {
      const ws = connect(id, { cookie, origin: "http://127.0.0.1:3000" });
      ws.on("unexpected-response", (_req, r) => resolve(r.statusCode ?? 0));
      ws.on("open", () => reject(new Error("opened from a foreign origin")));
      ws.on("error", () => undefined);
    });
    expect(status).toBe(403);
    const opened = await new Promise<boolean>((resolve) => {
      const ws = connect(id, { cookie, origin: `http://127.0.0.1:${port}` });
      ws.on("open", () => {
        ws.close();
        resolve(true);
      });
      ws.on("error", () => resolve(false));
    });
    expect(opened).toBe(true);
  });

  it("opens a terminal in a workspace", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { workspaceId: "github~o~r" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ workspaceId: "github~o~r", cwd: path.join(dir, "ws", "github", "o", "r"), title: "o/r" });
    const missing = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { workspaceId: "github~x~y" } });
    expect(missing.statusCode).toBe(404);
  });

  it("opens a terminal on a project; deleting the project closes it", async () => {
    await mkdir(path.join(dir, "ws", "github", "o", "s", ".git"), { recursive: true });
    const made = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "billing", workspaces: ["github~o~r", "github~o~s"] },
    });
    expect(made.statusCode).toBe(201);
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload });
    const list = async () => (await app.inject({ method: "GET", url: "/api/terminals", headers: { cookie } })).json().terminals as { id: string; projectId?: string }[];

    const res = await post({ projectId: "billing" });
    expect(res.statusCode).toBe(201);
    const info = res.json() as { id: string; workspaceId?: string; worktree: { id: string } };
    // Its own worktree of the project repo; r and s have no commit, so they link to their checkouts.
    expect(info).toMatchObject({
      projectId: "billing",
      cwd: path.join(dir, "ws", ".projects", "billing", ".gm-worktrees", info.worktree.id),
      title: "billing",
      worktree: { repos: [{ name: "r", isolated: false }, { name: "s", isolated: false }] },
    });
    expect(info.workspaceId).toBeUndefined();
    expect(await list()).toEqual([expect.objectContaining({ id: info.id, projectId: "billing" })]);

    const missing = await post({ projectId: "nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "project not found" });
    const both = await post({ projectId: "billing", workspaceId: "github~o~r" });
    expect(both.statusCode).toBe(400);
    expect(both.json()).toEqual({ error: "pass workspaceId or projectId, not both" });

    const gone = await app.inject({ method: "DELETE", url: "/api/projects/billing", headers: { cookie } });
    expect(gone.statusCode).toBe(204);
    expect(await list()).toEqual([]);
  });

  it("creates, streams over the WebSocket, and deletes", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(201);
    const { id, cwd } = res.json() as { id: string; cwd: string };
    expect(cwd).toBe(path.join(dir, "ws"));

    const ws = connect(id);
    const messages: { type: string; data?: string }[] = [];
    const got = new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string; data?: string };
        messages.push(msg);
        if (msg.type === "data" && messages.filter((m) => m.type === "data").map((m) => m.data).join("").includes("gm-42")) resolve();
      });
      ws.on("error", reject);
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    ws.send(JSON.stringify({ type: "input", data: "echo gm-$((40+2))\r" }));
    await got;
    expect(messages[0]?.type).toBe("replay");
    ws.close();

    const list = await app.inject({ url: "/api/terminals", headers: { cookie } });
    expect((list.json() as { terminals: { id: string }[] }).terminals.map((t) => t.id)).toEqual([id]);

    expect((await app.inject({ method: "DELETE", url: `/api/terminals/${id}`, headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/terminals/${id}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/terminals", headers: { cookie } })).json()).toEqual({ terminals: [] });
  });

  it("answers a ping with a pong carrying the same timestamp (the latency readout)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
    const { id } = res.json() as { id: string };
    const ws = connect(id);
    const pong = new Promise<{ type: string; t?: number }>((resolve, reject) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string; t?: number };
        if (msg.type === "pong") resolve(msg);
      });
      ws.on("error", reject);
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.send(JSON.stringify({ type: "ping", t: 1234.5 }));
    expect(await pong).toEqual({ type: "pong", t: 1234.5 });
    ws.close();
  });

  it("refuses the WebSocket without a cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
    const { id } = res.json() as { id: string };
    const ws = connect(id, {});
    const status = await new Promise<number>((resolve) => ws.on("unexpected-response", (_req, r) => resolve(r.statusCode ?? 0)));
    expect(status).toBe(401);
  });

  it("closes the WebSocket with 4404 for an unknown terminal", async () => {
    const ws = connect("t999");
    const code = await new Promise<number>((resolve) => ws.on("close", (c) => resolve(c)));
    expect(code).toBe(4404);
  });

  it("restarts an exited terminal over HTTP; a socket attached before keeps receiving (409 while running, 404 unknown)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { title: "sh" } });
    const { id } = res.json() as { id: string };
    expect((await app.inject({ method: "POST", url: `/api/terminals/${id}/restart`, headers: { cookie } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/terminals/t999/restart", headers: { cookie } })).statusCode).toBe(404);

    const ws = connect(id);
    const messages: { type: string; data?: string; code?: number }[] = [];
    const waitFor = (pred: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => (pred() ? resolve() : setTimeout(check, 20));
        check();
      });
    const data = () => messages.filter((m) => m.type === "data").map((m) => m.data).join("");
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as { type: string }));
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.send(JSON.stringify({ type: "input", data: "echo old-$((2+2)); exit 3\r" }));
    await waitFor(() => messages.some((m) => m.type === "exit"));
    expect(messages.find((m) => m.type === "exit")?.code).toBe(3);
    expect(data()).toContain("old-4");

    const restarted = await app.inject({ method: "POST", url: `/api/terminals/${id}/restart`, headers: { cookie } });
    expect(restarted.statusCode).toBe(200);
    expect(restarted.json()).toMatchObject({ id, title: "sh" });
    expect((restarted.json() as { status: string }).status).not.toBe("exited");
    await waitFor(() => messages.some((m) => m.type === "restart"));
    ws.send(JSON.stringify({ type: "input", data: "echo new-$((5+5))\r" }));
    await waitFor(() => data().includes("new-10"));
    ws.close();

    const ws2 = connect(id);
    const replay = await new Promise<string>((resolve) =>
      ws2.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string; data: string };
        if (msg.type === "replay") resolve(msg.data);
      }),
    );
    expect(replay).toContain("old-4");
    expect(replay).toContain("new-10");
    ws2.close();
  });

  it("renames with PATCH", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: {} });
    const { id } = res.json() as { id: string };
    const ok = await app.inject({ method: "PATCH", url: `/api/terminals/${id}`, headers: { cookie }, payload: { title: "fix-auth" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id, title: "fix-auth" });
    expect((await app.inject({ method: "PATCH", url: `/api/terminals/${id}`, headers: { cookie }, payload: { title: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/terminals/${id}`, headers: { cookie }, payload: { title: "x".repeat(201) } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/terminals/t999", headers: { cookie }, payload: { title: "x" } })).statusCode).toBe(404);
  });
});

describe.skipIf(process.platform === "win32")("terminal worktrees (KAN-100)", () => {
  const WS = "github~o~real";
  let wsDir: string;
  const git = async (cwd: string, ...args: string[]) => (await execa("git", args, { cwd })).stdout.trim();

  beforeEach(async () => {
    wsDir = path.join(dir, "ws", "github", "o", "real");
    await mkdir(wsDir, { recursive: true });
    await git(wsDir, "init", "-q", "-b", "main");
    await git(wsDir, "config", "user.name", "t");
    await git(wsDir, "config", "user.email", "t@example.com");
    await writeFile(path.join(wsDir, "README.md"), "# hi\n");
    await git(wsDir, "add", ".");
    await git(wsDir, "commit", "-q", "-m", "init");
  });

  const open = async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { workspaceId: WS } });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string; cwd: string; worktree: { id: string; path: string; branch: string } }>();
  };
  const close = (id: string, q = "") => app.inject({ method: "DELETE", url: `/api/terminals/${id}${q}`, headers: { cookie } });
  const kept = async () =>
    (await app.inject({ method: "GET", url: `/api/workspaces/${WS}/worktrees`, headers: { cookie } })).json<{ worktrees: { id: string; branch: string; dirty: number; ahead: number }[] }>().worktrees;

  it("opens each terminal in its own worktree and branch, and removes an untouched one on close", async () => {
    const a = await open();
    const b = await open();
    expect(a.worktree.branch).toBe(`gm-term/${a.worktree.id}`);
    expect(a.cwd).toBe(path.join(wsDir, ".gm-worktrees", a.worktree.id));
    expect(b.cwd).not.toBe(a.cwd);
    expect(await git(a.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(a.worktree.branch);
    // The workspace checkout does not see the worktrees.
    expect(await git(wsDir, "status", "--porcelain")).toBe("");

    expect((await close(a.id)).statusCode).toBe(204);
    expect(existsSync(a.cwd)).toBe(false);
    expect(await git(wsDir, "branch", "--list", a.worktree.branch)).toBe("");
    expect(await kept()).toEqual([]);
  });

  it("asks before closing a terminal with work; Keep lists it, and it can be reopened or deleted", async () => {
    const t = await open();
    await writeFile(path.join(t.cwd, "new.txt"), "work\n");
    const res = await close(t.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ needsChoice: true, dirty: 1, ahead: 0, branch: t.worktree.branch, worktreeId: t.worktree.id });
    expect(existsSync(t.cwd)).toBe(true);

    expect((await close(t.id, "?worktree=keep")).statusCode).toBe(204);
    expect(await kept()).toMatchObject([{ id: t.worktree.id, branch: t.worktree.branch, dirty: 1, ahead: 0 }]);

    const again = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { workspaceId: WS, worktreeId: t.worktree.id } });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ cwd: t.cwd, worktree: { id: t.worktree.id } });
    expect(await kept()).toEqual([]);
    expect((await close(again.json<{ id: string }>().id, "?worktree=keep")).statusCode).toBe(204);

    const del = await app.inject({ method: "DELETE", url: `/api/workspaces/${WS}/worktrees/${t.worktree.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);
    expect(existsSync(t.cwd)).toBe(false);
    expect(await git(wsDir, "branch", "--list", t.worktree.branch)).toBe("");
    expect((await app.inject({ method: "DELETE", url: `/api/workspaces/${WS}/worktrees/${t.worktree.id}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it("lists the specs of the terminal's own worktree only (KAN-99)", async () => {
    const a = await open();
    const b = await open();
    await mkdir(path.join(a.cwd, "docs", "prd"), { recursive: true });
    await writeFile(path.join(a.cwd, "docs", "prd", "mine.md"), "# Mine\n");
    const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
    expect((await get(`/api/terminals/${a.id}/specs`)).json()).toMatchObject({ specs: [{ path: "docs/prd/mine.md", title: "Mine" }] });
    expect((await get(`/api/terminals/${b.id}/specs`)).json()).toEqual({ specs: [] });
    expect((await get(`/api/workspaces/${WS}/specs`)).json()).toEqual({ specs: [] });
    expect((await get(`/api/terminals/${a.id}/specs/file?path=docs/prd/mine.md`)).json()).toMatchObject({ text: "# Mine\n" });
    expect((await get(`/api/terminals/nope/specs`)).statusCode).toBe(404);
  });

  it("Delete removes a worktree with commits and its branch", async () => {
    const t = await open();
    await writeFile(path.join(t.cwd, "c.txt"), "c\n");
    await git(t.cwd, "add", ".");
    await git(t.cwd, "commit", "-q", "-m", "c");
    expect((await close(t.id)).json()).toMatchObject({ needsChoice: true, dirty: 0, ahead: 1 });
    expect((await close(t.id, "?worktree=delete")).statusCode).toBe(204);
    expect(existsSync(t.cwd)).toBe(false);
    expect(await git(wsDir, "branch", "--list", t.worktree.branch)).toBe("");
  });
});

describe.skipIf(process.platform === "win32")("terminal base branch", () => {
  const WS = "github~o~based";
  let wsDir: string;
  let originDir: string;
  const git = async (cwd: string, ...args: string[]) => (await execa("git", args, { cwd })).stdout.trim();
  const ident = async (cwd: string) => {
    await git(cwd, "config", "user.name", "t");
    await git(cwd, "config", "user.email", "t@example.com");
  };

  beforeEach(async () => {
    wsDir = path.join(dir, "ws", "github", "o", "based");
    originDir = path.join(dir, "origin.git");
    await mkdir(wsDir, { recursive: true });
    await git(dir, "init", "-q", "--bare", "-b", "main", originDir);
    await git(wsDir, "init", "-q", "-b", "main");
    await ident(wsDir);
    await writeFile(path.join(wsDir, "README.md"), "# hi\n");
    await git(wsDir, "add", ".");
    await git(wsDir, "commit", "-q", "-m", "init");
    await git(wsDir, "remote", "add", "origin", originDir);
    await git(wsDir, "push", "-q", "origin", "main");
    await git(wsDir, "remote", "set-head", "origin", "main");
    // The checkout is on a local branch with its own commit.
    await git(wsDir, "checkout", "-q", "-b", "development");
    await writeFile(path.join(wsDir, "dev.txt"), "dev\n");
    await git(wsDir, "add", ".");
    await git(wsDir, "commit", "-q", "-m", "dev");
  });

  type Opened = { id: string; cwd: string; worktree: { id: string; branch: string }; warnings?: string[] };
  const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { workspaceId: WS, ...payload } });
  const keepAndList = async (t: Opened) => {
    await writeFile(path.join(t.cwd, "w.txt"), "w\n");
    expect((await app.inject({ method: "DELETE", url: `/api/terminals/${t.id}?worktree=keep`, headers: { cookie } })).statusCode).toBe(204);
  };

  it("cuts a new terminal from origin's default branch, not the checkout's branch", async () => {
    const res = await post({});
    expect(res.statusCode).toBe(201);
    const t = res.json<Opened>();
    expect(t.worktree.branch).toBe(`gm-term/${t.worktree.id}`);
    expect(await git(t.cwd, "rev-parse", "HEAD")).toBe(await git(wsDir, "rev-parse", "origin/main"));
    expect(t.warnings).toBeUndefined();
    await keepAndList(t);
    const stored = JSON.parse(await readFile(path.join(testConfig(dir).dataDir, DATA_FILE), "utf8")) as {
      terminalWorktrees: Record<string, { baseBranch?: string; base?: string }>;
    };
    expect(stored.terminalWorktrees[t.worktree.id]).toMatchObject({ baseBranch: "main", base: await git(wsDir, "rev-parse", "origin/main") });
  });

  it("cuts from a chosen base: pushed to origin, or the local branch with a warning", async () => {
    const local = await post({ base: "development" });
    expect(local.statusCode).toBe(201);
    const l = local.json<Opened>();
    expect(await git(l.cwd, "rev-parse", "HEAD")).toBe(await git(wsDir, "rev-parse", "development"));
    expect(l.warnings?.[0]).toContain("started from local development");

    await git(wsDir, "push", "-q", "origin", "development");
    const pushed = await post({ base: "development" });
    expect(pushed.statusCode).toBe(201);
    const p = pushed.json<Opened>();
    expect(await git(p.cwd, "rev-parse", "HEAD")).toBe(await git(wsDir, "rev-parse", "development"));
    expect(p.warnings).toBeUndefined();
  });

  it("fetches the base first, so a commit pushed from elsewhere is in the worktree", async () => {
    const other = path.join(dir, "other");
    await git(dir, "clone", "-q", originDir, other);
    await ident(other);
    await writeFile(path.join(other, "new.txt"), "new\n");
    await git(other, "add", ".");
    await git(other, "commit", "-q", "-m", "new");
    await git(other, "push", "-q", "origin", "main");
    const pushedSha = await git(other, "rev-parse", "HEAD");

    const res = await post({ base: "main" });
    expect(res.statusCode).toBe(201);
    const t = res.json<Opened>();
    expect(await git(t.cwd, "rev-parse", "HEAD")).toBe(pushedSha);
    expect(existsSync(path.join(t.cwd, "new.txt"))).toBe(true);
  });

  it("falls back to the local branch with a warning when origin can't be fetched", async () => {
    await rm(originDir, { recursive: true, force: true });
    const res = await post({ base: "main" });
    expect(res.statusCode).toBe(201);
    const t = res.json<Opened>();
    expect(t.warnings?.[0]).toMatch(/^could not fetch origin\/main: .*; started from local main$/);
    expect(await git(t.cwd, "rev-parse", "HEAD")).toBe(await git(wsDir, "rev-parse", "main"));
  });

  it("refuses an unknown base and leaves nothing behind", async () => {
    const res = await post({ base: "nope" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "branch nope not found" });
    const wtDir = path.join(wsDir, ".gm-worktrees");
    expect(existsSync(wtDir) ? (await readdir(wtDir)).length : 0).toBe(0);
    expect(await git(wsDir, "branch", "--list", "gm-term/*")).toBe("");
    expect((await post({ base: "-x" })).json()).toEqual({ error: "branch -x not found" });
  });

  it("refuses a base without a workspace", async () => {
    const res = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { projectId: "p1", base: "main" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "base needs a workspaceId" });
    const none = await app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload: { base: "main" } });
    expect(none.statusCode).toBe(400);
  });

  it("lists the branches a terminal can start from", async () => {
    await git(wsDir, "branch", "gm-term/wdeadbeef");
    await git(wsDir, "branch", "graph/run1");
    const get = (q = "") => app.inject({ method: "GET", url: `/api/workspaces/${WS}/branches${q}`, headers: { cookie } });
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json<{ branches: string[]; default: string; current: string; fetched: boolean }>();
    expect(body).toMatchObject({ default: "main", current: "development", fetched: false });
    expect(body.branches[0]).toBe("main");
    expect(body.branches).toContain("development");
    expect(body.branches).not.toContain("gm-term/wdeadbeef");
    expect(body.branches).not.toContain("graph/run1");

    expect((await get("?fetch=1")).json()).toMatchObject({ fetched: true });
    await rm(originDir, { recursive: true, force: true });
    const failed = await get("?fetch=1");
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ fetched: false, error: expect.any(String) });

    expect((await app.inject({ method: "GET", url: "/api/workspaces/github~o~missing/branches", headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/workspaces/github~o~r/branches", headers: { cookie } })).json()).toEqual({ branches: [], noCommit: true });
  });
});

describe.skipIf(process.platform === "win32")("project terminal worktrees", () => {
  const git = async (cwd: string, ...args: string[]) => (await execa("git", args, { cwd })).stdout.trim();
  const repo = (name: string) => path.join(dir, "ws", "github", "o", name);
  let projectDir: string;

  const initRepo = async (name: string, commit: boolean) => {
    const p = repo(name);
    await mkdir(p, { recursive: true });
    await git(p, "init", "-q", "-b", "main");
    await git(p, "config", "user.name", "t");
    await git(p, "config", "user.email", "t@example.com");
    if (commit) {
      await writeFile(path.join(p, "README.md"), `# ${name}\n`);
      await git(p, "add", ".");
      await git(p, "commit", "-q", "-m", "init");
    }
  };

  beforeEach(async () => {
    await initRepo("a", true);
    await initRepo("b", true);
    await initRepo("c", false);
    const made = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "billing", workspaces: ["github~o~a", "github~o~b", "github~o~c"] },
    });
    expect(made.statusCode).toBe(201);
    projectDir = path.join(dir, "ws", ".projects", "billing");
  });

  type Info = {
    id: string;
    cwd: string;
    warnings?: string[];
    worktree: { id: string; path: string; branch: string; repos: { name: string; branch?: string; baseBranch?: string; isolated: boolean }[] };
  };
  const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/terminals", headers: { cookie }, payload });
  const open = async () => {
    const res = await post({ projectId: "billing" });
    expect(res.statusCode).toBe(201);
    return res.json<Info>();
  };
  const close = (id: string, q = "") => app.inject({ method: "DELETE", url: `/api/terminals/${id}${q}`, headers: { cookie } });
  const stored = async () => JSON.parse(await readFile(path.join(dir, "data", DATA_FILE), "utf8")).projectWorktrees as Record<string, { kept?: boolean; terminalId?: string }>;
  /** Nothing of worktree `wid` remains in any repo or the project folder. */
  const nothingLeft = async (wid: string) => {
    for (const p of [repo("a"), repo("b"), projectDir]) {
      expect(await git(p, "branch", "--list", `gm-term/${wid}`)).toBe("");
      expect(existsSync(path.join(p, ".gm-worktrees", wid))).toBe(false);
    }
  };

  it("opens the terminal in a worktree of the project repo whose repos/ link to each repo's own worktree", async () => {
    const t = await open();
    const wid = t.worktree.id;
    expect(t.cwd).toBe(path.join(projectDir, ".gm-worktrees", wid));
    expect(t.worktree.branch).toBe(`gm-term/${wid}`);
    expect(existsSync(path.join(t.cwd, "project.json"))).toBe(true);
    expect(await git(t.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`gm-term/${wid}`);

    expect(realpathSync(path.join(t.cwd, "repos", "a"))).toBe(realpathSync(path.join(repo("a"), ".gm-worktrees", wid)));
    expect(await git(path.join(t.cwd, "repos", "a"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(`gm-term/${wid}`);
    expect(realpathSync(path.join(t.cwd, "repos", "b"))).toBe(realpathSync(path.join(repo("b"), ".gm-worktrees", wid)));
    expect(realpathSync(path.join(t.cwd, "repos", "c"))).toBe(realpathSync(repo("c")));
    expect(t.worktree.repos).toEqual([
      { name: "a", branch: `gm-term/${wid}`, baseBranch: "main", isolated: true },
      { name: "b", branch: `gm-term/${wid}`, baseBranch: "main", isolated: true },
      { name: "c", isolated: false },
    ]);

    // Nothing shows as a change: not the worktrees, not the repos/ links.
    expect(await git(repo("a"), "status", "--porcelain")).toBe("");
    expect(await git(projectDir, "status", "--porcelain")).toBe("");
    expect(await git(t.cwd, "status", "--porcelain")).toBe("");
    // The project folder's own links are untouched.
    expect(realpathSync(path.join(projectDir, "repos", "a"))).toBe(realpathSync(repo("a")));

    expect(await stored()).toMatchObject({ [wid]: { terminalId: t.id } });
  });

  it("removes everything on close when nothing holds work, without deleting through the links", async () => {
    const t = await open();
    const wid = t.worktree.id;
    expect((await close(t.id)).statusCode).toBe(204);
    await nothingLeft(wid);
    expect(existsSync(path.join(repo("a"), "README.md"))).toBe(true);
    expect(existsSync(path.join(repo("c"), ".git"))).toBe(true);
    expect(lstatSync(path.join(projectDir, "repos", "a")).isSymbolicLink()).toBe(true);
    expect(await stored()).toEqual({});
  });

  it("asks before closing when a repo has work; Keep keeps the record", async () => {
    const t = await open();
    const wid = t.worktree.id;
    await writeFile(path.join(t.cwd, "repos", "b", "new.txt"), "work\n");
    const res = await close(t.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "the terminal has work",
      needsChoice: true,
      project: { dirty: 0, ahead: 0 },
      repos: expect.arrayContaining([
        { name: "a", isolated: true, dirty: 0, ahead: 0 },
        { name: "b", isolated: true, dirty: 1, ahead: 0 },
        { name: "c", isolated: false, dirty: 0, ahead: 0 },
      ]),
      branch: `gm-term/${wid}`,
      worktreeId: wid,
    });
    expect((await close(t.id, "?worktree=keep")).statusCode).toBe(204);
    const rec = (await stored())[wid];
    expect(rec).toMatchObject({ kept: true });
    expect(rec?.terminalId).toBeUndefined();
    expect(existsSync(path.join(t.cwd, "repos", "b", "new.txt"))).toBe(true);
  });

  it("counts an edit of project.json as work; Delete removes everything", async () => {
    const t = await open();
    const wid = t.worktree.id;
    await writeFile(path.join(t.cwd, "project.json"), "{}\n");
    const res = await close(t.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ needsChoice: true, project: { dirty: 1, ahead: 0 } });
    expect((await close(t.id, "?worktree=delete")).statusCode).toBe(204);
    await nothingLeft(wid);
    expect(await stored()).toEqual({});
  });

  it("rolls back every worktree when a repo's base branch is unknown, naming the repo", async () => {
    const res = await post({ projectId: "billing", bases: { b: "nope" } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/^b: .*nope/);
    for (const p of [repo("a"), repo("b"), projectDir]) {
      expect(await git(p, "branch", "--list", "gm-term/*")).toBe("");
      expect(existsSync(path.join(p, ".gm-worktrees")) ? await readdir(path.join(p, ".gm-worktrees")) : []).toEqual([]);
    }
    expect(await stored()).toEqual({});
  });

  it("validates bases", async () => {
    const unknown = await post({ projectId: "billing", bases: { zz: "main" } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: "unknown repo zz" });
    const noProject = await post({ workspaceId: "github~o~a", bases: { a: "main" } });
    expect(noProject.statusCode).toBe(400);
    expect(noProject.json()).toEqual({ error: "bases needs a projectId" });
  });
});
