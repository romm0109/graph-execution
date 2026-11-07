import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appWithLogin } from "../test-helpers.js";
import { MAX_SPEC_BYTES, type SpecEntry } from "./specs.js";

const WS = "github~octo~hello";

let ctx: Awaited<ReturnType<typeof appWithLogin>>;
let wsDir: string;
let prd: string;

async function get(url: string, cookie = true): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({ method: "GET", url, headers: cookie ? { cookie: ctx.cookie } : {} });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
}

const file = (p: string): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }> =>
  get(`/api/workspaces/${WS}/specs/file?path=${encodeURIComponent(p)}`);

async function writeAt(rel: string, text: string, seconds: number): Promise<void> {
  const full = path.join(wsDir, rel);
  await writeFile(full, text);
  await utimes(full, seconds, seconds);
}

beforeEach(async () => {
  ctx = await appWithLogin();
  wsDir = path.join(ctx.config.workspacesDir, "github", "octo", "hello");
  prd = path.join(wsDir, "docs", "prd");
  await mkdir(wsDir, { recursive: true });
  await execa("git", ["init", "-q", "-b", "main"], { cwd: wsDir });
});

afterEach(async () => {
  await ctx.cleanup();
});

describe("GET /api/workspaces/:id/specs", () => {
  it("needs the login and a known workspace", async () => {
    expect((await get(`/api/workspaces/${WS}/specs`, false)).status).toBe(401);
    expect((await get(`/api/workspaces/${WS}/specs/file?path=docs/prd/a.md`, false)).status).toBe(401);
    expect((await get("/api/workspaces/github~octo~missing/specs")).status).toBe(404);
    expect((await get("/api/workspaces/github~octo~missing/specs/file?path=docs/prd/a.md")).status).toBe(404);
  });

  it("lists nothing without docs/prd", async () => {
    const res = await get(`/api/workspaces/${WS}/specs`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ specs: [] });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("lists the .md files directly in docs/prd, newest first, with their titles", async () => {
    await mkdir(path.join(prd, "done"), { recursive: true });
    await mkdir(path.join(prd, "sub.md"));
    await writeAt("docs/prd/old.md", "intro\n# Old spec\n", 1_000);
    await writeAt("docs/prd/new.md", "# New spec\nbody", 3_000);
    await writeAt("docs/prd/plain.MD", "no heading here", 2_000);
    await writeAt("docs/prd/done/finished.md", "# Done", 4_000);
    await writeAt("docs/prd/notes.txt", "# Notes", 4_000);
    await writeFile(path.join(ctx.config.workspacesDir, "outside.md"), "# Outside");
    await symlink(path.join(ctx.config.workspacesDir, "outside.md"), path.join(prd, "link.md"));
    const res = await get(`/api/workspaces/${WS}/specs`);
    expect(res.status).toBe(200);
    const specs = res.body.specs as SpecEntry[];
    expect(specs.map((s) => [s.path, s.name, s.title])).toEqual([
      ["docs/prd/new.md", "new.md", "New spec"],
      ["docs/prd/plain.MD", "plain.MD", "plain"],
      ["docs/prd/old.md", "old.md", "Old spec"],
    ]);
    expect(specs[0]).toMatchObject({ mtimeMs: 3_000_000, size: "# New spec\nbody".length });
  });

  it("lists nothing when docs/prd is a symlink out of the workspace", async () => {
    const outside = path.join(ctx.config.workspacesDir, "elsewhere");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "x.md"), "# X");
    await mkdir(path.join(wsDir, "docs"), { recursive: true });
    await symlink(outside, prd);
    expect((await get(`/api/workspaces/${WS}/specs`)).body).toEqual({ specs: [] });
    expect((await file("docs/prd/x.md")).status).toBe(400);
  });
});

describe("GET /api/workspaces/:id/specs/file", () => {
  beforeEach(async () => {
    await mkdir(path.join(prd, "done"), { recursive: true });
    await writeAt("docs/prd/a.md", "# A\ntext", 5_000);
    await writeAt("docs/prd/done/old.md", "# Old", 5_000);
    await writeAt("docs/prd/notes.txt", "notes", 5_000);
  });

  it("returns the text and mtime of a spec", async () => {
    const res = await file("docs/prd/a.md");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: "docs/prd/a.md", text: "# A\ntext", mtimeMs: 5_000_000 });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((await file("./docs/prd/a.md")).body.path).toBe("docs/prd/a.md");
    expect((await file("docs\\prd\\a.md")).body.path).toBe("docs/prd/a.md");
  });

  it("refuses anything but a .md file directly in docs/prd", async () => {
    for (const p of ["../../x.md", "docs/prd/../../../x.md", "docs/prd/done/old.md", "/etc/passwd", "docs/prd/notes.txt", "docs/prd/", "a.md"]) {
      const res = await file(p);
      expect(res.status, p).toBe(400);
      expect(res.body).toEqual({ error: "path: must be a .md file in docs/prd/" });
    }
    expect((await get(`/api/workspaces/${WS}/specs/file`)).status).toBe(400);
  });

  it("answers 404 for a missing spec", async () => {
    const res = await file("docs/prd/nope.md");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "spec not found" });
  });

  it("refuses a symlink that escapes the workspace", async () => {
    await writeFile(path.join(ctx.config.workspacesDir, "outside.md"), "# secret");
    await symlink(path.join(ctx.config.workspacesDir, "outside.md"), path.join(prd, "link.md"));
    expect((await file("docs/prd/link.md")).status).toBe(400);
  });

  it("answers a dangling symlink like any other, so it does not reveal whether its target exists", async () => {
    await symlink(path.join(ctx.config.workspacesDir, "missing.md"), path.join(prd, "dangling.md"));
    expect((await file("docs/prd/dangling.md")).status).toBe(400);
  });

  it("answers 413 for a spec over 1 MiB", async () => {
    await writeFile(path.join(prd, "big.md"), "x".repeat(MAX_SPEC_BYTES + 1));
    const res = await file("docs/prd/big.md");
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "spec is larger than 1 MiB" });
    await writeFile(path.join(prd, "edge.md"), "x".repeat(MAX_SPEC_BYTES));
    expect((await file("docs/prd/edge.md")).status).toBe(200);
  });
});
