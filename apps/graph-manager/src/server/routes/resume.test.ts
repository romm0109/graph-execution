// Resume and Stop sandbox through the API (KAN-88), against the fake Docker without exec: a started container only
// writes the ready file, so no engine runs here.
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDocker, startFakeDocker } from "../../../scripts/fake-docker.mjs";
import { DockerClient } from "../docker.js";
import { Sandboxes, type ToolsMount } from "../sandbox.js";
import { appWithLogin } from "../test-helpers.js";

const WS = "github~octo~hello";
const ID = "gm-20260101-000000-abcd";

let fake: FakeDocker;
let ctx: Awaited<ReturnType<typeof appWithLogin>> | undefined;
let wsDir: string;
let runDir: string;

async function setup(): Promise<NonNullable<typeof ctx>> {
  ctx = await appWithLogin({ dockerSocket: fake.socketPath, sandboxImage: "img:1" });
  wsDir = path.join(ctx.config.workspacesDir, "github", "octo", "hello");
  await mkdir(wsDir, { recursive: true });
  await execa("git", ["init", "-q", "-b", "main"], { cwd: wsDir });
  runDir = path.join(wsDir, ".graph-execution", ID);
  await mkdir(runDir, { recursive: true });
  return ctx;
}

async function writeState(extra: Record<string, unknown> = {}): Promise<void> {
  const state = {
    runId: ID,
    provider: "fake",
    startingCommit: "0".repeat(40),
    integrationBranch: `graph/${ID}`,
    specPath: path.join(wsDir, "spec.md"),
    tasksDir: path.join(wsDir, "diamond"),
    hashes: { config: "", tasks: "", spec: "" },
    tasks: { "1": { status: "pending", attempts: 0 } },
    review: { phase: "validate", round: 0, validationRounds: 0, reports: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "aborted",
    ...extra,
  };
  await writeFile(path.join(runDir, "state.json"), JSON.stringify(state));
}

const post = (c: NonNullable<typeof ctx>, url: string) => c.app.inject({ method: "POST", url, headers: { cookie: c.cookie } });
const resume = (c: NonNullable<typeof ctx>, id = ID) => post(c, `/api/runs/${WS}/${id}/resume`);

/** A container without a network (its page is not reachable) and a record for it; running unless `stopped`. */
async function oldSandbox(c: NonNullable<typeof ctx>, { stopped = false } = {}): Promise<string> {
  const docker = new DockerClient(fake.socketPath);
  const id = await docker.createContainer(`old-${ID}`, { Image: "img:old", Cmd: ["sleep", "infinity"] });
  await docker.startContainer(id);
  // No network: its page is unreachable, so the run is not live.
  const ct = fake.containers.get(id);
  if (ct) ct.networks = [];
  if (stopped) await docker.stopContainer(id, 0);
  await c.store.update((d) => {
    d.sandboxes[`${WS}/${ID}`] = { runId: ID, workspace: WS, container: id, name: `old-${ID}`, host: "sbx-old", image: "img:old", port: 7600, startedAt: "2026-01-01T00:00:00.000Z" };
  });
  return id;
}

beforeEach(async () => {
  fake = await startFakeDocker();
  vi.spyOn(Sandboxes.prototype as unknown as { prepareTools: () => Promise<string | undefined> }, "prepareTools").mockImplementation(async function (
    this: { mount?: ToolsMount },
  ) {
    this.mount = { Type: "bind", Source: "/tmp/gm-tools", Target: "/opt/gm-tools", ReadOnly: true };
    return undefined;
  });
  vi.spyOn(Sandboxes.prototype as unknown as { buildImages: () => Promise<{ image: string; clisVolume: string }> }, "buildImages").mockImplementation(async function (
    this: { opts: { config: { sandboxImage?: string } } },
  ) {
    // The built image is the recipe's base here: these tests start containers of a known image.
    // The CLI volume start() checks for (review F5); empty is enough for the fake provider.
    await (this as unknown as { docker: { createVolume(n: string): Promise<unknown> } }).docker.createVolume("gm-clis-test");
    return { image: this.opts.config.sandboxImage ?? "node:24.22.1-bookworm", clisVolume: "gm-clis-test" };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = undefined;
  await fake.close();
});

describe("POST /api/runs/:ws/:runId/resume", () => {
  it("answers 404 for an unknown run, 400 for a suite and an invalid id", async () => {
    const c = await setup();
    expect((await resume(c)).statusCode).toBe(404);
    expect((await resume(c, ".bad")).statusCode).toBe(400);
    expect((await post(c, `/api/runs/nope/${ID}/resume`)).statusCode).toBe(404);
    await writeFile(path.join(runDir, "suite.json"), "{}");
    const suite = await resume(c);
    expect(suite.statusCode).toBe(400);
    expect(suite.json<{ error: string }>().error).toBe("suites are resumed from a terminal");
  });

  it("answers 404 for an invalid state.json and 409 for a finished run", async () => {
    const c = await setup();
    await writeFile(path.join(runDir, "state.json"), "{ nope");
    expect((await resume(c)).statusCode).toBe(404);
    await writeState({ status: "applied" });
    const res = await resume(c);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("the run already finished (applied)");
  });

  it("resumes a sandboxed run in a new container that may take over the old lock", async () => {
    const c = await setup();
    await writeState({ sandbox: { image: "img:state" } });
    await writeFile(path.join(runDir, "lock"), "1\nt\nsbx-old\nsandbox\n");
    const res = await resume(c);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ runId: ID, viewUrl: `/runs/${WS}/${ID}/view/` });
    const create = fake.requests.find((r) => r.method === "POST" && r.path === "/containers/create");
    const body = create?.body as { Image: string; Cmd: string[]; Env: string[] };
    expect(body.Image).toBe("img:state");
    expect(body.Cmd).toEqual(expect.arrayContaining(["--resume", "--run", ID, "--web-serve"]));
    expect(body.Env).toContain("GRAPH_EXECUTION_TAKE_LOCK_FROM=sbx-old");
    expect(body.Env).toContain("GRAPH_EXECUTION_SANDBOX=1");
    expect(c.store.get().sandboxes[`${WS}/${ID}`]?.name).toBe(`gm-run-${ID}`);

    // Now live: a second resume is refused.
    const again = await resume(c);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string }>().error).toBe("the run is live");
  });

  it("refuses while the old container still runs, removes a stopped one and goes on", async () => {
    const c = await setup();
    await writeState();
    const running = await oldSandbox(c);
    const res = await resume(c);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("the run's sandbox is still running");
    expect(fake.containers.has(running)).toBe(true);

    await new DockerClient(fake.socketPath).removeContainer(running);
    await c.store.update((d) => {
      delete d.sandboxes[`${WS}/${ID}`];
    });
    const stopped = await oldSandbox(c, { stopped: true });
    const ok = await resume(c);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(fake.containers.has(stopped)).toBe(false);
    expect([...fake.containers.values()].map((ct) => ct.Name)).toEqual([`/gm-run-${ID}`]);
    // The state has no image: the default one is used.
    expect([...fake.containers.values()][0]?.Config.Image).toBe("img:1");
  });
});

