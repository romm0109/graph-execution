import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
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
function openStream(port: number): { states: unknown[]; res: Promise<http.IncomingMessage> } {
  const states: unknown[] = [];
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
            if (data) states.push(JSON.parse(data.slice(6)));
          }
        });
        resolve(r);
      })
      .on("error", reject);
  });
  return { states, res };
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
    expect(await page.text()).toContain("EventSource");
    expect((await fetch(`${web.url}nope`)).status).toBe(404);
    expect((await fetch(`${web.url}state`, { method: "POST" })).status).toBe(405);
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

  it("carries retryable and failures in /state", async () => {
    const { web } = await setupRetry(["2"]);
    const body = (await (await fetch(`${web.url}state`)).json()) as { retryable: string[]; failures: object };
    expect(body.retryable).toEqual(["2"]);
    expect(body.failures).toEqual({});
  });
});
