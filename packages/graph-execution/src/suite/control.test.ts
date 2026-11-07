import { describe, expect, it } from "vitest";
import { SuiteControl } from "./control.js";

describe("SuiteControl", () => {
  it("refuses what is not allowed", () => {
    const c = new SuiteControl();
    expect(c.retryFeature("a")).toEqual({ ok: false, reason: "not_failed" });
    expect(c.startIntegration()).toEqual({ ok: false, reason: "not_ready" });
    c.setAllowed({ retry: ["a"], integrate: false }, ["a", "b"]);
    expect(c.retryFeature("b")).toEqual({ ok: false, reason: "not_failed" });
    expect(c.retryFeature("zzz")).toEqual({ ok: false, reason: "unknown" });
  });

  it("hands accepted requests out in order", async () => {
    const c = new SuiteControl();
    c.setAllowed({ retry: ["a", "b"], integrate: true });
    expect(c.retryFeature("a")).toEqual({ ok: true });
    expect(c.retryFeature("b")).toEqual({ ok: true });
    expect(c.startIntegration()).toEqual({ ok: true });
    expect(await c.next()).toEqual({ retry: "a" });
    expect(await c.next()).toEqual({ retry: "b" });
    expect(await c.next()).toEqual({ integrate: true });
  });

  it("resolves a pending next with a request that arrives later", async () => {
    const c = new SuiteControl();
    c.setAllowed({ retry: ["a"], integrate: false });
    const p = c.next();
    c.retryFeature("a");
    expect(await p).toEqual({ retry: "a" });
  });

  it("resolves a pending next with undefined on quit", async () => {
    const c = new SuiteControl();
    const p = c.next();
    c.quit();
    expect(await p).toBeUndefined();
    expect(await c.next()).toBeUndefined();
  });

  it("tells listeners about changes", () => {
    const c = new SuiteControl();
    let n = 0;
    const off = c.onChange(() => n++);
    c.setAllowed({ retry: [], integrate: true });
    off();
    c.setAllowed({ retry: [], integrate: false });
    expect(n).toBe(1);
  });
});
