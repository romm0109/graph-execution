import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const src = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8");

type Listener = (e: unknown) => void;

function load(fetchImpl: (r: unknown) => Promise<Response>) {
  const listeners: Record<string, Listener> = {};
  const self = {
    addEventListener: (t: string, f: Listener) => (listeners[t] = f),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
  };
  const fetchMock = vi.fn(fetchImpl);
  new Function("self", "fetch", "Response", src)(self, fetchMock, Response);
  return { listeners, self, fetchMock };
}

function fire(listeners: Record<string, Listener>, mode: string) {
  const event = { request: { mode }, respondWith: vi.fn() };
  listeners.fetch!(event);
  return event;
}

describe("sw.js", () => {
  it("caches nothing", () => {
    expect(src).not.toContain("caches.");
  });

  it("takes over at once", async () => {
    const { listeners, self } = load(async () => new Response("ok"));
    listeners.install!({});
    expect(self.skipWaiting).toHaveBeenCalledTimes(1);
    const waitUntil = vi.fn();
    listeners.activate!({ waitUntil });
    expect(self.clients.claim).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
  });

  it("answers a failed navigation with the not-reachable page", async () => {
    const { listeners } = load(async () => {
      throw new TypeError("Failed to fetch");
    });
    const event = fire(listeners, "navigate");
    expect(event.respondWith).toHaveBeenCalledTimes(1);
    const res = (await event.respondWith.mock.calls[0]![0]) as Response;
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const text = await res.text();
    for (const part of ["graph-manager is not reachable", "Check that the server is running and that this device can reach it.", "Retry", "location.reload()"])
      expect(text).toContain(part);
  });

  it("passes a successful navigation through", async () => {
    const ok = new Response("page");
    const { listeners } = load(async () => ok);
    const event = fire(listeners, "navigate");
    expect(await event.respondWith.mock.calls[0]![0]).toBe(ok);
  });

  it.each(["cors", "no-cors", "same-origin"])("leaves %s requests alone", (mode) => {
    const { listeners, fetchMock } = load(async () => new Response("x"));
    const event = fire(listeners, mode);
    expect(event.respondWith).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
