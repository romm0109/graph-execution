import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SuiteControl } from "./control.js";
import { gitOut, tempRepo } from "../__fixtures__/repo.js";
import { startHumanRound } from "../review/human.js";
import { RunEmitter } from "../runner/events.js";
import { RetryHub } from "../runner/retry-hub.js";
import { createSuiteServer, type SuiteServer } from "./server.js";

const rawRequest = (port: number, opts: http.RequestOptions): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...opts }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function setup(running = false): Promise<{ server: SuiteServer; control: SuiteControl; state: { running: boolean }; hooks: { aborts: number; closes: number } }> {
  const dir = await mkdtemp(path.join(tmpdir(), "suite-server-"));
  // Feature a has a real task folder (1 <- 2); b's folder is missing, so its graph is empty.
  await mkdir(path.join(dir, "tasks-a"));
  await writeFile(path.join(dir, "tasks-a", "1.json"), JSON.stringify({ id: "1", content: "one", dependencies: [] }));
  await writeFile(path.join(dir, "tasks-a", "2.json"), JSON.stringify({ id: "2", content: "two", dependencies: ["1"] }));
  const feature = (name: string, status: string) => ({ name, tasksDir: name === "a" ? path.join(dir, "tasks-a") : `/t/${name}`, prd: `/p/${name}.md`, runId: `run-${name}`, status, share: 1 });
  await writeFile(
    path.join(dir, "suite.json"),
    JSON.stringify({
      suiteId: "suite-x",
      status: "running",
      provider: "fake",
      concurrency: 2,
      startingCommit: "abc",
      merge: false,
      features: [feature("a", "done"), feature("b", "failed")],
      integration: { merged: [] },
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  const runDir = path.join(dir, "features", "run-a");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "state.json"),
    JSON.stringify({
      runId: "run-a",
      provider: "fake",
      startingCommit: "abc",
      integrationBranch: "graph/run-a",
      specPath: "/p/a.md",
      tasksDir: "/t/a",
      hashes: { config: "", spec: "x", tasks: "y" },
      tasks: { "1": { status: "merged", attempts: 1 }, "2": { status: "running", attempts: 2 } },
      review: { phase: "review", round: 1, validationRounds: 0, reports: {} },
      createdAt: "2026-01-01T00:00:00Z",
      status: "running",
    }),
  );
  const control = new SuiteControl();
  control.setAllowed({ retry: [], integrate: false, retryIntegration: false }, ["a", "b"]);
  const state = { running };
  const hooks = { aborts: 0, closes: 0 };
  const server = await createSuiteServer({
    suiteDir: dir,
    control,
    isRunning: () => state.running,
    onAbort: () => void hooks.aborts++,
    onClose: () => void hooks.closes++,
    pageFile: path.join(dir, "page.html"),
  });
  await writeFile(path.join(dir, "page.html"), "<html>suite</html>");
  cleanups.push(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { server, control, state, hooks };
}

const post = (server: SuiteServer, p: string): Promise<Response> =>
  fetch(`${server.url}${p}`, { method: "POST", headers: { origin: server.url.slice(0, -1) } });

describe("createSuiteServer", () => {
  it("serves the page and the lanes with their tasks", async () => {
    const { server } = await setup();
    expect(await (await fetch(server.url)).text()).toContain("suite");
    const body = (await (await fetch(`${server.url}api/suite`)).json()) as {
      suite: { suiteId: string };
      features: { name: string; tasks: { id: string; status: string; attempts: number }[]; reviewPhase?: string; share: number }[];
      allowed: object;
      running: boolean;
    };
    expect(body.suite.suiteId).toBe("suite-x");
    expect(body.running).toBe(false);
    expect(body.features.map((f) => f.name)).toEqual(["a", "b"]);
    expect(body.features[0]!.tasks).toEqual([
      { id: "1", status: "merged", attempts: 1 },
      { id: "2", status: "running", attempts: 2 },
    ]);
    expect(body.features[0]!.reviewPhase).toBe("review");
    expect(body.features[1]!.tasks).toEqual([]);
  });

  it("sends each feature's task graph so the page draws it", async () => {
    const { server } = await setup();
    const body = (await (await fetch(`${server.url}api/suite`)).json()) as { features: { layers: string[][]; parents: Record<string, string[]> }[] };
    expect(body.features[0]!.layers).toEqual([["1"], ["2"]]);
    expect(body.features[0]!.parents).toEqual({ "1": [], "2": ["1"] });
    expect(body.features[1]!.layers).toEqual([]);
  });

  it("retries a failed feature, refuses others, 404s unknown names", async () => {
    const { server, control } = await setup();
    expect((await post(server, "api/features/b/retry")).status).toBe(409);
    control.setAllowed({ retry: ["b"], integrate: false, retryIntegration: false }, ["a", "b"]);
    expect((await post(server, "api/features/b/retry")).status).toBe(200);
    expect(await control.next()).toEqual({ retry: "b" });
    expect((await post(server, "api/features/a/retry")).status).toBe(409);
    expect((await post(server, "api/features/zzz/retry")).status).toBe(404);
  });

  it("starts and retries the integration only when allowed", async () => {
    const { server, control } = await setup();
    expect((await post(server, "api/integration/start")).status).toBe(409);
    expect((await post(server, "api/integration/retry")).status).toBe(409);
    control.setAllowed({ retry: [], integrate: true, retryIntegration: false });
    expect((await post(server, "api/integration/start")).status).toBe(200);
    expect(await control.next()).toEqual({ integrate: true });
    control.setAllowed({ retry: [], integrate: false, retryIntegration: true });
    expect((await post(server, "api/integration/retry")).status).toBe(200);
    expect(await control.next()).toEqual({ retryIntegration: true });
  });

  it("guards Host and Origin", async () => {
    const { server } = await setup();
    expect((await rawRequest(server.port, { path: "/api/suite", headers: { host: "evil.example" } })).status).toBe(421);
    const res = await rawRequest(server.port, { method: "POST", path: "/api/abort", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("404s unknown paths and 405s wrong methods", async () => {
    const { server } = await setup();
    expect((await fetch(`${server.url}nope`)).status).toBe(404);
    expect((await fetch(`${server.url}api/suite`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${server.url}close`)).status).toBe(405);
  });

  it("aborts only while running, and refuses Close while running", async () => {
    const { server, state, hooks } = await setup(true);
    expect((await post(server, "close")).status).toBe(409);
    expect((await post(server, "api/abort")).status).toBe(200);
    expect(hooks.aborts).toBe(1);
    state.running = false;
    expect((await post(server, "api/abort")).status).toBe(409);
    expect(hooks.aborts).toBe(1);
  });

  it("closes after the response once the suite ended", async () => {
    const { server, hooks } = await setup();
    expect((await post(server, "close")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(hooks.closes).toBe(1);
    await expect(rawRequest(server.port, { path: "/api/suite" })).rejects.toThrow();
  });
});

describe("suite review routes", () => {
  async function reviewSetup(): Promise<{ server: SuiteServer; hub: RetryHub; events: RunEmitter; suiteDir: string }> {
    const repo = await tempRepo();
    const base = await gitOut(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
    await gitOut(repo, ["add", "-A"]);
    await gitOut(repo, ["commit", "-q", "-m", "second"]);
    const head = await gitOut(repo, ["rev-parse", "HEAD"]);
    const suiteDir = await mkdtemp(path.join(tmpdir(), "suite-review-"));
    const feature = (name: string) => ({ name, tasksDir: `/t/${name}`, prd: `/p/${name}.md`, runId: `run-${name}`, status: "done" });
    await writeFile(
      path.join(suiteDir, "suite.json"),
      JSON.stringify({
        suiteId: "suite-x",
        status: "integrating",
        provider: "fake",
        concurrency: 2,
        startingCommit: base,
        merge: true,
        humanReview: true,
        features: [feature("a"), feature("b")],
        integration: { merged: ["a", "b"] },
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    await startHumanRound(suiteDir, 1, base, head);
    const hub = new RetryHub();
    const events = new RunEmitter();
    const server = await createSuiteServer({
      suiteDir,
      control: new SuiteControl(),
      isRunning: () => true,
      review: { hub, events, suiteDir, repo },
    });
    cleanups.push(async () => {
      await server.close();
      await rm(suiteDir, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    });
    return { server, hub, events, suiteDir };
  }
  const send = (server: SuiteServer, method: string, p: string, body?: object): Promise<Response> =>
    fetch(`${server.url}${p}`, { method, headers: { origin: server.url.slice(0, -1), "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const suiteInfo = async (server: SuiteServer): Promise<{ reviewWaiting: boolean }> => (await (await fetch(`${server.url}api/suite`)).json()) as { reviewWaiting: boolean };

  it("refuses every review route while the suite is not waiting", async () => {
    const { server } = await reviewSetup();
    expect((await fetch(`${server.url}api/review`)).status).toBe(409);
    expect((await send(server, "POST", "api/review/comments", { body: "x" })).status).toBe(409);
    expect((await send(server, "POST", "api/review/drop")).status).toBe(409);
    expect((await suiteInfo(server)).reviewWaiting).toBe(false);
  });

  it("lists files, takes comments, requests changes and drops", async () => {
    const { server, hub, events } = await reviewSetup();
    events.emit("review:waiting", { round: 1, blocking: [] });
    expect((await suiteInfo(server)).reviewWaiting).toBe(true);
    const info = (await (await fetch(`${server.url}api/review`)).json()) as { files: { path: string }[] };
    expect(info.files.map((f) => f.path)).toEqual(["a.txt"]);
    const diff = await fetch(`${server.url}api/review/diff?file=a.txt`);
    expect(diff.status).toBe(200);
    expect((await fetch(`${server.url}api/review/diff?file=README.md`)).status).toBe(400);
    expect((await fetch(`${server.url}api/review/diff?file=../x`)).status).toBe(400);

    const waited = hub.waitReview();
    expect((await send(server, "POST", "api/review/changes")).status).toBe(409);
    expect((await send(server, "POST", "api/review/comments", { body: "fix it", file: "a.txt" })).status).toBe(201);
    expect((await send(server, "POST", "api/review/changes")).status).toBe(200);
    expect(await waited).toEqual({ review: "changes" });

    events.emit("review:waiting", { round: 2, blocking: [] });
    const dropped = hub.waitReview();
    expect((await send(server, "POST", "api/review/drop")).status).toBe(200);
    expect(await dropped).toEqual({ review: "drop" });
  });

  it("needs force to apply with open findings", async () => {
    const { server, hub, events } = await reviewSetup();
    const finding = { id: "F1", severity: "major" as const, description: "bad", status: "open" as const };
    events.emit("review:waiting", { round: 1, blocking: [finding] });
    const waited = hub.waitReview();
    expect((await send(server, "POST", "api/review/apply", {})).status).toBe(409);
    expect((await send(server, "POST", "api/review/apply", { force: true })).status).toBe(200);
    expect(await waited).toEqual({ review: "apply", force: true });
  });

  it("keeps the Host and Origin guards on the review routes", async () => {
    const { server } = await reviewSetup();
    expect((await rawRequest(server.port, { path: "/api/review", headers: { host: "evil.example" } })).status).toBe(421);
    expect((await rawRequest(server.port, { method: "POST", path: "/api/review/drop", headers: { origin: "https://evil.example" } })).status).toBe(403);
  });
});
