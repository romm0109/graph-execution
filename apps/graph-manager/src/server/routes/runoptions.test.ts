import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserStore } from "../store.js";
import { appWithLogin, tempDir } from "../test-helpers.js";

const WS = "github~octo~hello";
const FAKE_BIN = `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./argv.json", import.meta.url), JSON.stringify(process.argv.slice(2)));
console.log("Started run gm-20261107-120000-abcd in the background: http://127.0.0.1:1/");
`;
const HEAD = ["diamond", "--spec", "spec.md", "--provider", "fake"];

let app: FastifyInstance;
let cookie: string;
let store: UserStore;
let argvFile: string;
let cleanups: (() => Promise<void>)[];

beforeEach(async () => {
  const bin = await tempDir();
  const fake = path.join(bin.dir, "fake-ge.mjs");
  await writeFile(fake, FAKE_BIN);
  argvFile = path.join(bin.dir, "argv.json");
  const ctx = await appWithLogin({ graphExecutionBin: fake });
  ({ app, cookie, store } = ctx);
  cleanups = [ctx.cleanup, bin.cleanup];
  const wsDir = path.join(ctx.config.workspacesDir, "github", "octo", "hello");
  await mkdir(path.join(wsDir, ".git"), { recursive: true });
  await mkdir(path.join(wsDir, "diamond"), { recursive: true });
  await writeFile(path.join(wsDir, "spec.md"), "# spec");
});

afterEach(async () => {
  for (const c of cleanups) await c();
});

async function start(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  await rm(argvFile, { force: true });
  const res = await app.inject({ method: "POST", url: `/api/runs/${WS}`, headers: { cookie }, payload: body as Record<string, unknown> });
  return { status: res.statusCode, body: res.json() };
}

async function argv(): Promise<string[]> {
  return JSON.parse(await readFile(argvFile, "utf8")) as string[];
}

async function defaults(id = WS, withCookie = true): Promise<{ status: number; body: unknown }> {
  const res = await app.inject({ method: "GET", url: `/api/workspaces/${id}/run-defaults`, headers: withCookie ? { cookie } : {} });
  return { status: res.statusCode, body: res.json() };
}

const base = { tasksDir: "diamond", spec: "spec.md", provider: "fake" };

describe("POST /api/runs/:ws options", () => {
  it("turns the options into flags (KAN-89 acceptance)", async () => {
    const res = await start({ ...base, options: { humanReview: true, merge: false, fixPasses: 2 } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await argv()).toEqual([...HEAD, "--no-merge", "--human-review", "--fix-passes", "2", "--web"]);
  });

  it("keeps the top-level concurrency, and options.concurrency wins", async () => {
    expect((await start({ ...base, concurrency: 3, options: { concurrency: 5 } })).status).toBe(201);
    const both = await argv();
    expect(both.filter((a) => a === "--concurrency")).toHaveLength(1);
    expect(both).toEqual([...HEAD, "--concurrency", "5", "--web"]);
    expect((await start({ ...base, concurrency: 3 })).status).toBe(201);
    expect(await argv()).toEqual([...HEAD, "--concurrency", "3", "--web"]);
  });

  it("refuses reserved extra arguments without spawning, and passes quoted words", async () => {
    const web = await start({ ...base, options: { extraArgs: "--web" } });
    expect(web.status).toBe(400);
    expect(web.body).toEqual({ error: "extra arguments: --web is set by graph-manager" });
    expect(existsSync(argvFile)).toBe(false);
    const spec = await start({ ...base, options: { extraArgs: "--spec x.md" } });
    expect(spec.status).toBe(400);
    expect(spec.body).toEqual({ error: "extra arguments: --spec is set by graph-manager" });
    const quoted = await start({ ...base, options: { extraArgs: "--model 'a b'" } });
    expect(quoted.status).toBe(201);
    expect(await argv()).toEqual([...HEAD, "--model", "a b", "--web"]);
  });

  it("refuses unknown keys and out-of-range numbers", async () => {
    expect((await start({ ...base, options: { bogus: true } })).status).toBe(400);
    expect((await start({ ...base, options: { attempts: 0 } })).status).toBe(400);
    expect(existsSync(argvFile)).toBe(false);
  });
});

describe("GET /api/workspaces/:id/run-defaults", () => {
  it("returns {} before a start and the last successful start's choices after", async () => {
    expect(await defaults()).toEqual({ status: 200, body: {} });
    expect((await start({ ...base, options: { humanReview: true, merge: false, fixPasses: 2 } })).status).toBe(201);
    const saved = { provider: "fake", tasksDir: "diamond", spec: "spec.md", options: { humanReview: true, merge: false, fixPasses: 2 } };
    expect(await defaults()).toEqual({ status: 200, body: saved });
    expect((await start({ ...base, options: { extraArgs: "--web" } })).status).toBe(400);
    expect((await start({ ...base, options: { attempts: 0 } })).status).toBe(400);
    expect(await defaults()).toEqual({ status: 200, body: saved });
    expect(store.get().runDefaults[WS]).toEqual(saved);
  });

  it("answers 404 for an unknown workspace and 401 without the cookie", async () => {
    expect((await defaults("github~octo~missing")).status).toBe(404);
    expect((await defaults(WS, false)).status).toBe(401);
  });
});
