import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HumanReviewStore, loadHumanRound, startHumanRound } from "../review/human.js";
import { RunEmitter } from "../runner/events.js";
import { RunStore } from "../ui/store.js";
import { createWebServer, type WebServer } from "./server.js";

let web: WebServer | undefined;
afterEach(async () => {
  await web?.close();
  web = undefined;
});

const END = { runId: "r1", branch: "graph/r1", exitCode: 2, reports: [], fixPasses: 3, runDir: "/r" };

async function setup() {
  const emitter = new RunEmitter();
  const hooks = { aborts: 0, closes: 0 };
  const store = new RunStore(emitter, { taskIds: ["a", "b"], attempts: 3 });
  web = await createWebServer({
    store,
    meta: { layers: [["a"], ["b"]], parents: { b: ["a"] }, runId: "r1", provider: "fake", startedAt: 1 },
    onAbort: () => void hooks.aborts++,
    onClose: () => void hooks.closes++,
  });
  return { store, web, emitter, hooks };
}

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

/** Opens /events and collects the `state` events as they arrive. */
function openStream(port: number): { states: unknown[]; events: { event: string; data: Record<string, unknown> }[]; res: Promise<http.IncomingMessage> } {
  const states: unknown[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const res = new Promise<http.IncomingMessage>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/events" }, (r) => {
        let buf = "";
        r.on("data", (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk.split("\n").find((l) => l.startsWith("data: "));
            const event = chunk.split("\n").find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
            if (!data) continue;
            const parsed = JSON.parse(data.slice(6)) as Record<string, unknown>;
            events.push({ event, data: parsed });
            if (event === "state" || event === "message") states.push(parsed);
          }
        });
        resolve(r);
      })
      .on("error", reject);
  });
  return { states, events, res };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createWebServer", () => {
  it("serves the snapshot with the pipeline layers", async () => {
    const { web } = await setup();
    const res = await fetch(`${web.url}state`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      runId: string;
      graph: { layers: string[][]; nodes: { id: string }[]; parents: Record<string, string[]> };
    };
    expect(body.runId).toBe("r1");
    expect(body.graph.layers).toEqual([["a"], ["b"], ["@gate"], ["@reviewer", "@tester"], ["@fixer"], ["@merge"]]);
    expect(body.graph.nodes.map((n) => n.id)).toContain("@merge");
    expect(body.graph.parents["@gate"]).toEqual(["b"]);
  });

  it("carries the tester's test plan in the snapshot", async () => {
    const { web, emitter } = await setup();
    const cases = [{ id: "P1", verdict: "pass" as const, title: "Login", priority: "must" as const }];
    emitter.emit("review:end", { round: 1, reports: [{ round: 1, reviewer: "tester", findings: [], cases }] });
    const body = (await (await fetch(`${web.url}state`)).json()) as {
      graph: { nodes: { id: string; view: { testPlan?: unknown } }[] };
    };
    expect(body.graph.nodes.find((n) => n.id === "@tester")!.view.testPlan).toEqual({ round: 1, cases });
  });

  it("sends the full state first to a late subscriber, then changes, coalesced", async () => {
    const { web, store } = await setup();
    store.addEvent("before");
    const stream = openStream(web.port);
    await stream.res;
    await sleep(50);
    expect(stream.states).toHaveLength(1);
    expect((stream.states[0] as { events: { text: string }[] }).events.at(-1)?.text).toBe("before");
    for (let i = 0; i < 20; i++) store.addEvent(`e${i}`);
    await sleep(250);
    expect(stream.states.length).toBeGreaterThan(1);
    expect(stream.states.length).toBeLessThan(6);
    expect((stream.states.at(-1) as { events: { text: string }[] }).events.at(-1)?.text).toBe("e19");
  });

  it("rejects a foreign Host with 421", async () => {
    const { web } = await setup();
    expect((await rawRequest(web.port, { path: "/state", headers: { host: "evil.example" } })).status).toBe(421);
  });

  it("rejects a foreign Origin on POST with 403", async () => {
    const { web } = await setup();
    const res = await rawRequest(web.port, { method: "POST", path: "/anything", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("serves the page, 404s other paths and 405s other methods", async () => {
    const { web } = await setup();
    const page = await fetch(web.url);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain("/assets/runpage.js");
    expect((await fetch(`${web.url}nope`)).status).toBe(404);
    expect((await fetch(`${web.url}state`, { method: "POST" })).status).toBe(405);
  });

  it("serves bundled assets and refuses traversal, unknown types and other methods", async () => {
    const { web } = await setup();
    const css = await fetch(`${web.url}assets/theme.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("cache-control")).toBe("no-cache");
    const js = await fetch(`${web.url}assets/vendor/highlight/highlight.min.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    for (const p of ["assets/../server.ts", "assets/%2e%2e/server.ts", "assets/nope.css", "assets/x.exe"]) {
      const res = await rawRequest(web.port, { method: "GET", path: `/${p}` });
      expect(res.status, p).toBe(404);
    }
    const post = await fetch(`${web.url}assets/theme.css`, { method: "POST", headers: { origin: web.url.slice(0, -1) } });
    expect(post.status).toBe(405);
  });

  it("aborts a running run once, and refuses after the end", async () => {
    const { web, emitter, hooks } = await setup();
    const res = await fetch(`${web.url}abort`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(hooks.aborts).toBe(1);
    emitter.emit("run:end", END);
    expect((await fetch(`${web.url}abort`, { method: "POST" })).status).toBe(409);
    expect(hooks.aborts).toBe(1);
  });

  it("closes only after the end, then stops listening", async () => {
    const { web, emitter, hooks } = await setup();
    expect((await fetch(`${web.url}close`, { method: "POST" })).status).toBe(409);
    emitter.emit("run:end", END);
    expect((await fetch(`${web.url}close`, { method: "POST" })).status).toBe(200);
    await sleep(100);
    expect(hooks.closes).toBe(1);
    await expect(rawRequest(web.port, { path: "/state" })).rejects.toThrow();
  });

  it("refuses a foreign Origin on /abort and /close", async () => {
    const { web, hooks } = await setup();
    for (const path of ["/abort", "/close"]) {
      const res = await rawRequest(web.port, { method: "POST", path, headers: { origin: "https://evil.example" } });
      expect(res.status).toBe(403);
    }
    expect(hooks.aborts).toBe(0);
  });

  it("adds summaryContent to the snapshot after run:end", async () => {
    const { web, emitter } = await setup();
    const before = (await (await fetch(`${web.url}state`)).json()) as { summaryContent?: unknown };
    expect(before.summaryContent).toBeUndefined();
    emitter.emit("run:end", END);
    const after = (await (await fetch(`${web.url}state`)).json()) as { summaryContent: { color: string; title: string } };
    expect(after.summaryContent.color).toBe("red");
    expect(after.summaryContent.title).toContain("aborted");
  });

  it("puts the test plan line in the summary content", async () => {
    const { web, emitter } = await setup();
    const tester = {
      round: 1,
      reviewer: "tester" as const,
      findings: [],
      cases: [
        { id: "P1", verdict: "pass" as const },
        { id: "P2", verdict: "blocked" as const },
      ],
    };
    emitter.emit("run:end", { ...END, reports: [tester] });
    const after = (await (await fetch(`${web.url}state`)).json()) as { summaryContent: { sections: { lines: string[] }[] } };
    expect(after.summaryContent.sections.flatMap((s) => s.lines)).toContain("Test plan: 1/2 passed (1 blocked)");
  });

  it("close ends open event streams", async () => {
    const { web } = await setup();
    const stream = openStream(web.port);
    const res = await stream.res;
    const ended = new Promise<void>((resolve) => res.on("close", resolve));
    await web.close();
    await ended;
  });
});

describe("POST /retry/:id", () => {
  async function setupRetry(ids: string[]) {
    const emitter = new RunEmitter();
    const store = new RunStore(emitter, { taskIds: ["2", "@fixer"], attempts: 3 });
    const retried: string[] = [];
    web = await createWebServer({
      store,
      meta: { layers: [["2"]], parents: {}, runId: "r1", provider: "fake", startedAt: 1 },
      onAbort: () => {},
      onClose: () => {},
      retry: { retryNode: (id) => (retried.push(id), { ok: true }) },
    });
    emitter.emit("retry:available", { nodes: ids });
    return { web, retried };
  }
  const post = (port: number, path: string, headers: http.OutgoingHttpHeaders = {}) =>
    rawRequest(port, { method: "POST", path, headers });

  it("accepts a retryable node, decoding the id", async () => {
    const { web, retried } = await setupRetry(["2", "@fixer"]);
    expect((await post(web.port, "/retry/2")).status).toBe(200);
    expect((await post(web.port, "/retry/%40fixer")).status).toBe(200);
    expect(retried).toEqual(["2", "@fixer"]);
  });

  it("answers 404 for an unknown node and 409 for one that is not retryable", async () => {
    const { web, retried } = await setupRetry(["2"]);
    expect((await post(web.port, "/retry/nope")).status).toBe(404);
    expect((await post(web.port, "/retry/@fixer")).status).toBe(409);
    expect(retried).toEqual([]);
  });

  it("refuses a foreign Origin or Host", async () => {
    const { web, retried } = await setupRetry(["2"]);
    expect((await post(web.port, "/retry/2", { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(web.port, "/retry/2", { host: "evil.example" })).status).toBe(421);
    expect(retried).toEqual([]);
  });

  it("merges from the page only while the run offers it", async () => {
    const emitter = new RunEmitter();
    const store = new RunStore(emitter, { taskIds: ["2"], attempts: 3 });
    let merged = 0;
    web = await createWebServer({
      store,
      meta: { layers: [["2"]], parents: {}, runId: "r1", provider: "fake", startedAt: 1 },
      onAbort: () => {},
      onClose: () => {},
      retry: { retryNode: () => ({ ok: true }), mergeNow: () => (merged++, { ok: true }) },
    });
    expect((await post(web.port, "/merge")).status).toBe(409);
    emitter.emit("retry:available", { nodes: ["2"], merge: true });
    expect((await post(web.port, "/merge", { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(web.port, "/merge")).status).toBe(200);
    expect(merged).toBe(1);
    expect(((await (await fetch(`${web.url}state`)).json()) as { mergeable: boolean }).mergeable).toBe(true);
  });

  it("carries retryable and failures in /state", async () => {
    const { web } = await setupRetry(["2"]);
    const body = (await (await fetch(`${web.url}state`)).json()) as { retryable: string[]; failures: object };
    expect(body.retryable).toEqual(["2"]);
    expect(body.failures).toEqual({});
  });
});

describe("review routes", () => {
  const finding = {
    id: "F1",
    severity: "blocker" as const,
    description: "Wrong.",
    failureScenario: "x",
    status: "open" as const,
  };
  async function setupReview() {
    const emitter = new RunEmitter();
    const store = new RunStore(emitter, { taskIds: ["2"], attempts: 3 });
    const decisions: unknown[] = [];
    web = await createWebServer({
      store,
      meta: { layers: [["2"]], parents: {}, runId: "r1", provider: "fake", startedAt: 1 },
      onAbort: () => {},
      onClose: () => {},
      review: { decide: (choice) => (decisions.push(choice), { ok: true }) },
    });
    return { web, emitter, decisions };
  }
  const post = (url: string, path: string, body?: string) =>
    fetch(`${url}${path.slice(1)}`, { method: "POST", ...(body === undefined ? {} : { body }) });

  it("answers 409 before the run waits, then serves the round", async () => {
    const { web, emitter, decisions } = await setupReview();
    expect((await fetch(`${web.url}review`)).status).toBe(409);
    expect((await post(web.url, "/review/apply")).status).toBe(409);
    expect((await post(web.url, "/review/drop")).status).toBe(409);
    emitter.emit("review:waiting", { round: 1, blocking: [] });
    const res = await fetch(`${web.url}review`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ round: 1, blocking: [] });
    expect((await post(web.url, "/review/apply")).status).toBe(200);
    expect((await post(web.url, "/review/drop")).status).toBe(200);
    expect(decisions).toEqual([{ review: "apply", force: false }, { review: "drop" }]);
  });

  it("request changes needs an open comment", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rc-"));
    await startHumanRound(dir, 1, "a", "b");
    const emitter = new RunEmitter();
    const decisions: unknown[] = [];
    web = await createWebServer({
      store: new RunStore(emitter, { taskIds: ["2"], attempts: 3 }),
      meta: { layers: [["2"]], parents: {}, runId: "r1", provider: "fake", startedAt: 1 },
      onAbort: () => {},
      onClose: () => {},
      review: { decide: (choice) => (decisions.push(choice), { ok: true }) },
      human: { runDir: dir, repo: dir },
    });
    emitter.emit("review:waiting", { round: 1, blocking: [] });
    const res = await post(web.url, "/review/changes");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "write or reopen a comment first" });
    await new HumanReviewStore(dir).add({ body: "fix it" });
    expect((await post(web.url, "/review/changes")).status).toBe(200);
    expect(decisions).toEqual([{ review: "changes" }]);
  });

  it("needs force to apply with open findings", async () => {
    const { web, emitter, decisions } = await setupReview();
    emitter.emit("review:waiting", { round: 1, blocking: [finding] });
    expect((await post(web.url, "/review/apply", "{}")).status).toBe(409);
    expect(decisions).toEqual([]);
    expect((await post(web.url, "/review/apply", '{"force":true}')).status).toBe(200);
    expect(decisions).toEqual([{ review: "apply", force: true }]);
  });

  it("stops accepting once decided", async () => {
    const { web, emitter } = await setupReview();
    emitter.emit("review:waiting", { round: 1, blocking: [] });
    emitter.emit("review:decided", { decision: "drop" });
    expect((await post(web.url, "/review/drop")).status).toBe(409);
  });

  it("refuses a foreign Origin and a bad body", async () => {
    const { web, emitter, decisions } = await setupReview();
    emitter.emit("review:waiting", { round: 1, blocking: [] });
    const evil = await rawRequest(web.port, { method: "POST", path: "/review/drop", headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect((await post(web.url, "/review/apply", "{nope")).status).toBe(400);
    expect(decisions).toEqual([]);
  });
});

describe("GET /changes/:id", () => {
  async function setupChanges() {
    const emitter = new RunEmitter();
    const store = new RunStore(emitter, { taskIds: ["a"], attempts: 3 });
    web = await createWebServer({
      store,
      meta: { layers: [["a"]], parents: {}, runId: "r1", provider: "fake", startedAt: 1 },
      onAbort: () => {},
      onClose: () => {},
      changes: { fileDiff: async (_id, f) => ({ path: f, diff: "+x\n", truncated: false, binary: false }), fileLines: async () => ({ lines: ["a", "b"], total: 2 }) },
    });
    const file = { path: "src/x.ts", added: 1, deleted: 0 };
    emitter.emit("nodeChanges", { nodeId: "a", changes: { files: [file], total: { added: 1, deleted: 0, files: 1 } } });
    return { web, file };
  }
  const get = (port: number, path: string, headers: http.OutgoingHttpHeaders = {}) =>
    rawRequest(port, { method: "GET", path, headers });

  it("lists the files and answers 404 for an unknown node", async () => {
    const { web, file } = await setupChanges();
    const res = await get(web.port, "/changes/a");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ files: [file] });
    expect((await get(web.port, "/changes/zzz")).status).toBe(404);
  });

  it("returns the diff of a listed file and rejects any other path", async () => {
    const { web } = await setupChanges();
    const ok = await get(web.port, "/changes/a?file=src/x.ts");
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ path: "src/x.ts", diff: "+x\n", truncated: false, binary: false });
    expect((await get(web.port, "/changes/a?file=../../etc/passwd")).status).toBe(400);
    expect((await get(web.port, "/changes/a?file=other.ts")).status).toBe(400);
  });

  it("serves lines of a listed node file only", async () => {
    const { web } = await setupChanges();
    const ok = await get(web.port, "/file?node=a&path=src/x.ts&from=1&to=2");
    expect(JSON.parse(ok.body)).toEqual({ path: "src/x.ts", from: 1, to: 2, lines: ["a", "b"], total: 2 });
    expect((await get(web.port, "/file?node=zz&path=src/x.ts&from=1&to=2")).status).toBe(404);
    expect((await get(web.port, "/file?node=a&path=other.ts&from=1&to=2")).status).toBe(400);
    expect((await get(web.port, "/file?node=a&path=src/x.ts&from=1&to=900")).status).toBe(200);
  });

  it("refuses a foreign Host", async () => {
    const { web } = await setupChanges();
    expect((await get(web.port, "/changes/a", { host: "evil.example" })).status).toBe(421);
  });
});

describe("review comments", () => {
  async function setupComments() {
    const repo = mkdtempSync(path.join(os.tmpdir(), "rv-repo-"));
    const runDir = mkdtempSync(path.join(os.tmpdir(), "rv-run-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    mkdirSync(path.join(repo, "src"));
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
    git("add", ".");
    git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD");
    await startHumanRound(runDir, 1, base, head);
    const emitter = new RunEmitter();
    const store = new RunStore(emitter, { taskIds: ["2"], attempts: 3 });
    web = await createWebServer({
      store,
      meta: { layers: [["2"]], parents: {}, runId: "r1", provider: "fake", startedAt: 1 },
      onAbort: () => {},
      onClose: () => {},
      human: { runDir, repo },
    });
    const send = (method: string, p: string, body?: object) =>
      fetch(`${web!.url}${p.slice(1)}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { emitter, runDir, send };
  }

  it("is 409 until the run waits", async () => {
    const { send } = await setupComments();
    expect((await send("GET", "/review")).status).toBe(409);
    expect((await send("POST", "/review/comments", { body: "x" })).status).toBe(409);
    expect((await send("GET", "/review/diff?file=a.txt&round=1")).status).toBe(409);
    expect((await send("DELETE", "/review/comments/H1-1")).status).toBe(409);
  });

  it("serves lines of a changed file of a review round", async () => {
    const { emitter, send } = await setupComments();
    expect((await send("GET", "/file?round=1&path=a.txt&from=1&to=2")).status).toBe(409);
    emitter.emit("review:waiting", { round: 1, blocking: [] });
    const ok = await send("GET", "/file?round=1&path=a.txt&from=1&to=2");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: "a.txt", from: 1, to: 2, lines: ["one", "two"], total: 3 });
    const clamped = await (await send("GET", "/file?round=1&path=a.txt&from=3&to=40")).json();
    expect(clamped).toEqual({ path: "a.txt", from: 3, to: 3, lines: ["three"], total: 3 });
    expect((await send("GET", "/file?round=1&path=nope.txt&from=1&to=2")).status).toBe(400);
    expect((await send("GET", "/file?round=1&path=../x&from=1&to=2")).status).toBe(400);
    expect((await send("GET", "/file?round=1&path=a.txt&from=3&to=2")).status).toBe(400);
    expect((await send("GET", "/file?round=1&path=a.txt&from=0&to=2")).status).toBe(400);
    expect((await send("GET", "/file?round=1&path=a.txt&from=x&to=2")).status).toBe(400);
    expect((await send("GET", "/file?round=9&path=a.txt&from=1&to=2")).status).toBe(404);
    expect((await send("POST", "/file?round=1&path=a.txt&from=1&to=2")).status).toBe(405);
  });

  it("adds, lists, edits and deletes comments, writing the file first", async () => {
    const { emitter, runDir, send } = await setupComments();
    emitter.emit("review:waiting", { round: 1, blocking: [] });
    const created = await send("POST", "/review/comments", { file: "a.txt", line: 3, snippet: "three", body: "why?", liveCheck: true });
    expect(created.status).toBe(201);
    const comment = (await created.json()) as { id: string };
    expect(comment.id).toBe("H1-1");
    expect(JSON.parse(readFileSync(path.join(runDir, "human", "round1.json"), "utf8")).comments[0].body).toBe("why?");
    const listed = (await (await send("GET", "/review")).json()) as { files: { path: string }[]; comments: unknown[]; diffBase: string };
    expect(listed.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(listed.comments).toHaveLength(1);
    expect(listed.diffBase).toBeTruthy();
    const edited = await send("PUT", "/review/comments/H1-1", { body: "changed" });
    expect(edited.status).toBe(200);
    expect(JSON.parse(readFileSync(path.join(runDir, "human", "round1.json"), "utf8")).comments[0].body).toBe("changed");
    expect((await send("DELETE", "/review/comments/H1-1")).status).toBe(200);
    expect(JSON.parse(readFileSync(path.join(runDir, "human", "round1.json"), "utf8")).comments).toEqual([]);
  });

  it("rejects a suggestion unless it is on the new side", async () => {
    const { emitter, send } = await setupComments();
    emitter.emit("review:waiting", { round: 1, blocking: [] });
    const body = "```suggestion\nx\n```";
    const bad = await send("POST", "/review/comments", { file: "a.txt", side: "old", startLine: 2, body });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "suggestion needs side new" });
    expect((await send("POST", "/review/comments", { file: "a.txt", side: "new", startLine: 2, body })).status).toBe(201);
    expect((await send("POST", "/review/comments", { file: "a.txt", side: "old", startLine: 2, body: "plain" })).status).toBe(201);
    expect((await send("PUT", "/review/comments/H1-2", { body })).status).toBe(400);
  });

  it("stores line ranges, normalizes the legacy line and rejects bad ranges", async () => {
    const { emitter, send } = await setupComments();
    emitter.emit("review:waiting", { round: 1, blocking: [] });
    const range = await send("POST", "/review/comments", { file: "a.txt", side: "new", startLine: 2, endLine: 3, snippet: "two\nthree", body: "x" });
    expect(range.status).toBe(201);
    expect((await send("POST", "/review/comments", { file: "a.txt", line: 3, body: "y" })).status).toBe(201);
    expect((await send("POST", "/review/comments", { file: "a.txt", startLine: 3, endLine: 2, body: "z" })).status).toBe(400);
    expect((await send("POST", "/review/comments", { startLine: 3, body: "z" })).status).toBe(400);
    const listed = (await (await send("GET", "/review")).json()) as { comments: Record<string, unknown>[] };
    expect(listed.comments[0]).toMatchObject({ side: "new", startLine: 2, endLine: 3 });
    expect(listed.comments[1]).toMatchObject({ side: "new", startLine: 3, endLine: 3 });
    expect(listed.comments[1]).not.toHaveProperty("line");
  });

  it("rejects bad input and unknown ids", async () => {
    const { emitter, send } = await setupComments();
    emitter.emit("review:waiting", { round: 1, blocking: [] });
    expect((await send("POST", "/review/comments", { line: 3, body: "x" })).status).toBe(400);
    expect((await send("POST", "/review/comments", { body: "  " })).status).toBe(400);
    expect((await send("PUT", "/review/comments/H1-9", { body: "x" })).status).toBe(404);
    expect((await send("DELETE", "/review/comments/H1-9")).status).toBe(404);
  });

  it("resolves and reopens earlier-round comments and returns outcomes", async () => {
    const { emitter, runDir, send } = await setupComments();
    expect((await send("POST", "/review/comments/H1-1/resolve")).status).toBe(409);
    await new HumanReviewStore(runDir).add({ body: "first" });
    const round1 = await loadHumanRound(runDir, 1);
    await startHumanRound(runDir, 2, round1!.diffBase, round1!.diffHead);
    mkdirSync(path.join(runDir, "reports", "round1"), { recursive: true });
    writeFileSync(path.join(runDir, "reports", "round1", "fixer-comments.json"), JSON.stringify([{ id: "H1-1", note: "done" }]));
    emitter.emit("review:waiting", { round: 2, reviewRound: 1, blocking: [] });
    const ownRes = await send("POST", "/review/comments", { body: "second" });
    expect(ownRes.status).toBe(201);
    const own = await ownRes.json();
    expect((own as { id: string }).id).toBe("H2-1");
    expect((await send("POST", "/review/comments/H2-1/resolve")).status).toBe(400);
    expect((await send("POST", "/review/comments/H1-9/resolve")).status).toBe(404);
    expect((await send("POST", "/review/comments/H1-9/reopen", {})).status).toBe(404);
    const reopened = await send("POST", "/review/comments/H1-1/reopen", { followUp: "more" });
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ status: "reopened", followUps: ["more"] });
    const resolved = await send("POST", "/review/comments/H1-1/resolve");
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ status: "resolved" });
    const listed = (await (await send("GET", "/review")).json()) as { outcomes: Record<string, { fixerNote?: string }> };
    expect(listed.outcomes["H1-1"]?.fixerNote).toBe("done");
  });

  it("serves the diff of files in the final diff only", async () => {
    const { emitter, send } = await setupComments();
    emitter.emit("review:waiting", { round: 1, blocking: [] });
    const ok = await send("GET", "/review/diff?file=a.txt&round=1");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { diff: string }).diff).toContain("+three");
    expect((await send("GET", "/review/diff?file=../etc/passwd&round=1")).status).toBe(400);
    expect((await send("GET", "/review/diff?file=nope.txt&round=1")).status).toBe(400);
  });

  it("lists the files of a round", async () => {
    const { emitter, send } = await setupComments();
    expect((await send("GET", "/review/files?round=1")).status).toBe(409);
    emitter.emit("review:waiting", { round: 1, blocking: [] });
    const ok = await send("GET", "/review/files?round=1");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { round: number; files: { path: string }[] };
    expect(body.round).toBe(1);
    expect(body.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect((await send("GET", "/review/files?round=0")).status).toBe(400);
    expect((await send("GET", "/review/files?round=99")).status).toBe(400);
  });

  it("refuses a foreign Origin on DELETE", async () => {
    const { emitter, send } = await setupComments();
    emitter.emit("review:waiting", { round: 1, blocking: [] });
    await send("POST", "/review/comments", { body: "x" });
    const evil = await rawRequest(web!.port, { method: "DELETE", path: "/review/comments/H1-1", headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
  });
});

describe("logs", () => {
  async function setupLogs() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "web-logs-"));
    writeFileSync(path.join(dir, "a.log"), "first\n");
    writeFileSync(path.join(dir, "a-validate-1.log"), "v\n");
    writeFileSync(path.join(dir, "b.log"), "other\n");
    const store = new RunStore(new RunEmitter(), { taskIds: ["a", "b"], attempts: 3 });
    web = await createWebServer({
      store,
      meta: { layers: [["a"], ["b"]], parents: {}, runId: "r1", provider: "fake", startedAt: 1 },
      onAbort: () => {},
      onClose: () => {},
      logsDir: dir,
    });
    return { dir, port: web.port };
  }

  it("lists a node's logs and serves one in full", async () => {
    const { port } = await setupLogs();
    const list = JSON.parse((await rawRequest(port, { path: "/logs?node=a" })).body) as { logs: { label: string; size: number; tail: string }[] };
    expect(list.logs.map((l) => l.label)).toEqual(["a", "a-validate-1"]);
    expect(list.logs[0]).toEqual({ label: "a", size: 6, tail: "first\n" });
    expect(JSON.parse((await rawRequest(port, { path: "/logs/b?full=1" })).body)).toMatchObject({ label: "b", text: "other\n", truncated: false });
    expect((await rawRequest(port, { path: "/logs/nope?full=1" })).status).toBe(404);
    expect((await rawRequest(port, { path: "/logs/..%2Fx?full=1" })).status).toBe(404);
  });

  it("is 404 without a logs dir", async () => {
    const { web } = await setup();
    expect((await rawRequest(web.port, { path: "/logs" })).status).toBe(404);
  });

  it("streams appended text to a subscribed client only", async () => {
    const { dir, port } = await setupLogs();
    const stream = openStream(port);
    await stream.res;
    await sleep(50);
    const hello = stream.events.find((e) => e.event === "hello")!;
    const send = (body: object, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/logs/subscribe", headers: { "content-type": "application/json", ...headers } }, (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode!, body: "" }));
        });
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
    expect((await send({ client: hello.data.id, labels: ["a"] }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await send({ client: hello.data.id, labels: ["../x"] })).status).toBe(400);
    expect((await send({ client: "nope", labels: ["a"] })).status).toBe(404);
    expect((await send({ client: hello.data.id, labels: ["a"] })).status).toBe(204);
    writeFileSync(path.join(dir, "b.log"), "other\nmore\n");
    writeFileSync(path.join(dir, "a.log"), "first\nsecond\n");
    const end = Date.now() + 2000;
    while (!stream.events.some((e) => e.event === "log") && Date.now() < end) await sleep(50);
    expect(stream.events.filter((e) => e.event === "log").map((e) => e.data)).toEqual([{ label: "a", offset: 6, text: "second\n" }]);
    (await stream.res).destroy();
  });
});