describe("resume of a sandboxed project run", () => {
  it("starts a new container with the suite's image and every repo mounted", async () => {
    const c = await setup();
    const repoDir = (n: string) => path.join(c.config.workspacesDir, "github", "acme", n);
    for (const r of ["api", "web"]) {
      await mkdir(repoDir(r), { recursive: true });
      await execa("git", ["init", "-q", "-b", "main"], { cwd: repoDir(r) });
    }
    const projDir = path.join(c.config.workspacesDir, ".projects", "billing");
    await mkdir(path.join(projDir, "repos"), { recursive: true });
    await execa("git", ["init", "-q", "-b", "main"], { cwd: projDir });
    for (const r of ["api", "web"]) await symlink(repoDir(r), path.join(projDir, "repos", r), process.platform === "win32" ? "junction" : "dir");
    await writeFile(path.join(projDir, "project.json"), JSON.stringify({ name: "billing", repos: [{ name: "api", path: "repos/api" }, { name: "web", path: "repos/web" }] }));
    await c.store.update((d) => {
      d.projects.billing = { name: "billing", workspaces: ["github~acme~api", "github~acme~web"], createdAt: "2026-11-13T00:00:00.000Z" };
    });
    const id = "suite-gm-20261113-120000-abcd";
    const suiteDir = path.join(projDir, ".graph-execution", id);
    await mkdir(suiteDir, { recursive: true });
    const repo = (name: string) => ({ name, path: repoDir(name), startingCommit: "0".repeat(40), startBranch: "main" });
    await writeFile(
      path.join(suiteDir, "suite.json"),
      JSON.stringify({
        suiteId: id,
        status: "failed",
        provider: "fake",
        concurrency: 2,
        startingCommit: "0".repeat(40),
        merge: true,
        features: [{ name: "api", tasksDir: path.join(projDir, "tasks", "api"), prd: path.join(suiteDir, "specs", "api.md"), runId: "r1", status: "failed", repo: repo("api") }],
        integration: { merged: [] },
        project: { dir: projDir, name: "billing", contract: path.join(projDir, "contract.md") },
        repos: [repo("api"), repo("web")],
        sandbox: { image: "img:old" },
        createdAt: "2026-11-13T12:00:00.000Z",
      }),
    );
    await writeFile(path.join(suiteDir, "lock"), "1\nt\nsbx-old\nsandbox\n");
    const res = await post(c, `/api/runs/project~billing/${id}/resume`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ runId: id, viewUrl: `/runs/project~billing/${id}/view/` });
    const ct = [...fake.containers.values()][0]!;
    expect(ct.Config.Image).toBe("img:old");
    expect(ct.Config.Cmd.slice(-5)).toEqual(["suite", "--resume", "--run", id, "--web-serve"]);
    expect(ct.Config.Labels).toEqual({ "gm.run": id, "gm.workspace": "project~billing" });
    expect(ct.Config.Env).toContain("GRAPH_EXECUTION_TAKE_LOCK_FROM=sbx-old");
    expect(ct.HostConfig.Mounts.map((m: { Source: string }) => m.Source)).toEqual(expect.arrayContaining([projDir, repoDir("api"), repoDir("web")]));
    expect(c.store.get().sandboxes[`project~billing/${id}`]?.name).toBe(`gm-run-${id}`);
  });
});

describe("POST /api/runs/:ws/:runId/sandbox/stop", () => {
  it("stops the run's container; 404 without a record", async () => {
    const c = await setup();
    await writeState();
    expect((await post(c, `/api/runs/${WS}/${ID}/sandbox/stop`)).statusCode).toBe(404);
    const id = await oldSandbox(c);
    const res = await post(c, `/api/runs/${WS}/${ID}/sandbox/stop`);
    expect(res.statusCode).toBe(204);
    expect(fake.requests.some((r) => r.method === "POST" && r.path === `/containers/${id}/stop`)).toBe(true);
    expect(fake.containers.get(id)?.State.Running).toBe(false);
  });
});
