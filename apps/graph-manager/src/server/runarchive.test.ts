import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { stateSchema } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderBlobStore, readAll } from "./blobs.js";
import { ADMIN_USER, type User } from "./identity.js";
import { archiveRun, RunArchiver, runBlobKey, SqlRunArchive } from "./runarchive.js";
import { workspaceHome, type RunHome } from "./runhome.js";
import { readTarGz } from "./tar.js";
import { appWithLogin } from "./test-helpers.js";
import { resolveWorkspace } from "./workspaces.js";

const U2: User = { id: "u2", name: "u2" };
const WS = "github~octo~hello";

let t: Awaited<ReturnType<typeof appWithLogin>>;
let wsDir: string;
let runDir: string;
let tasksDir: string;
let home: RunHome;
let blobs: FolderBlobStore;
let archive: SqlRunArchive;

function state(overrides: Record<string, unknown> = {}) {
  return stateSchema.parse({
    runId: "r1",
    provider: "fake",
    startingCommit: "0".repeat(40),
    integrationBranch: "graph/r1",
    specPath: "spec.md",
    tasksDir,
    hashes: { config: "", tasks: "", spec: "" },
    tasks: { "1": { status: "merged", attempts: 1 }, "2": { status: "failed", attempts: 2 } },
    review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
    createdAt: "2026-11-06T10:00:00.000Z",
    status: "failed",
    ...overrides,
  });
}

const writeState = (overrides: Record<string, unknown> = {}) => writeFile(path.join(runDir, "state.json"), JSON.stringify(state(overrides)));

async function put(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(runDir, rel)), { recursive: true });
  await writeFile(path.join(runDir, rel), content);
}

const logLines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);

