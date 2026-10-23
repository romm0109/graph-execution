import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function setup(running = false): Promise<{ server: SuiteServer; control: SuiteControl; state: { running: boolean }; hooks: { aborts: number; closes: number }; dir: string }> {
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
  return { server, control, state, hooks, dir };
}

const post = (server: SuiteServer, p: string): Promise<Response> =>
  fetch(`${server.url}${p}`, { method: "POST", headers: { origin: server.url.slice(0, -1) } });

describe("suite logs", () => {
  it("lists, streams and serves logs of the suite and of a feature run", async () => {
    const { server, dir } = await setup();
    await mkdir(path.join(dir, "logs"), { recursive: true });
    await mkdir(path.join(dir, "features", "run-a", "logs"), { recursive: true });
    await writeFile(path.join(dir, "logs", "code-r1.log"), "review\n");
    await writeFile(path.join(dir, "logs", "a.log"), "process\n");
    await writeFile(path.join(dir, "features", "run-a", "logs", "1.log"), "task\n");
    const get = async (p: string) => rawRequest(server.port, { path: p });
    expect(JSON.parse((await get("/api/logs")).body)).toEqual({ logs: [{ label: "code-r1", tail: "review\n" }] });
    expect(JSON.parse((await get("/api/logs?label=code")).body)).toEqual({ logs: [{ label: "code-r1", size: 7, tail: "review\n" }] });
    expect(JSON.parse((await get("/api/logs?feature=a")).body).logs.map((l: { label: string }) => l.label)).toEqual(["1"]);
    expect((await get("/api/logs?feature=zzz")).status).toBe(404);
    expect(JSON.parse((await get("/api/logs/1?full=1&feature=a")).body)).toMatchObject({ label: "1", text: "task\n", truncated: false });
    expect((await get("/api/logs/a?full=1")).status).toBe(404);
    expect((await rawRequest(server.port, { method: "POST", path: "/api/logs/stream" })).status).toBe(405);
    expect((await get("/api/logs/stream?feature=a&labels=../x")).status).toBe(400);

    const chunks: string[] = [];
    const req = http.get({ host: "127.0.0.1", port: server.port, path: "/api/logs/stream?feature=a&labels=1" }, (res) => res.on("data", (c) => chunks.push(String(c))));
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(path.join(dir, "features", "run-a", "logs", "1.log"), "task\nmore\n");
    const end = Date.now() + 2500;
    while (!chunks.join("").includes("event: log") && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    req.destroy();
    expect(chunks.join("")).toContain('data: {"label":"1","offset":5,"text":"more\\n"}');
  });
});

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

  it("shows the in-flight tasks of a feature whose run ended interrupted as stopped", async () => {
    const { server, dir } = await setup();
    // Feature b failed; its run was interrupted with task 2 running, which its state.json keeps for the resume.
    const saved = JSON.parse(await readFile(path.join(dir, "features", "run-a", "state.json"), "utf8")) as Record<string, unknown>;
    await mkdir(path.join(dir, "features", "run-b"), { recursive: true });
    await writeFile(path.join(dir, "features", "run-b", "state.json"), JSON.stringify({ ...saved, runId: "run-b", status: "aborted" }));
    const body = (await (await fetch(`${server.url}api/suite`)).json()) as { features: { tasks: { id: string; status: string }[] }[] };
    expect(body.features[1]!.tasks.map((t) => t.status)).toEqual(["merged", "stopped"]);
    expect(body.features[0]!.tasks.map((t) => t.status)).toEqual(["merged", "running"]);
  });

  it("refuses diffs of nodes without changes and of files outside a node's changes", async () => {
    const { server } = await setup();
    expect((await fetch(`${server.url}api/changes?node=${encodeURIComponent("@merge/a")}&file=x`)).status).toBe(404);
    expect((await fetch(`${server.url}api/changes?node=nope&file=x`)).status).toBe(404);
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

  it("serves shared assets and refuses traversal", async () => {
    const { server } = await setup();
    const css = await fetch(`${server.url}assets/theme.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect((await fetch(`${server.url}assets/%2e%2e/server.ts`)).status).toBe(404);
    expect((await fetch(`${server.url}assets/nope.css`)).status).toBe(404);
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
      review: { hub, events, suiteDir, repo, roots: {} },
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

  it("reviews a two-repo suite with prefixed paths", async () => {
    const roots: Record<string, string> = {};
    const range: Record<string, { diffBase: string; diffHead: string }> = {};
    for (const name of ["a", "b"]) {
      const repo = await tempRepo();
      const diffBase = await gitOut(repo, ["rev-parse", "HEAD"]);
      await writeFile(path.join(repo, `${name}.txt`), `${name} one\n`);
      await gitOut(repo, ["add", "-A"]);
      await gitOut(repo, ["commit", "-q", "-m", "second"]);
      roots[name] = repo;
      range[name] = { diffBase, diffHead: await gitOut(repo, ["rev-parse", "HEAD"]) };
      cleanups.push(() => rm(repo, { recursive: true, force: true }));
    }
    const suiteDir = await mkdtemp(path.join(tmpdir(), "suite-review-multi-"));
    cleanups.push(() => rm(suiteDir, { recursive: true, force: true }));
    await writeFile(
      path.join(suiteDir, "suite.json"),
      JSON.stringify({
        suiteId: "suite-x",
        status: "integrating",
        provider: "fake",
        concurrency: 2,
        startingCommit: range.a!.diffBase,
        merge: true,
        humanReview: true,
        features: [],
        integration: { merged: [] },
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    await startHumanRound(suiteDir, 1, range.a!.diffBase, range.a!.diffHead, range);
    const events = new RunEmitter();
    const server = await createSuiteServer({
      suiteDir,
      control: new SuiteControl(),
      isRunning: () => true,
      review: { hub: new RetryHub(), events, suiteDir, repo: roots.a!, roots },
    });
    cleanups.push(() => server.close());
    events.emit("review:waiting", { round: 1, blocking: [] });

    const info = (await (await fetch(`${server.url}api/review`)).json()) as { files: { path: string }[] };
    expect(info.files.map((f) => f.path)).toEqual(["a/a.txt", "b/b.txt"]);
    const diff = await fetch(`${server.url}api/review/diff?file=b/b.txt`);
    expect(diff.status).toBe(200);
    expect(JSON.stringify(await diff.json())).toContain("b one");
    expect((await fetch(`${server.url}api/review/diff?file=c/b.txt`)).status).toBe(400);
    expect((await fetch(`${server.url}api/review/diff?file=b/a.txt`)).status).toBe(400);
    expect((await send(server, "POST", "api/review/comments", { file: "b/b.txt", startLine: 1, body: "x" })).status).toBe(201);
    expect((await send(server, "POST", "api/review/comments", { file: "b/b.txt", startLine: 9, body: "x" })).status).toBe(400);
    expect((await send(server, "POST", "api/review/comments", { file: "c/b.txt", startLine: 1, body: "x" })).status).toBe(400);
  });

  it("refuses every review route while the suite is not waiting", async () => {
    const { server } = await reviewSetup();
    expect((await fetch(`${server.url}api/review`)).status).toBe(409);
    expect((await send(server, "POST", "api/review/comments", { body: "x" })).status).toBe(409);
    expect((await send(server, "POST", "api/review/drop")).status).toBe(409);
    expect((await suiteInfo(server)).reviewWaiting).toBe(false);
  });

  it("lists the files of a round", async () => {
    const { server, events } = await reviewSetup();
    expect((await fetch(`${server.url}api/review/files?round=1`)).status).toBe(409);
    events.emit("review:waiting", { round: 1, blocking: [] });
    const res = await fetch(`${server.url}api/review/files?round=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { round: number; files: { path: string }[] };
    expect(body.round).toBe(1);
    expect(body.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect((await fetch(`${server.url}api/review/files?round=2`)).status).toBe(400);
    expect((await fetch(`${server.url}api/review/files?round=x`)).status).toBe(400);
    expect((await send(server, "POST", "api/review/files?round=1")).status).toBe(405);
    expect(((await (await fetch(`${server.url}api/suite`)).json()) as { reviewRound: number }).reviewRound).toBe(1);
  });

  it("takes a range comment", async () => {
    const { server, events } = await reviewSetup();
    events.emit("review:waiting", { round: 1, blocking: [] });
    const res = await send(server, "POST", "api/review/comments", { file: "a.txt", side: "old", startLine: 2, endLine: 3, body: "x" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ side: "old", startLine: 2, endLine: 3 });
    const listed = (await (await fetch(`${server.url}api/review`)).json()) as { comments: object[] };
    expect(listed.comments).toMatchObject([{ file: "a.txt", side: "old", startLine: 2, endLine: 3 }]);
    expect((await send(server, "POST", "api/review/comments", { file: "a.txt", startLine: 3, endLine: 2, body: "x" })).status).toBe(400);
  });

  it("rejects a suggestion unless it is on the new side", async () => {
    const { server, events } = await reviewSetup();
    events.emit("review:waiting", { round: 1, blocking: [] });
    const body = "```suggestion\nx\n```";
    const bad = await send(server, "POST", "api/review/comments", { file: "a.txt", side: "old", startLine: 2, body });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "suggestion needs side new" });
    expect((await send(server, "POST", "api/review/comments", { file: "a.txt", side: "new", startLine: 2, body })).status).toBe(201);
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

  it("serves lines of the review round's changed files", async () => {
    const { server, events } = await reviewSetup();
    expect((await fetch(`${server.url}api/file?round=1&path=a.txt&from=1&to=2`)).status).toBe(409);
    events.emit("review:waiting", { round: 1, blocking: [] });
    const ok = await fetch(`${server.url}api/file?round=1&path=a.txt&from=1&to=5`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: "a.txt", from: 1, to: 2, lines: ["one", "two"], total: 2 });
    expect((await fetch(`${server.url}api/file?round=1&path=README.md&from=1&to=2`)).status).toBe(400);
    expect((await fetch(`${server.url}api/file?round=7&path=a.txt&from=1&to=2`)).status).toBe(404);
    expect((await fetch(`${server.url}api/file?round=1&path=a.txt&from=2&to=1`)).status).toBe(400);
    expect((await fetch(`${server.url}api/file?node=nope&path=a.txt&from=1&to=2`)).status).toBe(404);
    expect((await send(server, "POST", "api/file?round=1&path=a.txt&from=1&to=2")).status).toBe(405);
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

describe("suite page over several repos", () => {
  it("lists each repo's files per node, prefixed on @apply, and opens their diffs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "suite-multi-"));
    const repos = [] as { name: string; root: string; startingCommit: string }[];
    for (const name of ["a", "b"]) {
      const root = await tempRepo();
      const startingCommit = await gitOut(root, ["rev-parse", "HEAD"]);
      await gitOut(root, ["checkout", "-q", "-b", "suite/x"]);
      await gitOut(root, ["checkout", "-q", "-b", `graph/run-${name}`, startingCommit]);
      await writeFile(path.join(root, `${name}.txt`), `${name} line\n`);
      await gitOut(root, ["add", "-A"]);
      await gitOut(root, ["commit", "-q", "-m", `feature ${name}`]);
      await gitOut(root, ["checkout", "-q", "suite/x"]);
      await gitOut(root, ["merge", "--no-ff", "-q", "-m", `merge ${name}`, `graph/run-${name}`]);
      repos.push({ name, root, startingCommit });
    }
    const feature = (name: string) => ({ name, repo: name, tasksDir: `/t/${name}`, prd: `/p/${name}.md`, runId: `run-${name}`, status: "done", share: 1 });
    await writeFile(
      path.join(dir, "suite.json"),
      JSON.stringify({
        suiteId: "suite-x", status: "done", provider: "fake", concurrency: 2, startingCommit: repos[0]!.startingCommit, merge: true,
        repos, features: [feature("a"), feature("b")], integrationBranch: "suite/x", integration: { merged: ["a", "b"] }, createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    for (const n of ["a", "b"]) {
      await mkdir(path.join(dir, "features", `run-${n}`), { recursive: true });
      await writeFile(
        path.join(dir, "features", `run-${n}`, "state.json"),
        JSON.stringify({
          runId: `run-${n}`, provider: "fake", startingCommit: "abc", integrationBranch: `graph/run-${n}`, specPath: "/p", tasksDir: "/t",
          hashes: { config: "", spec: "x", tasks: "y" }, tasks: {}, review: { phase: "review", round: 1, validationRounds: 0, reports: {} },
          createdAt: "2026-01-01T00:00:00Z", status: "done",
        }),
      );
    }
    await writeFile(path.join(dir, "page.html"), "<html>suite</html>");
    const server = await createSuiteServer({ suiteDir: dir, control: new SuiteControl(), isRunning: () => false, onAbort: () => {}, onClose: () => {}, pageFile: path.join(dir, "page.html") });
    cleanups.push(async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
      for (const r of repos) await rm(r.root, { recursive: true, force: true });
    });
    const body = (await (await fetch(`${server.url}api/suite`)).json()) as {
      repos: { name: string }[];
      features: { name: string; repo: string }[];
      changes: Record<string, { files: { path: string }[] }>;
    };
    expect(body.repos.map((r) => r.name)).toEqual(["a", "b"]);
    expect(body.features.map((f) => f.repo)).toEqual(["a", "b"]);
    expect(body.changes["@merge/a"]!.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(body.changes["@merge/b"]!.files.map((f) => f.path)).toEqual(["b.txt"]);
    expect(body.changes["@apply"]!.files.map((f) => f.path)).toEqual(["a/a.txt", "b/b.txt"]);
    const diff = await (await fetch(`${server.url}api/changes?node=${encodeURIComponent("@apply")}&file=b%2Fb.txt`)).text();
    expect(diff).toContain("b line");
  });
});
