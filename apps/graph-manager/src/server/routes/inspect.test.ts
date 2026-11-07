import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appWithLogin } from "../test-helpers.js";
import type { WorkspaceInspection } from "./inspect.js";

const WS = "github~octo~hello";

let ctx: Awaited<ReturnType<typeof appWithLogin>>;
let wsDir: string;

async function git(...args: string[]): Promise<void> {
  await execa("git", args, { cwd: wsDir });
}

async function inspect(query: string, id = WS): Promise<{ status: number; body: WorkspaceInspection & { error?: string } }> {
  const res = await ctx.app.inject({ method: "GET", url: `/api/workspaces/${id}/inspect${query}`, headers: { cookie: ctx.cookie } });
  return { status: res.statusCode, body: res.json() };
}

beforeEach(async () => {
  ctx = await appWithLogin();
  wsDir = path.join(ctx.config.workspacesDir, "github", "octo", "hello");
  await mkdir(path.join(wsDir, "diamond"), { recursive: true });
  await git("init", "-q", "-b", "main");
  for (const n of ["1", "2", "3"]) await writeFile(path.join(wsDir, "diamond", `${n}.json`), JSON.stringify({ id: n, content: "x" }));
  await writeFile(path.join(wsDir, "diamond", "test-plan.json"), "{}");
  await writeFile(path.join(wsDir, "diamond", "notes.md"), "notes");
  await mkdir(path.join(wsDir, "diamond", "sub.json"));
  await writeFile(path.join(wsDir, "spec.md"), "# Spec");
  await git("add", ".");
  await git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
});

afterEach(async () => {
  await ctx.cleanup();
});

describe("GET /api/workspaces/:id/inspect", () => {
  it("gives the branch, the uncommitted files outside .graph-execution, the task files and the spec", async () => {
    await writeFile(path.join(wsDir, "spec.md"), "# Changed");
    await writeFile(path.join(wsDir, "new.txt"), "new");
    await mkdir(path.join(wsDir, ".graph-execution", "r1"), { recursive: true });
    await writeFile(path.join(wsDir, ".graph-execution", "r1", "state.json"), "{}");
    const { status, body } = await inspect("?tasksDir=diamond&spec=spec.md");
    expect(status).toBe(200);
    expect(body).toEqual({ branch: "main", changes: 2, tasksDir: { exists: true, taskFiles: 3 }, spec: { exists: true } });
  });

  it("reports missing paths, files given as folders and paths that escape the workspace as not existing", async () => {
    await writeFile(path.join(ctx.config.workspacesDir, "outside.md"), "# outside");
    await symlink(path.join(ctx.config.workspacesDir), path.join(wsDir, "escape"));
    expect((await inspect("?tasksDir=nope&spec=nope.md")).body).toMatchObject({ tasksDir: { exists: false, taskFiles: 0 }, spec: { exists: false } });
    expect((await inspect("?tasksDir=spec.md&spec=diamond")).body).toMatchObject({ tasksDir: { exists: false }, spec: { exists: false } });
    expect((await inspect("?tasksDir=../../..&spec=../../../outside.md")).body).toMatchObject({ tasksDir: { exists: false }, spec: { exists: false } });
    expect((await inspect(`?tasksDir=${encodeURIComponent(path.join(wsDir, "diamond"))}`)).body.tasksDir).toEqual({ exists: false, taskFiles: 0 });
    expect((await inspect("?spec=escape/outside.md")).body.spec).toEqual({ exists: false });
  });

  it("leaves out the paths it was not asked about, and has no changes on a clean tree", async () => {
    const { body } = await inspect("");
    expect(body).toEqual({ branch: "main", changes: 0 });
  });

  it("answers 404 for an unknown workspace and needs the login", async () => {
    expect((await inspect("", "github~octo~missing")).status).toBe(404);
    const res = await ctx.app.inject({ method: "GET", url: `/api/workspaces/${WS}/inspect` });
    expect(res.statusCode).toBe(401);
  });
});