beforeEach(async () => {
  t = await appWithLogin();
  wsDir = path.join(t.config.workspacesDir, "github", "octo", "hello");
  await mkdir(wsDir, { recursive: true });
  await execa("git", ["init", "-q"], { cwd: wsDir });
  await execa("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: wsDir });
  // The task files live outside the workspace and go away with it, as in a session.
  tasksDir = path.join(wsDir, "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(path.join(tasksDir, "1.json"), JSON.stringify({ id: "1", content: "# Base", dependencies: [] }));
  await writeFile(path.join(tasksDir, "2.json"), JSON.stringify({ id: "2", content: "# Feature", dependencies: ["1"] }));
  runDir = path.join(wsDir, ".graph-execution", "r1");
  await mkdir(runDir, { recursive: true });
  await writeState();
  await put("run.log", `${logLines.join("\n")}\n`);
  await put("logs/task-1.log", "task one log\n");
  await put("reports/round1/reviewer.json", '{"verdict":"ok"}');
  await put("reports/round1/tester.json", '{"notes":"tester notes"}');
  await put("worktrees/integration/big.txt", "not archived");
  home = workspaceHome(resolveWorkspace(t.config.workspacesDir, WS)!);
  blobs = new FolderBlobStore(path.join(t.config.dataDir, "blobs"));
  archive = new SqlRunArchive(t.db, blobs);
});

afterEach(async () => {
  await t.cleanup();
});

const get = (url: string) => t.app.inject({ method: "GET", url, headers: { cookie: t.cookie } });

async function blobPaths(): Promise<string[]> {
  const stream = await blobs.get(runBlobKey("admin", WS, "r1"));
  return readTarGz(await readAll(stream!)).map((e) => e.path);
}

describe("run archive", () => {
  it("a run archived at session end is listed and opens read-only, including a task log and the review notes from the folder blob", async () => {
    expect(await archiveRun(t.app.ctx.runArchive, ADMIN_USER, home, "r1", { dataDir: t.config.dataDir })).toBe(true);
    const blobFile = path.join(t.config.dataDir, "blobs", "runs", "admin", WS, "r1.tar.gz");
    expect(existsSync(blobFile)).toBe(true);
    await rm(wsDir, { recursive: true, force: true });

    const list = await get("/api/runs");
    expect(list.statusCode).toBe(200);
    const runs = (list.json() as { runs: { id: string; archived?: boolean; status: string; live: boolean }[] }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: "r1", archived: true, status: "failed", live: false });

    const res = await get(`/api/runs/${WS}/r1`);
    expect(res.statusCode).toBe(200);
    const d = res.json() as { archived: boolean; graph: { nodes: { id: string }[] }; logTail: string; files: string[]; landed?: unknown; tasks: unknown[] };
    expect(d.archived).toBe(true);
    expect(d.graph.nodes.map((n) => n.id)).toEqual(["1", "2"]);
    expect(d.logTail).toBe(logLines.slice(-200).join("\n"));
    expect(d.files).toContain("logs/task-1.log");
    expect(d.files).toContain("reports/round1/reviewer.json");
    expect(d.files).not.toContain("gm-detail.json");
    expect(d.files.some((f) => f.startsWith("worktrees/") || f.includes("/worktrees/"))).toBe(false);
    expect(d.landed).toBeUndefined();
    expect(d.tasks).toHaveLength(2);

    const log = await get(`/api/runs/${WS}/r1/archive/file?path=logs/task-1.log`);
    expect(log.statusCode).toBe(200);
    expect(log.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(log.headers["cache-control"]).toBe("no-store");
    expect(log.body).toBe("task one log\n");
    const notes = await get(`/api/runs/${WS}/r1/archive/file?path=${encodeURIComponent("reports/round1/tester.json")}`);
    expect(notes.statusCode).toBe(200);
    expect(notes.headers["content-type"]).toMatch(/^application\/json/);
    expect(notes.body).toBe('{"notes":"tester notes"}');
    expect((await get(`/api/runs/${WS}/r1/archive/file?path=worktrees/integration/big.txt`)).statusCode).toBe(404);
    expect((await get(`/api/runs/${WS}/r1/archive/file?path=nope.txt`)).json()).toEqual({ error: "file not in the archive" });
    const escape = await get(`/api/runs/${WS}/r1/archive/file?path=../state.json`);
    expect(escape.statusCode).toBe(400);
    expect(escape.json()).toEqual({ error: "invalid path" });
    expect((await get(`/api/runs/${WS}/r1/archive/file?path=/etc/passwd`)).statusCode).toBe(400);
    expect((await get(`/api/runs/${WS}/r1/archive/file`)).statusCode).toBe(400);
    expect((await get(`/api/runs/${WS}/r2/archive/file?path=run.log`)).statusCode).toBe(404);
    expect((await get(`/api/runs/${WS}/r2`)).json()).toEqual({ error: "unknown workspace" });
  });

  it("keeps the blob private (mode 600)", async () => {
    if (process.platform === "win32") return;
    await archiveRun(archive, ADMIN_USER, home, "r1", { dataDir: t.config.dataDir });
    const { stat } = await import("node:fs/promises");
    const st = await stat(path.join(t.config.dataDir, "blobs", "runs", "admin", WS, "r1.tar.gz"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("never shows a user another user's archived runs", async () => {
    await archiveRun(archive, ADMIN_USER, home, "r1", { dataDir: t.config.dataDir });
    expect(await archive.list(U2)).toEqual([]);
    expect(await archive.get(U2, WS, "r1")).toBeUndefined();
    expect(await archive.openFile(U2, WS, "r1", "run.log")).toBeUndefined();
    expect(await archive.list(ADMIN_USER)).toHaveLength(1);
  });

  it("archives a resumed run again when it ends", async () => {
    await archiveRun(archive, ADMIN_USER, home, "r1", { dataDir: t.config.dataDir });
    // Resumed: state.json says running and a live process holds the lock.
    await writeState({ status: "running" });
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
    const save = vi.spyOn(archive, "saveFolder");
    try {
      await writeFile(path.join(runDir, "lock"), `${child.pid}\ntok\n${os.hostname()}\n`);
      await archiveRun(archive, ADMIN_USER, home, "r1", { dataDir: t.config.dataDir });
    } finally {
      child.kill();
    }
    expect(save).not.toHaveBeenCalled();
    expect((await archive.list(ADMIN_USER))[0]?.status).toBe("running");
    expect(await blobPaths()).not.toContain("logs/task-2.log");

    await rm(path.join(runDir, "lock"));
    await writeState({ status: "applied" });
    await put("logs/task-2.log", "task two\n");
    await archiveRun(archive, ADMIN_USER, home, "r1", { dataDir: t.config.dataDir });
    expect(save).toHaveBeenCalledTimes(1);
    expect((await archive.list(ADMIN_USER))[0]?.status).toBe("applied");
    expect(await blobPaths()).toContain("logs/task-2.log");
  });

  it("RunArchiver archives an ended run on its own, and skips it when nothing changed", async () => {
    const owner = vi.fn(() => Promise.resolve(true));
    const archiver = new RunArchiver({
      archive,
      store: t.stores,
      workspacesDir: t.config.workspacesDir,
      dataDir: t.config.dataDir,
      users: () => Promise.resolve([ADMIN_USER]),
      owns: owner,
    });
    const save = vi.spyOn(archive, "saveFolder");
    await archiver.tick();
    expect(owner).toHaveBeenCalledWith(ADMIN_USER, WS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(await blobPaths()).toContain("logs/task-1.log");
    await archiver.tick();
    expect(save).toHaveBeenCalledTimes(1);
    await archiver.stop();
  });

  it("RunArchiver archives a clone's runs only under the users who own it", async () => {
    const bob: User = { id: "bob", name: "bob" };
    const archiver = new RunArchiver({
      archive,
      store: t.stores,
      workspacesDir: t.config.workspacesDir,
      dataDir: t.config.dataDir,
      users: () => Promise.resolve([ADMIN_USER, bob]),
      owns: (u) => Promise.resolve(u.id === "bob"),
    });
    await archiver.tick();
    await archiver.stop();
    expect(await archive.list(ADMIN_USER)).toEqual([]);
    expect(await archive.list(bob)).toHaveLength(1);
    expect(existsSync(path.join(t.config.dataDir, "blobs", "runs", "bob", WS, "r1.tar.gz"))).toBe(true);
  });

  it("a gateway user id that is not a safe key segment is encoded in the blob key", async () => {
    const u: User = { id: "auth0|6512ab", name: "g" };
    expect(runBlobKey(u.id, WS, "r1")).toBe(`runs/~${Buffer.from(u.id).toString("base64url")}/${WS}/r1.tar.gz`);
    await archiveRun(archive, u, home, "r1", { dataDir: t.config.dataDir });
    const got = await archive.get(u, WS, "r1");
    expect(got?.files).toContain("logs/task-1.log");
    await archive.deleteUser(u.id);
    expect(await archive.list(u)).toEqual([]);
    expect(existsSync(path.join(t.config.dataDir, "blobs", "runs", `~${Buffer.from(u.id).toString("base64url")}`))).toBe(false);
  });

  it("deleteUser removes the user's rows and blobs", async () => {
    await archiveRun(archive, ADMIN_USER, home, "r1", { dataDir: t.config.dataDir });
    await archive.deleteUser("admin");
    expect(await archive.list(ADMIN_USER)).toEqual([]);
    expect(existsSync(path.join(t.config.dataDir, "blobs", "runs", "admin"))).toBe(false);
  });

  it("deleting a user through the user lifecycle removes their archived runs", async () => {
    const u: User = { id: "u3", name: "u3" };
    await archiveRun(t.app.ctx.runArchive, u, home, "r1", { dataDir: t.config.dataDir });
    await archiveRun(t.app.ctx.runArchive, ADMIN_USER, home, "r1", { dataDir: t.config.dataDir });
    expect(await t.app.ctx.runArchive.list(u)).toHaveLength(1);
    await t.app.ctx.userLifecycle.deleted("u3");
    expect(await t.app.ctx.runArchive.list(u)).toEqual([]);
    expect(existsSync(path.join(t.config.dataDir, "blobs", "runs", "u3"))).toBe(false);
    expect(await t.app.ctx.runArchive.list(ADMIN_USER)).toHaveLength(1);
    expect(existsSync(path.join(t.config.dataDir, "blobs", "runs", "admin", WS, "r1.tar.gz"))).toBe(true);
  });

  it("archiveRun is false for a run that does not exist", async () => {
    expect(await archiveRun(archive, ADMIN_USER, home, "nope", { dataDir: t.config.dataDir })).toBe(false);
  });
});
