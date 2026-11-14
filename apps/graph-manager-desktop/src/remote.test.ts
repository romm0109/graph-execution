import { describe, expect, it } from "vitest";
import { isLoopback, normalizeServerUrl, probeServer } from "./remote.js";

describe("normalizeServerUrl", () => {
  it("adds https:// when there is no scheme", () => {
    expect(normalizeServerUrl("  gm.example.com ")).toEqual({ ok: true, origin: "https://gm.example.com", insecure: false });
  });
  it("drops the path and flags plain http to another host", () => {
    expect(normalizeServerUrl("http://10.0.0.5:7420/x/")).toEqual({ ok: true, origin: "http://10.0.0.5:7420", insecure: true });
  });
  it("does not flag plain http to this machine", () => {
    expect(normalizeServerUrl("http://localhost:7420")).toEqual({ ok: true, origin: "http://localhost:7420", insecure: false });
    expect(normalizeServerUrl("http://127.0.0.1:7420")).toMatchObject({ insecure: false });
    expect(normalizeServerUrl("http://[::1]:7420")).toMatchObject({ insecure: false });
  });
  it("refuses other schemes and bad input", () => {
    expect(normalizeServerUrl("ftp://x")).toEqual({ ok: false, error: "Use an http:// or https:// address." });
    expect(normalizeServerUrl("http://")).toEqual({ ok: false, error: "That isn't a valid address." });
    expect(normalizeServerUrl("")).toEqual({ ok: false, error: "That isn't a valid address." });
  });
});

describe("isLoopback", () => {
  it("knows this machine's hosts", () => {
    expect(isLoopback("http://127.0.0.1:7420")).toBe(true);
    expect(isLoopback("http://localhost:1")).toBe(true);
    expect(isLoopback("http://[::1]:7420")).toBe(true);
    expect(isLoopback("https://gm.example.com")).toBe(false);
    expect(isLoopback("http://10.0.0.5:7420")).toBe(false);
    expect(isLoopback("nonsense")).toBe(false);
  });
});

describe("probeServer", () => {
  const origin = "https://gm.example.com";
  const err = { ok: false, error: "No graph-manager server answered at https://gm.example.com." };
  const fake = (res: () => Response): typeof fetch => (async () => res()) as unknown as typeof fetch;

  it("accepts a 200 with a host", async () => {
    let asked = "";
    const f = (async (u: string) => {
      asked = u;
      return Response.json({ host: "h" });
    }) as unknown as typeof fetch;
    expect(await probeServer(origin, f)).toEqual({ ok: true, host: "h" });
    expect(asked).toBe("https://gm.example.com/api/auth/info");
  });
  it("refuses a 404", async () => {
    expect(await probeServer(origin, fake(() => new Response("no", { status: 404 })))).toEqual(err);
  });
  it("refuses a network error", async () => {
    const f = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await probeServer(origin, f)).toEqual(err);
  });
  it("refuses a host that isn't a string and non-JSON", async () => {
    expect(await probeServer(origin, fake(() => Response.json({ host: 1 })))).toEqual(err);
    expect(await probeServer(origin, fake(() => new Response("<html>")))).toEqual(err);
  });
});
